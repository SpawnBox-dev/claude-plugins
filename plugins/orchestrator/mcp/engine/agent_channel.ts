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

import { readFileSync, existsSync, statSync, readdirSync } from "fs";
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
  type SessionEntry,
} from "./agent_channel_state";
import { readNewSystemEvents } from "./system_events";

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
      | "permission_request_pending";
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
  /** Byte offset into system_events.jsonl for this filewatcher. */
  private systemEventsOffset = 0;

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

  private heartbeat(): void {
    const updated = {
      ...this.selfSession,
      last_heartbeat_at: new Date().toISOString(),
    };
    writeSession(this.projectStateDir, updated);
  }

  private detectSessionChanges(): void {
    const current = new Map(
      readSessions(this.projectStateDir).map((s) => [s.session_id, s]),
    );
    const now = Date.now();

    // Reap stale
    for (const [sid, entry] of current) {
      const last = new Date(entry.last_heartbeat_at).getTime();
      if (now - last > STALE_THRESHOLD_MS) {
        current.delete(sid);
        removeSession(this.projectStateDir, sid);
      }
    }

    // Joined: in current, not in known
    for (const [sid, entry] of current) {
      if (
        !this.knownSessions.has(sid) &&
        sid !== this.selfSession.session_id
      ) {
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
      }
    }

    // Departed: in known, not in current
    for (const [sid, entry] of this.knownSessions) {
      if (!current.has(sid) && sid !== this.selfSession.session_id) {
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
      }
    }

    this.knownSessions = current;
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
      const sessions = Array.from(this.knownSessions.values());
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
    const result = readNewSystemEvents(this.projectStateDir, this.systemEventsOffset);
    this.systemEventsOffset = result.newOffset;

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
    const lastOffset = offsets[file] ?? 0;
    let stat;
    try {
      stat = statSync(file);
    } catch {
      return false;
    }
    if (stat.size === lastOffset) return false;
    if (stat.size < lastOffset) {
      // File truncated - reset offset
      offsets[file] = 0;
      return true;
    }

    // Slice by BYTE offset, then decode UTF-8. Doing readFileSync(file, "utf8")
    // followed by string.slice(lastOffset) is a UTF-8 corruption hazard:
    // lastOffset is a byte count (Buffer.byteLength was used to advance it),
    // but String.slice is index-based - any multibyte char (emoji, non-ASCII
    // user text) that straddles the offset would produce invalid JSON.
    let buf: string;
    try {
      const raw = readFileSync(file);
      buf = raw.subarray(lastOffset).toString("utf8");
    } catch {
      return false;
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
    // writing a status update to Jarid that also contains an `@SA-<id8>`
    // directive paragraph. Whole-message routing would deliver the entire
    // mixed message (including the Jarid-private prose) to the addressed SA.
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

/**
 * Filter content paragraphs to only those that address `receiverId`. Returns
 * null when no paragraph addresses this receiver (caller should suppress
 * the emit entirely). Paragraphs are separated by one or more blank lines.
 *
 * Used by SA receivers to extract only the parts of a sender's message
 * that were addressed to them - prevents PA-Jarid prose in a mixed message
 * from leaking to an SA that was named in a different paragraph.
 */
function filterParagraphsForReceiver(
  content: string,
  receiverId: string,
  sender: SessionEntry,
  sessions: SessionEntry[],
): string | null {
  const paragraphs = content.split(/\n{2,}/);
  const kept: string[] = [];
  for (const para of paragraphs) {
    const paraAddr = parseAddressing(para, sender, sessions);
    if (paraAddr.targets.includes(receiverId)) {
      kept.push(para);
    }
  }
  return kept.length > 0 ? kept.join("\n\n") : null;
}
