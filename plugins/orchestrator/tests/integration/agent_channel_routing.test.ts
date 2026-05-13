// Force :memory: DB path for tests BEFORE the agent_channel_state module
// loads. bun:sqlite on Windows holds the .db file handle for an indefinite
// window after Database.close() returns, which trips EBUSY in rmSync teardown.
// `:memory:` DBs have no file to lock; per-stateDir cache key still isolates
// each test. Production retains file-backed DBs via the default.
process.env.ORCHESTRATOR_AGENT_CHANNEL_DB_PATH_TEST_ONLY = ":memory:";

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, appendFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { AgentChannel, type ChannelNotification } from "../../mcp/engine/agent_channel";
import {
  writeSession,
  closeAgentChannelDb,
  type SessionEntry,
} from "../../mcp/engine/agent_channel_state";

const PROJECT_HASH = "fixture-project";

let baseDir: string;
let projectDir: string;
let projectsHashDir: string;
let stateDir: string;

beforeEach(() => {
  baseDir = mkdtempSync(join(tmpdir(), "agent-channel-it-"));
  projectDir = join(baseDir, "project");
  projectsHashDir = join(baseDir, "claude-projects", PROJECT_HASH);
  stateDir = join(projectDir, ".orchestrator-state", "agent-channel");
  mkdirSync(projectsHashDir, { recursive: true });
  mkdirSync(stateDir, { recursive: true });
});

afterEach(() => {
  // Release cached SQLite connection (it's :memory: so no file lock, but the
  // cache entry would otherwise persist across tests with stale state).
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

describe("agent-channel routing E2E", () => {
  test("PA receives all events; SA only sees addressed events", async () => {
    const pa = makeSession("prime", "f5b8708d", "PA-test");
    const saA = makeSession("subordinate", "abc12345", "SA-A");
    const saB = makeSession("subordinate", "d4e5f6a7", "SA-B");

    writeSession(stateDir, pa);
    writeSession(stateDir, saA);
    writeSession(stateDir, saB);

    const paJsonl = join(projectsHashDir, `${pa.session_id}.jsonl`);
    const saAJsonl = join(projectsHashDir, `${saA.session_id}.jsonl`);
    const saBJsonl = join(projectsHashDir, `${saB.session_id}.jsonl`);
    writeFileSync(paJsonl, "");
    writeFileSync(saAJsonl, "");
    writeFileSync(saBJsonl, "");

    // Pre-populate JSONL events BEFORE starting filewatchers so the first tick
    // sees them. (The filewatcher's first read happens during start().)
    appendAssistantEvent(saAJsonl, "@SA-d4e5f6a7 want to coordinate?");
    appendAssistantEvent(saAJsonl, "Just edited foo.ts");
    appendAssistantEvent(paJsonl, "@SA-abc12345 update the migration");

    const paReceived: ChannelNotification[] = [];
    const saAReceived: ChannelNotification[] = [];
    const saBReceived: ChannelNotification[] = [];

    const paChan = new AgentChannel(stateDir, projectsHashDir, pa, (n) => paReceived.push(n));
    const saAChan = new AgentChannel(stateDir, projectsHashDir, saA, (n) => saAReceived.push(n));
    const saBChan = new AgentChannel(stateDir, projectsHashDir, saB, (n) => saBReceived.push(n));

    paChan.start();
    saAChan.start();
    saBChan.start();
    await new Promise((r) => setTimeout(r, 50));
    paChan.stop();
    saAChan.stop();
    saBChan.stop();

    // PA: gets all SA-A events (it's the default observer) + PA's own event
    // is filtered by self-event suppression. So PA gets 2 events: both SA-A's.
    const paContents = paReceived
      .filter((n) => n.meta.event_type !== "session_joined" && n.meta.event_type !== "session_departed")
      .map((n) => n.content);
    expect(paContents).toEqual(
      expect.arrayContaining([
        expect.stringContaining("want to coordinate?"),
        expect.stringContaining("Just edited foo.ts"),
      ]),
    );

    // SA-A: gets PA's @SA-abc12345 directive
    const saAContents = saAReceived
      .filter((n) => n.meta.event_type !== "session_joined" && n.meta.event_type !== "session_departed")
      .map((n) => n.content);
    expect(saAContents).toEqual(
      expect.arrayContaining([expect.stringContaining("update the migration")]),
    );

    // SA-B: gets SA-A's @SA-d4e5f6a7 address
    const saBContents = saBReceived
      .filter((n) => n.meta.event_type !== "session_joined" && n.meta.event_type !== "session_departed")
      .map((n) => n.content);
    expect(saBContents).toEqual(
      expect.arrayContaining([expect.stringContaining("want to coordinate?")]),
    );

    // SA-B: should NOT have received SA-A's unaddressed event or PA's SA-A directive
    expect(saBContents).not.toEqual(
      expect.arrayContaining([
        expect.stringContaining("Just edited foo.ts"),
        expect.stringContaining("update the migration"),
      ]),
    );
  });

  // Regression: a multibyte UTF-8 char straddling lastOffset would
  // produce invalid JSON when sliced by character index. Fix uses Buffer
  // subarray (byte-based) before utf8 decode.
  test("multibyte UTF-8 content (emoji / non-ASCII) doesn't corrupt across reads", async () => {
    const pa = makeSession("prime", "f5b8708d", "PA");
    const sa = makeSession("subordinate", "abc12345", "SA-A");
    writeSession(stateDir, pa);
    writeSession(stateDir, sa);

    const saJsonl = join(projectsHashDir, `${sa.session_id}.jsonl`);
    writeFileSync(saJsonl, "");

    const paReceived: ChannelNotification[] = [];
    const paChan = new AgentChannel(stateDir, projectsHashDir, pa, (n) => paReceived.push(n));

    // First batch: short ASCII line. Filewatcher reads, advances offset.
    appendAssistantEvent(saJsonl, "first short line");
    paChan.start();
    await new Promise((r) => setTimeout(r, 50));

    // Second batch: a line containing emoji + accented chars. Each multibyte
    // char takes 2-4 bytes. The string-index slice bug would mistake byte
    // offset for char offset and split a char.
    appendAssistantEvent(saJsonl, "emoji 🚀 and accents éàü - all preserved");

    await new Promise((r) => setTimeout(r, 1700));
    paChan.stop();

    const contents = paReceived
      .filter((n) => n.meta.event_type !== "session_joined" && n.meta.event_type !== "session_departed")
      .map((n) => n.content);

    expect(contents).toEqual(
      expect.arrayContaining([expect.stringContaining("🚀")]),
    );
    expect(contents).toEqual(
      expect.arrayContaining([expect.stringContaining("éàü")]),
    );
  });

  test("session_joined event fires when new session appears mid-flight", async () => {
    const pa = makeSession("prime", "f5b8708d", "PA");
    writeSession(stateDir, pa);
    writeFileSync(join(projectsHashDir, `${pa.session_id}.jsonl`), "");

    const paReceived: ChannelNotification[] = [];
    const paChan = new AgentChannel(stateDir, projectsHashDir, pa, (n) => paReceived.push(n));
    paChan.start();
    await new Promise((r) => setTimeout(r, 50));

    // SA joins mid-flight
    const sa = makeSession("subordinate", "abc12345", "SA-new");
    writeSession(stateDir, sa);
    writeFileSync(join(projectsHashDir, `${sa.session_id}.jsonl`), "");

    // Wait for one filewatcher tick (poll interval is 1500ms)
    await new Promise((r) => setTimeout(r, 1700));
    paChan.stop();

    expect(
      paReceived.some(
        (n) => n.meta.event_type === "session_joined" && n.meta.from_id8 === "abc12345",
      ),
    ).toBe(true);
  });

  // Per-paragraph routing (0.30.22, work_item b4c37849):
  // A mixed-audience message (private-to-user paragraphs + @SA-<id8> directive
  // paragraphs in one assistant_text event) must NOT deliver the private
  // paragraphs to the named SA. Only the addressed paragraphs reach the SA.
  //
  // Test setup: a SOURCE SA writes the mixed message. The receiving SAs and
  // PA observe via the filewatcher. PA's own session always suppresses
  // self-events (each AgentChannel skips events from its own session_id),
  // which is why the source must be a different session than any receiver
  // we want to verify.
  test("SA receives only the @SA-addressed paragraphs of a mixed-audience message", async () => {
    const pa = makeSession("prime", "f5b8708d", "PA");
    const sourceSa = makeSession("subordinate", "50ce0bba", "SA-source");
    const targetA = makeSession("subordinate", "abc12345", "SA-target");
    const targetB = makeSession("subordinate", "deadbe11", "SA-other");
    writeSession(stateDir, pa);
    writeSession(stateDir, sourceSa);
    writeSession(stateDir, targetA);
    writeSession(stateDir, targetB);

    const sourceJsonl = join(projectsHashDir, `${sourceSa.session_id}.jsonl`);
    writeFileSync(sourceJsonl, "");

    // Mixed message: paragraph 1 is private to the user, paragraph 2 addresses
    // SA-abc12345, paragraph 3 is again private to the user, paragraph 4
    // addresses a DIFFERENT SA.
    const mixed = [
      "Hey Jarid, here's a private read on the orchestrator situation. The relay is misbehaving.",
      "@SA-abc12345 Please re-run the migration and verify the schema version.",
      "Back to you Jarid - I think the larger architectural pivot is needed.",
      "@SA-deadbe11 Standby for next assignment.",
    ].join("\n\n");
    appendAssistantEvent(sourceJsonl, mixed);

    const paReceived: ChannelNotification[] = [];
    const targetAReceived: ChannelNotification[] = [];
    const targetBReceived: ChannelNotification[] = [];

    const paChan = new AgentChannel(stateDir, projectsHashDir, pa, (n) => paReceived.push(n));
    const targetAChan = new AgentChannel(stateDir, projectsHashDir, targetA, (n) => targetAReceived.push(n));
    const targetBChan = new AgentChannel(stateDir, projectsHashDir, targetB, (n) => targetBReceived.push(n));

    paChan.start();
    targetAChan.start();
    targetBChan.start();
    await new Promise((r) => setTimeout(r, 50));
    paChan.stop();
    targetAChan.stop();
    targetBChan.stop();

    // PA observes the FULL content (PA is the project observer).
    const paAssistantContents = paReceived
      .filter((n) => n.meta.event_type === "assistant_text")
      .map((n) => n.content);
    expect(paAssistantContents.length).toBeGreaterThanOrEqual(1);
    const paFullContent = paAssistantContents.join("\n---\n");
    expect(paFullContent).toContain("private read on the orchestrator");
    expect(paFullContent).toContain("re-run the migration");
    expect(paFullContent).toContain("larger architectural pivot");
    expect(paFullContent).toContain("Standby for next assignment");

    // SA-target receives ONLY paragraph 2 (its addressed paragraph). The two
    // private paragraphs MUST be filtered out. The other SA's paragraph
    // is also not for SA-target.
    const targetAContents = targetAReceived
      .filter((n) => n.meta.event_type === "assistant_text")
      .map((n) => n.content);
    expect(targetAContents.length).toBe(1);
    const targetAContent = targetAContents[0];
    expect(targetAContent).toContain("re-run the migration");
    expect(targetAContent).not.toContain("private read on the orchestrator");
    expect(targetAContent).not.toContain("larger architectural pivot");
    expect(targetAContent).not.toContain("Standby for next assignment");

    // SA-other receives ONLY paragraph 4 (its addressed paragraph).
    const targetBContents = targetBReceived
      .filter((n) => n.meta.event_type === "assistant_text")
      .map((n) => n.content);
    expect(targetBContents.length).toBe(1);
    const targetBContent = targetBContents[0];
    expect(targetBContent).toContain("Standby for next assignment");
    expect(targetBContent).not.toContain("private read on the orchestrator");
    expect(targetBContent).not.toContain("re-run the migration");
    expect(targetBContent).not.toContain("larger architectural pivot");
  });

  // Per-paragraph routing edge case: unaddressed message gets no SA delivery
  // but PA still observes it. Source must be a non-PA, non-receiver session
  // to avoid self-event suppression on either end.
  test("unaddressed message reaches PA but no SA", async () => {
    const pa = makeSession("prime", "f5b8708d", "PA");
    const sourceSa = makeSession("subordinate", "50ce0bba", "SA-source");
    const otherSa = makeSession("subordinate", "abc12345", "SA-other");
    writeSession(stateDir, pa);
    writeSession(stateDir, sourceSa);
    writeSession(stateDir, otherSa);

    const sourceJsonl = join(projectsHashDir, `${sourceSa.session_id}.jsonl`);
    writeFileSync(sourceJsonl, "");

    const unaddressed = "Just thinking out loud about how the API should evolve.";
    appendAssistantEvent(sourceJsonl, unaddressed);

    const paReceived: ChannelNotification[] = [];
    const otherReceived: ChannelNotification[] = [];
    const paChan = new AgentChannel(stateDir, projectsHashDir, pa, (n) => paReceived.push(n));
    const otherChan = new AgentChannel(stateDir, projectsHashDir, otherSa, (n) => otherReceived.push(n));
    paChan.start();
    otherChan.start();
    await new Promise((r) => setTimeout(r, 50));
    paChan.stop();
    otherChan.stop();

    // PA observes
    expect(
      paReceived.some(
        (n) => n.meta.event_type === "assistant_text" && n.content.includes("thinking out loud"),
      ),
    ).toBe(true);
    // Other SA does NOT receive
    expect(
      otherReceived.some(
        (n) => n.meta.event_type === "assistant_text" && n.content.includes("thinking out loud"),
      ),
    ).toBe(false);
  });
});
