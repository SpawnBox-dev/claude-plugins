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

  // =========================================================================
  // 7ff34714: colon-gated sticky cascade + fenced-code-block-aware splitting.
  // Design: decision note 88321142. An addressed paragraph opens a sticky
  // cascade for its audience ONLY IF it is a colon-header (ends ":"); a
  // non-colon addressed paragraph is a complete directive and opens NO
  // cascade (preserves the locked b4c37849 mixed-audience invariant). Fenced
  // code blocks are atomic (internal blank lines don't fragment) and any
  // @-address inside them is literal content, never routing.
  // =========================================================================

  // Test A (was the trap): a colon-headed multi-paragraph directive must
  // deliver IN FULL to the addressed SA - not just the header line.
  test("colon-header directive: SA receives ALL continuation paragraphs (trap fixed)", async () => {
    const pa = makeSession("prime", "f5b8708d", "PA");
    const src = makeSession("subordinate", "50ce0bba", "SA-src");
    const target = makeSession("subordinate", "abc12345", "SA-target");
    writeSession(stateDir, pa);
    writeSession(stateDir, src);
    writeSession(stateDir, target);

    const srcJsonl = join(projectsHashDir, `${src.session_id}.jsonl`);
    writeFileSync(srcJsonl, "");
    const msg = [
      "@SA-abc12345 Probe directive:",
      "Do step X now and capture the output.",
      "Then report Y back when complete.",
    ].join("\n\n");
    appendAssistantEvent(srcJsonl, msg);

    const targetReceived: ChannelNotification[] = [];
    const targetChan = new AgentChannel(stateDir, projectsHashDir, target, (n) =>
      targetReceived.push(n),
    );
    targetChan.start();
    await new Promise((r) => setTimeout(r, 50));
    targetChan.stop();

    const got = targetReceived
      .filter((n) => n.meta.event_type === "assistant_text")
      .map((n) => n.content);
    expect(got.length).toBe(1);
    expect(got[0]).toContain("Probe directive");
    expect(got[0]).toContain("Do step X now");
    expect(got[0]).toContain("report Y back");
  });

  // Test B (regression lock): a NON-colon addressed paragraph does NOT open a
  // cascade, so an interleaved user-private paragraph is NOT leaked to the
  // SA. This is the colon-gate that preserves b4c37849.
  test("non-colon addressed paragraph does NOT cascade trailing user prose (b4c37849 colon-gate)", async () => {
    const pa = makeSession("prime", "f5b8708d", "PA");
    const src = makeSession("subordinate", "50ce0bba", "SA-src");
    const tA = makeSession("subordinate", "abc12345", "SA-A");
    const tB = makeSession("subordinate", "deadbe11", "SA-B");
    writeSession(stateDir, pa);
    writeSession(stateDir, src);
    writeSession(stateDir, tA);
    writeSession(stateDir, tB);

    const srcJsonl = join(projectsHashDir, `${src.session_id}.jsonl`);
    writeFileSync(srcJsonl, "");
    const msg = [
      "@SA-abc12345 First directive is complete.",
      "Private aside to Jarid: the larger architectural pivot is needed.",
      "@SA-deadbe11 Second directive for you.",
    ].join("\n\n");
    appendAssistantEvent(srcJsonl, msg);

    const aReceived: ChannelNotification[] = [];
    const bReceived: ChannelNotification[] = [];
    const aChan = new AgentChannel(stateDir, projectsHashDir, tA, (n) => aReceived.push(n));
    const bChan = new AgentChannel(stateDir, projectsHashDir, tB, (n) => bReceived.push(n));
    aChan.start();
    bChan.start();
    await new Promise((r) => setTimeout(r, 50));
    aChan.stop();
    bChan.stop();

    const aContents = aReceived
      .filter((n) => n.meta.event_type === "assistant_text")
      .map((n) => n.content);
    expect(aContents.length).toBe(1);
    expect(aContents[0]).toContain("First directive is complete");
    expect(aContents[0]).not.toContain("Private aside");
    expect(aContents[0]).not.toContain("Second directive");

    const bContents = bReceived
      .filter((n) => n.meta.event_type === "assistant_text")
      .map((n) => n.content);
    expect(bContents.length).toBe(1);
    expect(bContents[0]).toContain("Second directive for you");
    expect(bContents[0]).not.toContain("Private aside");
    expect(bContents[0]).not.toContain("First directive");
  });

  // Test C: a colon-cascade is RESET when a later paragraph addresses someone
  // else. Continuations flow to the colon-header's audience until the next
  // address; the new address does not inherit the prior cascade.
  test("colon-cascade resets on a new addressed paragraph", async () => {
    const pa = makeSession("prime", "f5b8708d", "PA");
    const src = makeSession("subordinate", "50ce0bba", "SA-src");
    const tA = makeSession("subordinate", "abc12345", "SA-A");
    const tB = makeSession("subordinate", "deadbe11", "SA-B");
    writeSession(stateDir, pa);
    writeSession(stateDir, src);
    writeSession(stateDir, tA);
    writeSession(stateDir, tB);

    const srcJsonl = join(projectsHashDir, `${src.session_id}.jsonl`);
    writeFileSync(srcJsonl, "");
    const msg = [
      "@SA-abc12345 do these steps:",
      "step one of the work",
      "step two of the work",
      "@SA-deadbe11 your unrelated task.",
      "a trailing note addressed to nobody",
    ].join("\n\n");
    appendAssistantEvent(srcJsonl, msg);

    const aReceived: ChannelNotification[] = [];
    const bReceived: ChannelNotification[] = [];
    const aChan = new AgentChannel(stateDir, projectsHashDir, tA, (n) => aReceived.push(n));
    const bChan = new AgentChannel(stateDir, projectsHashDir, tB, (n) => bReceived.push(n));
    aChan.start();
    bChan.start();
    await new Promise((r) => setTimeout(r, 50));
    aChan.stop();
    bChan.stop();

    const aContent = aReceived
      .filter((n) => n.meta.event_type === "assistant_text")
      .map((n) => n.content)
      .join("\n---\n");
    expect(aContent).toContain("do these steps");
    expect(aContent).toContain("step one of the work");
    expect(aContent).toContain("step two of the work");
    expect(aContent).not.toContain("your unrelated task");
    expect(aContent).not.toContain("trailing note");

    const bContent = bReceived
      .filter((n) => n.meta.event_type === "assistant_text")
      .map((n) => n.content)
      .join("\n---\n");
    expect(bContent).toContain("your unrelated task");
    expect(bContent).not.toContain("step one");
    // B's directive ended with "." (no colon) so it opens NO cascade -
    // the trailing nobody-addressed note must not reach B either.
    expect(bContent).not.toContain("trailing note");
  });

  // Test D: fenced code blocks are atomic (internal blank line must not
  // fragment the directive) AND an @SA-<id8> inside a fence is literal
  // content, never routing.
  test("fenced code block is atomic and @-address inside it is literal, not routing", async () => {
    const pa = makeSession("prime", "f5b8708d", "PA");
    const src = makeSession("subordinate", "50ce0bba", "SA-src");
    const tA = makeSession("subordinate", "abc12345", "SA-A");
    const tB = makeSession("subordinate", "deadbe11", "SA-B");
    writeSession(stateDir, pa);
    writeSession(stateDir, src);
    writeSession(stateDir, tA);
    writeSession(stateDir, tB);

    const srcJsonl = join(projectsHashDir, `${src.session_id}.jsonl`);
    writeFileSync(srcJsonl, "");
    // Colon-header to A, then a bash fence containing a blank line and a
    // line that looks like an address to B, then a trailing instruction.
    const msg = [
      "@SA-abc12345 run this script:",
      "",
      "```bash",
      "echo start-marker",
      "",
      'echo "@SA-deadbe11 literal-not-an-address"',
      "echo end-marker",
      "```",
      "",
      "confirm when complete",
    ].join("\n");
    appendAssistantEvent(srcJsonl, msg);

    const aReceived: ChannelNotification[] = [];
    const bReceived: ChannelNotification[] = [];
    const aChan = new AgentChannel(stateDir, projectsHashDir, tA, (n) => aReceived.push(n));
    const bChan = new AgentChannel(stateDir, projectsHashDir, tB, (n) => bReceived.push(n));
    aChan.start();
    bChan.start();
    await new Promise((r) => setTimeout(r, 50));
    aChan.stop();
    bChan.stop();

    const aContent = aReceived
      .filter((n) => n.meta.event_type === "assistant_text")
      .map((n) => n.content)
      .join("\n---\n");
    // The whole code block survives intact, including its internal blank
    // line, and the cascade carries the post-fence instruction to A.
    expect(aContent).toContain("run this script");
    expect(aContent).toContain("echo start-marker");
    expect(aContent).toContain("echo end-marker");
    expect(aContent).toContain("literal-not-an-address");
    expect(aContent).toContain("confirm when complete");

    // SA-B must receive NOTHING: the @SA-deadbe11 inside the fence is
    // literal content, not an address.
    const bAssistant = bReceived.filter((n) => n.meta.event_type === "assistant_text");
    expect(bAssistant.length).toBe(0);
  });

  // Test E (review I1 lock): CommonMark fence-length rule. A 3-backtick line
  // INSIDE a 5-backtick fence must NOT close it (closer must be >= opener
  // length, same char). Otherwise the outer block ends early and the rest -
  // including an @SA-<id8> - leaks into routing.
  test("a shorter same-char fence inside a longer fence does NOT close it (fence-length rule)", async () => {
    const pa = makeSession("prime", "f5b8708d", "PA");
    const src = makeSession("subordinate", "50ce0bba", "SA-src");
    const tA = makeSession("subordinate", "abc12345", "SA-A");
    const tB = makeSession("subordinate", "deadbe11", "SA-B");
    writeSession(stateDir, pa);
    writeSession(stateDir, src);
    writeSession(stateDir, tA);
    writeSession(stateDir, tB);

    const srcJsonl = join(projectsHashDir, `${src.session_id}.jsonl`);
    writeFileSync(srcJsonl, "");
    // 5-backtick outer fence documenting a 3-backtick markdown example that
    // itself contains a line that looks like an address to B.
    const msg = [
      "@SA-abc12345 here is the markdown to embed:",
      "",
      "`````markdown",
      "```bash",
      "echo hi",
      "```",
      "@SA-deadbe11 this whole thing is literal documentation",
      "`````",
      "",
      "ship it when ready",
    ].join("\n");
    appendAssistantEvent(srcJsonl, msg);

    const aReceived: ChannelNotification[] = [];
    const bReceived: ChannelNotification[] = [];
    const aChan = new AgentChannel(stateDir, projectsHashDir, tA, (n) => aReceived.push(n));
    const bChan = new AgentChannel(stateDir, projectsHashDir, tB, (n) => bReceived.push(n));
    aChan.start();
    bChan.start();
    await new Promise((r) => setTimeout(r, 50));
    aChan.stop();
    bChan.stop();

    const aContent = aReceived
      .filter((n) => n.meta.event_type === "assistant_text")
      .map((n) => n.content)
      .join("\n---\n");
    // The inner ``` did NOT split the block: A gets the whole thing + the
    // post-fence cascade line.
    expect(aContent).toContain("here is the markdown to embed");
    expect(aContent).toContain("echo hi");
    expect(aContent).toContain("this whole thing is literal documentation");
    expect(aContent).toContain("ship it when ready");

    // B must receive NOTHING - the @SA-deadbe11 line is inside the still-open
    // 5-backtick fence, hence literal, not routing.
    const bAssistant = bReceived.filter((n) => n.meta.event_type === "assistant_text");
    expect(bAssistant.length).toBe(0);
  });

  // Test F (7ff34714 LIVE-FAIL regression lock - WI 96798325):
  // The exact shape the 9-test suite missed and the clean confound-free live
  // probe caught. A PA-PRIME sender writes a colon-header @SA cascade, then
  // unaddressed continuations, a fenced code block, and a TRAILING non-colon
  // "@PA ..." paragraph. Because the sender IS the prime, parseAddressing
  // self-excludes @PA (addressing.ts:92 `pa.session_id !== sender.session_id`)
  // and resolves it to ZERO targets. The pre-fix cascade-close gate
  // (`addr.targets.length > 0`) then misclassified that syntactically-
  // addressed paragraph as an UNADDRESSED continuation, so it rode the still-
  // open SA cascade and LEAKED to the SA - reproducing the live failure
  // verbatim. Fix: parseAddressing exposes `had_address_syntax`; a
  // syntactically-addressed paragraph that resolves to no deliverable target
  // still CLOSES the cascade (it is a directive boundary, never a
  // continuation), so it cannot ride a prior cascade into an SA.
  test("PA-prime trailing @PA paragraph does NOT leak into an open SA colon-cascade (7ff34714 live-fail lock)", async () => {
    const pa = makeSession("prime", "f5b8708d", "PA");
    const target = makeSession("subordinate", "abc12345", "SA-target");
    const other = makeSession("subordinate", "deadbe11", "SA-other");
    writeSession(stateDir, pa);
    writeSession(stateDir, target);
    writeSession(stateDir, other);

    // PA-PRIME is the SENDER (the exact live scenario: PA addressing an SA
    // with a colon-header cascade, then a trailing self-addressed @PA line).
    const paJsonl = join(projectsHashDir, `${pa.session_id}.jsonl`);
    writeFileSync(paJsonl, "");
    const msg = [
      "@SA-abc12345 colon-cascade live test:",
      "",
      "CONT-ALPHA",
      "",
      "CONT-BETA",
      "",
      "```bash",
      'echo "@SA-deadbe11 literal, routed nowhere"',
      "```",
      "",
      "@PA reset-check",
    ].join("\n");
    appendAssistantEvent(paJsonl, msg);

    const targetReceived: ChannelNotification[] = [];
    const otherReceived: ChannelNotification[] = [];
    const targetChan = new AgentChannel(stateDir, projectsHashDir, target, (n) =>
      targetReceived.push(n),
    );
    const otherChan = new AgentChannel(stateDir, projectsHashDir, other, (n) =>
      otherReceived.push(n),
    );
    targetChan.start();
    otherChan.start();
    await new Promise((r) => setTimeout(r, 50));
    targetChan.stop();
    otherChan.stop();

    const targetContent = targetReceived
      .filter((n) => n.meta.event_type === "assistant_text")
      .map((n) => n.content)
      .join("\n---\n");
    // The legitimate cascade content DOES reach the SA:
    expect(targetContent).toContain("colon-cascade live test");
    expect(targetContent).toContain("CONT-ALPHA");
    expect(targetContent).toContain("CONT-BETA");
    expect(targetContent).toContain("literal, routed nowhere"); // fence rides cascade (intended)
    // THE LEAK LOCK: the trailing @PA-from-PA paragraph must NOT reach the SA.
    expect(targetContent).not.toContain("reset-check");

    // SA-other is addressed nowhere (the @SA-deadbe11 is literal inside the
    // fence). It must receive NOTHING.
    const otherAssistant = otherReceived.filter(
      (n) => n.meta.event_type === "assistant_text",
    );
    expect(otherAssistant.length).toBe(0);
  });

  // Test G (7ff34714 general-class lock - WI 96798325, second variant):
  // Same root cause as Test F but the SECOND member of the bug class: a
  // syntactically-addressed paragraph that resolves to ZERO targets because
  // the @SA-<id8> is UNRESOLVED (no such session). The pre-fix gate
  // `addr.targets.length > 0` is false, so it was misclassified as an
  // unaddressed continuation and rode the still-open SA cascade, leaking a
  // directive meant for a (non-existent) third party into SA-target. The
  // class-complete fix (had_address_syntax) must close the cascade for THIS
  // sub-case too, not only prime-self-@PA. (The third class member - @all
  // resolving to empty - cannot co-occur with an SA receiver: @all resolves
  // empty only when the sender is the sole session, in which case no SA
  // receiver exists to leak to, so it is covered by the same had_address_
  // syntax mechanism without a separate exploitable test.)
  test("unresolved @SA-<id8> trailing an open colon-cascade does NOT leak to the cascaded SA (7ff34714 general-class lock)", async () => {
    const src = makeSession("subordinate", "50ce0bba", "SA-src");
    const target = makeSession("subordinate", "abc12345", "SA-target");
    writeSession(stateDir, src);
    writeSession(stateDir, target);

    const srcJsonl = join(projectsHashDir, `${src.session_id}.jsonl`);
    writeFileSync(srcJsonl, "");
    // 99999999 is valid @SA-<id8> syntax ([a-f0-9]{8}) but resolves to no
    // session - had_address_syntax=true, targets=[].
    const msg = [
      "@SA-abc12345 cascade for you:",
      "",
      "CONT-ONE",
      "",
      "CONT-TWO",
      "",
      "@SA-99999999 directive to a session that does not exist",
    ].join("\n");
    appendAssistantEvent(srcJsonl, msg);

    const targetReceived: ChannelNotification[] = [];
    const targetChan = new AgentChannel(stateDir, projectsHashDir, target, (n) =>
      targetReceived.push(n),
    );
    targetChan.start();
    await new Promise((r) => setTimeout(r, 50));
    targetChan.stop();

    const targetContent = targetReceived
      .filter((n) => n.meta.event_type === "assistant_text")
      .map((n) => n.content)
      .join("\n---\n");
    expect(targetContent).toContain("cascade for you");
    expect(targetContent).toContain("CONT-ONE");
    expect(targetContent).toContain("CONT-TWO");
    // THE LEAK LOCK: the unresolved-@SA directive paragraph must NOT ride the
    // cascade into SA-target.
    expect(targetContent).not.toContain("does not exist");
  });

  // Test H (2026-05-18 FIELD-FAIL regression lock - WI 7ff34714 REOPENED):
  // PA's idiomatic directive header is markdown-BOLDED: "**Directive:**". That
  // paragraph ends in ":**", and the original isColonHeader did
  // `text.trimEnd().endsWith(":")` - trimEnd strips whitespace, NOT markdown -
  // so a bolded header's last char is "*", endsWith(":") is false, the sticky
  // cascade never opened, and every continuation paragraph was silently
  // dropped. Wire-confirmed from the live PA 6a2cab38 -> FE-AGENT-01 19703445
  // transcript diff, 2026-05-18 18:30 (FE received the header line ONLY; the
  // identical content re-sent single-newline at 18:31 delivered in full).
  // Fixture is the verbatim shape of that dropped message. Fix: isColonHeader
  // strips a trailing run of markdown emphasis/code/strike markers before the
  // colon test.
  test("BOLDED colon-header directive: SA receives ALL continuation paragraphs (2026-05-18 field-fail lock)", async () => {
    const pa = makeSession("prime", "f5b8708d", "PA");
    const src = makeSession("subordinate", "50ce0bba", "SA-src");
    const target = makeSession("subordinate", "abc12345", "SA-target");
    writeSession(stateDir, pa);
    writeSession(stateDir, src);
    writeSession(stateDir, target);

    const srcJsonl = join(projectsHashDir, `${src.session_id}.jsonl`);
    writeFileSync(srcJsonl, "");
    // Verbatim shape of the real dropped message: a markdown-bolded header
    // ending ":**", then blank-line-separated continuation paragraphs.
    const msg = [
      "@SA-abc12345 - **Jarid directive, mandatory in the implementation process:**",
      "MANDATORY in the implementation process, all three of you:",
      "(1) Each code-writing agent runs its own review after writing it.",
      "(2) Do NOT blindly trust the reviewer; verify against the actual code.",
    ].join("\n\n");
    appendAssistantEvent(srcJsonl, msg);

    const targetReceived: ChannelNotification[] = [];
    const targetChan = new AgentChannel(stateDir, projectsHashDir, target, (n) =>
      targetReceived.push(n),
    );
    targetChan.start();
    await new Promise((r) => setTimeout(r, 50));
    targetChan.stop();

    const got = targetReceived
      .filter((n) => n.meta.event_type === "assistant_text")
      .map((n) => n.content);
    expect(got.length).toBe(1);
    expect(got[0]).toContain("Jarid directive, mandatory");
    // THE LOCK: every continuation paragraph must reach the SA, not just the
    // bolded header line.
    expect(got[0]).toContain("MANDATORY in the implementation process, all three");
    expect(got[0]).toContain("(1) Each code-writing agent runs its own review");
    expect(got[0]).toContain("(2) Do NOT blindly trust the reviewer");
  });

  // Test I (markdown-strip FALSE-POSITIVE lock): stripping trailing markdown
  // for the colon test must NOT promote a bolded NON-colon directive into a
  // colon-header. "@SA-x **First directive is complete.**" ends in markdown
  // but has NO colon - it stays a COMPLETE directive and must open NO cascade,
  // so the following user-private paragraph is NOT leaked to the SA. Locks the
  // b4c37849 mixed-audience invariant across the isColonHeader change. Must
  // hold BOTH before and after the fix.
  test("bolded NON-colon addressed paragraph still opens NO cascade (markdown-strip false-positive lock)", async () => {
    const pa = makeSession("prime", "f5b8708d", "PA");
    const src = makeSession("subordinate", "50ce0bba", "SA-src");
    const tA = makeSession("subordinate", "abc12345", "SA-A");
    const tB = makeSession("subordinate", "deadbe11", "SA-B");
    writeSession(stateDir, pa);
    writeSession(stateDir, src);
    writeSession(stateDir, tA);
    writeSession(stateDir, tB);

    const srcJsonl = join(projectsHashDir, `${src.session_id}.jsonl`);
    writeFileSync(srcJsonl, "");
    const msg = [
      "@SA-abc12345 **First directive is complete.**",
      "Private aside to Jarid: the larger architectural pivot is needed.",
      "@SA-deadbe11 **Second directive for you.**",
    ].join("\n\n");
    appendAssistantEvent(srcJsonl, msg);

    const aReceived: ChannelNotification[] = [];
    const bReceived: ChannelNotification[] = [];
    const aChan = new AgentChannel(stateDir, projectsHashDir, tA, (n) => aReceived.push(n));
    const bChan = new AgentChannel(stateDir, projectsHashDir, tB, (n) => bReceived.push(n));
    aChan.start();
    bChan.start();
    await new Promise((r) => setTimeout(r, 50));
    aChan.stop();
    bChan.stop();

    const aContents = aReceived
      .filter((n) => n.meta.event_type === "assistant_text")
      .map((n) => n.content);
    expect(aContents.length).toBe(1);
    expect(aContents[0]).toContain("First directive is complete");
    expect(aContents[0]).not.toContain("Private aside");
    expect(aContents[0]).not.toContain("Second directive");

    const bContents = bReceived
      .filter((n) => n.meta.event_type === "assistant_text")
      .map((n) => n.content);
    expect(bContents.length).toBe(1);
    expect(bContents[0]).toContain("Second directive for you");
    expect(bContents[0]).not.toContain("Private aside");
    expect(bContents[0]).not.toContain("First directive");
  });

  // =========================================================================
  // Explicit envelope (WI eabc89b6, Jarid GO 2026-05-18): the structural fix
  // that removes the colon gymnastics. An agent wraps a block:
  //     @@@ @SA-<id8>
  //     ...anything: paragraphs, markdown, blank lines, code fences...
  //     @@@
  // The whole inner payload is ONE atomic unit, delivered VERBATIM to the
  // opener's targets only (markers stripped), routes nowhere else, @-mentions
  // inside are literal, cascade-transparent. Purely additive - no prior
  // content uses `@@@`, so A-I stay green.
  // =========================================================================

  // Test J (headline): "format it however you want, it arrives in entirety."
  // A deliberately trap-shaped payload - bold header with NO colon, multiple
  // blank-line paragraphs, a fenced code block containing a literal @SA-other
  // - delivers in full to the envelope target, and the literal mention does
  // NOT route to the other SA.
  test("explicit envelope delivers an arbitrarily-formatted multi-paragraph payload in full to its target only", async () => {
    const pa = makeSession("prime", "f5b8708d", "PA");
    const src = makeSession("subordinate", "50ce0bba", "SA-src");
    const target = makeSession("subordinate", "abc12345", "SA-target");
    const other = makeSession("subordinate", "deadbe11", "SA-other");
    writeSession(stateDir, pa);
    writeSession(stateDir, src);
    writeSession(stateDir, target);
    writeSession(stateDir, other);

    const srcJsonl = join(projectsHashDir, `${src.session_id}.jsonl`);
    writeFileSync(srcJsonl, "");
    const msg = [
      "@@@ @SA-abc12345",
      "**Plan (bold header, NO colon, multiple paragraphs):**",
      "",
      "First paragraph of the body.",
      "",
      "Second paragraph, separated by a blank line.",
      "",
      "```bash",
      'echo "@SA-deadbe11 literal inside envelope - must NOT route"',
      "```",
      "",
      "Final paragraph - ship it.",
      "@@@",
    ].join("\n");
    appendAssistantEvent(srcJsonl, msg);

    const targetReceived: ChannelNotification[] = [];
    const otherReceived: ChannelNotification[] = [];
    const targetChan = new AgentChannel(stateDir, projectsHashDir, target, (n) =>
      targetReceived.push(n),
    );
    const otherChan = new AgentChannel(stateDir, projectsHashDir, other, (n) =>
      otherReceived.push(n),
    );
    targetChan.start();
    otherChan.start();
    await new Promise((r) => setTimeout(r, 50));
    targetChan.stop();
    otherChan.stop();

    const got = targetReceived
      .filter((n) => n.meta.event_type === "assistant_text")
      .map((n) => n.content);
    expect(got.length).toBe(1);
    // Every part of the arbitrarily-formatted payload arrives:
    expect(got[0]).toContain("Plan (bold header, NO colon, multiple paragraphs)");
    expect(got[0]).toContain("First paragraph of the body.");
    expect(got[0]).toContain("Second paragraph, separated by a blank line.");
    expect(got[0]).toContain("literal inside envelope - must NOT route");
    expect(got[0]).toContain("Final paragraph - ship it.");
    // Envelope markers themselves are stripped from delivered content.
    expect(got[0]).not.toContain("@@@");

    // The @SA-deadbe11 inside the envelope is literal - SA-other gets nothing.
    const otherAssistant = otherReceived.filter(
      (n) => n.meta.event_type === "assistant_text",
    );
    expect(otherAssistant.length).toBe(0);
  });

  // Test K (privacy + additivity): content OUTSIDE the envelope still routes
  // by the existing per-paragraph rules. A private aside reaches nobody; an
  // envelope reaches only its target; a normal addressed paragraph after the
  // envelope still reaches its own SA. The envelope adds precision, never
  // leaks (b4c37849 invariant preserved alongside the new mechanism).
  test("envelope is precise; non-envelope content still routes per existing rules (additive, no leak)", async () => {
    const pa = makeSession("prime", "f5b8708d", "PA");
    const src = makeSession("subordinate", "50ce0bba", "SA-src");
    const tA = makeSession("subordinate", "abc12345", "SA-A");
    const tB = makeSession("subordinate", "deadbe11", "SA-B");
    writeSession(stateDir, pa);
    writeSession(stateDir, src);
    writeSession(stateDir, tA);
    writeSession(stateDir, tB);

    const srcJsonl = join(projectsHashDir, `${src.session_id}.jsonl`);
    writeFileSync(srcJsonl, "");
    const msg = [
      "Private aside to Jarid - must not leak anywhere.",
      "",
      "@@@ @SA-abc12345",
      "Envelope body for A only. Mentions @SA-deadbe11 literally.",
      "@@@",
      "",
      "@SA-deadbe11 Real directive for B, outside the envelope.",
    ].join("\n");
    appendAssistantEvent(srcJsonl, msg);

    const aReceived: ChannelNotification[] = [];
    const bReceived: ChannelNotification[] = [];
    const aChan = new AgentChannel(stateDir, projectsHashDir, tA, (n) => aReceived.push(n));
    const bChan = new AgentChannel(stateDir, projectsHashDir, tB, (n) => bReceived.push(n));
    aChan.start();
    bChan.start();
    await new Promise((r) => setTimeout(r, 50));
    aChan.stop();
    bChan.stop();

    const aContents = aReceived
      .filter((n) => n.meta.event_type === "assistant_text")
      .map((n) => n.content)
      .join("\n---\n");
    expect(aContents).toContain("Envelope body for A only");
    expect(aContents).not.toContain("Private aside");
    expect(aContents).not.toContain("Real directive for B");

    const bContents = bReceived
      .filter((n) => n.meta.event_type === "assistant_text")
      .map((n) => n.content)
      .join("\n---\n");
    expect(bContents).toContain("Real directive for B, outside the envelope");
    expect(bContents).not.toContain("Envelope body for A only");
    expect(bContents).not.toContain("Private aside");
  });

  // Test L (unclosed-envelope containment): an opener with no closer swallows
  // the remainder and routes it ONLY to the envelope target - routing-safe
  // over-containment (never leaks the tail to cascade/others), mirroring the
  // unclosed-fence guarantee.
  test("unclosed envelope swallows the remainder to its target only (routing-safe)", async () => {
    const pa = makeSession("prime", "f5b8708d", "PA");
    const src = makeSession("subordinate", "50ce0bba", "SA-src");
    const tA = makeSession("subordinate", "abc12345", "SA-A");
    const tB = makeSession("subordinate", "deadbe11", "SA-B");
    writeSession(stateDir, pa);
    writeSession(stateDir, src);
    writeSession(stateDir, tA);
    writeSession(stateDir, tB);

    const srcJsonl = join(projectsHashDir, `${src.session_id}.jsonl`);
    writeFileSync(srcJsonl, "");
    const msg = [
      "@SA-deadbe11 a normal directive first.",
      "",
      "@@@ @SA-abc12345",
      "Unclosed envelope body line one.",
      "",
      "Unclosed envelope body line two - swallows to end.",
    ].join("\n");
    appendAssistantEvent(srcJsonl, msg);

    const aReceived: ChannelNotification[] = [];
    const bReceived: ChannelNotification[] = [];
    const aChan = new AgentChannel(stateDir, projectsHashDir, tA, (n) => aReceived.push(n));
    const bChan = new AgentChannel(stateDir, projectsHashDir, tB, (n) => bReceived.push(n));
    aChan.start();
    bChan.start();
    await new Promise((r) => setTimeout(r, 50));
    aChan.stop();
    bChan.stop();

    const aContents = aReceived
      .filter((n) => n.meta.event_type === "assistant_text")
      .map((n) => n.content)
      .join("\n---\n");
    expect(aContents).toContain("Unclosed envelope body line one.");
    expect(aContents).toContain("Unclosed envelope body line two - swallows to end.");
    expect(aContents).not.toContain("a normal directive first");

    const bContents = bReceived
      .filter((n) => n.meta.event_type === "assistant_text")
      .map((n) => n.content)
      .join("\n---\n");
    expect(bContents).toContain("a normal directive first");
    expect(bContents).not.toContain("Unclosed envelope body");
  });

  // Test M (cascade-transparency): an envelope between a colon-cascade opener
  // and its continuation does NOT break the cascade for the original SA, and
  // the envelope's content does not leak to the cascade SA.
  test("envelope is cascade-transparent (does not open/close the colon-cascade)", async () => {
    const pa = makeSession("prime", "f5b8708d", "PA");
    const src = makeSession("subordinate", "50ce0bba", "SA-src");
    const tA = makeSession("subordinate", "abc12345", "SA-A");
    const tB = makeSession("subordinate", "deadbe11", "SA-B");
    writeSession(stateDir, pa);
    writeSession(stateDir, src);
    writeSession(stateDir, tA);
    writeSession(stateDir, tB);

    const srcJsonl = join(projectsHashDir, `${src.session_id}.jsonl`);
    writeFileSync(srcJsonl, "");
    const msg = [
      "@SA-abc12345 do these steps:",
      "",
      "step one for A",
      "",
      "@@@ @SA-deadbe11",
      "this block is only for B",
      "@@@",
      "",
      "step two for A - still in A's cascade, envelope was transparent",
    ].join("\n");
    appendAssistantEvent(srcJsonl, msg);

    const aReceived: ChannelNotification[] = [];
    const bReceived: ChannelNotification[] = [];
    const aChan = new AgentChannel(stateDir, projectsHashDir, tA, (n) => aReceived.push(n));
    const bChan = new AgentChannel(stateDir, projectsHashDir, tB, (n) => bReceived.push(n));
    aChan.start();
    bChan.start();
    await new Promise((r) => setTimeout(r, 50));
    aChan.stop();
    bChan.stop();

    const aContents = aReceived
      .filter((n) => n.meta.event_type === "assistant_text")
      .map((n) => n.content)
      .join("\n---\n");
    expect(aContents).toContain("do these steps");
    expect(aContents).toContain("step one for A");
    expect(aContents).toContain("step two for A - still in A's cascade");
    expect(aContents).not.toContain("this block is only for B");

    const bContents = bReceived
      .filter((n) => n.meta.event_type === "assistant_text")
      .map((n) => n.content)
      .join("\n---\n");
    expect(bContents).toContain("this block is only for B");
    expect(bContents).not.toContain("step one for A");
    expect(bContents).not.toContain("do these steps");
  });
});
