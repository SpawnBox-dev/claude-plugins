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

  test("getActiveSiblings does not let a SQL cap drop LIVE peers", () => {
    // Measured on the live fleet 2026-08-11 17:47Z: 7 live siblings, 5 shown.
    // The query was `ORDER BY last_active_at DESC LIMIT 5` and the live filter
    // ran AFTER, so peers were cut by a churning timestamp before liveness was
    // ever considered - and one of the two dropped was the PRIME, mid-publish.
    //
    // The filter must be able to see every live peer; bounding what gets
    // RENDERED is the caller's job, where the true total is still known.
    const now = new Date().toISOString();
    const ids = Array.from({ length: 9 }, (_, i) => `sib${i}-0000-0000-0000-00000000000${i}`);
    for (const id of ids) {
      db.run(
        `INSERT OR REPLACE INTO session_registry (session_id, started_at, last_active_at, current_task)
         VALUES (?, ?, ?, ?)`,
        [id, now, now, "a lane"]
      );
    }
    // All nine are live. A LIMIT-5-then-filter would return at most 5.
    const t = new SessionTracker(db, () => ids);
    expect(t.getActiveSiblings("someone-else").length).toBe(9);
  });

  test("a DEAD peer is still excluded - the live filter must keep working", () => {
    const now = new Date().toISOString();
    const ids = ["aaa-1", "bbb-2", "ccc-3"];
    for (const id of ids) {
      db.run(
        `INSERT OR REPLACE INTO session_registry (session_id, started_at, last_active_at, current_task)
         VALUES (?, ?, ?, ?)`,
        [id, now, now, "a lane"]
      );
    }
    const t = new SessionTracker(db, () => ["aaa-1", "ccc-3"]); // bbb-2 is dead
    const got = t.getActiveSiblings("someone-else").map((r) => r.session_id);
    expect(got.sort()).toEqual(["aaa-1", "ccc-3"]);
  });

  test("migration 25 adds the coherence columns", () => {
    const cols = db.query("PRAGMA table_info(session_registry)").all() as Array<{ name: string }>;
    expect(cols.some((c) => c.name === "warm_context")).toBe(true);
    expect(cols.some((c) => c.name === "hot_path_status")).toBe(true);
  });

  test("hot_path_status persists durably - the field PA's repurposing query reads", () => {
    // The operational one. Without a durable copy, every reload leaves PA
    // reading the whole fleet as unknown, and an unknown lane is
    // indistinguishable from a busy one.
    tracker.persistCoherence(SID, { hot_path_status: "idle-available" });
    const row = db
      .query(`SELECT hot_path_status FROM session_registry WHERE session_id = ?`)
      .get(SID) as { hot_path_status: string };
    expect(row.hot_path_status).toBe("idle-available");
  });

  test("warm_context persists durably as an array", () => {
    tracker.persistCoherence(SID, { warm_context: ["a/path.ts", "b/path.ts"] });
    const row = db
      .query(`SELECT warm_context FROM session_registry WHERE session_id = ?`)
      .get(SID) as { warm_context: string };
    expect(JSON.parse(row.warm_context)).toEqual(["a/path.ts", "b/path.ts"]);
  });

  test("UNDEFINED coherence fields must NOT clear prior values", () => {
    // Same trap as refs, and the same reason: most declarations omit these, so
    // treating absent as "clear" would wipe the durable copy on the next
    // ordinary re-declaration - the identical loss, arriving more slowly.
    tracker.persistCoherence(SID, {
      warm_context: ["kept.ts"],
      hot_path_status: "driving",
    });
    tracker.persistCoherence(SID, {}); // a declaration carrying neither field
    const row = db
      .query(`SELECT warm_context, hot_path_status FROM session_registry WHERE session_id = ?`)
      .get(SID) as { warm_context: string; hot_path_status: string };
    expect(JSON.parse(row.warm_context)).toEqual(["kept.ts"]);
    expect(row.hot_path_status).toBe("driving");
  });

  test("the two fields are independent - setting one leaves the other alone", () => {
    tracker.persistCoherence(SID, { hot_path_status: "parked", warm_context: ["x.ts"] });
    tracker.persistCoherence(SID, { hot_path_status: "driving" });
    const row = db
      .query(`SELECT warm_context, hot_path_status FROM session_registry WHERE session_id = ?`)
      .get(SID) as { warm_context: string; hot_path_status: string };
    expect(row.hot_path_status).toBe("driving");
    expect(JSON.parse(row.warm_context)).toEqual(["x.ts"]);
  });

  test("a pre-migration-25 database does not break the declaration", () => {
    const old = new Database(":memory:");
    applyMigrations(old, "project");
    old.run(`ALTER TABLE session_registry RENAME COLUMN hot_path_status TO hps_removed`);
    const t2 = new SessionTracker(old, () => null);
    old.run(
      `INSERT OR REPLACE INTO session_registry (session_id, started_at, last_active_at)
       VALUES (?, ?, ?)`,
      [SID, new Date().toISOString(), new Date().toISOString()]
    );
    expect(() => t2.persistCoherence(SID, { hot_path_status: "driving" })).not.toThrow();
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
