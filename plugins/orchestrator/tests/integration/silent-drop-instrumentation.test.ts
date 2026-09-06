process.env.ORCHESTRATOR_AGENT_CHANNEL_DB_PATH_TEST_ONLY = ":memory:";

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, appendFileSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { AgentChannel, type ChannelNotification } from "../../mcp/engine/agent_channel";
import { looksRoutableAssistantText } from "../../mcp/engine/agent_channel_filter";
import {
  writeSession,
  closeAgentChannelDb,
  type SessionEntry,
} from "../../mcp/engine/agent_channel_state";

// ===========================================================================
// WI 6cf7437a - THE TWO SILENT PATHS.
//
// Measured twice, unconfounded the second time: a session's assistant text was
// CONSUMED by all four watchers - every offsets row past its end - with no
// emit, no sent, and no enqueue row anywhere. The second specimen sat 23
// minutes clear of any reload, and there were no unknown_sender records in the
// window, so it is not the identity mechanism either. Cost was concrete: it
// was a RE-SEND of an already-lost message, the re-send was lost too, and the
// lane sat idle 40 minutes.
//
// Only two paths in processFile/processEvent can consume a line and record
// NOTHING for a prime receiver, and neither was instrumented:
//   - JSON.parse throws        -> `catch { continue }`, offset already advanced
//   - filterEvent returns null -> `return`, deliberately unlogged because it
//                                 fires on every tool_result line
//
// THESE TESTS EXIST TO PROVE THE DETECTORS CAN FIRE. A detector that cannot
// fire is indistinguishable from one that found nothing, and "the log is
// empty" would then be read as "the channel is healthy" - the exact inversion
// this whole item has been fighting.
// ===========================================================================

const PROJECT_HASH = "fixture-project";

let baseDir: string;
let projectDir: string;
let projectsHashDir: string;
let stateDir: string;

beforeEach(() => {
  baseDir = mkdtempSync(join(tmpdir(), "silent-drop-"));
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

const logRows = () => {
  const p = join(stateDir, "emit-log.jsonl");
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
};

/** PA + one writing peer, first-sight tick done, ready for appends. */
function setup(rx: ChannelNotification[]) {
  const pa = makeSession("prime", "aaaaaaaa", "PA-test");
  const sa = makeSession("subordinate", "bbbbbbbb", "SA-writer");
  writeSession(stateDir, pa);
  writeSession(stateDir, sa);
  const saJsonl = join(projectsHashDir, `${sa.session_id}.jsonl`);
  writeFileSync(join(projectsHashDir, `${pa.session_id}.jsonl`), "");
  writeFileSync(saJsonl, "");
  const chan = new AgentChannel(stateDir, projectsHashDir, pa, (n) => rx.push(n));
  (chan as any).tick(); // first-sight EOF-init
  return { chan, saJsonl };
}

describe("parse_failed: a line that cannot be parsed is recorded, not silently skipped", () => {
  test("FIRES on a malformed line, and records where it was", () => {
    const rx: ChannelNotification[] = [];
    const { chan, saJsonl } = setup(rx);
    appendFileSync(saJsonl, `{"type":"assistant","message":{"content":[{"type":"text","text":\n`);
    (chan as any).tick();

    const rows = logRows().filter((r) => r.event === "parse_failed");
    expect(rows.length).toBe(1);
    expect(rows[0].sender_id8).toBe("bbbbbbbb");
    expect(typeof rows[0].src_offset).toBe("number");
    // The detail carries the parser's own complaint, so a reader can tell a
    // truncation from an encoding problem without re-deriving it.
    expect(typeof rows[0].detail).toBe("string");
    expect(rows[0].detail.length).toBeGreaterThan(0);
  });

  test("the offset STILL advances - the log records the loss, it does not prevent it", () => {
    // Being explicit that this is instrumentation and not a fix. Holding the
    // offset was considered and rejected: it wedges forever on a transcript
    // from a session that never registered.
    const rx: ChannelNotification[] = [];
    const { chan, saJsonl } = setup(rx);
    appendFileSync(saJsonl, `{not json\n`);
    (chan as any).tick();
    const first = logRows().filter((r) => r.event === "parse_failed").length;
    (chan as any).tick();
    const second = logRows().filter((r) => r.event === "parse_failed").length;
    expect(first).toBe(1);
    expect(second).toBe(1); // not re-read on the next tick
  });

  test("SILENT on well-formed traffic - the negative control", () => {
    // Without this the arm above passes on a detector that fires on everything.
    const rx: ChannelNotification[] = [];
    const { chan, saJsonl } = setup(rx);
    appendFileSync(
      saJsonl,
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "hello" }] } }) + "\n",
    );
    (chan as any).tick();
    expect(logRows().filter((r) => r.event === "parse_failed")).toHaveLength(0);
    // ...and it did route, so the fixture exercises the real path.
    expect(logRows().some((r) => r.event === "emit")).toBe(true);
  });
});

describe("filter_dropped: routable prose the filter refused is recorded", () => {
  test("FIRES when an assistant entry carries text but filterEvent says no", () => {
    // filterEvent's assistant branch requires message.content to be an ARRAY.
    // A string body is routable prose to any reader and returns null today -
    // which is a live candidate cause for the measured drops, not a synthetic
    // case invented to make the detector fire.
    const rx: ChannelNotification[] = [];
    const { chan, saJsonl } = setup(rx);
    appendFileSync(
      saJsonl,
      JSON.stringify({ type: "assistant", message: { content: "prose written as a string" } }) + "\n",
    );
    (chan as any).tick();

    const rows = logRows().filter((r) => r.event === "filter_dropped");
    expect(rows.length).toBe(1);
    expect(rows[0].sender_id8).toBe("bbbbbbbb");
    expect(rows[0].event_type).toBe("assistant_text");
    // And nothing was delivered, which is the loss being recorded.
    expect(rx.some((n) => String(n.content).includes("prose written as a string"))).toBe(false);
  });

  test("SILENT on a tool_result entry - the case that would swamp the log", () => {
    // The whole design decision. filterEvent returns null for these constantly
    // and logging them would bury the signal; the narrow predicate must not.
    const rx: ChannelNotification[] = [];
    const { chan, saJsonl } = setup(rx);
    appendFileSync(
      saJsonl,
      JSON.stringify({
        type: "user",
        message: { content: [{ type: "tool_result", tool_use_id: "x", content: "ok" }] },
      }) + "\n",
    );
    (chan as any).tick();
    expect(logRows().filter((r) => r.event === "filter_dropped")).toHaveLength(0);
  });

  test("marks a PEER-OWED drop distinctly from a SELF one", () => {
    // The log runs before self-suppression, so our own routable text that the
    // filter rejects lands here too - and no peer was ever owed that one.
    // Both are real filter bugs and neither should be hidden, but an expected
    // count of ZERO is what makes a single entry a finding, so the two have to
    // be countable apart.
    const rx: ChannelNotification[] = [];
    const { chan, saJsonl } = setup(rx);
    appendFileSync(
      saJsonl,
      JSON.stringify({ type: "assistant", message: { content: "peer prose as a string" } }) + "\n",
    );
    (chan as any).tick();
    const row = logRows().find((r) => r.event === "filter_dropped");
    expect(row).toBeDefined();
    expect(row.detail).toContain("PEER-OWED");
    expect(row.detail).not.toContain("SELF");
  });

  test("a SELF drop is marked SELF, not counted as a peer loss", () => {
    const rx: ChannelNotification[] = [];
    const pa = makeSession("prime", "aaaaaaaa", "PA-test");
    writeSession(stateDir, pa);
    const paJsonl = join(projectsHashDir, `${pa.session_id}.jsonl`);
    writeFileSync(paJsonl, "");
    const chan = new AgentChannel(stateDir, projectsHashDir, pa, (n) => rx.push(n));
    (chan as any).tick();
    // PA's OWN transcript gets routable-but-unfilterable prose.
    appendFileSync(
      paJsonl,
      JSON.stringify({ type: "assistant", message: { content: "my own prose as a string" } }) + "\n",
    );
    (chan as any).tick();
    const row = logRows().find((r) => r.event === "filter_dropped");
    expect(row).toBeDefined();
    expect(row.detail).toContain("SELF");
    expect(row.detail).toContain("no peer was owed this");
  });

  test("SILENT on normal routed prose", () => {
    const rx: ChannelNotification[] = [];
    const { chan, saJsonl } = setup(rx);
    appendFileSync(
      saJsonl,
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "hi" }] } }) + "\n",
    );
    (chan as any).tick();
    expect(logRows().filter((r) => r.event === "filter_dropped")).toHaveLength(0);
  });
});

describe("offset_reset: a vanished offset row is recorded, not a silent EOF jump", () => {
  // THE DETECTOR THAT MATCHES THE MEASURED LOSSES. Verified against the real
  // specimen at 745977db offset 1851702: it parses, it is ARRAY[text], and
  // filterEvent yields assistant_text (4091 ch). So it should have emitted -
  // meaning it was never ITERATED, which the other two detectors cannot see.
  //
  // ROOT-B re-inits to EOF whenever the offset row is undefined. That is right
  // for a new transcript and catastrophic for one whose row disappeared:
  // writeAllOffsets DELETEs rows whose path is absent from the map it is
  // handed, and that map comes from listJsonlFiles(), so one transient readdir
  // miss on this OneDrive-backed directory drops the row.

  test("SILENT on a genuinely new transcript - ROOT-B's legitimate case", () => {
    // The negative control, and it has to come first: without it the positive
    // arm below would pass on a detector that fires on every first sight,
    // which would bury the real signal under every session launch.
    const rx: ChannelNotification[] = [];
    const pa = makeSession("prime", "aaaaaaaa", "PA-test");
    const sa = makeSession("subordinate", "bbbbbbbb", "SA-writer");
    writeSession(stateDir, pa);
    writeSession(stateDir, sa);
    writeFileSync(join(projectsHashDir, `${pa.session_id}.jsonl`), "");
    writeFileSync(join(projectsHashDir, `${sa.session_id}.jsonl`), "backlog\n");
    const chan = new AgentChannel(stateDir, projectsHashDir, pa, (n) => rx.push(n));
    (chan as any).tick();
    expect(logRows().filter((r) => r.event === "offset_reset")).toHaveLength(0);
  });

  test("FIRES when a row this process already tracked disappears", () => {
    const rx: ChannelNotification[] = [];
    const { chan, saJsonl } = setup(rx);

    // Content the watcher would have routed on its next tick...
    appendFileSync(
      saJsonl,
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "about to be skipped" }] } }) + "\n",
    );
    // ...but the row vanishes first (the readdir-miss outcome, reproduced by
    // clearing this receiver's offsets the way writeAllOffsets would).
    const { writeAllOffsets } = require("../../mcp/engine/agent_channel_state");
    writeAllOffsets(stateDir, pa8, {});

    (chan as any).tick();

    const rows = logRows().filter((r) => r.event === "offset_reset");
    expect(rows.length).toBeGreaterThanOrEqual(1);
    const mine = rows.find((r) => r.sender_id8 === "bbbbbbbb");
    expect(mine).toBeDefined();
    expect(typeof mine.src_offset).toBe("number"); // the EOF it jumped to
    expect(mine.detail).toContain("skipped unread");

    // And the loss is real: the text was never delivered.
    expect(rx.some((n) => String(n.content).includes("about to be skipped"))).toBe(false);
  });
});

const pa8 = "aaaaaaaa";

describe("looksRoutableAssistantText - the predicate itself", () => {
  test("true for an array body with non-empty text", () => {
    expect(
      looksRoutableAssistantText({ type: "assistant", message: { content: [{ type: "text", text: "x" }] } }),
    ).toBe(true);
  });

  test("true for a STRING body - the shape filterEvent refuses", () => {
    expect(looksRoutableAssistantText({ type: "assistant", message: { content: "x" } })).toBe(true);
  });

  test("false for whitespace-only text - not a lost message", () => {
    expect(
      looksRoutableAssistantText({ type: "assistant", message: { content: [{ type: "text", text: "   " }] } }),
    ).toBe(false);
    expect(looksRoutableAssistantText({ type: "assistant", message: { content: "  \n " } })).toBe(false);
  });

  test("false for tool_use-only, user entries, and junk", () => {
    expect(
      looksRoutableAssistantText({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash" }] } }),
    ).toBe(false);
    expect(looksRoutableAssistantText({ type: "user", message: { content: "hello" } })).toBe(false);
    expect(looksRoutableAssistantText(null)).toBe(false);
    expect(looksRoutableAssistantText("nonsense")).toBe(false);
    expect(looksRoutableAssistantText({ type: "assistant" })).toBe(false);
  });
});
