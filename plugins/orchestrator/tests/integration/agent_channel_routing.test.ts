import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, appendFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { AgentChannel, type ChannelNotification } from "../../mcp/engine/agent_channel";
import { writeSession, type SessionEntry } from "../../mcp/engine/agent_channel_state";

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
});
