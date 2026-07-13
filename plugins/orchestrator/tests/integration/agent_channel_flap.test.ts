// Flap-storm fix (WI 8522c487). Tests for the three changes that end
// false session_departed/session_joined churn under load:
//   ROOT-A  positional/partial transcript read (refactor; behavior-preserving)
//   ROOT-B  new-receiver offsets init to EOF (skip pre-join history)
//   DEFENSE-C observer-side departure hysteresis + depart<->rejoin debounce
//
// Deterministic ticking via the established `(chan as any).<private>()` seam
// (same convention as agent_channel_permission.test.ts's processSystemEvents()).
process.env.ORCHESTRATOR_AGENT_CHANNEL_DB_PATH_TEST_ONLY = ":memory:";

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, appendFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { AgentChannel, DEPART_GRACE_TICKS, classifyAbsence, classifyIngress, parseIngressTail, INGRESS_STALE_THRESHOLD_MS, type ChannelNotification } from "../../mcp/engine/agent_channel";
import {
  writeSession,
  removeSession,
  closeAgentChannelDb,
  type SessionEntry,
} from "../../mcp/engine/agent_channel_state";

const PROJECT_HASH = "fixture-project";

let baseDir: string;
let projectDir: string;
let projectsHashDir: string;
let stateDir: string;

beforeEach(() => {
  baseDir = mkdtempSync(join(tmpdir(), "agent-channel-flap-"));
  projectDir = join(baseDir, "project");
  projectsHashDir = join(baseDir, "claude-projects", PROJECT_HASH);
  stateDir = join(projectDir, ".orchestrator-state", "agent-channel");
  mkdirSync(projectsHashDir, { recursive: true });
  mkdirSync(stateDir, { recursive: true });
});

afterEach(() => {
  closeAgentChannelDb(stateDir);
  rmSync(baseDir, { recursive: true, force: true });
});

function makeSession(role: "prime" | "subordinate", id8: string, name: string): SessionEntry {
  return {
    session_id: `${id8}-1234-5678-9abc-def012345678`,
    id8,
    role,
    name,
    started_at: new Date().toISOString(),
    last_heartbeat_at: new Date().toISOString(),
  };
}

function appendAssistantEvent(jsonl: string, text: string): void {
  const ev = { type: "assistant", message: { content: [{ type: "text", text }] } };
  appendFileSync(jsonl, JSON.stringify(ev) + "\n");
}

function assistantContents(received: ChannelNotification[]): string[] {
  return received
    .filter((n) => n.meta.event_type === "assistant_text")
    .map((n) => n.content);
}

describe("flap fix ROOT-B: new-receiver EOF-init skips pre-join history", () => {
  test("a new receiver does not replay pre-join transcript content, only post-join", () => {
    const pa = makeSession("prime", "f5b8708d", "PA");
    const src = makeSession("subordinate", "abc12345", "SA-src");
    writeSession(stateDir, pa);
    writeSession(stateDir, src);

    const srcJsonl = join(projectsHashDir, `${src.session_id}.jsonl`);
    writeFileSync(srcJsonl, "");
    // Pre-join history: an @all message that WOULD be delivered to the observer
    // if the new receiver replayed history from offset 0.
    appendAssistantEvent(srcJsonl, "@all HISTORICAL-do-not-replay");

    const received: ChannelNotification[] = [];
    const paChan = new AgentChannel(stateDir, projectsHashDir, pa, (n) => received.push(n));

    // First tick = first-sight of srcJsonl. EOF-init must skip the backlog.
    (paChan as any).tick();
    expect(assistantContents(received).some((c) => c.includes("HISTORICAL"))).toBe(false);

    // Content written AFTER first-sight must still be delivered.
    appendAssistantEvent(srcJsonl, "@all FRESH-deliver-me");
    (paChan as any).tick();
    expect(assistantContents(received).some((c) => c.includes("FRESH"))).toBe(true);
    // History is never delivered, even after subsequent ticks.
    expect(assistantContents(received).some((c) => c.includes("HISTORICAL"))).toBe(false);
  });
});

describe("flap fix ROOT-A: positional read (byte-offset, multibyte-safe, partial-line carry)", () => {
  test("reads the delta at a nonzero offset, preserves multibyte, and carries a partial trailing line", () => {
    const pa = makeSession("prime", "f5b8708d", "PA");
    const src = makeSession("subordinate", "abc12345", "SA-src");
    writeSession(stateDir, pa);
    writeSession(stateDir, src);

    const srcJsonl = join(projectsHashDir, `${src.session_id}.jsonl`);
    writeFileSync(srcJsonl, "");

    const received: ChannelNotification[] = [];
    const paChan = new AgentChannel(stateDir, projectsHashDir, pa, (n) => received.push(n));

    // First-sight EOF-init on the empty file (offset 0).
    (paChan as any).tick();

    // A first complete line advances the offset to a NONZERO byte position, so
    // the subsequent read exercises the positional read at an offset (not 0).
    appendAssistantEvent(srcJsonl, "@all FIRST-LINE plain ascii");
    (paChan as any).tick();
    expect(assistantContents(received).some((c) => c.includes("FIRST-LINE"))).toBe(true);

    // Now append a COMPLETE multibyte line (emoji + accents) followed by a
    // PARTIAL line with no trailing newline. The positional read starts at the
    // nonzero offset; the multibyte content must survive byte-based decoding,
    // and the unterminated line must NOT be delivered yet.
    const multibyte =
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "@all MULTIBYTE 🚀 éàü survives the positional read" }] },
      }) + "\n";
    const partial = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: "@all PARTIAL-LINE not yet terminated" }] },
    }); // deliberately no trailing "\n"
    appendFileSync(srcJsonl, multibyte + partial);
    (paChan as any).tick();

    expect(assistantContents(received).some((c) => c.includes("🚀"))).toBe(true);
    expect(assistantContents(received).some((c) => c.includes("éàü"))).toBe(true);
    expect(assistantContents(received).some((c) => c.includes("PARTIAL-LINE"))).toBe(false);

    // Terminate the partial line; it must now be delivered exactly once, intact.
    appendFileSync(srcJsonl, "\n");
    (paChan as any).tick();
    const partialHits = assistantContents(received).filter((c) => c.includes("PARTIAL-LINE"));
    expect(partialHits.length).toBe(1);
  });
});

function eventsOfType(
  received: ChannelNotification[],
  type: string,
  id8: string,
): ChannelNotification[] {
  return received.filter((n) => n.meta.event_type === type && n.meta.from_id8 === id8);
}

describe("flap fix DEFENSE-C: observer-side departure hysteresis + depart<->rejoin debounce", () => {
  // The observer (PA here) holds a peer through the grace window. A peer that
  // leaves the fresh roster (row removed / heartbeat stale) is not announced
  // departed until DEPART_GRACE_TICKS consecutive misses; a reappearance before
  // then cancels the pair (no depart, no re-join). This lives entirely on the
  // OBSERVER side - the flapping victim is blocked and cannot act for itself.
  function setup() {
    const pa = makeSession("prime", "f5b8708d", "PA");
    const peer = makeSession("subordinate", "abc12345", "SA-peer");
    writeSession(stateDir, pa);
    writeSession(stateDir, peer);
    const received: ChannelNotification[] = [];
    const chan = new AgentChannel(stateDir, projectsHashDir, pa, (n) => received.push(n));
    (chan as any).tick(); // establish `peer` as a known, present session (emits its join)
    return { peer, received, chan };
  }

  test("a departure is NOT announced within the grace window", () => {
    const { peer, received, chan } = setup();
    removeSession(stateDir, peer.session_id); // peer leaves the fresh roster
    for (let i = 0; i < DEPART_GRACE_TICKS - 1; i++) (chan as any).tick();
    expect(eventsOfType(received, "session_departed", peer.id8).length).toBe(0);
  });

  test("a genuine departure IS announced once the grace elapses", () => {
    const { peer, received, chan } = setup();
    removeSession(stateDir, peer.session_id);
    for (let i = 0; i < DEPART_GRACE_TICKS - 1; i++) (chan as any).tick();
    expect(eventsOfType(received, "session_departed", peer.id8).length).toBe(0); // not yet
    (chan as any).tick(); // the DEPART_GRACE_TICKS-th consecutive miss
    expect(eventsOfType(received, "session_departed", peer.id8).length).toBe(1);
  });

  test("a peer that leaves then rejoins within grace triggers NEITHER a departed NOR a re-join (flap debounced)", () => {
    const { peer, received, chan } = setup();
    const joinsAfterSetup = eventsOfType(received, "session_joined", peer.id8).length; // 1
    removeSession(stateDir, peer.session_id);
    for (let i = 0; i < 3; i++) (chan as any).tick(); // a few misses, well within grace
    writeSession(stateDir, peer); // peer recovers (re-registers, fresh heartbeat)
    for (let i = 0; i < 4; i++) (chan as any).tick(); // recovery tick + keep observing
    expect(eventsOfType(received, "session_departed", peer.id8).length).toBe(0);
    // No SECOND join: the peer was held in `known` through the grace, so its
    // reappearance is not a new join.
    expect(eventsOfType(received, "session_joined", peer.id8).length).toBe(joinsAfterSetup);
  });
});

describe("flap fix: self-routing robustness (self always in the routing roster)", () => {
  // Regression lock (code-review Finding 1): routing resolves addressing from
  // the fresh roster (currentRoster). If self's own DB row is transiently
  // missing - e.g. an old-version peer reaped self after a >90s stall in a
  // mixed-version fleet, before self's next heartbeat re-registers it - self
  // MUST still be in the routing roster, or a recovering SA silently drops
  // messages addressed to it (@SA-<selfid8>) and @all broadcasts.
  test("a receiver still delivers @self and @all traffic when its own DB row is transiently gone", () => {
    const self = makeSession("subordinate", "abc12345", "SA-self");
    const peer = makeSession("prime", "f5b8708d", "PA");
    writeSession(stateDir, self);
    writeSession(stateDir, peer);

    const peerJsonl = join(projectsHashDir, `${peer.session_id}.jsonl`);
    writeFileSync(peerJsonl, "");

    const received: ChannelNotification[] = [];
    const chan = new AgentChannel(stateDir, projectsHashDir, self, (n) => received.push(n));
    (chan as any).tick(); // EOF-init peerJsonl, establish roster

    // Self's row is reaped out from under it (old-version peer, post-stall).
    removeSession(stateDir, self.session_id);

    // A peer addresses self directly and broadcasts to @all.
    appendAssistantEvent(peerJsonl, "@SA-abc12345 directive meant for the recovering SA");
    appendAssistantEvent(peerJsonl, "@all broadcast that must reach everyone");
    (chan as any).tick();

    const contents = received
      .filter((n) => n.meta.event_type === "assistant_text")
      .map((n) => n.content);
    expect(contents.some((c) => c.includes("directive meant for the recovering SA"))).toBe(true);
    expect(contents.some((c) => c.includes("broadcast that must reach everyone"))).toBe(true);
  });
});

describe("egress-death classifyAbsence (WI 0f9dcd95)", () => {
  test("transcript grew since going stale -> egress_suspect (alive but unreachable), regardless of miss count", () => {
    expect(
      classifyAbsence({ grewSinceStale: true, missCount: 1, graceTicks: DEPART_GRACE_TICKS }),
    ).toBe("egress_suspect");
    // growth dominates: even past the depart grace, a growing transcript = alive
    expect(
      classifyAbsence({ grewSinceStale: true, missCount: 999, graceTicks: DEPART_GRACE_TICKS }),
    ).toBe("egress_suspect");
  });
  test("no growth, still within the grace -> pending (wait)", () => {
    expect(
      classifyAbsence({ grewSinceStale: false, missCount: 5, graceTicks: DEPART_GRACE_TICKS }),
    ).toBe("pending");
  });
  test("no growth, grace elapsed -> departed (genuinely gone / frozen transcript)", () => {
    expect(
      classifyAbsence({ grewSinceStale: false, missCount: DEPART_GRACE_TICKS, graceTicks: DEPART_GRACE_TICKS }),
    ).toBe("departed");
  });
});

describe("egress-death detection (integration) - WI 0f9dcd95", () => {
  test("a stale peer whose transcript keeps GROWING is egress_suspect (alive), NOT departed - held, no reap, emitted once", () => {
    const pa = makeSession("prime", "f5b8708d", "PA");
    const peer = makeSession("subordinate", "abc12345", "SA-peer");
    writeSession(stateDir, pa);
    writeSession(stateDir, peer);
    const peerJsonl = join(projectsHashDir, `${peer.session_id}.jsonl`);
    writeFileSync(peerJsonl, "initial transcript state\n");

    const received: ChannelNotification[] = [];
    const chan = new AgentChannel(stateDir, projectsHashDir, pa, (n) => received.push(n));
    (chan as any).tick(); // establish known {peer}
    removeSession(stateDir, peer.session_id); // peer leaves the fresh roster (heartbeat gone)
    (chan as any).tick(); // first absent tick: sizeAtStale captured, verdict pending

    // The peer is ALIVE but egress-dead: it keeps appending turns.
    appendFileSync(peerJsonl, "a new turn appended while unreachable\n");
    (chan as any).tick();
    expect(eventsOfType(received, "egress_suspect", peer.id8).length).toBe(1);
    expect(eventsOfType(received, "session_departed", peer.id8).length).toBe(0);

    // Held: keep ticking WELL past the depart grace - growth dominates, never departs,
    // and egress_suspect is emitted only ONCE (not spammed).
    for (let i = 0; i < DEPART_GRACE_TICKS + 3; i++) (chan as any).tick();
    expect(eventsOfType(received, "session_departed", peer.id8).length).toBe(0);
    expect(eventsOfType(received, "egress_suspect", peer.id8).length).toBe(1);
  });

  test("a stale peer whose transcript is FROZEN departs normally after the grace (genuinely gone)", () => {
    const pa = makeSession("prime", "f5b8708d", "PA");
    const peer = makeSession("subordinate", "abc12345", "SA-peer");
    writeSession(stateDir, pa);
    writeSession(stateDir, peer);
    const peerJsonl = join(projectsHashDir, `${peer.session_id}.jsonl`);
    writeFileSync(peerJsonl, "final state - process is dead, no more turns\n");

    const received: ChannelNotification[] = [];
    const chan = new AgentChannel(stateDir, projectsHashDir, pa, (n) => received.push(n));
    (chan as any).tick(); // establish known {peer}
    removeSession(stateDir, peer.session_id);
    for (let i = 0; i < DEPART_GRACE_TICKS; i++) (chan as any).tick(); // no growth through the grace

    expect(eventsOfType(received, "session_departed", peer.id8).length).toBe(1);
    expect(eventsOfType(received, "egress_suspect", peer.id8).length).toBe(0);
  });

  // Review finding #2 (0.30.66): a RECOVERABLE MCP wedge trips egress_suspect
  // once, then self-heals when the peer's heartbeat returns. Lock that the
  // recovery is clean (no departed, no re-join) AND that egress state is fully
  // reset so a genuinely-new later episode re-arms and fires afresh.
  test("a growing (egress-dead) peer that RECONNECTS self-heals: no departed, no re-join, state re-armed for a fresh episode", () => {
    const pa = makeSession("prime", "f5b8708d", "PA");
    const peer = makeSession("subordinate", "abc12345", "SA-peer");
    writeSession(stateDir, pa);
    writeSession(stateDir, peer);
    const peerJsonl = join(projectsHashDir, `${peer.session_id}.jsonl`);
    writeFileSync(peerJsonl, "initial transcript state\n");

    const received: ChannelNotification[] = [];
    const chan = new AgentChannel(stateDir, projectsHashDir, pa, (n) => received.push(n));
    (chan as any).tick(); // establish known {peer}
    removeSession(stateDir, peer.session_id); // heartbeat gone
    (chan as any).tick(); // sizeAtStale captured, verdict pending
    appendFileSync(peerJsonl, "a turn while unreachable\n");
    (chan as any).tick(); // episode 1 -> egress_suspect
    expect(eventsOfType(received, "egress_suspect", peer.id8).length).toBe(1);

    // The MCP self-heals: the peer is back in the fresh roster (heartbeat alive).
    writeSession(stateDir, peer);
    const joinsBefore = eventsOfType(received, "session_joined", peer.id8).length;
    (chan as any).tick(); // present-branch clears egress state; peer was held in known

    // Clean recovery: never departed, no re-join (held through the episode), and
    // the one stale advisory is NOT re-emitted now that it is reachable again.
    expect(eventsOfType(received, "session_departed", peer.id8).length).toBe(0);
    expect(eventsOfType(received, "session_joined", peer.id8).length).toBe(joinsBefore);
    expect(eventsOfType(received, "egress_suspect", peer.id8).length).toBe(1);

    // State truly reset: a FRESH absence+growth episode re-arms and fires a NEW
    // egress_suspect (proves egressEmitted + sizeAtStale were cleared on recovery,
    // not merely suppressed).
    removeSession(stateDir, peer.session_id);
    (chan as any).tick(); // re-capture sizeAtStale for episode 2
    appendFileSync(peerJsonl, "another turn, second episode\n");
    (chan as any).tick();
    expect(eventsOfType(received, "egress_suspect", peer.id8).length).toBe(2);
    expect(eventsOfType(received, "session_departed", peer.id8).length).toBe(0);
  });
});

// ─── Ingress-death detection (WI 19294811) ──────────────────────────────────
// The INVERSE of egress: a session PRESENT in the fresh roster (heartbeat fresh)
// whose event loop is PARKED - the confirmed cause being an interactive
// menu/prompt left open (an open /mcp menu parks the loop), other causes
// possible. Its bun keeps heartbeating and the filewatcher keeps ENQUEUEing
// channel deliveries into its transcript, but no turn runs to DEQUEUE them.
// Only last-real-activity-vs-orphaned-enqueue reveals it; heartbeat + transcript
// growth are both false-negatives. Peer-side detection only (a self-emit rides
// server.server.notification() -> the parked local harness, which cannot drain
// the transport until the park clears, so it can never escape its own park).

function isoAt(ms: number): string {
  return new Date(ms).toISOString();
}
function qop(jsonl: string, op: "enqueue" | "dequeue", tsMs: number): void {
  appendFileSync(
    jsonl,
    JSON.stringify({ type: "queue-operation", operation: op, timestamp: isoAt(tsMs) }) + "\n",
  );
}
function realEntry(jsonl: string, tsMs: number, type = "assistant"): void {
  appendFileSync(
    jsonl,
    JSON.stringify({ type, timestamp: isoAt(tsMs), message: { role: "assistant", content: [] } }) + "\n",
  );
}
// Deterministic seam: build the roster, then run the ingress scan directly,
// bypassing tick()'s wall-clock throttle so dedup/recovery are testable.
function runIngress(chan: AgentChannel, now: number = Date.now()): void {
  (chan as any).detectSessionChanges();
  (chan as any).detectIngress((chan as any).currentRoster, now);
}

describe("ingress-death classifyIngress (WI 19294811)", () => {
  const T = INGRESS_STALE_THRESHOLD_MS;
  const now = 10_000_000;
  test("fresh heartbeat + orphan older than threshold + not mid-turn -> ingress_suspect", () => {
    expect(
      classifyIngress({ heartbeatFresh: true, oldestOrphanEnqueueTs: now - T - 1, lastRealIsMidTurn: false, now, thresholdMs: T }),
    ).toBe("ingress_suspect");
  });
  test("fresh heartbeat + orphan within threshold -> pending (a normal dequeue may be imminent)", () => {
    expect(
      classifyIngress({ heartbeatFresh: true, oldestOrphanEnqueueTs: now - 1000, lastRealIsMidTurn: false, now, thresholdMs: T }),
    ).toBe("pending");
  });
  test("fresh heartbeat + no orphaned delivery -> healthy", () => {
    expect(
      classifyIngress({ heartbeatFresh: true, oldestOrphanEnqueueTs: null, lastRealIsMidTurn: false, now, thresholdMs: T }),
    ).toBe("healthy");
  });
  test("stale heartbeat -> healthy (absent peers belong to egress/departed, not ingress)", () => {
    expect(
      classifyIngress({ heartbeatFresh: false, oldestOrphanEnqueueTs: now - T - 999999, lastRealIsMidTurn: false, now, thresholdMs: T }),
    ).toBe("healthy");
  });
  test("mid-turn (tool running OR owes-response/extended-thinking) -> healthy even with an aged orphan", () => {
    expect(
      classifyIngress({ heartbeatFresh: true, oldestOrphanEnqueueTs: now - T - 999999, lastRealIsMidTurn: true, now, thresholdMs: T }),
    ).toBe("healthy");
  });
});

describe("ingress-death parseIngressTail (WI 19294811)", () => {
  const t0 = Date.parse("2026-07-13T17:00:00.000Z");
  const L = (o: any) => JSON.stringify(o);
  test("last real activity then orphaned enqueues -> oldest orphan = first enqueue ts", () => {
    const tail = [
      L({ type: "assistant", timestamp: isoAt(t0) }),
      L({ type: "queue-operation", operation: "enqueue", timestamp: isoAt(t0 + 1000) }),
      L({ type: "queue-operation", operation: "enqueue", timestamp: isoAt(t0 + 2000) }),
      "",
    ].join("\n");
    expect(parseIngressTail(tail).oldestOrphanEnqueueTs).toBe(t0 + 1000);
  });
  test("enqueue -> dequeue -> real activity (drained) -> no orphan", () => {
    const tail = [
      L({ type: "queue-operation", operation: "enqueue", timestamp: isoAt(t0) }),
      L({ type: "queue-operation", operation: "dequeue", timestamp: isoAt(t0 + 500) }),
      L({ type: "assistant", timestamp: isoAt(t0 + 1000) }),
      "",
    ].join("\n");
    expect(parseIngressTail(tail).oldestOrphanEnqueueTs).toBeNull();
  });
  test("FIFO-matches partial drain: enqueue,dequeue,enqueue after last real -> oldest orphan = 2nd enqueue", () => {
    const tail = [
      L({ type: "assistant", timestamp: isoAt(t0) }),
      L({ type: "queue-operation", operation: "enqueue", timestamp: isoAt(t0 + 1000) }),
      L({ type: "queue-operation", operation: "dequeue", timestamp: isoAt(t0 + 1500) }),
      L({ type: "queue-operation", operation: "enqueue", timestamp: isoAt(t0 + 2000) }),
      "",
    ].join("\n");
    expect(parseIngressTail(tail).oldestOrphanEnqueueTs).toBe(t0 + 2000);
  });
  test("window of ONLY orphaned enqueues (real activity scrolled past the tail) -> oldest orphan = first enqueue", () => {
    const tail = [
      L({ type: "queue-operation", operation: "enqueue", timestamp: isoAt(t0) }),
      L({ type: "queue-operation", operation: "enqueue", timestamp: isoAt(t0 + 1000) }),
      "",
    ].join("\n");
    expect(parseIngressTail(tail).oldestOrphanEnqueueTs).toBe(t0);
  });
  test("a partial leading line (byte-window landed mid-line) is skipped, not fatal", () => {
    const tail = [
      '{"type":"queue-oper',
      L({ type: "assistant", timestamp: isoAt(t0) }),
      L({ type: "queue-operation", operation: "enqueue", timestamp: isoAt(t0 + 1000) }),
      "",
    ].join("\n");
    expect(parseIngressTail(tail).oldestOrphanEnqueueTs).toBe(t0 + 1000);
  });
  test("last real entry is an assistant WITH a tool_use block (tool in flight) -> midTurn true", () => {
    const tail = [
      L({ type: "assistant", timestamp: isoAt(t0), message: { role: "assistant", content: [{ type: "tool_use" }] } }),
      L({ type: "queue-operation", operation: "enqueue", timestamp: isoAt(t0 + 1000) }),
      "",
    ].join("\n");
    expect(parseIngressTail(tail).lastRealIsMidTurn).toBe(true);
  });
  test("last real entry is a `user` entry (owes response / extended-thinking) -> midTurn true", () => {
    const tail = [
      L({ type: "user", timestamp: isoAt(t0), message: { role: "user", content: [{ type: "tool_result" }] } }),
      L({ type: "queue-operation", operation: "enqueue", timestamp: isoAt(t0 + 1000) }),
      "",
    ].join("\n");
    expect(parseIngressTail(tail).lastRealIsMidTurn).toBe(true);
  });
  test("last real entry is a completed assistant text turn -> midTurn false (park-eligible)", () => {
    const tail = [
      L({ type: "assistant", timestamp: isoAt(t0), message: { role: "assistant", content: [{ type: "text" }] } }),
      "",
    ].join("\n");
    expect(parseIngressTail(tail).lastRealIsMidTurn).toBe(false);
  });
  test("last real entry is a trailing `system` entry (idle after a turn) -> midTurn false (the real park shape)", () => {
    const tail = [
      L({ type: "assistant", timestamp: isoAt(t0), message: { role: "assistant", content: [{ type: "text" }] } }),
      L({ type: "system", timestamp: isoAt(t0 + 100) }),
      "",
    ].join("\n");
    expect(parseIngressTail(tail).lastRealIsMidTurn).toBe(false);
  });
  test("a STALE unmatched tool_use earlier in the window does NOT mask a later park (scoped to last real entry)", () => {
    // A tool was invoked and (say) interrupted - no tool_result. Later the session
    // completes a text turn and goes idle -> the earlier tool_use must NOT keep
    // midTurn stuck true (that was the code-review persistence concern).
    const tail = [
      L({ type: "assistant", timestamp: isoAt(t0), message: { role: "assistant", content: [{ type: "tool_use" }] } }),
      L({ type: "assistant", timestamp: isoAt(t0 + 5000), message: { role: "assistant", content: [{ type: "text" }] } }),
      L({ type: "system", timestamp: isoAt(t0 + 5100) }),
      "",
    ].join("\n");
    expect(parseIngressTail(tail).lastRealIsMidTurn).toBe(false);
  });
});

describe("ingress-death detection (integration) - WI 19294811", () => {
  test("a present peer with a delivery enqueued-but-never-dequeued past the threshold -> ingress_suspect (emitted once)", () => {
    const pa = makeSession("prime", "f5b8708d", "PA");
    const peer = makeSession("subordinate", "abc12345", "SA-peer");
    writeSession(stateDir, pa);
    writeSession(stateDir, peer); // heartbeat fresh -> present in the roster
    const jsonl = join(projectsHashDir, `${peer.session_id}.jsonl`);
    const now = Date.now();
    realEntry(jsonl, now - 10 * 60_000); // last real turn 10 min ago
    qop(jsonl, "enqueue", now - 6 * 60_000); // delivery parked 6 min (> 3-min threshold)
    qop(jsonl, "enqueue", now - 5 * 60_000);

    const received: ChannelNotification[] = [];
    const chan = new AgentChannel(stateDir, projectsHashDir, pa, (n) => received.push(n));
    runIngress(chan, now);
    expect(eventsOfType(received, "ingress_suspect", peer.id8).length).toBe(1);
    // same episode -> not re-emitted
    runIngress(chan, now);
    runIngress(chan, now);
    expect(eventsOfType(received, "ingress_suspect", peer.id8).length).toBe(1);
    // never a departed (the peer is present/heartbeat-fresh)
    expect(eventsOfType(received, "session_departed", peer.id8).length).toBe(0);
  });

  test("a present peer inside a LONG TOOL CALL (unmatched tool_use, delivery enqueued mid-run) is NOT ingress_suspect", () => {
    // Reviewer's confirmed false-positive: a >3min build/deploy appends nothing
    // between tool_use (invocation) and tool_result (return), so a delivery
    // enqueued mid-run looks like a park - but the session is healthy.
    const pa = makeSession("prime", "f5b8708d", "PA");
    const peer = makeSession("subordinate", "abc12345", "SA-peer");
    writeSession(stateDir, pa);
    writeSession(stateDir, peer);
    const jsonl = join(projectsHashDir, `${peer.session_id}.jsonl`);
    const now = Date.now();
    // Last real entry = an assistant invoking a tool, no tool_result yet.
    appendFileSync(
      jsonl,
      JSON.stringify({ type: "assistant", timestamp: isoAt(now - 8 * 60_000), message: { role: "assistant", content: [{ type: "tool_use" }] } }) + "\n",
    );
    qop(jsonl, "enqueue", now - 6 * 60_000); // delivery parked 6 min DURING the tool run

    const received: ChannelNotification[] = [];
    const chan = new AgentChannel(stateDir, projectsHashDir, pa, (n) => received.push(n));
    runIngress(chan, now);
    expect(eventsOfType(received, "ingress_suspect", peer.id8).length).toBe(0);
  });

  test("a present peer in a long EXTENDED-THINKING span (last real entry is a user entry) is NOT ingress_suspect", () => {
    // Verified shape: a multi-minute think appends nothing and always follows a
    // `user` entry (input / tool_result). Same blocked-but-alive pattern as a
    // long tool call - must not misfire.
    const pa = makeSession("prime", "f5b8708d", "PA");
    const peer = makeSession("subordinate", "abc12345", "SA-peer");
    writeSession(stateDir, pa);
    writeSession(stateDir, peer);
    const jsonl = join(projectsHashDir, `${peer.session_id}.jsonl`);
    const now = Date.now();
    appendFileSync(
      jsonl,
      JSON.stringify({ type: "user", timestamp: isoAt(now - 8 * 60_000), message: { role: "user", content: [{ type: "tool_result" }] } }) + "\n",
    );
    qop(jsonl, "enqueue", now - 6 * 60_000); // delivery enqueued mid-think

    const received: ChannelNotification[] = [];
    const chan = new AgentChannel(stateDir, projectsHashDir, pa, (n) => received.push(n));
    runIngress(chan, now);
    expect(eventsOfType(received, "ingress_suspect", peer.id8).length).toBe(0);
  });

  test("a STALE unmatched tool_use earlier in the window does NOT mask a later genuine park (still detected)", () => {
    // Persistence-FN guard (code-review): an interrupted tool_use with no result,
    // then a completed idle turn, then a parked delivery -> the earlier tool_use
    // must NOT suppress detection of the real park.
    const pa = makeSession("prime", "f5b8708d", "PA");
    const peer = makeSession("subordinate", "abc12345", "SA-peer");
    writeSession(stateDir, pa);
    writeSession(stateDir, peer);
    const jsonl = join(projectsHashDir, `${peer.session_id}.jsonl`);
    const now = Date.now();
    appendFileSync(
      jsonl,
      JSON.stringify({ type: "assistant", timestamp: isoAt(now - 20 * 60_000), message: { role: "assistant", content: [{ type: "tool_use" }] } }) + "\n",
    );
    // then the session completed a normal text turn and went idle:
    realEntry(jsonl, now - 10 * 60_000);
    qop(jsonl, "enqueue", now - 6 * 60_000); // parked delivery

    const received: ChannelNotification[] = [];
    const chan = new AgentChannel(stateDir, projectsHashDir, pa, (n) => received.push(n));
    runIngress(chan, now);
    expect(eventsOfType(received, "ingress_suspect", peer.id8).length).toBe(1);
  });

  test("a present peer MID-TURN (real activity after the enqueue) is NOT ingress_suspect", () => {
    const pa = makeSession("prime", "f5b8708d", "PA");
    const peer = makeSession("subordinate", "abc12345", "SA-peer");
    writeSession(stateDir, pa);
    writeSession(stateDir, peer);
    const jsonl = join(projectsHashDir, `${peer.session_id}.jsonl`);
    const now = Date.now();
    qop(jsonl, "enqueue", now - 6 * 60_000);
    realEntry(jsonl, now - 30_000); // real activity 30s ago -> loop draining, not parked

    const received: ChannelNotification[] = [];
    const chan = new AgentChannel(stateDir, projectsHashDir, pa, (n) => received.push(n));
    runIngress(chan, now);
    expect(eventsOfType(received, "ingress_suspect", peer.id8).length).toBe(0);
  });

  test("a delivery enqueued only RECENTLY (within threshold) is not yet ingress_suspect", () => {
    const pa = makeSession("prime", "f5b8708d", "PA");
    const peer = makeSession("subordinate", "abc12345", "SA-peer");
    writeSession(stateDir, pa);
    writeSession(stateDir, peer);
    const jsonl = join(projectsHashDir, `${peer.session_id}.jsonl`);
    const now = Date.now();
    realEntry(jsonl, now - 60_000);
    qop(jsonl, "enqueue", now - 20_000); // 20s ago, under the 3-min threshold

    const received: ChannelNotification[] = [];
    const chan = new AgentChannel(stateDir, projectsHashDir, pa, (n) => received.push(n));
    runIngress(chan, now);
    expect(eventsOfType(received, "ingress_suspect", peer.id8).length).toBe(0);
  });

  test("recovery: a real turn that drains the queue clears ingress state and re-arms a fresh episode", () => {
    const pa = makeSession("prime", "f5b8708d", "PA");
    const peer = makeSession("subordinate", "abc12345", "SA-peer");
    writeSession(stateDir, pa);
    writeSession(stateDir, peer);
    const jsonl = join(projectsHashDir, `${peer.session_id}.jsonl`);
    const now = Date.now();
    realEntry(jsonl, now - 10 * 60_000);
    qop(jsonl, "enqueue", now - 6 * 60_000);

    const received: ChannelNotification[] = [];
    const chan = new AgentChannel(stateDir, projectsHashDir, pa, (n) => received.push(n));
    runIngress(chan, now);
    expect(eventsOfType(received, "ingress_suspect", peer.id8).length).toBe(1);

    // The park clears: queue flushes (dequeue) and a fresh turn runs.
    qop(jsonl, "dequeue", now - 1000);
    realEntry(jsonl, now);
    runIngress(chan, now);
    expect(eventsOfType(received, "ingress_suspect", peer.id8).length).toBe(1); // no new emit

    // A genuinely-new parked delivery re-arms and fires a SECOND ingress_suspect
    // (proves ingressEmitted was cleared on recovery, not merely suppressed).
    qop(jsonl, "enqueue", now - 6 * 60_000);
    runIngress(chan, now);
    expect(eventsOfType(received, "ingress_suspect", peer.id8).length).toBe(2);
  });

  test("self is never an ingress_suspect (peer-side only; self-emit cannot escape its own park)", () => {
    const pa = makeSession("prime", "f5b8708d", "PA");
    writeSession(stateDir, pa);
    const selfJsonl = join(projectsHashDir, `${pa.session_id}.jsonl`);
    const now = Date.now();
    realEntry(selfJsonl, now - 10 * 60_000);
    qop(selfJsonl, "enqueue", now - 6 * 60_000); // self looks parked...

    const received: ChannelNotification[] = [];
    const chan = new AgentChannel(stateDir, projectsHashDir, pa, (n) => received.push(n));
    runIngress(chan, now);
    expect(eventsOfType(received, "ingress_suspect", pa.id8).length).toBe(0);
  });
});
