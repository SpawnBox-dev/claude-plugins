// Force :memory: DB path BEFORE agent_channel_state loads - see the note in
// agent_channel_routing.test.ts (bun:sqlite holds the file handle on Windows).
process.env.ORCHESTRATOR_AGENT_CHANNEL_DB_PATH_TEST_ONLY = ":memory:";

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, appendFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { AgentChannel, type ChannelNotification } from "../../mcp/engine/agent_channel";
import { filterEvent, syntheticTurnKind } from "../../mcp/engine/agent_channel_filter";
import {
  writeSession,
  closeAgentChannelDb,
  type SessionEntry,
} from "../../mcp/engine/agent_channel_state";

// ===========================================================================
// WI cb376ece - A TURN THE HARNESS WROTE IS NEVER ROUTED AS SOMEONE'S INPUT.
//
// Claude Code records compaction summaries, background-task notifications,
// Stop-hook feedback and scheduled prompts as top-level `user` records with a
// string body: the same shape as something Jarid typed. The filter forwarded
// them all as `user_input`, and the addressing parser then routed any
// `@SA-<id8>` the text happened to contain. The record shapes below are copied
// from the two live specimens (fields trimmed, values kept).
// ===========================================================================

/** Specimen 1: PA's post-compaction summary, 2026-09-28 05:56:31Z, routed as
 *  emit muku4py5-fl-8nu to the lanes its text mentioned. */
function compactionSummary(text: string, turnOrigin = "peer"): any {
  return {
    type: "user",
    isSidechain: false,
    isVisibleInTranscriptOnly: true,
    isCompactSummary: true,
    turnOrigin,
    timestamp: new Date().toISOString(),
    message: {
      role: "user",
      content:
        "This session is being continued from a previous conversation that ran out of context. " +
        "The summary below covers the earlier portion of the conversation.\n\nSummary:\n" + text,
    },
  };
}

/** Specimen 2: VIDEO's Monitor event, 2026-09-28 06:04:04Z, routed to PA as
 *  emit mukue0oz-krt-ti5. */
function taskNotification(event: string): any {
  return {
    type: "user",
    isSidechain: false,
    origin: { kind: "task-notification" },
    promptSource: "system",
    turnOrigin: "task_notification",
    queueSkipAttachments: true,
    timestamp: new Date().toISOString(),
    message: {
      role: "user",
      content:
        "<task-notification>\n<task-id>bu3khqyza</task-id>\n" +
        `<summary>Monitor event: "VM guard v3"</summary>\n<event>${event}</event>\n</task-notification>`,
    },
  };
}

/** The same class, found by the census: Stop-hook feedback injected as a turn. */
function stopHookFeedback(text: string): any {
  return {
    type: "user",
    isMeta: true,
    timestamp: new Date().toISOString(),
    message: { role: "user", content: `Stop hook feedback:\n${text}` },
  };
}

/** The same class, found by the census: a scheduled (cron) prompt. */
function scheduledPrompt(text: string): any {
  return {
    type: "user",
    isMeta: true,
    promptSource: "system",
    turnOrigin: "scheduled",
    timestamp: new Date().toISOString(),
    message: { role: "user", content: text },
  };
}

/** What a person typing at the prompt produces (census: promptSource typed). */
function typedByHuman(text: string): any {
  return {
    type: "user",
    promptSource: "typed",
    origin: { kind: "human" },
    turnOrigin: "human",
    timestamp: new Date().toISOString(),
    message: { role: "user", content: text },
  };
}

describe("cb376ece: filterEvent drops turns the harness wrote", () => {
  test("SPECIMEN 1: a compaction summary is not user_input", () => {
    const raw = compactionSummary("9. Optional Next Step: @SA-2f7c0e1a rule on W1's block with option (a)");
    expect(syntheticTurnKind(raw)).toBe("compaction_summary");
    expect(filterEvent(raw)).toBeNull();
  });

  test("SPECIMEN 1, the case turnOrigin would miss: a summary of a turn a HUMAN started", () => {
    // 5 of 303 summaries in the census carried turnOrigin:"human".
    expect(filterEvent(compactionSummary("@SA-2f7c0e1a go", "human"))).toBeNull();
  });

  test("SPECIMEN 2: a background-task notification is not user_input", () => {
    const raw = taskNotification("HOLD ON (build 1 procs, file no) at 06:04:04Z");
    expect(syntheticTurnKind(raw)).toBe("task_notification");
    expect(filterEvent(raw)).toBeNull();
  });

  test("same class: Stop-hook feedback and a scheduled prompt are not user_input", () => {
    expect(filterEvent(stopHookFeedback("[orch] @SA-2f7c0e1a housekeeping"))).toBeNull();
    expect(filterEvent(scheduledPrompt("RELEASE 1-5-5 status tick. @SA-2f7c0e1a"))).toBeNull();
    // promptSource:"system" is redundant on the census (every record carrying
    // it also carried origin or isMeta); it is kept because it is the
    // harness's own statement of provenance. This pins that it is read.
    expect(syntheticTurnKind(scheduledPrompt("tick"))).toBe("system_prompt");
    expect(syntheticTurnKind(stopHookFeedback("x"))).toBe("meta");
  });

  test("CONTROL: text a person typed still routes, including a pasted summary-looking line", () => {
    const ev = filterEvent(typedByHuman("PA, This session is being continued - what do you make of it?"));
    expect(ev?.event_type).toBe("user_input");
    expect(syntheticTurnKind(typedByHuman("hi"))).toBeNull();
  });

  test("CONTROL: a record with no provenance fields (older transcripts, /clear) still routes", () => {
    const ev = filterEvent({ type: "user", message: { content: "<command-name>/clear</command-name>" } });
    expect(ev?.event_type).toBe("user_input");
  });
});

// ── The router: an @-address inside a synthetic turn is never delivered ──────

const PROJECT_HASH = "fixture-project";
let baseDir: string;
let projectsHashDir: string;
let stateDir: string;

beforeEach(() => {
  baseDir = mkdtempSync(join(tmpdir(), "synthetic-turns-"));
  projectsHashDir = join(baseDir, "claude-projects", PROJECT_HASH);
  stateDir = join(baseDir, "project", ".orchestrator-state", "agent-channel");
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
    started_at: new Date(Date.now() - 60_000).toISOString(),
    last_heartbeat_at: new Date().toISOString(),
  };
}

const file = (sid: string) => join(projectsHashDir, `${sid}.jsonl`);
const append = (sid: string, rec: any) => appendFileSync(file(sid), JSON.stringify(rec) + "\n");

/** A PA and a lane, each with a transcript, and a live watcher for `receiver`. */
function fleet(receiver: "pa" | "sa") {
  const pa = makeSession("prime", "aaaaaaaa", "PA-test");
  const sa = makeSession("subordinate", "bbbbbbbb", "SA-LANE");
  writeSession(stateDir, pa);
  writeSession(stateDir, sa);
  writeFileSync(file(pa.session_id), "");
  writeFileSync(file(sa.session_id), "");
  const rx: ChannelNotification[] = [];
  const chan = new AgentChannel(stateDir, projectsHashDir, receiver === "pa" ? pa : sa, (n) => rx.push(n));
  (chan as any).tick(); // first sight
  (chan as any).tick(); // backfill pass
  return { pa, sa, rx, tick: () => (chan as any).tick() };
}

const userInputFrom = (rx: ChannelNotification[], sid: string) =>
  rx.filter((n) => n.meta.from_session === sid && n.meta.event_type === "user_input");

describe("cb376ece: the router never delivers a synthetic turn", () => {
  test("SPECIMEN 1: PA's compaction summary naming @SA-bbbbbbbb does not reach that lane", () => {
    const { pa, rx, tick } = fleet("sa");
    // A summary quotes the directives it carried as bullet lines, and a
    // line-leading bullet IS an addressing context (addressing.ts ADDRESS_RE).
    // A mid-sentence "@SA-..." would not route even before the fix, so a
    // fixture shaped that way could not fail - it was the first draft of this
    // test, and it passed against the unfixed filter.
    append(
      pa.session_id,
      compactionSummary("9. Optional Next Step:\n- @SA-bbbbbbbb (W2): rule on W1's block with option (a)"),
    );
    tick();
    expect(userInputFrom(rx, pa.session_id)).toHaveLength(0);
  });

  test("CONTROL for specimen 1: the same address typed by a person in PA's terminal IS delivered", () => {
    const { pa, rx, tick } = fleet("sa");
    append(pa.session_id, typedByHuman("9. Optional Next Step:\n- @SA-bbbbbbbb (W2): rule on W1's block with option (a)"));
    tick();
    expect(userInputFrom(rx, pa.session_id)).toHaveLength(1);
  });

  test("SPECIMEN 2: a lane's task notification does not reach PA as that lane's input", () => {
    const { sa, rx, tick } = fleet("pa");
    append(sa.session_id, taskNotification("HOLD ON (build 1 procs, file no) at 06:04:04Z"));
    tick();
    expect(userInputFrom(rx, sa.session_id)).toHaveLength(0);
  });

  test("CONTROL for specimen 2: a person typing in the lane's terminal IS delivered to PA", () => {
    const { sa, rx, tick } = fleet("pa");
    append(sa.session_id, typedByHuman("PA, hold the VM until the build finishes"));
    tick();
    expect(userInputFrom(rx, sa.session_id)).toHaveLength(1);
  });
});
