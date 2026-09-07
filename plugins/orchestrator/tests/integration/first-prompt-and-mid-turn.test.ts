process.env.ORCHESTRATOR_AGENT_CHANNEL_DB_PATH_TEST_ONLY = ":memory:";

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  appendFileSync,
  readFileSync,
  existsSync,
} from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { AgentChannel, type ChannelNotification } from "../../mcp/engine/agent_channel";
import { filterEvent } from "../../mcp/engine/agent_channel_filter";
import {
  writeSession,
  closeAgentChannelDb,
  type SessionEntry,
} from "../../mcp/engine/agent_channel_state";

// ===========================================================================
// WI ebd29e32 - THE TWO WAYS A HUMAN'S TYPED MESSAGE NEVER REACHED PA.
//
// Measured 2026-09-06 across three live sessions:
//
//  D1  A session's FIRST typed prompt was lost because Claude Code does not
//      create the transcript until that prompt, then flushes the whole startup
//      block AND the prompt in one burst before the watcher's next 1.5s poll.
//      First sight therefore found a 93,709-byte file and seeded at EOF, with
//      the prompt sitting at byte 11718 - below the seed, never read.
//      The loss scales with STARTUP-CONTEXT VOLUME, so richly-bootstrapped SAs
//      lost it every time and plain sessions never did.
//
//  D2  EVERY message typed while the session was mid-turn was lost, because CC
//      records those as `queue-operation` + `attachment`/`queued_command`
//      rather than as `type:"user"`, and filterEvent had no branch for either.
//      It was a fall-through to `return null`: nothing rejected it, nothing
//      logged it, so it produced no unknown_sender, no parse_failed and no
//      filter_dropped - the three places anyone would have looked.
//
// These tests pin the SHAPE of each specimen, not just the fix, so a later
// refactor that reintroduces either silence fails here.
// ===========================================================================

const PROJECT_HASH = "fixture-project";

let baseDir: string;
let projectDir: string;
let projectsHashDir: string;
let stateDir: string;

beforeEach(() => {
  baseDir = mkdtempSync(join(tmpdir(), "first-prompt-"));
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

function makeSession(
  role: "prime" | "subordinate",
  id8: string,
  name: string,
  startedAt: string,
): SessionEntry {
  return {
    session_id: `${id8}-1234-5678-9abc-def012345678`,
    id8,
    role,
    name,
    started_at: startedAt,
    last_heartbeat_at: new Date().toISOString(),
  };
}

const logRows = () => {
  const p = join(stateDir, "emit-log.jsonl");
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
};

/**
 * Build a transcript on disk BEFORE the channel ever sees it - the situation
 * the fix is about. `setup()` in the sibling suite writes empty files and ticks
 * first, which is the already-tracked case and cannot reproduce either defect.
 */
function seedTranscriptThenStart(
  lines: string[],
  joinIso: string,
  rx: ChannelNotification[],
) {
  const pa = makeSession("prime", "aaaaaaaa", "PA-test", joinIso);
  const sa = makeSession("subordinate", "bbbbbbbb", "SA-writer", joinIso);
  writeSession(stateDir, pa);
  writeSession(stateDir, sa);
  writeFileSync(join(projectsHashDir, `${pa.session_id}.jsonl`), "");
  const saJsonl = join(projectsHashDir, `${sa.session_id}.jsonl`);
  writeFileSync(saJsonl, lines.map((l) => l + "\n").join(""));
  const chan = new AgentChannel(stateDir, projectsHashDir, pa, (n) => rx.push(n));
  (chan as any).tick(); // first sight: seed (at 0 for a backfill, at EOF otherwise)
  (chan as any).tick(); // the backfill pass itself
  return { chan, saJsonl };
}

/**
 * Only the events that came from a TRANSCRIPT LINE. The channel also emits
 * lifecycle notifications (session_joined and friends) on the same callback,
 * and counting those would make every assertion below off-by-the-roster - a
 * green that moves whenever session bookkeeping changes.
 */
const ROUTED = new Set(["user_input", "assistant_text", "tool_use", "summary"]);
const routed = (rx: ChannelNotification[]) =>
  rx.filter((n) => ROUTED.has(n.meta.event_type));

const userRecord = (text: string, ts: string) =>
  JSON.stringify({ type: "user", message: { role: "user", content: text }, timestamp: ts });

const assistantRecord = (text: string, ts: string) =>
  JSON.stringify({
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text }] },
    timestamp: ts,
  });

// ---------------------------------------------------------------------------
// D1 - the first prompt, lost under the opening burst.
// ---------------------------------------------------------------------------

describe("WI ebd29e32 D1 - first prompt beneath the startup burst", () => {
  const JOIN = "2026-09-06T23:46:40.000Z";

  test("the prompt is emitted even though it sat far below EOF at first sight", () => {
    // Reproduces the measured shape: ~93KB of startup context written in the
    // same burst, with the human prompt near the FRONT of the file. Under the
    // old EOF seed this emitted nothing at all.
    const padding = assistantRecord("x".repeat(45_000), "2026-09-06T23:49:46.000Z");
    const lines = [
      assistantRecord("startup context block", "2026-09-06T23:49:45.500Z"),
      userRecord("you're the plugin SA", "2026-09-06T23:49:45.393Z"),
      padding,
      padding,
    ];
    const rx: ChannelNotification[] = [];
    seedTranscriptThenStart(lines, JOIN, rx);

    const prompts = routed(rx).filter((n) => n.content?.includes("you're the plugin SA"));
    expect(prompts.length).toBe(1);
    // And it must arrive as user_input, not swept up as some other class.
    expect(logRows().some(
      (r) => r.event === "emit" && r.event_type === "user_input",
    )).toBe(true);
  });

  test("a record OLDER than the session's join is not replayed", () => {
    // The --resume case in miniature: history that predates this join must stay
    // silent, which is the property that makes reading from offset 0 safe.
    const lines = [
      userRecord("history from a previous run", "2026-09-06T20:00:00.000Z"),
      assistantRecord("also old", "2026-09-06T20:00:01.000Z"),
    ];
    const rx: ChannelNotification[] = [];
    seedTranscriptThenStart(lines, JOIN, rx);

    expect(routed(rx).length).toBe(0);
  });

  test("post-join records in the same file still emit (the floor is not a mute)", () => {
    const lines = [
      userRecord("history from a previous run", "2026-09-06T20:00:00.000Z"),
      assistantRecord("after the new join", "2026-09-06T23:49:45.000Z"),
    ];
    const rx: ChannelNotification[] = [];
    seedTranscriptThenStart(lines, JOIN, rx);

    expect(routed(rx).length).toBe(1);
    expect(routed(rx)[0].content).toContain("after the new join");
  });

  test("content appended DURING the backfill window is not judged by the floor", () => {
    // THE FLAW THIS PINS, found by the ROOT-B and multibyte suites rather than
    // by me: the backfill pass runs a tick after first sight, so live content
    // has usually landed by then. An earlier draft gated that live content by
    // the join floor too, which silently dropped any record without a parseable
    // `timestamp` - reintroducing exactly the class of loss this item removes.
    //
    // Only bytes present at first sight are history. The bound is the file size
    // we measured when we met it, not the clock.
    const pa = makeSession("prime", "aaaaaaaa", "PA-test", JOIN);
    const sa = makeSession("subordinate", "bbbbbbbb", "SA-writer", JOIN);
    writeSession(stateDir, pa);
    writeSession(stateDir, sa);
    writeFileSync(join(projectsHashDir, `${pa.session_id}.jsonl`), "");
    const saJsonl = join(projectsHashDir, `${sa.session_id}.jsonl`);
    // Pre-existing history, and deliberately WITHOUT a timestamp field.
    writeFileSync(
      saJsonl,
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "HISTORICAL-do-not-replay" }] },
      }) + "\n",
    );

    const rx: ChannelNotification[] = [];
    const chan = new AgentChannel(stateDir, projectsHashDir, pa, (n) => rx.push(n));
    (chan as any).tick(); // first sight: untilOffset captured here

    // Live content arrives before the backfill pass, also without a timestamp.
    appendFileSync(
      saJsonl,
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "FRESH-deliver-me" }] },
      }) + "\n",
    );
    (chan as any).tick(); // the backfill pass, which now spans both records

    const contents = routed(rx).map((n) => n.content);
    expect(contents.some((c) => c.includes("FRESH-deliver-me"))).toBe(true);
    expect(contents.some((c) => c.includes("HISTORICAL"))).toBe(false);
  });

  test("a transcript already over the cap is seeded at EOF and SAYS SO", () => {
    // The one case the fix declines to act on. It must announce itself: silence
    // here would be indistinguishable from the bug this replaces.
    const big = assistantRecord("y".repeat(300_000), "2026-09-06T23:49:46.000Z");
    const rx: ChannelNotification[] = [];
    seedTranscriptThenStart([big], JOIN, rx);

    expect(routed(rx).length).toBe(0);
    const skipped = logRows().filter((r) => r.event === "backfill_skipped");
    expect(skipped.length).toBe(1);
    expect(skipped[0].src_offset).toBeGreaterThan(262_144);
  });
});

// ---------------------------------------------------------------------------
// D2 - the mid-turn typed message, which had no branch at all.
// ---------------------------------------------------------------------------

describe("WI ebd29e32 D2 - a message typed mid-turn", () => {
  // The exact triple CC writes, transcribed from the live specimen at byte
  // offsets 604725 / 635937 / 645405 of session 704c0c2c on 2026-09-06.
  const TEXT = "just typing a message here to see if the PA gets it as a test";

  const enqueueRow = {
    type: "queue-operation",
    operation: "enqueue",
    timestamp: "2026-09-06T23:53:13.519Z",
    sessionId: "704c0c2c-2639-4857-a3c8-7b23b4d28fdb",
    content: TEXT,
  };
  const removeRow = {
    type: "queue-operation",
    operation: "remove",
    timestamp: "2026-09-06T23:53:33.181Z",
    sessionId: "704c0c2c-2639-4857-a3c8-7b23b4d28fdb",
    content: TEXT,
    reason: "absorbed_mid_turn",
  };
  const attachmentRow = {
    type: "attachment",
    timestamp: "2026-09-06T23:53:13.519Z",
    attachment: {
      type: "queued_command",
      prompt: TEXT,
      source_uuid: "d2e111a7-71d6-40dd-8ac5-ef973f9148ce",
      commandMode: "prompt",
      origin: { kind: "human" },
      timestamp: "2026-09-06T23:53:13.519Z",
    },
  };

  test("the three-record specimen produces EXACTLY ONE routable event", () => {
    // All three carry the same text. Emitting per matching record would send
    // every mid-turn message to PA three times, so this is the load-bearing
    // assertion of the fix, not a formality.
    const events = [enqueueRow, removeRow, attachmentRow]
      .map((r) => filterEvent(r))
      .filter(Boolean);

    expect(events.length).toBe(1);
    expect(events[0]!.event_type).toBe("user_input");
    expect(events[0]!.content).toContain(TEXT);
  });

  test("it is marked as mid-turn, so PA can tell it from a prompt typed at idle", () => {
    const ev = filterEvent(attachmentRow);
    expect(ev?.content.startsWith("[typed mid-turn] ")).toBe(true);
  });

  test("a queued_command that is NOT human-originated is dropped", () => {
    // Forwarding a machine-injected command would put words in the user's mouth.
    const ev = filterEvent({
      ...attachmentRow,
      attachment: { ...attachmentRow.attachment, origin: { kind: "replay" } },
    });
    expect(ev).toBeNull();
  });

  test("an attachment that is not a queued_command is dropped", () => {
    const ev = filterEvent({
      type: "attachment",
      timestamp: "2026-09-06T23:53:13.519Z",
      attachment: { type: "file", path: "/tmp/x.png" },
    });
    expect(ev).toBeNull();
  });

  test("channel injections arriving through the queue are not re-broadcast", () => {
    // Same echo-prevention the `user` branch has applied since 0.29.9 - a queued
    // command must not become a new way in for content we ourselves delivered.
    for (const prompt of ['<channel source="x">hi</channel>', "← core: something"]) {
      expect(
        filterEvent({
          type: "attachment",
          attachment: { ...attachmentRow.attachment, prompt },
        }),
      ).toBeNull();
    }
  });

  test("NEGATIVE CONTROL: an idle-typed user record is unchanged by this fix", () => {
    // It must still route, still be verbatim, and NOT pick up the mid-turn mark.
    const ev = filterEvent({
      type: "user",
      message: { role: "user", content: "typed while idle" },
      timestamp: "2026-09-06T23:49:45.393Z",
    });
    expect(ev?.event_type).toBe("user_input");
    expect(ev?.content).toBe("typed while idle");
  });

  test("REGRESSION GUARD: the queue-operation rows stay unroutable on their own", () => {
    // They remain the ingress detector's business (agent_channel.ts:669). If a
    // future change starts routing them, the specimen above silently triples.
    expect(filterEvent(enqueueRow)).toBeNull();
    expect(filterEvent(removeRow)).toBeNull();
  });
});
