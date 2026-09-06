process.env.ORCHESTRATOR_AGENT_CHANNEL_DB_PATH_TEST_ONLY = ":memory:";

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, appendFileSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { AgentChannel, type ChannelNotification } from "../../mcp/engine/agent_channel";
import { writeSession, closeAgentChannelDb, type SessionEntry } from "../../mcp/engine/agent_channel_state";

// ===========================================================================
// WI 6cf7437a - ORPHAN SELF-RETIREMENT. The root-cause fix (note d628d93a).
//
// THE BUG. A reload or `/mcp` reconnect ABANDONS the old MCP server instead of
// terminating it, so stop() never runs and the old process keeps polling.
// Measured 2026-09-06: seven watchers alive for four sessions, orphans aged
// 12, 15 and 25 hours. All of them read the SAME offsets row and advanced the
// SAME bookmark, but only one had a transport anyone was reading - so the rest
// consumed messages into nothing. Delivery fell 100% -> 48% -> 42% as they
// accumulated.
//
// PA'S TEST CONSTRAINT, AND IT IS THE REASON THIS FILE IS SHAPED THIS WAY:
// "that reaping has to be tested on a fleet that already HAS an orphan, not a
// clean one. A fix verified on a clean fleet is a control that cannot fail."
// So every arm below constructs the orphan condition explicitly - two live
// AgentChannel instances for ONE session - rather than asserting on a fleet
// where the bug could not occur.
// ===========================================================================

const PROJECT_HASH = "fixture-project";
let baseDir: string, projectsHashDir: string, stateDir: string;

beforeEach(() => {
  baseDir = mkdtempSync(join(tmpdir(), "orphan-"));
  projectsHashDir = join(baseDir, "claude-projects", PROJECT_HASH);
  stateDir = join(baseDir, "project", ".orchestrator-state", "agent-channel");
  mkdirSync(projectsHashDir, { recursive: true });
  mkdirSync(stateDir, { recursive: true });
});
afterEach(() => {
  closeAgentChannelDb(stateDir);
  rmSync(baseDir, { recursive: true, force: true });
});

const session = (id8: string, startedAt: string): SessionEntry => ({
  session_id: `${id8}-1234-5678-9abc-def012345678`,
  id8,
  role: "prime",
  name: "PA-test",
  started_at: startedAt,
  last_heartbeat_at: new Date().toISOString(),
});

const logRows = () => {
  const p = join(stateDir, "emit-log.jsonl");
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
};

describe("an orphaned watcher retires when a newer instance owns the session", () => {
  test("THE FIX: the older instance stands down, the newer one does not", () => {
    const OLD = "2026-09-06T02:54:25.000Z";
    const NEW = "2026-09-06T15:32:16.000Z";
    const self = session("aaaaaaaa", OLD);
    writeSession(stateDir, self);
    writeFileSync(join(projectsHashDir, `${self.session_id}.jsonl`), "");

    // The orphan: constructed with the OLD start time, still running.
    const orphan = new AgentChannel(stateDir, projectsHashDir, self, () => {});
    (orphan as any).tick();
    expect((orphan as any).retired).toBe(false); // it owns the row so far

    // A replacement registers - exactly what a reload does.
    writeSession(stateDir, { ...self, started_at: NEW, last_heartbeat_at: new Date().toISOString() });

    (orphan as any).checkSuperseded();
    expect((orphan as any).retired).toBe(true);

    const r = logRows().find((x) => x.event === "retired");
    expect(r).toBeDefined();
    expect(r.detail).toContain("superseded");

    // The NEWER instance must NOT retire itself - otherwise the fix takes the
    // live watcher down and the fleet goes silent, which is worse than the bug.
    const live = new AgentChannel(stateDir, projectsHashDir, { ...self, started_at: NEW }, () => {});
    (live as any).checkSuperseded();
    expect((live as any).retired).toBe(false);
  });

  test("a retired watcher STOPS CONSUMING - the actual harm being prevented", () => {
    // The orphan's damage was never that it existed; it was that it advanced a
    // SHARED bookmark past messages the live watcher then never saw. A retired
    // instance that still ticked would keep doing exactly that.
    const OLD = "2026-09-06T02:54:25.000Z";
    const self = session("aaaaaaaa", OLD);
    writeSession(stateDir, self);
    const peer = session("bbbbbbbb", OLD);
    writeSession(stateDir, peer);
    const peerJsonl = join(projectsHashDir, `${peer.session_id}.jsonl`);
    writeFileSync(join(projectsHashDir, `${self.session_id}.jsonl`), "");
    writeFileSync(peerJsonl, "");

    const rx: ChannelNotification[] = [];
    const orphan = new AgentChannel(stateDir, projectsHashDir, self, (n) => rx.push(n));
    (orphan as any).tick();

    writeSession(stateDir, { ...self, started_at: "2026-09-06T15:32:16.000Z", last_heartbeat_at: new Date().toISOString() });
    (orphan as any).checkSuperseded();
    expect((orphan as any).retired).toBe(true);

    // New traffic arrives after retirement. The orphan must not touch it.
    appendFileSync(
      peerJsonl,
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "for the live watcher" }] } }) + "\n",
    );
    const before = rx.length;
    (orphan as any).tick();
    expect(rx.length).toBe(before);
    expect(rx.some((n) => String(n.content).includes("for the live watcher"))).toBe(false);
  });

  test("does NOT retire on an equal start time - only strictly newer wins", () => {
    // Guards a self-inflicted outage: if equality retired, a single instance
    // reading back its own row would stand itself down and the fleet would go
    // dark with no replacement anywhere.
    const T = "2026-09-06T15:32:16.000Z";
    const self = session("aaaaaaaa", T);
    writeSession(stateDir, self);
    writeFileSync(join(projectsHashDir, `${self.session_id}.jsonl`), "");
    const chan = new AgentChannel(stateDir, projectsHashDir, self, () => {});
    (chan as any).checkSuperseded();
    expect((chan as any).retired).toBe(false);
  });

  test("does NOT retire when its row is ABSENT", () => {
    // A missing row means the registry has not seen us yet, not that we lost.
    // writeSession re-adds us on the next heartbeat.
    const self = session("aaaaaaaa", "2026-09-06T15:32:16.000Z");
    writeFileSync(join(projectsHashDir, `${self.session_id}.jsonl`), "");
    const chan = new AgentChannel(stateDir, projectsHashDir, self, () => {});
    (chan as any).checkSuperseded();
    expect((chan as any).retired).toBe(false);
  });

  test("does NOT retire on an unparseable start time", () => {
    const self = session("aaaaaaaa", "2026-09-06T15:32:16.000Z");
    writeSession(stateDir, { ...self, started_at: "not-a-date" });
    writeFileSync(join(projectsHashDir, `${self.session_id}.jsonl`), "");
    const chan = new AgentChannel(stateDir, projectsHashDir, self, () => {});
    (chan as any).checkSuperseded();
    expect((chan as any).retired).toBe(false);
  });

  test("retirement is idempotent - it logs once, not once per heartbeat", () => {
    const self = session("aaaaaaaa", "2026-09-06T02:54:25.000Z");
    writeSession(stateDir, self);
    writeFileSync(join(projectsHashDir, `${self.session_id}.jsonl`), "");
    const chan = new AgentChannel(stateDir, projectsHashDir, self, () => {});
    writeSession(stateDir, { ...self, started_at: "2026-09-06T15:32:16.000Z", last_heartbeat_at: new Date().toISOString() });
    (chan as any).checkSuperseded();
    (chan as any).checkSuperseded();
    (chan as any).checkSuperseded();
    expect(logRows().filter((x) => x.event === "retired")).toHaveLength(1);
  });
});
