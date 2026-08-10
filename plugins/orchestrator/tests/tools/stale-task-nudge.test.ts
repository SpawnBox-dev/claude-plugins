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

  test("SILENT when the declaration predates migration 23", () => {
    // A NULL timestamp means "set before we tracked this" - unknowable age,
    // and it must not be guessed at.
    seed(db, "a task from before the column existed", null);
    expect(takeTurns(ctx, TURNS + 5)).toBe("");
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
