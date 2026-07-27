import { describe, test, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { applyMigrations } from "../../mcp/db/schema";
import { composeBriefing } from "../../mcp/engine/composer";
import { mergeDuplicates } from "../../mcp/engine/deduplicator";
import { generateId, now } from "../../mcp/utils";

// ===========================================================================
// 0.30.92: the briefing timeout, and the maintenance pass that never ran.
//
// Four of six sessions reported briefing() blowing the 120s tool budget - the
// one call every session must make before it is allowed to respond. Found by
// COUNTERFACTUAL (timing sections against a copy of the live DB), not by
// reading code: work_items / open_threads / decisions were ~0.1s each while
// `neglected` ALONE exceeded 240s.
//
// Root cause was an N+1 with a leading-wildcard LIKE: one full-table scan per
// distinct tag, 8,888 tags over 6,827 notes. Measured after the fix: 0.07s,
// full briefing 0.22s.
//
// Separately: mergeDuplicates threw SQLITE_CONSTRAINT_UNIQUE on the live data
// because links carries UNIQUE(from,to,relationship) and re-pointing a
// victim's edges collides on any shared neighbour - near-certain at ~140 links
// per note. reflect wrapped decay AND merge in one transaction, so the throw
// rolled decay back too: no signal decay had persisted for as long as that
// held.
// ===========================================================================

function makeDb(): Database {
  const db = new Database(":memory:");
  applyMigrations(db, "project");
  return db;
}

function addNote(db: Database, opts: { tags: string; updated: string; content?: string }) {
  const id = generateId();
  db.run(
    `INSERT INTO notes (id, type, content, context, keywords, tags, confidence, resolved, created_at, updated_at)
     VALUES (?, 'insight', ?, NULL, '', ?, 'medium', 0, ?, ?)`,
    [id, opts.content ?? `note ${id}`, opts.tags, opts.updated, opts.updated]
  );
  return id;
}

describe("neglected areas", () => {
  let db: Database;
  let g: Database;
  const OLD = "2020-01-01T00:00:00.000Z";
  const NEW = new Date().toISOString();

  beforeEach(() => {
    db = makeDb();
    g = new Database(":memory:");
    applyMigrations(g, "global");
  });

  test("reports a tag with no recent activity", () => {
    addNote(db, { tags: "dormant", updated: OLD });
    const b = composeBriefing(db, g, ["neglected"] as any);
    expect(b.neglected_areas).toContain("dormant");
  });

  test("does NOT report a tag touched inside the window", () => {
    addNote(db, { tags: "active", updated: NEW });
    const b = composeBriefing(db, g, ["neglected"] as any);
    expect(b.neglected_areas).not.toContain("active");
  });

  test("one recent note rescues a tag that also has stale notes", () => {
    addNote(db, { tags: "mixed", updated: OLD });
    addNote(db, { tags: "mixed", updated: NEW });
    const b = composeBriefing(db, g, ["neglected"] as any);
    expect(b.neglected_areas).not.toContain("mixed");
  });

  test("SEMANTIC FIX: a substring collision no longer masks a neglected tag", () => {
    // The old query counted with `tags LIKE '%map%'`, so a RECENT note tagged
    // `roadmap` made the stale tag `map` look active and it was never
    // reported. Exact tag equality fixes that - expect a few tags to newly
    // appear as neglected.
    addNote(db, { tags: "map", updated: OLD });
    addNote(db, { tags: "roadmap", updated: NEW });
    const b = composeBriefing(db, g, ["neglected"] as any);
    expect(b.neglected_areas).toContain("map");
    expect(b.neglected_areas).not.toContain("roadmap");
  });

  test("stays linear: many distinct tags do not multiply table scans", () => {
    // The old shape ran one full-table LIKE scan PER DISTINCT TAG. This is the
    // regression guard for that: 400 tags across 400 notes must stay fast.
    for (let i = 0; i < 400; i++) {
      addNote(db, { tags: `tag${i},shared`, updated: OLD });
    }
    const t0 = performance.now();
    const b = composeBriefing(db, g, ["neglected"] as any);
    const ms = performance.now() - t0;
    expect(b.neglected_areas.length).toBeGreaterThan(300);
    expect(ms).toBeLessThan(2000);
  });
});

describe("mergeDuplicates link collision", () => {
  test("does not throw when merged notes share a neighbour", () => {
    const db = makeDb();
    const ts = now();
    const mk = (id: string, content: string, keywords: string) =>
      db.run(
        `INSERT INTO notes (id, type, content, context, keywords, tags, confidence, resolved, created_at, updated_at)
         VALUES (?, 'insight', ?, NULL, ?, '', 'medium', 0, ?, ?)`,
        [id, content, keywords, ts, ts]
      );
    // Two exact-duplicate notes, plus a neighbour BOTH already link to - the
    // shape that collides on UNIQUE(from_note_id, to_note_id, relationship).
    //
    // The neighbour needs DISJOINT keywords: mergeDuplicates also matches on
    // keyword Jaccard, so giving it the same keyword set would make it a
    // duplicate too and merge all three - which is what the first version of
    // this test did, and it measured the wrong thing.
    mk("dup-1", "identical body", "alpha,beta,gamma,delta");
    mk("dup-2", "identical body", "alpha,beta,gamma,delta");
    mk("shared", "some neighbour", "zulu,yankee,xray,whiskey");
    for (const from of ["dup-1", "dup-2"]) {
      db.run(
        `INSERT INTO links (id, from_note_id, to_note_id, relationship, strength, created_at)
         VALUES (?, ?, 'shared', 'related_to', 'moderate', ?)`,
        [generateId(), from, ts]
      );
    }

    expect(() => mergeDuplicates(db)).not.toThrow();

    // The survivor keeps exactly one edge to the shared neighbour.
    const edges = db
      .query(`SELECT COUNT(*) AS c FROM links WHERE to_note_id = 'shared'`)
      .get() as { c: number };
    expect(edges.c).toBe(1);
    // And no link may still reference the deleted victim.
    const dangling = db
      .query(
        `SELECT COUNT(*) AS c FROM links l WHERE NOT EXISTS (SELECT 1 FROM notes n WHERE n.id = l.from_note_id)
         OR NOT EXISTS (SELECT 1 FROM notes n2 WHERE n2.id = l.to_note_id)`
      )
      .get() as { c: number };
    expect(dangling.c).toBe(0);
  });
});
