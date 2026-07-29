import { describe, test, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { applyMigrations } from "../../mcp/db/schema";
import { composeBriefing } from "../../mcp/engine/composer";
import { now, generateId } from "../../mcp/utils";

// ===========================================================================
// 0.39.0: SEVERITY IS ORTHOGONAL TO WORKFLOW STATE, and the status filter was
// gating it.
//
// The active sweep every session orients with is `status IN ('active',
// 'planned')`. So a work item marked `critical` and left in `proposed` is
// invisible to the one question anybody asks at session start.
//
// MEASURED 2026-07-29 on the live project DB: 61 critical work_items, SIX of
// them in `proposed`, the oldest open 105 days. Two of the six are
// community-reported bugs with a named person waiting - one reporting world
// corruption and datapack loss, one a Bedrock UDP failure. That is a different
// severity from an internal umbrella going stale.
//
// HOW IT WAS FOUND, which is the part worth keeping: PA's warden asserted a
// work item's stored priority was `high` when the row said `critical`.
// Correcting that ONE ROW took an hour of fleet time. Nobody asked how many
// others were in the same trap until the end, and the answer was a single
// query. Establishing that a mechanism is real and not asking how many things
// it affects leaves the actual exposure unknown.
//
// This mirrors 0.30.74's upcoming_work exactly: that one established that
// status must not gate a DATE, on the same reasoning and after the same kind
// of near-miss (a CA$350 credit expiring silently from `planned`). Severity is
// the second axis; there may be others, and the general rule is that a filter
// chosen for one dimension should not silently suppress another.
// ===========================================================================

function makeDb(type: "project" | "global"): Database {
  const db = new Database(":memory:");
  applyMigrations(db, type);
  return db;
}

function addItem(
  db: Database,
  opts: { content: string; priority?: string; status?: string; resolved?: number; created?: string }
) {
  const ts = opts.created ?? now();
  db.run(
    `INSERT INTO notes (id, type, content, context, keywords, tags, confidence, resolved, status, priority, due_date, created_at, updated_at, source_session)
     VALUES (?, 'work_item', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      generateId(), opts.content, null, "", "work", "high",
      opts.resolved ?? 0, opts.status ?? null, opts.priority ?? null, null, ts, ts, null,
    ]
  );
}

describe("0.39.0: critical work is visible regardless of status", () => {
  let projectDb: Database;
  let globalDb: Database;

  beforeEach(() => {
    projectDb = makeDb("project");
    globalDb = makeDb("global");
  });

  test("THE REAL CASE: critical + proposed is surfaced", () => {
    // The exact shape of all six live items.
    addItem(projectDb, {
      content: "SEVERE: datapacks disappeared and world partially corrupt",
      priority: "critical",
      status: "proposed",
    });
    const b = composeBriefing(projectDb, globalDb);
    expect(b.critical_work.length).toBe(1);
    expect(b.critical_work[0].content).toContain("SEVERE");

    // And confirm it is genuinely absent from the sweep that hid it - so this
    // test fails if someone "fixes" the problem by widening active_work
    // instead, which would change a different behaviour.
    expect(b.active_work.length).toBe(0);
  });

  test("does NOT duplicate items the active sweep already shows", () => {
    // Noise control. A critical item in `active` is already the first thing in
    // Work Items; listing it twice makes the new section look like filler and
    // gets the whole block skimmed.
    addItem(projectDb, { content: "already visible", priority: "critical", status: "active" });
    addItem(projectDb, { content: "also visible", priority: "critical", status: "planned" });
    const b = composeBriefing(projectDb, globalDb);
    expect(b.critical_work.length).toBe(0);
    expect(b.active_work.length).toBe(2);
  });

  test("excludes done and resolved - finished work is not hidden work", () => {
    addItem(projectDb, { content: "shipped", priority: "critical", status: "done" });
    addItem(projectDb, { content: "closed out", priority: "critical", status: "proposed", resolved: 1 });
    const b = composeBriefing(projectDb, globalDb);
    expect(b.critical_work.length).toBe(0);
  });

  test("does not fire on lower priorities - critical only, or it becomes a second work list", () => {
    addItem(projectDb, { content: "high but proposed", priority: "high", status: "proposed" });
    addItem(projectDb, { content: "medium but blocked", priority: "medium", status: "blocked" });
    const b = composeBriefing(projectDb, globalDb);
    expect(b.critical_work.length).toBe(0);
  });

  test("catches statuses nobody has invented yet, not just 'proposed'", () => {
    // Written as NOT IN (active, planned, done) rather than = 'proposed' on
    // purpose: the defect is the sweep's allowlist, so the fix must be its
    // complement. A future status would otherwise reintroduce the same hole
    // silently.
    addItem(projectDb, { content: "awaiting-diag item", priority: "critical", status: "awaiting-diag" });
    addItem(projectDb, { content: "no status at all", priority: "critical", status: undefined });
    const b = composeBriefing(projectDb, globalDb);
    expect(b.critical_work.length).toBe(2);
  });

  test("oldest first - age is the argument, and it is capped", () => {
    addItem(projectDb, { content: "newer", priority: "critical", status: "proposed", created: "2026-06-01T00:00:00.000Z" });
    addItem(projectDb, { content: "oldest", priority: "critical", status: "proposed", created: "2026-04-15T00:00:00.000Z" });
    for (let i = 0; i < 15; i++) {
      addItem(projectDb, { content: `filler ${i}`, priority: "critical", status: "proposed" });
    }
    const b = composeBriefing(projectDb, globalDb);
    expect(b.critical_work[0].content).toBe("oldest");
    expect(b.critical_work.length).toBeLessThanOrEqual(10);
  });

  test("empty when there is nothing hidden - no ceremony on a clean KB", () => {
    addItem(projectDb, { content: "normal work", priority: "high", status: "active" });
    const b = composeBriefing(projectDb, globalDb);
    expect(b.critical_work).toEqual([]);
  });
});
