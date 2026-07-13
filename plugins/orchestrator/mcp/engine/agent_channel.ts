/**
 * Agent-channel filewatcher subsystem.
 *
 * Polls ~/.claude/projects/<hash>/*.jsonl every ~1.5s for new events on each
 * active session in the project. Filters via agent_channel_filter, parses
 * addressing via addressing.parseAddressing, and emits ChannelNotification
 * objects via the injected callback (the MCP server wires this to
 * mcp.notification(...)).
 *
 * Each Claude Code session in the project runs its own instance of this
 * class via the orchestrator MCP server. PA's instance forwards every event
 * (authoritative observer); SA instances forward only events explicitly
 * addressed to them.
 *
 * Heartbeat (30s) keeps sessions.json fresh; stale sessions (>90s without
 * heartbeat) are reaped by any active instance and a session_departed
 * event is emitted.
 */

import { openSync, readSync, closeSync, existsSync, statSync, readdirSync } from "fs";
import { join } from "path";
import { parseAddressing } from "./addressing";
import { filterEvent, type FilteredEvent } from "./agent_channel_filter";
import {
  readSessions,
  writeSession,
  removeSession,
  readOverrideState,
  readOffsets,
  writeAllOffsets,
  readNewSystemEvents,
  type SessionEntry,
} from "./agent_channel_state";

// NOTE: The MCP channels contract (https://code.claude.com/docs/en/channels-reference)
// requires meta values to be strings; Claude Code's receive-side validator silently
// drops notifications whose meta contains non-string values. The internal
// ChannelNotification.meta below carries rich types for in-process use; conversion
// to the on-wire string-only form happens in server.ts at the MCP boundary via
// sanitizeChannelMeta. Also note: the <channel source="..."> attribute is set
// automatically by Claude Code from the MCP server's `name` field — so receivers
// will see source="orchestrator" regardless of any meta.source we pass.
export interface ChannelNotification {
  content: string;
  meta: {
    from_session: string;
    from_id8: string;
    from_role: "prime" | "subordinate";
    from_name: string;
    from_task: string | null;
    event_type:
      | FilteredEvent["event_type"]
      | "session_joined"
      | "session_departed"
      | "override_set"
      | "override_cleared"
      | "permission_request_pending"
      | "post_compact_recovery"
      | "pa_compact_recovery"
      | "egress_suspect"
      | "ingress_suspect";
    tool_name?: string;
    pa_addressed?: boolean;
    addressed_to?: string[];
    pa_global_pause?: boolean;
    sa_paused?: boolean;
    ts: string;
  };
}

export type EmitFn = (n: ChannelNotification) => void;

const POLL_INTERVAL_MS = 1500;
const HEARTBEAT_INTERVAL_MS = 30_000;
const STALE_THRESHOLD_MS = 90_000;
// DEFENSE-C (WI 8522c487): consecutive stale-observation ticks a peer must be
// absent from the fresh roster before its session_departed is announced (and
// its row reaped). ~one heartbeat interval (30s) at the 1.5s nominal tick rate:
// a starved-but-alive victim refreshes within one 30s beat of the stall
// clearing, so this grace absorbs the recovery and suppresses depart<->rejoin
// flaps; under load the observer's own ticks dilate, lengthening the wall-clock
// grace exactly when it is needed. Trade: genuine-departure announcement
// latency rises from 90s to ~120s. Basis: measured ~72x tick-I/O reduction from
// A+B (1099ms -> 15ms at 6x20MB) removes self-inflicted starvation, leaving only
// bounded external-CPU stalls, so a modest fixed grace suffices.
export const DEPART_GRACE_TICKS = 20;

// Egress-death detection (WI 0f9dcd95): a peer absent from the fresh roster is
// EITHER genuinely gone (its transcript FROZE at exit) OR egress-dead (alive,
// still appending turns while its heartbeat/outbound is down - anti_pattern
// 6ef0c61f, proven live 2026-07-13). Byte-size growth AFTER going stale is the
// discriminator: a dead process appends nothing, and transcript size is
// monotonic, so growth-since-stale => alive-but-unreachable. PURE for TDD; the
// statSync/emit glue in detectSessionChanges stays untested-for-live.
export function classifyAbsence(opts: {
  grewSinceStale: boolean;
  missCount: number;
  graceTicks: number;
}): "egress_suspect" | "departed" | "pending" {
  // Growth after going stale = the process is alive and still taking turns
  // while unreachable -> egress-dead (hold, do not reap; needs /mcp reconnect).
  // Dominates the miss count: a growing transcript is alive no matter how long
  // its heartbeat has been down.
  if (opts.grewSinceStale) return "egress_suspect";
  // No growth: frozen transcript = a dead process. Once the depart grace
  // elapses, it is genuinely gone.
  if (opts.missCount >= opts.graceTicks) return "departed";
  // No growth yet, still inside the grace window - wait (a real reconnect or a
  // first post-stale turn may still arrive).
  return "pending";
}

// Ingress-death detection (WI 19294811) - the INVERSE of egress. A session
// PRESENT in the fresh roster (heartbeat fresh) whose event loop is PARKED
// keeps heartbeating (its bun ticks) and keeps ENQUEUEing channel deliveries
// into its transcript, but runs no turn to DEQUEUE them. Confirmed cause: an
// interactive menu/prompt left open (an open /mcp menu parks the loop, verified
// live 2026-07-13); other parking causes possible. Both false-negatives - fresh
// heartbeat AND transcript growth - so the only truthful signal is a delivery
// that has been enqueued-but-never-dequeued since the last real activity. PEER-
// SIDE ONLY: a self-emit rides server.server.notification() -> the parked local
// harness, which cannot drain the MCP transport until the park clears, so it
// could never escape its own park. Advisory-only; never reaps a live session.
export const INGRESS_STALE_THRESHOLD_MS = 180_000; // 3 min unprocessed => parked
// Tail bytes scanned per peer for the enqueue/dequeue balance. Comfortably holds
// dozens of enqueued channel payloads; if real activity has scrolled entirely
// out of the window (nothing but queue-ops), that is itself a strong parked
// signal and the window's oldest enqueue is used as a lower-bound orphan age.
export const INGRESS_TAIL_BYTES = 131_072; // 128 KB
// The tail read is heavier than the egress statSync, so the scan is throttled to
// run every ~30s (in tick()) rather than every 1.5s tick. Detection latency of
// tens of seconds is irrelevant against the 3-min threshold, and this keeps the
// per-tick I/O near the post-flap-fix floor (WI 8522c487).
export const INGRESS_CHECK_INTERVAL_MS = 30_000;

// Classify a PRESENT peer's liveness from its transcript ingress signal. PURE
// for TDD; the tail read + emit glue in detectIngress stays untested-for-live.
export function classifyIngress(opts: {
  heartbeatFresh: boolean;
  oldestOrphanEnqueueTs: number | null;
  lastRealIsMidTurn: boolean;
  now: number;
  thresholdMs: number;
}): "ingress_suspect" | "healthy" | "pending" {
  // Only present (heartbeat-fresh) sessions are ingress candidates; an absent
  // peer is egress/departed territory (classifyAbsence owns it).
  if (!opts.heartbeatFresh) return "healthy";
  // The session is MID-TURN (a tool running, or the model owes a response /
  // is extended-thinking) -> blocked-but-alive, NOT parked. This is the
  // confirmed false-positive guard: both a long build/deploy and a multi-minute
  // thinking span append nothing while a channel delivery sits enqueued, looking
  // exactly like a park - but the session is healthy and working.
  if (opts.lastRealIsMidTurn) return "healthy";
  // No delivery has been enqueued-but-unprocessed since the last real activity
  // -> the loop is draining normally.
  if (opts.oldestOrphanEnqueueTs == null) return "healthy";
  // A delivery has sat unprocessed; once it passes the threshold the loop is
  // parked (open menu/prompt, or other cause).
  if (opts.now - opts.oldestOrphanEnqueueTs >= opts.thresholdMs) return "ingress_suspect";
  // Enqueued but still recent -> a normal dequeue may be imminent; wait.
  return "pending";
}

// Parse a transcript tail for the ingress signal: the timestamp (ms) of the
// oldest enqueue that remains UNMATCHED by a dequeue since the last real
// (non-queue-operation) transcript entry, or null if the loop is draining
// normally. A real entry RESETS the accounting - anything before it was
// processed. Dequeues are FIFO-matched to earlier enqueues so an interleaved
// partial drain does not overstate the orphan age. PURE for TDD.
export function parseIngressTail(tail: string): {
  lastRealActivityTs: number | null;
  oldestOrphanEnqueueTs: number | null;
  lastRealIsMidTurn: boolean;
} {
  let lastRealTs: number | null = null;
  let lastRealIsMidTurn = false;
  let enqueueTs: number[] = [];
  let dequeueCount = 0;
  for (const raw of tail.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    let o: any;
    try {
      o = JSON.parse(line);
    } catch {
      // Partial leading line (the byte-window can land mid-line) or non-JSON -
      // skip, never fatal.
      continue;
    }
    const t = typeof o?.timestamp === "string" ? Date.parse(o.timestamp) : NaN;
    if (o?.type === "queue-operation") {
      if (o?.operation === "enqueue") {
        if (Number.isFinite(t)) enqueueTs.push(t);
      } else if (o?.operation === "dequeue") {
        dequeueCount++;
      }
      continue;
    }
    // A real (non-queue-op) entry: the loop was running here, so anything queued
    // before it is drained - reset the orphan accounting to what follows.
    if (Number.isFinite(t)) lastRealTs = t;
    // ...and (re)compute whether the session is MID-TURN as of THIS entry.
    // Mid-turn = blocked-but-alive, NOT parked. Two verified shapes, both of
    // which append nothing further until they resolve (so they masquerade as a
    // park). Scoped to the LAST real entry so a stale unmatched tool_use earlier
    // in the window can't mask a later genuine park (code-review finding).
    //  - a `user` entry: the model owes a response - a human input or a
    //    tool_result it is about to process - INCLUDING a multi-minute extended-
    //    thinking span (verified: a silent think always follows a `user` entry
    //    and appends nothing until it resolves).
    //  - an `assistant` entry carrying a `tool_use` block: a tool is running now
    //    (its `tool_result` arrives later as a `user` entry; verified: a real
    //    180s gap where the last entry stayed the tool_use assistant).
    // A completed assistant turn (text, no tool_use) or a trailing `system`
    // entry = idle => park-eligible.
    if (o?.type === "user") {
      lastRealIsMidTurn = true;
    } else {
      const content = o?.message?.content;
      lastRealIsMidTurn =
        Array.isArray(content) && content.some((b: any) => b?.type === "tool_use");
    }
    enqueueTs = [];
    dequeueCount = 0;
  }
  // Oldest UNMATCHED enqueue: FIFO-skip dequeueCount matched enqueues.
  const oldestOrphan =
    enqueueTs.length > dequeueCount ? enqueueTs[dequeueCount] : null;
  return {
    lastRealActivityTs: lastRealTs,
    oldestOrphanEnqueueTs: oldestOrphan,
    lastRealIsMidTurn,
  };
}

/**
 * Decorate the channel-content body — but only when the decoration is
 * load-bearing.
 *
 * Decoration history:
 * - 0.30.2: wrapped every event with a markdown header + blockquote
 *   (`**PA** (id8) · event_type:` + `> ` per line). Empirically markdown
 *   does NOT render in Claude Code's channel content area - the asterisks
 *   and `> ` arrived as literal characters, AND the terminal pane collapses
 *   multi-line content to a one-line preview anyway. Net result: 36+ chars
 *   of header noise per event with zero rendered benefit.
 * - 0.30.5: drop decoration entirely for unaddressed events (peer chatter,
 *   observer traffic). The CC terminal prefix `← core:` plus the channel
 *   envelope's `from_id8` attribute already convey "this is from session X
 *   on the orchestrator channel" - re-adding a `[SA-<id8>]` prefix to the
 *   content is pure noise. Keep a compact `[sender] @target | ` prefix
 *   ONLY when the event is actually addressed (pa_addressed=true OR
 *   addr.targets non-empty); the receiver needs to know they're being
 *   directed at vs. just observing.
 *
 * Applied only to user_input / assistant_text / tool_use / summary events.
 * Session join/depart and override events emit hand-crafted short labels
 * and skip this wrapper.
 */
function decorateChannelContent(
  content: string,
  sender: SessionEntry,
  eventType: string,
  addrTargets: string[],
  paAddressed: boolean,
  sessions: SessionEntry[],
): string {
  // No addressing → pass content through raw, save the tokens.
  if (!paAddressed && addrTargets.length === 0) {
    return content;
  }

  const senderLabel = sender.role === "prime" ? "PA" : `SA-${sender.id8}`;
  const evtSuffix = eventType === "assistant_text" ? "" : `·${eventType}`;

  // Resolve target session_ids to display labels.
  let targetLabels: string[];
  if (paAddressed) {
    const pa = sessions.find((s) => s.role === "prime");
    targetLabels = [pa ? `@PA-${pa.id8}` : `@PA`];
  } else {
    targetLabels = addrTargets.map((sid) => {
      const s = sessions.find((x) => x.session_id === sid);
      if (!s) return `@${sid.slice(0, 8)}`;
      return s.role === "prime" ? `@PA-${s.id8}` : `@SA-${s.id8}`;
    });
  }

  return `[${senderLabel}${evtSuffix}] ${targetLabels.join(",")} | ${content}`;
}

/**
 * Optional dependency injection for the AgentChannel - lets the channel
 * filewatcher route permission verdicts back to the SA's permission_relay
 * when they arrive on the system_events bus. PA's MCP does NOT instantiate
 * a relay (PA doesn't receive permission_requests from CC) so this is
 * conditionally injected by server.ts.
 */
export interface PermissionRelayLike {
  /** Resolve a pending request - called when a permission_verdict event
   *  arrives addressed to this session. */
  resolveVerdict(
    request_id: string,
    input: { verdict: "allow" | "deny" | "defer_to_human"; pa_session: string; pa_reason?: string },
  ): void;
}

export class AgentChannel {
  private timer: ReturnType<typeof setInterval> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private knownSessions = new Map<string, SessionEntry>();
  /** DEFENSE-C (WI 8522c487): per-peer consecutive stale-observation tick
   *  count. A known peer absent from the fresh roster accrues misses; its
   *  departure is announced (and its row reaped) only at DEPART_GRACE_TICKS,
   *  and a reappearance before then clears it - suppressing depart<->rejoin
   *  flaps. Observer-side only; the flapping victim never runs this for itself. */
  private pendingMisses = new Map<string, number>();
  /** The fresh roster (self + heartbeat-fresh peers) computed by the last
   *  detectSessionChanges; consumed by tick() for sender/addressing resolution.
   *  Distinct from knownSessions, which now also holds peers being held through
   *  the departure grace. */
  private currentRoster = new Map<string, SessionEntry>();
  /** Egress-death detection (WI 0f9dcd95): per-absent-peer transcript byte-size
   *  captured the first tick it left the fresh roster. Growth beyond this while
   *  its heartbeat stays down => alive-but-unreachable (egress-dead), not gone. */
  private sizeAtStale = new Map<string, number>();
  /** Peers we've already emitted an egress_suspect for (emit once per episode). */
  private egressEmitted = new Set<string>();
  /** Ingress-death detection (WI 19294811): present peers we've already emitted
   *  an ingress_suspect for (emit once per parked episode; cleared when the peer
   *  drains its queue / produces a real turn, or departs). */
  private ingressEmitted = new Set<string>();
  /** Wall-clock ms of the last ingress scan; throttles the tail reads to
   *  INGRESS_CHECK_INTERVAL_MS (the scan is heavier than the egress statSync). */
  private lastIngressCheckAt = 0;
  /** Last `system_events.id` we've processed (auto-increment id in
   *  agent_channel.db's system_events table, 0.30.36+; pre-0.30.36 this
   *  was a byte offset into system_events.jsonl). In-memory only - reset
   *  to 0 on MCP restart, so each fresh process replays the full event
   *  history once before advancing. */
  private systemEventsLastSeenId = 0;
  /** Consecutive heartbeat-write failures. Reset on success. Used to
   *  escalate stderr log level + suppress repetitive warnings. */
  private heartbeatFailures = 0;

  constructor(
    private projectStateDir: string, // <project>/.orchestrator-state/agent-channel/
    private projectsHashDir: string, // ~/.claude/projects/<hash>/
    private selfSession: SessionEntry, // this instance's own session
    private emit: EmitFn,
    /** Optional. SA's MCP injects when receiving permission_request notifications
     *  from CC; PA's MCP leaves it undefined. */
    private permissionRelay?: PermissionRelayLike,
  ) {}

  start(): void {
    // 0.30.32 (ghost-session fix): prefer prior name from sessions.json when
    // selfSession.name was defaulted to "auto-<id8>" by the MCP-restart-
    // without-launcher-env path. This preserves human-readable names like
    // "SA-fe-data-contract" across `/mcp` reloads instead of clobbering them.
    const priorEntry = readSessions(this.projectStateDir).find(
      (s) => s.session_id === this.selfSession.session_id,
    );
    const isAutoName = this.selfSession.name === `auto-${this.selfSession.id8}`;
    if (
      priorEntry &&
      priorEntry.name &&
      priorEntry.name !== this.selfSession.name &&
      !priorEntry.name.startsWith("auto-") &&
      isAutoName
    ) {
      process.stderr.write(
        `agent-channel: preserved prior name "${priorEntry.name}" ` +
          `over default "${this.selfSession.name}" (MCP restart without ` +
          `ORCHESTRATOR_AGENT_NAME env)\n`,
      );
      this.selfSession = { ...this.selfSession, name: priorEntry.name };
    }

    // 0.30.32 (ghost-session fix): if we were absent from sessions.json on
    // startup, log loudly - it means a prior MCP heartbeat lapsed and we were
    // reaped, OR something cleared sessions.json. This is the signal to look
    // for in post-incident analysis of ghost-session reports.
    if (!priorEntry) {
      process.stderr.write(
        `agent-channel: self not in sessions.json on start ` +
          `(session_id=${this.selfSession.session_id}, ` +
          `name=${this.selfSession.name}). Likely prior MCP restart after ` +
          `reaper pruned us, or fresh install. Re-registering.\n`,
      );
    }

    writeSession(this.projectStateDir, {
      ...this.selfSession,
      last_heartbeat_at: new Date().toISOString(),
    });
    this.knownSessions = new Map(
      readSessions(this.projectStateDir).map((s) => [s.session_id, s]),
    );
    this.tick();
    this.timer = setInterval(() => this.tick(), POLL_INTERVAL_MS);
    this.heartbeatTimer = setInterval(
      () => this.heartbeat(),
      HEARTBEAT_INTERVAL_MS,
    );
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    removeSession(this.projectStateDir, this.selfSession.session_id);
  }

  /**
   * Write a heartbeat to sessions.json with the current timestamp. The
   * write is the only thing standing between this session and the
   * 90s-stale reaper, so it MUST survive transient I/O failures.
   *
   * 0.30.32 (ghost-session fix): wrapped in try/catch with stderr
   * logging. Prior behavior let exceptions propagate from writeSession's
   * atomicWrite (writeFileSync + renameSync) directly into the
   * setInterval callback. In Bun + Node, an uncaught exception in a
   * setInterval callback silently halts the interval - meaning a single
   * transient Windows file-lock during the atomic rename (OneDrive
   * sync, antivirus, EBUSY race) would permanently kill heartbeats for
   * the rest of the session's life. The session then gets reaped after
   * 90s, becomes a "ghost" - alive in claude.exe, invisible to
   * agent-channel coordination. See open_thread 6fb3b978 for the full
   * incident report (2026-05-12, SA-95e6890e).
   *
   * Recovery: writeSession already re-adds an absent self entry, so
   * the next successful heartbeat after a transient failure transparently
   * re-registers us. The atomicWrite retry in agent_channel_state.ts
   * further reduces the probability of a write failure escaping this
   * try/catch in the first place.
   */
  private heartbeat(): void {
    try {
      const updated = {
        ...this.selfSession,
        last_heartbeat_at: new Date().toISOString(),
      };
      writeSession(this.projectStateDir, updated);
      if (this.heartbeatFailures > 0) {
        process.stderr.write(
          `agent-channel: heartbeat recovered after ` +
            `${this.heartbeatFailures} consecutive failure(s)\n`,
        );
        this.heartbeatFailures = 0;
      }
    } catch (err) {
      this.heartbeatFailures += 1;
      // Log at increasing escalation. Suppress beyond 10 to avoid spam if
      // the failure is persistent (e.g., disk full, perms permanently
      // broken). Operator should already be paged at that point.
      if (this.heartbeatFailures <= 3 || this.heartbeatFailures === 10) {
        process.stderr.write(
          `agent-channel: heartbeat write failed ` +
            `(failure #${this.heartbeatFailures}, ` +
            `session=${this.selfSession.id8}): ${err}\n`,
        );
      }
    }
  }

  private detectSessionChanges(): void {
    const now = Date.now();

    // Fresh roster. Self is ALWAYS kept (0.30.32 - never self-reap: our tick is
    // literally executing, so a stale-looking self entry only means our own
    // heartbeat write is momentarily behind and will recover; self-reaping would
    // let a peer see us departed). Other sessions are kept only while
    // heartbeat-fresh (<= 90s). This is both the routing roster (sender +
    // addressing resolution, consumed by tick()) and the liveness signal for
    // join/depart derivation below.
    const current = new Map<string, SessionEntry>();
    // Enforce the self-always-present invariant unconditionally, BEFORE reading
    // the DB. Routing (sender/addressing resolution) consumes currentRoster, and
    // self must resolve even when self's own row is transiently ABSENT - e.g. an
    // old-version peer reaped self after a >90s stall (mixed-version fleet)
    // before self's next heartbeat re-registers it. Without this, a recovering
    // SA silently drops @SA-<selfid8> and @all traffic. The DB row (if present)
    // overwrites this seed below with the fresher name/current_task.
    current.set(this.selfSession.session_id, this.selfSession);
    for (const s of readSessions(this.projectStateDir)) {
      if (s.session_id === this.selfSession.session_id) {
        current.set(s.session_id, s);
        continue;
      }
      const last = new Date(s.last_heartbeat_at).getTime();
      if (Number.isFinite(last) && now - last <= STALE_THRESHOLD_MS) {
        current.set(s.session_id, s);
      }
    }
    this.currentRoster = current;

    // Joined: a peer present now and not already known. Peers held through the
    // departure grace stay in knownSessions, so a reappearance is NOT a new
    // join. Adopt genuinely-new peers into known.
    for (const [sid, entry] of current) {
      if (sid === this.selfSession.session_id) continue;
      if (!this.knownSessions.has(sid)) {
        this.emit({
          content: `[session_joined] ${entry.name} (${entry.id8}, role=${entry.role})`,
          meta: {
            from_session: entry.session_id,
            from_id8: entry.id8,
            from_role: entry.role,
            from_name: entry.name,
            from_task: entry.current_task ?? null,
            event_type: "session_joined",
            ts: new Date().toISOString(),
          },
        });
        this.knownSessions.set(sid, entry);
      }
      // Present again -> clear any accrued miss + egress-tracking. Combined with
      // "held in known" above, a peer that flapped (left then returned within
      // the grace) OR reconnected produces NEITHER a session_departed NOR a
      // re-join, and drops any egress-suspect state (it is reachable again).
      this.pendingMisses.delete(sid);
      this.sizeAtStale.delete(sid);
      this.egressEmitted.delete(sid);
    }

    // Departed WITH hysteresis (DEFENSE-C, WI 8522c487) - OBSERVER-SIDE ONLY.
    // The flapping victim is blocked (starved event loop) and cannot defend
    // itself; self is never in this loop (self is always in `current`). A known
    // peer absent from the fresh roster accrues consecutive-miss ticks; only at
    // DEPART_GRACE_TICKS is it announced departed and its row reaped (the reap
    // is thus deferred from the old immediate-90s reap). The grace is uniform
    // for both the stale-but-present and row-absent cases, which keeps it safe
    // in a mixed-version fleet where an older peer may still immediately reap a
    // merely-stalled victim's row.
    for (const [sid, entry] of this.knownSessions) {
      if (sid === this.selfSession.session_id) continue;
      if (current.has(sid)) continue;
      // Absent -> not an ingress candidate (ingress is present-only). Clear any
      // ingress dedup flag now, so if this peer returns PRESENT-and-still-parked
      // its next episode re-emits. Done here (absent peers only) rather than in
      // the present-again branch, which runs every tick and would race the
      // throttled ingress scan into re-emitting each interval.
      this.ingressEmitted.delete(sid);
      // Egress-death detection (WI 0f9dcd95). Capture the peer's transcript size
      // the FIRST tick it goes absent; growth beyond that while its heartbeat
      // stays down = alive-but-unreachable (egress-dead), NOT gone.
      const size = this.peerTranscriptSize(sid);
      if (!this.sizeAtStale.has(sid) && size != null) {
        this.sizeAtStale.set(sid, size);
      }
      const baseSize = this.sizeAtStale.get(sid);
      const grewSinceStale =
        size != null && baseSize != null && size > baseSize;
      const misses = (this.pendingMisses.get(sid) ?? 0) + 1;
      const verdict = classifyAbsence({
        grewSinceStale,
        missCount: misses,
        graceTicks: DEPART_GRACE_TICKS,
      });
      if (verdict === "egress_suspect") {
        // Alive but unreachable - HOLD (never reap), and alert PA/warden ONCE.
        // The victim cannot self-detect (its own hook is an MCP call, likely
        // also dead), so a peer-emitted alert is the only surface for a /mcp
        // reconnect (anti_pattern 6ef0c61f). NOT a hard session_departed - a
        // false-depart is exactly what this fix removes.
        //
        // ACCEPTED FALSE-POSITIVE (review finding #2, 0.30.66): a RECOVERABLE
        // MCP wedge (transient stall >90s where the process kept taking turns,
        // then the MCP self-heals) also grows-while-stale and trips this once.
        // Deliberately tolerated: this is ADVISORY and NEVER reaps, and the
        // present-branch above clears egress state the moment the peer returns
        // to the fresh roster - so a self-heal produces exactly one stale
        // advisory then silence, no departed, no re-join. A one-off "check on
        // X" nudge for a session that recovers on its own is a benign cost;
        // suppressing it would risk muting a real egress-death. The self-heal
        // path is covered by tests (agent_channel_flap egress self-heal case).
        if (!this.egressEmitted.has(sid)) {
          this.emit({
            content:
              `[egress_suspect] ${entry.name} (${entry.id8}) - heartbeat down ` +
              `but its transcript is still growing = ALIVE but unreachable ` +
              `(MCP egress dropped). It cannot see this; it needs a /mcp reconnect.`,
            meta: {
              from_session: entry.session_id,
              from_id8: entry.id8,
              from_role: entry.role,
              from_name: entry.name,
              from_task: entry.current_task ?? null,
              event_type: "egress_suspect",
              ts: new Date().toISOString(),
            },
          });
          this.egressEmitted.add(sid);
        }
        // Held: keep in knownSessions, do NOT reap, do NOT accrue toward depart.
      } else if (verdict === "departed") {
        this.emit({
          content: `[session_departed] ${entry.name} (${entry.id8})`,
          meta: {
            from_session: entry.session_id,
            from_id8: entry.id8,
            from_role: entry.role,
            from_name: entry.name,
            from_task: entry.current_task ?? null,
            event_type: "session_departed",
            ts: new Date().toISOString(),
          },
        });
        this.knownSessions.delete(sid);
        this.pendingMisses.delete(sid);
        this.sizeAtStale.delete(sid);
        this.egressEmitted.delete(sid);
        this.ingressEmitted.delete(sid);
        removeSession(this.projectStateDir, sid);
      } else {
        this.pendingMisses.set(sid, misses);
      }
    }
  }

  /** Byte-size of a peer's transcript (`<projectsHashDir>/<sid>.jsonl`), or null
   *  if absent/unreadable. Egress-death check (WI 0f9dcd95): growth = alive.
   *  Cheap statSync, only for peers already in the pending-departed path. */
  private peerTranscriptSize(sid: string): number | null {
    try {
      return statSync(join(this.projectsHashDir, `${sid}.jsonl`)).size;
    } catch {
      return null;
    }
  }

  /** Read the last INGRESS_TAIL_BYTES of a session's transcript, or null if
   *  absent/unreadable. Byte-positional read from (size - window); a partial
   *  leading line is tolerated by parseIngressTail's JSON.parse skip. */
  private readTranscriptTail(sid: string): string | null {
    let fd: number | undefined;
    try {
      const path = join(this.projectsHashDir, `${sid}.jsonl`);
      const size = statSync(path).size;
      const start = Math.max(0, size - INGRESS_TAIL_BYTES);
      const length = size - start;
      if (length <= 0) return "";
      fd = openSync(path, "r");
      const chunk = Buffer.allocUnsafe(length);
      const n = readSync(fd, chunk, 0, length, start);
      return chunk.subarray(0, n).toString("utf8");
    } catch {
      return null;
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }

  /** Ingress-death detection (WI 19294811), PEER-SIDE. For each PRESENT peer
   *  (heartbeat fresh, so it's in `current`), scan its transcript tail for a
   *  channel delivery enqueued-but-never-dequeued since the peer's last real
   *  activity; if the oldest such delivery has been parked past
   *  INGRESS_STALE_THRESHOLD_MS, its event loop is parked (open menu/prompt, or
   *  other cause). Emit ingress_suspect ONCE per episode; advisory, never reaps.
   *  Self is skipped: a self-emit rides the parked local harness transport and
   *  can never escape its own park, so only a healthy peer can raise the alarm. */
  private detectIngress(current: Map<string, SessionEntry>, now: number): void {
    for (const [sid, entry] of current) {
      if (sid === this.selfSession.session_id) continue; // peer-side only
      const tail = this.readTranscriptTail(sid);
      // Transient read failure (file lock / I/O blip): skip WITHOUT clearing the
      // dedup flag, so a momentary blip can't re-arm and double-emit the same
      // episode. Genuine departure clears the flag in the departed loop.
      if (tail == null) continue;
      const { oldestOrphanEnqueueTs, lastRealIsMidTurn } = parseIngressTail(tail);
      const verdict = classifyIngress({
        heartbeatFresh: true, // membership in `current` == heartbeat fresh
        oldestOrphanEnqueueTs,
        lastRealIsMidTurn,
        now,
        thresholdMs: INGRESS_STALE_THRESHOLD_MS,
      });
      if (verdict === "ingress_suspect") {
        if (!this.ingressEmitted.has(sid)) {
          const mins = Math.round(INGRESS_STALE_THRESHOLD_MS / 60_000);
          this.emit({
            content:
              `[ingress_suspect] ${entry.name} (${entry.id8}) - heartbeat fresh ` +
              `but a channel delivery has sat unprocessed for >${mins}min = the ` +
              `session loop is PARKED (an open menu/prompt is the confirmed cause; ` +
              `other causes possible). It cannot see this. Fix: check that terminal ` +
              `for an open menu/prompt - Enter/Escape, then /mcp if still dead.`,
            meta: {
              from_session: entry.session_id,
              from_id8: entry.id8,
              from_role: entry.role,
              from_name: entry.name,
              from_task: entry.current_task ?? null,
              event_type: "ingress_suspect",
              ts: new Date().toISOString(),
            },
          });
          this.ingressEmitted.add(sid);
        }
      } else {
        // healthy (queue drained / no orphan) or pending (too recent) -> not
        // parked; clear so a future parked episode re-arms and re-emits.
        this.ingressEmitted.delete(sid);
      }
    }
  }

  private listJsonlFiles(): string[] {
    if (!existsSync(this.projectsHashDir)) return [];
    return readdirSync(this.projectsHashDir)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => join(this.projectsHashDir, f));
  }

  private tick(): void {
    try {
      this.detectSessionChanges();
      // Ingress-death scan (WI 19294811), throttled to INGRESS_CHECK_INTERVAL_MS
      // since its tail reads are heavier than the per-tick routing. Runs on the
      // fresh roster detectSessionChanges just computed.
      const ingressNow = Date.now();
      if (ingressNow - this.lastIngressCheckAt >= INGRESS_CHECK_INTERVAL_MS) {
        this.lastIngressCheckAt = ingressNow;
        this.detectIngress(this.currentRoster, ingressNow);
      }
      // Route on the FRESH roster (self + heartbeat-fresh peers), NOT
      // knownSessions - which now also holds peers held through the departure
      // grace (DEFENSE-C). detectSessionChanges refreshes currentRoster first.
      const sessions = Array.from(this.currentRoster.values());
      const overrideState = readOverrideState(this.projectStateDir);

      // Read offsets ONCE at tick start; mutate in memory; write ONCE at end.
      // Avoids the N-reads-N-writes-per-tick storm when many JSONLs are
      // tracked. Only one disk write per instance per tick.
      const offsets = readOffsets(this.projectStateDir, this.selfSession.id8);
      let mutated = false;

      for (const file of this.listJsonlFiles()) {
        if (this.processFile(file, sessions, overrideState, offsets)) {
          mutated = true;
        }
      }

      if (mutated) {
        writeAllOffsets(this.projectStateDir, this.selfSession.id8, offsets);
      }

      // 0.30.16+: also process the system_events.jsonl bus for cross-MCP
      // events (permission_request_pending, permission_verdict).
      this.processSystemEvents();
    } catch (err) {
      process.stderr.write(`agent-channel tick error: ${err}\n`);
    }
  }

  /**
   * Read new entries on the system_events.jsonl bus and emit/route based
   * on the event_type. Only events targeted at THIS session (to_session
   * === selfSession.session_id) trigger local action.
   *
   * Currently handles two event_types:
   *   - `permission_request_pending`: emit a channel notification to the
   *     local session so PA (or whichever role this MCP serves) sees the
   *     inbound permission request inline and can call respond_to_permission.
   *   - `permission_verdict`: if a permissionRelay is injected (i.e. this
   *     is the SA's MCP that emitted the original request), call
   *     resolveVerdict to unblock the pending Promise.
   */
  private processSystemEvents(): void {
    const result = readNewSystemEvents(this.projectStateDir, this.systemEventsLastSeenId);
    this.systemEventsLastSeenId = result.newSeenId;

    for (const ev of result.events) {
      if (ev.to_session !== this.selfSession.session_id) continue;
      // Self-emitted events: skip (we don't echo our own events).
      if (ev.from_session === this.selfSession.session_id) continue;

      switch (ev.event_type) {
        case "permission_request_pending": {
          const request_id = String(ev.request_id ?? "");
          const tool_name = String(ev.tool_name ?? "");
          const description = String(ev.description ?? "");
          const input_preview = String(ev.input_preview ?? "");
          if (!request_id) break;
          this.emit({
            content:
              `[permission_request_pending] request_id=${request_id} ` +
              `tool=${tool_name}\n` +
              `description: ${description}\n` +
              `input_preview: ${input_preview}\n` +
              `from_session: ${ev.from_session}\n` +
              `\n` +
              `Decide via respond_to_permission({request_id, verdict, reason?}). ` +
              `Verdict: allow | deny | defer_to_human. ` +
              `Non-allow verdicts require a reason.`,
            meta: {
              from_session: ev.from_session,
              from_id8: ev.from_session.slice(0, 8),
              from_role: "subordinate",
              from_name: `<system_event>`,
              from_task: null,
              event_type: "permission_request_pending",
              ts: typeof ev.ts === "string" ? ev.ts : new Date().toISOString(),
              pa_addressed: true,
              addressed_to: [this.selfSession.session_id],
            },
          });
          break;
        }
        case "permission_verdict": {
          if (!this.permissionRelay) break;
          const request_id = String(ev.request_id ?? "");
          const verdict = ev.verdict as "allow" | "deny" | "defer_to_human";
          const pa_session = String(ev.pa_session ?? ev.from_session);
          const pa_reason = typeof ev.pa_reason === "string" ? ev.pa_reason : undefined;
          if (!request_id) break;
          if (verdict !== "allow" && verdict !== "deny" && verdict !== "defer_to_human") break;
          this.permissionRelay.resolveVerdict(request_id, { verdict, pa_session, pa_reason });
          break;
        }
        case "post_compact_recovery": {
          // e4774e4b: a peer SA just compacted; its post-compact hook
          // deterministically solicited a backstop addressed to us (PA). The
          // to_session/from_session guards above already ensure ONLY PA's
          // instance (never the compacted SA itself) reaches here.
          //
          // Freshness guard: system_events has no auto-reaping and
          // systemEventsLastSeenId resets to 0 on MCP restart (full replay),
          // so a PA restart would otherwise re-surface every historical
          // recovery ping at once. A backstop is only actionable while fresh
          // (the compacted session has long moved on otherwise), so drop
          // anything older than the window. This is advisory, not a relay -
          // a missed stale one costs nothing.
          const tsMs = new Date(String(ev.ts ?? "")).getTime();
          const RECOVERY_FRESH_MS = 15 * 60_000;
          if (!Number.isFinite(tsMs) || Date.now() - tsMs > RECOVERY_FRESH_MS) {
            break;
          }
          const fromId8 = ev.from_session.slice(0, 8);
          const task = String(ev.task ?? "").trim();
          this.emit({
            content:
              `[post-compact recovery] SA-${fromId8} just compacted` +
              (task ? ` (task: ${task})` : "") +
              `. The lossy compaction summary may have dropped load-bearing ` +
              `context this session was carrying. If you (PA) or a non-` +
              `compacted peer hold context its checkpoint/notes likely don't ` +
              `capture, surface it to @SA-${fromId8} now. Non-blocking, ` +
              `advisory - a targeted gap-check, not a full context resend.`,
            meta: {
              from_session: ev.from_session,
              from_id8: fromId8,
              from_role: "subordinate",
              from_name: `<post_compact_recovery>`,
              from_task: task || null,
              event_type: "post_compact_recovery",
              ts:
                typeof ev.ts === "string"
                  ? ev.ts
                  : new Date().toISOString(),
              pa_addressed: true,
              addressed_to: [this.selfSession.session_id],
            },
          });
          break;
        }
        case "pa_compact_recovery": {
          // WI 2ad3240e: the symmetric, reversed-direction counterpart of
          // post_compact_recovery. PA just compacted and its post-compact hook
          // deterministically advised each active SA (us). The
          // to_session/from_session guards above already ensure ONLY the
          // addressed SA's instance (never PA itself) reaches here.
          //
          // Same freshness guard rationale as post_compact_recovery: no
          // auto-reaping + systemEventsLastSeenId resets to 0 on MCP restart
          // (full replay), so drop anything older than the window to avoid
          // re-surfacing every historical ping after an SA restart. Advisory,
          // not a relay - a missed stale one costs nothing.
          const tsMs = new Date(String(ev.ts ?? "")).getTime();
          const RECOVERY_FRESH_MS = 15 * 60_000;
          if (!Number.isFinite(tsMs) || Date.now() - tsMs > RECOVERY_FRESH_MS) {
            break;
          }
          const fromId8 = ev.from_session.slice(0, 8);
          const task = String(ev.task ?? "").trim();
          this.emit({
            content:
              `[PA compacted] The PrimeAgent (PA-${fromId8}) just compacted its ` +
              `context` +
              (task ? ` (its last task: ${task})` : "") +
              `. Its summary is lossy and likely dropped load-bearing context ` +
              `it was holding about the fleet. Surface what PA will need to ` +
              `re-establish: what you are working on, your recent completions ` +
              `WITH IDs, and - critically - flag anything already DONE or any ` +
              `directive PA already sent you, so it does not re-request or ` +
              `re-drive it. The final minutes before PA compacted are the ` +
              `highest-loss zone (directives it sent you then may be missing ` +
              `from its summary; items it thinks are pending may already be ` +
              `done). Reply to PA now; non-blocking, advisory.`,
            meta: {
              from_session: ev.from_session,
              from_id8: fromId8,
              from_role: "prime",
              from_name: `<pa_compact_recovery>`,
              from_task: task || null,
              event_type: "pa_compact_recovery",
              ts:
                typeof ev.ts === "string"
                  ? ev.ts
                  : new Date().toISOString(),
              addressed_to: [this.selfSession.session_id],
            },
          });
          break;
        }
        default:
          // Unknown event_type - ignore. Forward-compat: future event
          // types added to system_events should not crash old watchers.
          break;
      }
    }
  }

  /**
   * Process new content in one JSONL file. Mutates `offsets` in place.
   * Returns true if the offset for this file changed (caller will batch-write).
   */
  private processFile(
    file: string,
    sessions: SessionEntry[],
    overrideState: ReturnType<typeof readOverrideState>,
    offsets: Record<string, number>,
  ): boolean {
    let stat;
    try {
      stat = statSync(file);
    } catch {
      return false;
    }
    // ROOT-B (WI 8522c487): first sight of this transcript by this receiver.
    // A newly-joined / restarted session must NOT replay the fleet's pre-join
    // backlog. Reading gigabytes of history synchronously per tick starved the
    // 30s heartbeat timer (one event loop shared with this tick) past the 90s
    // stale threshold -> peers reaped a live session -> false session_departed
    // then session_joined flap. It also re-injects historical @all traffic to
    // the joiner. Init to current EOF and skip the backlog. `undefined` (no
    // offset row) is the genuine first-sight signal, distinct from a real 0.
    if (offsets[file] === undefined) {
      offsets[file] = stat.size;
      return true; // persist EOF offset; nothing to process this tick
    }
    const lastOffset = offsets[file];
    if (stat.size === lastOffset) return false;
    if (stat.size < lastOffset) {
      // File truncated/rotated - reset offset
      offsets[file] = 0;
      return true;
    }

    // ROOT-A (WI 8522c487): read ONLY the new bytes [lastOffset, size) with a
    // positional read, instead of readFileSync-ing the whole (often 100MB+)
    // transcript every tick. The prior full-file read of every actively-growing
    // peer transcript per 1.5s tick was ~N^2 x file-size synchronous I/O that
    // blocked the single bun event loop and starved the co-resident 30s
    // heartbeat timer past the 90s stale threshold -> a peer reaped a live
    // session -> false session_departed then session_joined flap under load.
    //
    // The read stays BYTE-positional on purpose (preserves the prior fix's
    // rationale): lastOffset is a byte count (Buffer.byteLength advances it
    // below), so reading at that byte offset - and byte-based line accounting -
    // avoids the UTF-8 corruption hazard a string-index slice (String.slice at
    // a byte offset) would cause for any multibyte char (emoji, non-ASCII user
    // text) straddling the offset. lastOffset always lands just past a '\n' (a
    // single byte, never mid-codepoint), so the read never starts mid-character;
    // a partial trailing line is carried to the next tick by the consumed-
    // accounting below, and decoding a buffer that ends mid-codepoint only
    // affects that unprocessed trailing line.
    let buf: string;
    let fd: number | undefined;
    try {
      fd = openSync(file, "r");
      const length = stat.size - lastOffset;
      const chunk = Buffer.allocUnsafe(length);
      const bytesRead = readSync(fd, chunk, 0, length, lastOffset);
      buf = chunk.subarray(0, bytesRead).toString("utf8");
    } catch {
      return false;
    } finally {
      if (fd !== undefined) closeSync(fd);
    }

    const lines = buf.split("\n");
    let consumed = 0;
    for (let i = 0; i < lines.length - 1; i++) {
      consumed += Buffer.byteLength(lines[i], "utf8") + 1; // +1 for \n
      const line = lines[i].trim();
      if (!line) continue;

      let raw: any;
      try {
        raw = JSON.parse(line);
      } catch {
        continue;
      }

      // Sender derived from JSONL filename: <session_id>.jsonl
      const senderId = file
        .split(/[\\/]/)
        .pop()!
        .replace(/\.jsonl$/, "");
      const sender = sessions.find((s) => s.session_id === senderId);
      if (!sender) continue;

      this.processEvent(raw, sender, sessions, overrideState);
    }
    offsets[file] = lastOffset + consumed;
    return consumed > 0;
  }

  private processEvent(
    raw: any,
    sender: SessionEntry,
    sessions: SessionEntry[],
    overrideState: ReturnType<typeof readOverrideState>,
  ): void {
    const ev = filterEvent(raw);
    if (!ev) return;

    // Self-event suppression: an instance never re-fires its own session's events
    if (sender.session_id === this.selfSession.session_id) return;

    const fullAddr = parseAddressing(ev.content, sender, sessions);

    // Per-paragraph routing (0.30.22, work_item b4c37849):
    //
    // The sender's content can mix audiences within one message - e.g. PA
    // writing a status update to the user that also contains an `@SA-<id8>`
    // directive paragraph. Whole-message routing would deliver the entire
    // mixed message (including the user-private prose) to the addressed SA.
    //
    // We split on blank-line paragraphs and parse addressing per paragraph.
    // PA still observes the full content (PA is the project observer by
    // design). SAs receive only the paragraphs whose addressing includes
    // them - everything else is filtered out before emit.
    let emitContent: string;
    let emitTargets: string[];
    if (this.selfSession.role === "prime") {
      // PA observes everything unchanged.
      emitContent = ev.content;
      emitTargets = fullAddr.targets;
    } else {
      const myId = this.selfSession.session_id;
      if (!fullAddr.targets.includes(myId)) return;
      const filtered = filterParagraphsForReceiver(
        ev.content,
        myId,
        sender,
        sessions,
      );
      if (!filtered) return;
      emitContent = filtered;
      emitTargets = [myId];
    }

    const isPaused = !!overrideState.sa_pauses[sender.session_id];
    const isGlobalPaused = overrideState.pa_global_pause.active;

    this.emit({
      content: decorateChannelContent(
        emitContent,
        sender,
        ev.event_type,
        emitTargets,
        fullAddr.pa_addressed,
        sessions,
      ),
      meta: {
        from_session: sender.session_id,
        from_id8: sender.id8,
        from_role: sender.role,
        from_name: sender.name,
        from_task: sender.current_task ?? null,
        event_type: ev.event_type,
        tool_name: ev.tool_name,
        pa_addressed: fullAddr.pa_addressed,
        addressed_to: emitTargets.length > 0 ? emitTargets : undefined,
        pa_global_pause: isGlobalPaused || undefined,
        sa_paused: isPaused || undefined,
        ts: new Date().toISOString(),
      },
    });
  }
}

/** A routing unit: a prose paragraph, an atomic fenced code block, or an
 *  explicit-envelope block. */
interface ContentUnit {
  text: string;
  /** Fenced code block - literal content: never split internally, never
   *  parsed for addressing (an `@SA-<id8>` inside it is just text). */
  isCode: boolean;
  /** Explicit-envelope unit (WI eabc89b6 - the Discord-model fix): the raw
   *  address spec from the `@@@ <addr>` opener (e.g. "@SA-19703445",
   *  "@SA-a,@SA-b", "@PA", "@all"). When set, `text` is the verbatim inner
   *  payload (markers stripped) and routing is EXPLICIT to those targets
   *  only - the body is never address-parsed (an `@`-mention inside is
   *  literal) and the envelope is cascade-transparent. This is what makes
   *  "format the message however you want, it arrives whole" safe. */
  envelopeAddr?: string;
}

/** Opening/closing fence line: 3+ backticks or 3+ tildes at line start
 *  (after optional indentation), optionally followed by an info string. */
const FENCE_RE = /^[ \t]*(`{3,}|~{3,})/;

/**
 * Explicit-envelope delimiters (WI eabc89b6 - the Discord-model fix).
 *
 * The Anthropic Discord plugin never infers audience from message body: a
 * `reply` has an explicit `chat_id` and the whole message goes there intact.
 * The orchestrator can't take a destination parameter (comms are pure
 * terminal text - the send tool was removed in 0.29.0), so the envelope makes
 * the destination explicit and structural WITHIN the text:
 *
 *     @@@ @SA-19703445
 *     ...anything: paragraphs, markdown, blank lines, ``` code fences,
 *        literal @-mentions - all verbatim, none of it routed...
 *     @@@
 *
 * OPEN = `@@@` + whitespace + an address spec (`@SA-<id8>` / `@SA-a,@SA-b` /
 * `@PA` / `@all`). CLOSE = a bare `@@@` line. Open and close are disjoint
 * (open requires a trailing `@addr`; close must be bare) so they never
 * collide, and a bare-`@@@` only matters once an envelope is already open.
 */
const ENVELOPE_OPEN_RE = /^[ \t]*@@@[ \t]+(@\S.*?)[ \t]*$/;
const ENVELOPE_CLOSE_RE = /^[ \t]*@@@[ \t]*$/;

/**
 * Split content into ordered routing units. Prose runs are paragraph-split on
 * blank lines (`\n{2,}`), exactly as the legacy splitter did. Fenced code
 * blocks (``` or ~~~) are ATOMIC: their internal blank lines do not fragment
 * them, and their content is never parsed for addressing. An unclosed fence
 * swallows the remainder of the message as one code unit (routing-safe: an
 * `@SA-<id8>` in a dangling code block can't be mistaken for an address).
 *
 * On fence-free content this produces exactly `content.split(/\n{2,}/)`
 * (minus empty paragraphs), so the non-code common path is unchanged.
 */
function splitContentUnits(content: string): ContentUnit[] {
  const lines = content.split("\n");
  const units: ContentUnit[] = [];
  let prose: string[] = [];
  let code: string[] = [];
  let inFence = false;
  let fenceChar = "";
  let fenceLen = 0; // opener run length; CommonMark closer must be >= this

  const flushProse = () => {
    if (prose.length === 0) return;
    for (const p of prose.join("\n").split(/\n{2,}/)) {
      if (p.trim().length > 0) units.push({ text: p, isCode: false });
    }
    prose = [];
  };

  // Explicit-envelope state (WI eabc89b6). Once `@@@ @addr` opens an
  // envelope, every line up to the bare `@@@` closer is verbatim payload:
  // atomic, never fence-parsed, never address-parsed, routed explicitly.
  let inEnvelope = false;
  let envelopeAddr = "";
  let envelope: string[] = [];

  for (const line of lines) {
    // An open envelope owns every line until the bare `@@@` closer. A fence
    // opener or @-mention inside it is literal payload - the envelope is
    // atomic and routing-explicit (this is what makes "format it however you
    // want, it arrives whole" safe).
    if (inEnvelope) {
      if (ENVELOPE_CLOSE_RE.test(line)) {
        units.push({ text: envelope.join("\n"), isCode: false, envelopeAddr });
        envelope = [];
        inEnvelope = false;
        envelopeAddr = "";
      } else {
        envelope.push(line);
      }
      continue;
    }

    const m = line.match(FENCE_RE);
    if (m) {
      const marker = m[1][0]; // "`" or "~"
      const runLen = m[1].length;
      if (!inFence) {
        flushProse();
        inFence = true;
        fenceChar = marker;
        fenceLen = runLen;
        code = [line];
        continue;
      }
      // CommonMark: the closing fence must use the same character AND be at
      // least as long as the opener. A SHORTER same-char run (or a different
      // char) is literal code content, NOT a close - otherwise a ``` inside a
      // ````` block would prematurely end it and leak the rest (incl. any
      // @SA-<id8>) into routing. This is the 7ff34714 code-block-atomicity
      // guarantee done correctly.
      if (marker === fenceChar && runLen >= fenceLen) {
        code.push(line);
        units.push({ text: code.join("\n"), isCode: true });
        code = [];
        inFence = false;
        fenceChar = "";
        fenceLen = 0;
        continue;
      }
      // A non-closing fence-like line inside an open fence is literal code.
      code.push(line);
      continue;
    }
    if (inFence) {
      code.push(line);
      continue;
    }

    // Not in a fence/envelope: an `@@@ @addr` line opens an explicit
    // envelope. Pending prose flushes first - the envelope is its own
    // atomic unit.
    const env = line.match(ENVELOPE_OPEN_RE);
    if (env) {
      flushProse();
      inEnvelope = true;
      envelopeAddr = env[1].trim();
      envelope = [];
      continue;
    }

    prose.push(line);
  }
  // Unclosed envelope: emit the remainder as one atomic envelope unit -
  // routing-safe over-containment to the explicit target (mirrors the
  // unclosed-fence guarantee; the tail never leaks to cascade/others).
  if (inEnvelope && envelope.length > 0) {
    units.push({ text: envelope.join("\n"), isCode: false, envelopeAddr });
  }
  // Unclosed fence: keep the remainder as one atomic (routing-inert) code unit.
  if (inFence && code.length > 0) {
    units.push({ text: code.join("\n"), isCode: true });
  }
  flushProse();
  return units;
}

/** True when the addressed paragraph is a colon-HEADER introducing
 *  continuation paragraphs (the 7ff34714 trap pattern: "@SA-x directive:").
 *
 *  The colon may be wrapped in trailing markdown emphasis/code/strike markers:
 *  PA's idiomatic directive header is BOLDED - "**Directive:**" - which ends
 *  in ":**". trimEnd() strips whitespace but NOT markdown, so a naive
 *  `.endsWith(":")` misreads every bolded header as a non-colon COMPLETE
 *  directive: the sticky cascade never opens and every continuation paragraph
 *  is silently dropped. This was the 2026-05-18 field-fail (wire-confirmed,
 *  PA 6a2cab38 -> FE-AGENT-01 19703445: receiver got the header line only;
 *  the same content re-sent single-newline delivered in full). The original
 *  7ff34714 fix only covered a bare trailing colon, never PA's actual idiom.
 *
 *  Strip a trailing run of markdown markers (`*` `_` `` ` `` `~`) then re-trim
 *  before the colon test, so "**...:**", "*...:*", "`...:`", "__...:__",
 *  "~~...:~~" all register as headers. This only WIDENS recognition: a
 *  paragraph with no logical trailing colon (e.g. "**done.**" -> "**done.")
 *  still resolves to non-colon, so a complete directive still opens NO cascade
 *  and the b4c37849 mixed-audience invariant is preserved (Test I locks this;
 *  Test H locks the field-fail). */
function isColonHeader(text: string): boolean {
  const stripped = text.trimEnd().replace(/[*_`~]+$/, "").trimEnd();
  return stripped.endsWith(":");
}

/**
 * Extract only the parts of a sender's message addressed to `receiverId`.
 * Returns null when nothing reaches this receiver (caller suppresses emit).
 *
 * 7ff34714 - colon-gated sticky cascade (design: decision note 88321142):
 * an addressed paragraph delivers to its targets AND, if it is a colon-header
 * ("...:"), opens a sticky cascade so subsequent UNADDRESSED continuation
 * paragraphs (and atomic code blocks) also deliver to that same audience -
 * until another addressed paragraph redefines the cascade. A non-colon
 * addressed paragraph is a COMPLETE directive and opens no cascade, so an
 * interleaved user-private paragraph is never leaked to the SA (preserves the
 * locked b4c37849 mixed-audience invariant). Fenced code blocks are atomic
 * and routing-inert (an `@SA-<id8>` inside one is literal, never an address).
 */
function filterParagraphsForReceiver(
  content: string,
  receiverId: string,
  sender: SessionEntry,
  sessions: SessionEntry[],
): string | null {
  const units = splitContentUnits(content);
  const kept: string[] = [];
  // The audience of the currently-open colon-header directive, or null when
  // no cascade is open.
  let cascade: Set<string> | null = null;

  for (const unit of units) {
    if (unit.envelopeAddr !== undefined) {
      // Explicit envelope (WI eabc89b6 - the Discord-model fix): route by
      // the opener's DECLARED address only. The body is never address-
      // parsed (an `@`-mention inside is literal) and the envelope is
      // cascade-transparent - it neither opens nor closes a colon-cascade,
      // so content around it routes exactly as if it weren't there. This is
      // the explicit, structural destination the Anthropic Discord plugin
      // has natively (its `reply` takes a chat_id); nothing is body-inferred.
      const env = parseAddressing(unit.envelopeAddr, sender, sessions);
      if (env.targets.includes(receiverId)) kept.push(unit.text);
      continue;
    }
    if (unit.isCode) {
      // Literal block: never addresses anyone. Rides an open cascade so a
      // code block inside a colon-headed directive reaches the SA intact.
      if (cascade && cascade.has(receiverId)) kept.push(unit.text);
      continue;
    }

    const addr = parseAddressing(unit.text, sender, sessions);
    if (addr.targets.length > 0) {
      if (addr.targets.includes(receiverId)) kept.push(unit.text);
      // Redefine the cascade: a colon-header opens one for THIS paragraph's
      // audience; a complete (non-colon) directive closes any open cascade.
      cascade = isColonHeader(unit.text) ? new Set(addr.targets) : null;
    } else if (addr.had_address_syntax) {
      // 7ff34714 general-class fix (WI 96798325): this paragraph IS an
      // addressing line but resolved to ZERO deliverable targets - the
      // sender self-addressing @PA as prime, an unresolved @SA-<id8>, or
      // @all with no peers. It is a fresh DIRECTIVE BOUNDARY, never an
      // unaddressed continuation, so it must CLOSE any open cascade rather
      // than RIDE it. Riding it leaked the paragraph into the cascaded SA
      // (the live-fail: a trailing "@PA reset-check" written by PA-prime
      // reaching an SA mid-cascade). Nothing is delivered here - targets is
      // empty so it does not include this receiver by construction.
      cascade = null;
    } else {
      // Genuinely unaddressed continuation (no addressing syntax at all):
      // delivers iff a cascade is open for us.
      if (cascade && cascade.has(receiverId)) kept.push(unit.text);
    }
  }

  return kept.length > 0 ? kept.join("\n\n") : null;
}
