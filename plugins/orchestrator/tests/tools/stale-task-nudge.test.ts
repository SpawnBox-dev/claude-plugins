import { describe, test, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { applyMigrations } from "../../mcp/db/schema";
import {
  renderCompactRoster,
  tickStaleTaskDeclaration,
  tickStaleTaskAction,
  type CompactPeer,
} from "../../mcp/tools/hook_event";

// WI 7844a909 + e3a58e10.
//
// Jarid: "are you planning to somehow address the fact that agents don't
// maintain their running notes/records like they should?" ... "there must be a
// way to make this smart and efficient so its as up to date as possible, but
// intermittently injected so it can't be classified as noise".
//
// NAGGING HAS ALREADY FAILED, WITH EVIDENCE: the plugin injects a reminder on
// EVERY turn, and under that regime PA's own declaration went TWO DAYS stale
// (describing 0.44.x while the fleet ran 0.56.0). Volume is not the lever.
//
// TURNS, NOT WALL-CLOCK (Jarid's refinement, and it is the better signal):
// drift happens when what a session is DOING diverges from what it SAID, and
// doing is measured in turns. Six idle hours change nothing; forty turns in one
// hour can change everything. Turn-counting also removes the parked-session
// false positive for free - no turns accumulate, so nothing fires.
//
// Researched against code.claude.com/docs/en/hooks (2026-08-10): PreCompact
// cannot carry this (synchronous, no model turn before compaction), so `Stop`
// is the only event where an actionable nudge survives into the next turn.

const SID = "11111111-2222-3333-4444-555555555555";
const TURNS = 30; // must track STALE_TASK_TURNS

function seed(db: Database, task: string | null, declaredAt: string | null) {
  db.run(
    `INSERT OR REPLACE INTO session_registry
       (session_id, started_at, last_active_at, current_task, current_task_at)
     VALUES (?, ?, ?, ?, ?)`,
    [SID, new Date().toISOString(), new Date().toISOString(), task, declaredAt]
  );
}

/** Take n turns; returns whatever the last one produced. */
function takeTurns(ctx: any, n: number): string {
  let out = "";
  for (let i = 0; i < n; i++) out = tickStaleTaskDeclaration(ctx, SID);
  return out;
}

describe("turn-based staleness nudge: up to date, but intermittent", () => {
  let db: Database;
  let ctx: any;
  beforeEach(() => {
    db = new Database(":memory:");
    applyMigrations(db, "project");
    ctx = { db, tracker: null };
  });

  test("SILENT for the first 29 turns", () => {
    // The control that matters most. If this ever fails the nudge has become
    // per-turn chrome and is worse than nothing.
    seed(db, "ORCH-IMP: fixing the roster", new Date().toISOString());
    expect(takeTurns(ctx, TURNS - 1)).toBe("");
  });

  test("FIRES on the 30th turn", () => {
    seed(db, "ORCH-IMP: shipped 0.44.0 + 0.44.1", new Date().toISOString());
    const out = takeTurns(ctx, TURNS);
    expect(out).not.toBe("");
    expect(out).toContain("update_session_task");
    expect(out).toContain("0.44.0"); // quotes the stale text back at the reader
    expect(out).toContain("30 turns old");
  });

  test("RESETS after firing - intermittent, not every turn from then on", () => {
    // Without the reset the counter keeps climbing and every subsequent turn
    // fires. That is the exact failure mode this design exists to avoid.
    seed(db, "some task", new Date().toISOString());
    expect(takeTurns(ctx, TURNS)).not.toBe("");
    expect(tickStaleTaskDeclaration(ctx, SID)).toBe(""); // turn 31
    expect(takeTurns(ctx, TURNS - 2)).toBe(""); // ...through 59
    expect(tickStaleTaskDeclaration(ctx, SID)).not.toBe(""); // 60: next interval
  });

  test("a PARKED session is never nudged - no turns, no firing", () => {
    // Wall-clock would fire here (declared long ago); turns do not, because the
    // session has done nothing its declaration could have drifted from.
    seed(db, "reserve, idle-available", "2026-08-01T00:00:00.000Z");
    expect(tickStaleTaskDeclaration(ctx, SID)).toBe("");
  });

  test("SILENT when no task was ever declared", () => {
    // A different ask, already covered by the briefing.
    seed(db, null, null);
    expect(takeTurns(ctx, TURNS + 5)).toBe("");
  });

  test("ARMS a declaration that predates migration 23, instead of ignoring it forever", () => {
    // CHANGED in 0.58.0 (WI 40d09574). This test previously asserted permanent
    // silence for a NULL timestamp, and that assertion was the bug: measured on
    // the live fleet, 16 of 18 rows had a task and no timestamp, so the nudge
    // was DORMANT for every session that declared before the upgrade. Nothing
    // errored - it simply never fired, which is why it went unnoticed.
    //
    // The original reasoning still holds and is preserved: an unknowable age
    // must not be guessed at. So the first tick stamps NOW as an OBSERVATION
    // time and stays silent; the clock starts fresh from there. The nudge lands
    // up to a full interval late and never early.
    seed(db, "a task from before the column existed", null);

    expect(tickStaleTaskDeclaration(ctx, SID)).toBe(""); // arms, does not fire
    const stamped = db
      .query(`SELECT current_task_at FROM session_registry WHERE session_id = ?`)
      .get(SID) as { current_task_at: string | null };
    expect(stamped.current_task_at).not.toBeNull();

    // ...and from a fresh clock it now behaves like any armed session.
    expect(takeTurns(ctx, TURNS - 1)).toBe("");
    expect(tickStaleTaskDeclaration(ctx, SID)).not.toBe("");
  });

  test("arming NEVER back-dates - a fleet-wide nudge burst is the failure to avoid", () => {
    // Stamping started_at (or any inferred earlier time) would make every
    // pre-upgrade session instantly overdue and fire at once on the next tick.
    // The stamp must be no earlier than the moment we first saw the row.
    const before = new Date().toISOString();
    seed(db, "old declaration", null);
    tickStaleTaskDeclaration(ctx, SID);
    const { current_task_at: at } = db
      .query(`SELECT current_task_at FROM session_registry WHERE session_id = ?`)
      .get(SID) as { current_task_at: string };
    expect(at >= before).toBe(true);
  });

  test("REGRESSION PIN: the roster repair writes NO once-per-session flag", () => {
    // 0.58.0 gated this repair on a `task_mirrored_<sid>` plugin_state flag, so
    // it could run only once per session id. A session id SURVIVES A PLUGIN
    // RELOAD, and a reload DELETES AND RECREATES the agent-channel row - so
    // after the wipe the flag was already set and the repair could never fire
    // again. Measured on the live fleet at 22:02Z: 7 of 8 sessions had a NULL
    // roster task, all 8 still had the task in session_registry, and every one
    // had `task_mirrored_` stamped at the PREVIOUS reload. The repair was
    // structurally unable to run in exactly the situation it was written for.
    //
    // The guard is now DERIVED FROM STATE ("is the mirror empty?"), which
    // cannot go stale. If a flag guard ever comes back, this test fails.
    seed(db, "a task", new Date().toISOString());
    takeTurns(ctx, TURNS + 5);
    const flags = db
      .query(`SELECT COUNT(*) AS n FROM plugin_state WHERE key LIKE 'task_mirrored_%'`)
      .get() as { n: number };
    expect(flags.n).toBe(0);
  });

  test("an unknown session is silent, not an error", () => {
    expect(tickStaleTaskDeclaration(ctx, "no-such-session")).toBe("");
  });

  test("re-declaring resets the counter", () => {
    // The escape hatch the nudge text promises: "re-declaring costs one call
    // and resets this". If it did not hold, the advice would be false.
    seed(db, "task A", new Date().toISOString());
    takeTurns(ctx, TURNS - 1);
    db.run(`INSERT OR REPLACE INTO plugin_state (key, value, updated_at) VALUES (?, '0', ?)`, [
      `task_turns_${SID}`,
      new Date().toISOString(),
    ]);
    expect(tickStaleTaskDeclaration(ctx, SID)).toBe("");
  });
});

describe("records checkpoint: the shipped-but-still-queued blind spot", () => {
  let db: Database;
  let ctx: any;
  beforeEach(() => {
    db = new Database(":memory:");
    applyMigrations(db, "project");
    ctx = { db, tracker: null };
    seed(db, "ORCH-IMP: building the records checkpoint", new Date().toISOString());
  });

  function seedItem(id: string, status: string, content: string, session = SID) {
    db.run(
      `INSERT OR REPLACE INTO notes (id, type, content, status, source_session, created_at, updated_at)
       VALUES (?, 'work_item', ?, ?, ?, ?, ?)`,
      [id, content, status, session, new Date().toISOString(), new Date().toISOString()]
    );
  }

  test("names an item left at 'planned' - the case nothing else can see", () => {
    // The whole reason this exists: listInFlightWorkItemsForSession EXCLUDES
    // proposed/planned, so an item shipped straight from its birth status never
    // passes through the in-flight check and no other nudge will ever mention
    // it. Lived: two of the authoring session's own items were exactly this.
    seedItem("40d09574-aaaa-bbbb-cccc-dddddddddddd", "planned", "Staleness nudge cold start");
    const out = takeTurns(ctx, TURNS);
    expect(out).toContain("40d09574");
    expect(out).toContain("[planned]");
    expect(out).toContain("still read as not-yet-started");
  });

  test("does NOT duplicate loop-close: an in-flight item is not named here", () => {
    // Two nudges naming the same item is how a rare signal becomes noise.
    seedItem("11111111-aaaa-bbbb-cccc-dddddddddddd", "in_progress", "actively being worked");
    expect(takeTurns(ctx, TURNS)).not.toContain("11111111");
  });

  test("ignores the project backlog - only what THIS session touched", () => {
    // Naming items an agent merely read about in a briefing was the documented
    // over-fire that R7.6 removed; do not reintroduce it here.
    seedItem("22222222-aaaa-bbbb-cccc-dddddddddddd", "planned", "someone else's item", "other-session");
    expect(takeTurns(ctx, TURNS)).not.toContain("22222222");
  });

  test("an UNCHANGED set is suppressed at the next firing", () => {
    // The failure this prevents is documented in note 60f2fdc2: a nudge that
    // named one long-lived item ~30 times taught PA to stop reading it by turn
    // ten. A genuinely-deferred item must not become wallpaper.
    seedItem("33333333-aaaa-bbbb-cccc-dddddddddddd", "planned", "deferred on purpose");
    expect(takeTurns(ctx, TURNS)).toContain("33333333");
    expect(takeTurns(ctx, TURNS)).not.toContain("33333333"); // second interval
  });

  test("a CHANGED set renders again immediately", () => {
    // Suppression must not swallow new information - that would trade one
    // failure for a worse one.
    seedItem("44444444-aaaa-bbbb-cccc-dddddddddddd", "planned", "first item");
    expect(takeTurns(ctx, TURNS)).toContain("44444444");
    seedItem("55555555-aaaa-bbbb-cccc-dddddddddddd", "planned", "a NEW item appeared");
    expect(takeTurns(ctx, TURNS)).toContain("55555555");
  });

  test("closing the item silences it", () => {
    seedItem("66666666-aaaa-bbbb-cccc-dddddddddddd", "planned", "will be closed");
    expect(takeTurns(ctx, TURNS)).toContain("66666666");
    db.run(`UPDATE notes SET status = 'done' WHERE id LIKE '66666666%'`);
    expect(takeTurns(ctx, TURNS)).not.toContain("66666666");
  });

  test("BOUNDED at 3 - the checkpoint stays readable", () => {
    for (let i = 0; i < 6; i++) {
      seedItem(`7777777${i}-aaaa-bbbb-cccc-dddddddddddd`, "planned", `queued item ${i}`);
    }
    const out = takeTurns(ctx, TURNS);
    const named = (out.match(/\*\*7777777\d\*\*/g) ?? []).length;
    expect(named).toBeLessThanOrEqual(3);
  });

  test("the ask is OPEN, not a checklist - it must not cap the work at what we can see", () => {
    // Jarid: "i don't want to limit its scope by telling it what specifically
    // to update, the agent should reason over the things it knows it should be
    // maintaining." The named items are EVIDENCE that drift is real (which is
    // what earns the interruption, per 60f2fdc2); the instruction that follows
    // must stay open, because the plugin can only see a fraction of what any
    // given lane actually maintains.
    seedItem("88888888-aaaa-bbbb-cccc-dddddddddddd", "planned", "an item");
    const out = takeTurns(ctx, TURNS);
    expect(out).toContain("do your own pass");
    expect(out).toContain("not the list");
  });

  test("the open ask is present even with nothing else to report", () => {
    // If it only appeared alongside findings, the checkpoint would silently
    // degrade to a single-field reminder in exactly the sessions whose records
    // the plugin cannot see - the ones that need the open pass most.
    const out = takeTurns(ctx, TURNS);
    expect(out).toContain("do your own pass");
  });

  test("with no touched items the checkpoint is just the task line", () => {
    // No work items seeded - the nudge must not render an empty section header.
    const out = takeTurns(ctx, TURNS);
    expect(out).toContain("update_session_task");
    expect(out).not.toContain("still read as not-yet-started");
  });
});

describe("WI e3a58e10: liveness reaches the roster PA rebuilds from", () => {
  test("a SUSPECT peer is flagged", () => {
    const peers: CompactPeer[] = [
      { id8: "aaaaaaaa", current_task: "FIXER lane", liveness_state: "ingress_suspect" },
    ];
    const out = renderCompactRoster(peers);
    expect(out).toContain("[ingress_suspect]");
    expect(out).toContain("FIXER lane");
  });

  test("a HEALTHY peer is NOT annotated - absence means reachable", () => {
    // Printing "healthy" on every line trains the reader to skip the column,
    // which is exactly when the one suspect line gets missed.
    const peers: CompactPeer[] = [
      { id8: "bbbbbbbb", current_task: "CREATOR lane", liveness_state: "healthy" },
    ];
    expect(renderCompactRoster(peers)).not.toContain("[healthy]");
  });

  test("null liveness degrades to the previous rendering", () => {
    const peers: CompactPeer[] = [{ id8: "cccccccc", current_task: "VMTEST" }];
    expect(renderCompactRoster(peers)).toBe("  - SA-cccccccc: VMTEST");
  });

  test("the client-transport state surfaces, task or no task", () => {
    const peers: CompactPeer[] = [
      { id8: "dddddddd", current_task: null, liveness_state: "client_transport_suspect" },
    ];
    const out = renderCompactRoster(peers);
    expect(out).toContain("[client_transport_suspect]");
    expect(out).toContain("(no task set)");
  });
});

describe("ACTION trigger: reaches a long autonomous run that never hands back", () => {
  let db: Database;
  let ctx: any;
  beforeEach(() => {
    db = new Database(":memory:");
    applyMigrations(db, "project");
    ctx = { db, tracker: null };
  });

  const ACTIONS = 60; // must track STALE_TASK_ACTIONS

  test("FIRES on the Nth substantive action, with ZERO hand-backs", () => {
    // The gap this closes: Claude Code runs long stretches without a Stop, so
    // the turn counter can sit at 0 for hours while a lot of work happens.
    seed(db, "ORCH-IMP: one long autonomous task", new Date().toISOString());
    let out = "";
    for (let i = 0; i < ACTIONS; i++) out = tickStaleTaskAction(ctx, SID);
    expect(out).toContain("update_session_task");
    expect(out).toContain("60 actions old");
  });

  test("SILENT well into focused work - one feature is not an interruption", () => {
    seed(db, "a focused task", new Date().toISOString());
    let out = "";
    for (let i = 0; i < 40; i++) out = tickStaleTaskAction(ctx, SID);
    expect(out).toBe("");
  });

  test("firing resets the TURN counter too - one nudge, not two", () => {
    // Both triggers describe the same drift. If only its own counter reset, the
    // other would fire moments later for something already corrected.
    seed(db, "task", new Date().toISOString());
    for (let i = 0; i < 29; i++) tickStaleTaskDeclaration(ctx, SID); // turns primed at 29
    let out = "";
    for (let i = 0; i < ACTIONS; i++) out = tickStaleTaskAction(ctx, SID);
    expect(out).not.toBe(""); // action trigger fired
    expect(tickStaleTaskDeclaration(ctx, SID)).toBe(""); // turn counter was reset, not at 30
  });
});
