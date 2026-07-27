import { describe, test, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { applyMigrations } from "../../mcp/db/schema";
import {
  detectsHedge,
  composeScopeRetrievalText,
} from "../../mcp/tools/hook_event";
import { composeBriefing, UPCOMING_HORIZON_DAYS } from "../../mcp/engine/composer";
import { generateId, now } from "../../mcp/utils";

// ===========================================================================
// 0.30.74: the READ side of the orchestrator.
//
// Jarid, unprompted 2026-07-27: agents write to the orchestrator well and read
// from it badly, and the failure moment is SCOPE CHANGE - the agent explores
// code, reports findings, and he has to tell it to go read the KB, git history
// and docs for answers to the questions it just asked him.
//
// Two mechanisms tested here:
//   1. HEDGE DETECTION. Scope change is a vibe; hedging is a string. The
//      asker's own uncertainty markers are the tractable trigger.
//   2. UPCOMING DEADLINES. Dated commitments must surface BEFORE they lapse
//      and regardless of workflow status.
// ===========================================================================

describe("hedge detection (retrieval trigger)", () => {
  test("fires on the asker's uncertainty markers", () => {
    const hedged = [
      "i think we already decided this somewhere",
      "IIRC the daemon handles that",
      "wasn't there a note about the backup path?",
      "didn't we fix this last month?",
      "at some point we changed the DNS lease logic",
      "pretty sure the worker already does this",
      "we used to run that on a cron",
    ];
    for (const p of hedged) {
      expect(detectsHedge(p)).toBe(true);
    }
  });

  test("does NOT fire on confident, well-scoped instructions", () => {
    const confident = [
      "add a busy_timeout pragma to the agent-channel DB",
      "run the test suite and report failures",
      "publish 0.30.74 to the marketplace",
      "the linker caps at 25 edges",
      "",
    ];
    for (const p of confident) {
      expect(detectsHedge(p)).toBe(false);
    }
  });

  test("is case insensitive and tolerates missing apostrophes", () => {
    expect(detectsHedge("Wasnt there a decision about this?")).toBe(true);
    expect(detectsHedge("DIDNT WE ship that already")).toBe(true);
  });
});

describe("scope-retrieval block content", () => {
  test("carries the retrieved notes INLINE, not an instruction to fetch them", () => {
    const text = composeScopeRetrievalText([
      { id: "abcd1234-0000-0000-0000-000000000000", type: "decision", content: "We route telemetry through the broker" },
      { id: "ef567890-0000-0000-0000-000000000000", type: "convention", content: "Never query datapack tables directly" },
    ]);

    // The whole point: the knowledge is present, not requested. A pointer costs
    // the agent a decision it usually declines (PA saw the old lookup pointer
    // dozens of times and never once ran it).
    expect(text).toContain("We route telemetry through the broker");
    expect(text).toContain("Never query datapack tables directly");
    expect(text).toContain("abcd1234");
    expect(text).toContain("retrieved for you");
  });

  test("tells the agent to verify the PREMISE, not just look things up", () => {
    const text = composeScopeRetrievalText([]);
    expect(text).toContain("PREMISE");
    // A hedged question often contains an assumption the repo will correct.
    expect(text.toLowerCase()).toContain("git log");
    expect(text.toLowerCase()).toContain("docs/");
  });

  test("carries the staleness check - the sub-class a lookup nudge cannot fix", () => {
    const text = composeScopeRetrievalText([
      { id: "11112222-0000-0000-0000-000000000000", type: "insight", content: "campaign has 0 clicks so far" },
    ]);
    // SA-90bf73bd's case: it HAD read the note. The note stayed accurate; the
    // conclusion drawn from it expired when the count went 0 -> 297. "Go look
    // it up" would not have helped, because the lookup had happened.
    expect(text).toContain("is it STILL true");
  });
});

describe("UPCOMING deadlines in the briefing", () => {
  let projectDb: Database;
  let globalDb: Database;

  beforeEach(() => {
    projectDb = new Database(":memory:");
    applyMigrations(projectDb, "project");
    globalDb = new Database(":memory:");
    applyMigrations(globalDb, "global");
  });

  function addWorkItem(opts: { content: string; status: string; dueInDays: number }) {
    const id = generateId();
    const ts = now();
    const due = new Date(Date.now() + opts.dueInDays * 86400000)
      .toISOString()
      .slice(0, 10);
    projectDb.run(
      `INSERT INTO notes (id, type, content, context, keywords, tags, confidence, resolved, status, priority, due_date, created_at, updated_at)
       VALUES (?, 'work_item', ?, NULL, '', '', 'medium', 0, ?, 'high', ?, ?, ?)`,
      [id, opts.content, opts.status, due, ts, ts]
    );
    return id;
  }

  test("surfaces a dated item BEFORE it lapses, even in a non-active status", () => {
    // SA-90bf73bd's live case: a CA$600 credit watch filed as `planned`
    // because that is semantically honest - and that honesty hid it from the
    // default "what's active?" sweep. Status and deadlines are orthogonal.
    const plannedId = addWorkItem({
      content: "CA$600 Google Ads credit watch",
      status: "planned",
      dueInDays: 20,
    });
    const proposedId = addWorkItem({
      content: "CA$350 offer qualification",
      status: "proposed",
      dueInDays: 5,
    });

    const briefing = composeBriefing(projectDb, globalDb);
    const ids = briefing.upcoming_work.map((w) => w.id);

    expect(ids).toContain(plannedId);
    expect(ids).toContain(proposedId);
  });

  test("is ordered soonest-first so the tightest deadline reads first", () => {
    addWorkItem({ content: "later thing", status: "planned", dueInDays: 25 });
    addWorkItem({ content: "sooner thing", status: "proposed", dueInDays: 3 });

    const briefing = composeBriefing(projectDb, globalDb);
    expect(briefing.upcoming_work[0].content).toBe("sooner thing");
  });

  test("excludes done items and anything past the horizon", () => {
    addWorkItem({ content: "already handled", status: "done", dueInDays: 4 });
    addWorkItem({
      content: "far future",
      status: "planned",
      dueInDays: UPCOMING_HORIZON_DAYS + 30,
    });

    const briefing = composeBriefing(projectDb, globalDb);
    const contents = briefing.upcoming_work.map((w) => w.content);
    expect(contents).not.toContain("already handled");
    expect(contents).not.toContain("far future");
  });

  test("does not duplicate OVERDUE - upcoming is strictly future-dated", () => {
    addWorkItem({ content: "lapsed already", status: "active", dueInDays: -10 });

    const briefing = composeBriefing(projectDb, globalDb);
    expect(briefing.upcoming_work.map((w) => w.content)).not.toContain("lapsed already");
    expect(briefing.overdue_work.map((w) => w.content)).toContain("lapsed already");
  });
});
