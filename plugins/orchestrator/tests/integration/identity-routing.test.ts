// Force :memory: DB path BEFORE agent_channel_state loads - see the note in
// agent_channel_routing.test.ts (bun:sqlite holds the file handle on Windows).
process.env.ORCHESTRATOR_AGENT_CHANNEL_DB_PATH_TEST_ONLY = ":memory:";

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, appendFileSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { AgentChannel, type ChannelNotification } from "../../mcp/engine/agent_channel";
import {
  writeSession,
  removeSession,
  closeAgentChannelDb,
  type SessionEntry,
} from "../../mcp/engine/agent_channel_state";

// ===========================================================================
// WI 6cf7437a - ROUTE ON IDENTITY, NOT LIVENESS. PA's verification bar.
//
// THE BUG THESE PIN. `removeSession` is an unconditional `DELETE FROM
// sessions` issued by a PEER against a table the whole fleet shares. So one
// session's departure hysteresis deletes a peer's row for EVERYONE, and until
// that peer's next 30s heartbeat re-inserts it, every watcher fails to resolve
// it, consumes its transcript lines, advances past them, and emits nothing.
// Measured signature: contiguous RUNS of loss, not scattered singles, because
// the blindness is a time window. A plugin reload is simply the most reliable
// trigger of that window, not a separate mechanism.
//
// THE FIX. Sender resolution consults identity (fresh roster + ever-seen +
// unfiltered registry); the heartbeat filter keeps deciding who is
// ADDRESSABLE and who is LIVE, never who is allowed to have SPOKEN.
//
// THE NO-WEDGE PROPERTY, which was PA's condition for approving this over the
// rejected "hold the offset until the sender resolves": a transcript from a
// session that never registered is STILL skipped and its offset STILL
// advances. The negative control below is the one that keeps that honest.
// ===========================================================================

const PROJECT_HASH = "fixture-project";

let baseDir: string;
let projectDir: string;
let projectsHashDir: string;
let stateDir: string;

beforeEach(() => {
  baseDir = mkdtempSync(join(tmpdir(), "identity-routing-"));
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
  appendFileSync(
    jsonl,
    JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text }] } }) + "\n",
  );
}

const routed = (rx: ChannelNotification[]) =>
  rx
    .filter((n) => n.meta.event_type !== "session_joined" && n.meta.event_type !== "session_departed")
    .map((n) => n.content);

describe("6cf7437a: identity resolution survives a peer's reap", () => {
  test("POSITIVE CONTROL: a message written while the sender's row is deleted still routes", () => {
    const pa = makeSession("prime", "aaaaaaaa", "PA-test");
    const sa = makeSession("subordinate", "bbbbbbbb", "SA-writer");
    writeSession(stateDir, pa);
    writeSession(stateDir, sa);

    const paJsonl = join(projectsHashDir, `${pa.session_id}.jsonl`);
    const saJsonl = join(projectsHashDir, `${sa.session_id}.jsonl`);
    writeFileSync(paJsonl, "");
    writeFileSync(saJsonl, "");

    const rx: ChannelNotification[] = [];
    const paChan = new AgentChannel(stateDir, projectsHashDir, pa, (n) => rx.push(n));

    // First-sight tick: EOF-init, and PA learns SA exists (knownSessions).
    (paChan as any).tick();

    // A peer's departure hysteresis fires and hard-deletes SA's shared row.
    // SA is very much alive and still writing - nothing about SA changed.
    removeSession(stateDir, sa.session_id);

    appendAssistantEvent(saJsonl, "turn-final message written during the blind window");
    (paChan as any).tick();

    expect(routed(rx)).toEqual(
      expect.arrayContaining([expect.stringContaining("during the blind window")]),
    );
  });

  test("the identity roster resolves a reaped session; the liveness roster does not", () => {
    // Asserts the SEPARATION itself, which is the whole design. If a later
    // change quietly re-points sender resolution at currentRoster, this fails
    // even if delivery happens to work in the test above for another reason.
    const pa = makeSession("prime", "aaaaaaaa", "PA-test");
    const sa = makeSession("subordinate", "bbbbbbbb", "SA-writer");
    writeSession(stateDir, pa);
    writeSession(stateDir, sa);
    writeFileSync(join(projectsHashDir, `${pa.session_id}.jsonl`), "");
    writeFileSync(join(projectsHashDir, `${sa.session_id}.jsonl`), "");

    const paChan = new AgentChannel(stateDir, projectsHashDir, pa, () => {});
    (paChan as any).tick();

    removeSession(stateDir, sa.session_id);
    (paChan as any).detectSessionChanges();

    const identity: Map<string, SessionEntry> = (paChan as any).identityRoster();
    const liveness: Map<string, SessionEntry> = (paChan as any).currentRoster;

    expect(identity.has(sa.session_id)).toBe(true);
    expect(liveness.has(sa.session_id)).toBe(false);
  });

  test("a stale heartbeat does not stop a known peer's lines from routing", () => {
    // Generalises the mechanism past reloads, which is what PA asked for: a
    // long tool call or a compaction that delays a heartbeat produces the same
    // window without any restart.
    const pa = makeSession("prime", "aaaaaaaa", "PA-test");
    const sa = makeSession("subordinate", "bbbbbbbb", "SA-writer");
    writeSession(stateDir, pa);
    writeSession(stateDir, sa);
    const saJsonl = join(projectsHashDir, `${sa.session_id}.jsonl`);
    writeFileSync(join(projectsHashDir, `${pa.session_id}.jsonl`), "");
    writeFileSync(saJsonl, "");

    const rx: ChannelNotification[] = [];
    const paChan = new AgentChannel(stateDir, projectsHashDir, pa, (n) => rx.push(n));
    (paChan as any).tick();

    // Heartbeat lapses well past STALE_THRESHOLD_MS (90s).
    writeSession(stateDir, {
      ...sa,
      last_heartbeat_at: new Date(Date.now() - 10 * 60_000).toISOString(),
    });

    appendAssistantEvent(saJsonl, "written while my heartbeat was stale");
    (paChan as any).tick();

    expect(routed(rx)).toEqual(
      expect.arrayContaining([expect.stringContaining("heartbeat was stale")]),
    );
  });
});

describe("6cf7437a: the no-wedge property", () => {
  test("NEGATIVE CONTROL: an unregistered session's transcript is skipped, its offset still advances, nothing wedges", () => {
    // The failure mode of the REJECTED option (a): a plain `claude` run never
    // registers, so holding its offset until the sender resolves would stall
    // that file forever and re-read the same bytes every tick. Assert the
    // offset MOVES and the skip does not repeat across ticks.
    const pa = makeSession("prime", "aaaaaaaa", "PA-test");
    writeSession(stateDir, pa);
    writeFileSync(join(projectsHashDir, `${pa.session_id}.jsonl`), "");

    const strangerId = "99999999-1234-5678-9abc-def012345678";
    const strangerJsonl = join(projectsHashDir, `${strangerId}.jsonl`);
    writeFileSync(strangerJsonl, "");

    const rx: ChannelNotification[] = [];
    const paChan = new AgentChannel(stateDir, projectsHashDir, pa, (n) => rx.push(n));
    (paChan as any).tick();

    appendAssistantEvent(strangerJsonl, "nobody registered me");
    (paChan as any).tick();

    // Nothing routed from a session that never registered.
    expect(routed(rx).some((c) => c.includes("nobody registered me"))).toBe(false);

    // The offset advanced past it. Read it back through the same accessor the
    // tick uses, so this asserts real persisted state rather than a local.
    const { readOffsets } = require("../../mcp/engine/agent_channel_state");
    const after = readOffsets(stateDir, pa.id8)[strangerJsonl];
    expect(after).toBeGreaterThan(0);

    // And it does not re-read the same bytes on the next tick - the wedge.
    (paChan as any).tick();
    const afterAgain = readOffsets(stateDir, pa.id8)[strangerJsonl];
    expect(afterAgain).toBe(after);
  });

  test("the discard is RECORDED, not merely silent", () => {
    // (c)'s first detector. A discard never mints an emit_id, so it leaves no
    // counter gap anywhere - this log line is the only thing that can see it.
    const pa = makeSession("prime", "aaaaaaaa", "PA-test");
    writeSession(stateDir, pa);
    writeFileSync(join(projectsHashDir, `${pa.session_id}.jsonl`), "");

    const strangerId = "99999999-1234-5678-9abc-def012345678";
    const strangerJsonl = join(projectsHashDir, `${strangerId}.jsonl`);
    writeFileSync(strangerJsonl, "");

    const paChan = new AgentChannel(stateDir, projectsHashDir, pa, () => {});
    (paChan as any).tick();
    appendAssistantEvent(strangerJsonl, "nobody registered me either");
    (paChan as any).tick();

    const logPath = join(stateDir, "emit-log.jsonl");
    expect(existsSync(logPath)).toBe(true);
    const rows = readFileSync(logPath, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    const drops = rows.filter((r) => r.event === "unknown_sender");
    expect(drops.length).toBeGreaterThan(0);
    expect(drops[0].sender_id8).toBe("99999999");
    expect(typeof drops[0].src_offset).toBe("number");
  });
});
