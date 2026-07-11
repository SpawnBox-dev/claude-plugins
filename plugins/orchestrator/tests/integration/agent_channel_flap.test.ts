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
import { AgentChannel, DEPART_GRACE_TICKS, type ChannelNotification } from "../../mcp/engine/agent_channel";
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
