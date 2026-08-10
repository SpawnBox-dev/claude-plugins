import { describe, test, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { applyMigrations } from "../../mcp/db/schema";
import { SessionTracker } from "../../mcp/engine/session_tracker";

// WI fe4d4acf. Measured on the live fleet 2026-08-10 22:02Z: a plugin reload
// DELETES AND RECREATES every agent-channel session row - all eight started_at
// values were rewritten to the reload minute - taking current_task, refs,
// warm_context and hot_path_status with it.
//
// current_task survived only because session_registry holds a durable copy that
// the repair reads back. refs had no such copy, so a declared pointer set
// vanished on every reload and returned only if the session happened to
// re-declare - and the sessions least likely to re-declare are the parked ones,
// which is the same population every other gap in this area has landed on.

const SID = "aaaaaaaa-1111-2222-3333-444444444444";

function readRefs(db: Database): string | null {
  const row = db
    .query(`SELECT refs FROM session_registry WHERE session_id = ?`)
    .get(SID) as { refs: string | null } | undefined;
  return row?.refs ?? null;
}

describe("durable refs on session_registry", () => {
  let db: Database;
  let tracker: SessionTracker;

  beforeEach(() => {
    db = new Database(":memory:");
    applyMigrations(db, "project");
    tracker = new SessionTracker(db, () => null);
    db.run(
      `INSERT OR REPLACE INTO session_registry (session_id, started_at, last_active_at)
       VALUES (?, ?, ?)`,
      [SID, new Date().toISOString(), new Date().toISOString()]
    );
  });

  test("migration 24 adds the column", () => {
    const cols = db.query("PRAGMA table_info(session_registry)").all() as Array<{ name: string }>;
    expect(cols.some((c) => c.name === "refs")).toBe(true);
  });

  test("a declaration persists its cited ids durably", () => {
    tracker.updateCurrentTask(SID, "ORCH-IMP lane", ["fe4d4acf", "dcc756ec"]);
    expect(JSON.parse(readRefs(db)!)).toEqual(["fe4d4acf", "dcc756ec"]);
  });

  test("UNDEFINED refs must NOT clear a previously declared set", () => {
    // The distinction that matters: most declarations do not pass refs at all,
    // and treating "absent" as "clear it" would wipe the durable copy on the
    // next ordinary re-declaration - reintroducing the very loss this fixes,
    // but slower and harder to spot.
    tracker.updateCurrentTask(SID, "first", ["fe4d4acf"]);
    tracker.updateCurrentTask(SID, "second, no refs argument");
    expect(JSON.parse(readRefs(db)!)).toEqual(["fe4d4acf"]);
  });

  test("an EXPLICIT empty array DOES clear - 'I cite nothing now' is a real statement", () => {
    tracker.updateCurrentTask(SID, "first", ["fe4d4acf"]);
    tracker.updateCurrentTask(SID, "second", []);
    expect(JSON.parse(readRefs(db)!)).toEqual([]);
  });

  test("re-declaring REPLACES rather than accumulating", () => {
    tracker.updateCurrentTask(SID, "first", ["aaaaaaaa", "bbbbbbbb"]);
    tracker.updateCurrentTask(SID, "second", ["cccccccc"]);
    expect(JSON.parse(readRefs(db)!)).toEqual(["cccccccc"]);
  });

  test("the task still updates normally when refs are passed", () => {
    tracker.updateCurrentTask(SID, "a task with refs", ["fe4d4acf"]);
    const row = db
      .query(`SELECT current_task, current_task_at FROM session_registry WHERE session_id = ?`)
      .get(SID) as { current_task: string; current_task_at: string };
    expect(row.current_task).toBe("a task with refs");
    expect(row.current_task_at).not.toBeNull();
  });

  test("a pre-migration-24 database does not break the declaration", () => {
    // The refs write is guarded because partial-DB fixtures exist and older
    // databases upgrade lazily. Losing the durable copy is acceptable; losing
    // the task write would not be.
    const old = new Database(":memory:");
    applyMigrations(old, "project");
    old.run(`ALTER TABLE session_registry RENAME COLUMN refs TO refs_removed`);
    const t2 = new SessionTracker(old, () => null);
    old.run(
      `INSERT OR REPLACE INTO session_registry (session_id, started_at, last_active_at)
       VALUES (?, ?, ?)`,
      [SID, new Date().toISOString(), new Date().toISOString()]
    );
    expect(() => t2.updateCurrentTask(SID, "still works", ["fe4d4acf"])).not.toThrow();
    const row = old
      .query(`SELECT current_task FROM session_registry WHERE session_id = ?`)
      .get(SID) as { current_task: string };
    expect(row.current_task).toBe("still works");
  });
});
