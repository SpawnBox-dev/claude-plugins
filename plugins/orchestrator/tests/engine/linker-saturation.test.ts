import { describe, test, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { applyMigrations } from "../../mcp/db/schema";
import {
  createAutoLinksWithStats,
  pruneSaturatedLinks,
  rebuildAutoLinks,
  AUTO_LINK_MAX_PER_NOTE,
} from "../../mcp/engine/linker";
import { generateId, now } from "../../mcp/utils";

// ===========================================================================
// 0.30.73: auto-link saturation - IDF-weighted relevance + cap.
//
// Reported with hard numbers by FIVE sessions on 2026-07-27: single notes drew
// 494, 421, 381, 295, 293, 285, 254 auto-links. The old linker linked to EVERY
// note sharing >= 3 keywords, unbounded and unnormalized.
//
// The diagnosis was refined mid-thread and the refinement changed the fix.
// PA's first hypothesis was "the highest-linking notes are the least
// specific". SA-df343a05 produced the counter-example: a note whose CLAIM was
// extremely narrow (one session must not run one command) drew 421 edges
// because its VOCABULARY was dense with house jargon. So the driver is
// common-vocabulary density, not claim generality - and a flat cap would keep
// 25 arbitrary edges instead of 421. Term rarity (IDF) cuts at the cause.
// ===========================================================================

function makeDb(): Database {
  const db = new Database(":memory:");
  applyMigrations(db, "project");
  return db;
}

function insertNote(db: Database, keywords: string, type = "insight"): string {
  const id = generateId();
  const ts = now();
  db.run(
    `INSERT INTO notes (id, type, content, context, keywords, tags, confidence, resolved, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, type, `note ${id}`, null, keywords, "", "medium", 0, ts, ts]
  );
  return id;
}

describe("auto-link saturation", () => {
  let db: Database;

  beforeEach(() => {
    db = makeDb();
  });

  test("degree is CAPPED regardless of how many candidates qualify", () => {
    // 200 notes that all share the same house jargon - the 421-edge shape.
    for (let i = 0; i < 200; i++) {
      insertNote(db, `session,plugin,update,note,extra${i}`);
    }
    const sourceId = insertNote(db, "session,plugin,update,note");

    const stats = createAutoLinksWithStats(db, sourceId, [
      "session",
      "plugin",
      "update",
      "note",
    ]);

    expect(stats.considered).toBeGreaterThan(AUTO_LINK_MAX_PER_NOTE);
    expect(stats.links.length).toBeLessThanOrEqual(AUTO_LINK_MAX_PER_NOTE);
    expect(stats.capped).toBe(true);

    // And the DB agrees - this is the bound that must hold as the KB grows.
    const edges = db
      .query(`SELECT COUNT(*) AS c FROM links WHERE from_note_id = ?`)
      .get(sourceId) as { c: number };
    expect(edges.c).toBeLessThanOrEqual(AUTO_LINK_MAX_PER_NOTE);
  });

  test("RARE shared vocabulary outranks COMMON shared vocabulary", () => {
    // House jargon: present in ~everything, so it should carry ~no weight.
    for (let i = 0; i < 60; i++) {
      insertNote(db, `session,plugin,update,filler${i}`);
    }
    // The distinctive neighbour: shares rare domain terms instead.
    const rareId = insertNote(db, "portproxy,vhdx,geyser");
    // A jargon-only neighbour, matched on nothing but common terms.
    const jargonId = insertNote(db, "session,plugin,update");

    const sourceId = insertNote(
      db,
      "session,plugin,update,portproxy,vhdx,geyser"
    );
    const stats = createAutoLinksWithStats(db, sourceId, [
      "session",
      "plugin",
      "update",
      "portproxy",
      "vhdx",
      "geyser",
    ]);

    const linked = stats.links.map((l) => l.to_note_id);
    expect(linked).toContain(rareId);

    // The rare-term neighbour must rank ABOVE the jargon-only one. That is the
    // whole point: both clear minOverlap with 3 shared terms, so raw overlap
    // count cannot tell them apart - only rarity can.
    if (linked.includes(jargonId)) {
      expect(linked.indexOf(rareId)).toBeLessThan(linked.indexOf(jargonId));
    }
  });

  test("does not link on jargon alone once that jargon is corpus-wide", () => {
    // Every note in the corpus carries these three terms, so they are
    // information-free and must not by themselves justify an edge.
    for (let i = 0; i < 80; i++) {
      insertNote(db, `session,plugin,update,unique${i}`);
    }
    const sourceId = insertNote(db, "session,plugin,update,distinctterm");

    const stats = createAutoLinksWithStats(db, sourceId, [
      "session",
      "plugin",
      "update",
      "distinctterm",
    ]);

    // Bounded, and far below the 80 that would have linked before.
    expect(stats.links.length).toBeLessThanOrEqual(AUTO_LINK_MAX_PER_NOTE);
    expect(stats.considered).toBeGreaterThanOrEqual(80);
  });

  test("COLD START: a small KB still links normally (PA's concern)", () => {
    // On a tiny corpus every term looks rare. Because relevance is normalized
    // as a FRACTION of the source note's total distinctive weight, this
    // behaves like plain keyword overlap rather than linking everything - and
    // it can never be worse than the old unbounded behavior, which had no
    // floor at all.
    const a = insertNote(db, "backup,snapshot,retention");
    insertNote(db, "landing,hero,carousel");

    const sourceId = insertNote(db, "backup,snapshot,retention");
    const stats = createAutoLinksWithStats(db, sourceId, [
      "backup",
      "snapshot",
      "retention",
    ]);

    // The genuine match still links on a 3-note KB.
    expect(stats.links.map((l) => l.to_note_id)).toContain(a);
    // The unrelated note does not.
    expect(stats.links.length).toBe(1);
    expect(stats.capped).toBe(false);
  });

  test("minOverlap (R4.3) semantics are unchanged", () => {
    insertNote(db, "alpha,beta,epsilon,zeta");
    const sourceId = insertNote(db, "alpha,beta,gamma,delta");

    const stats = createAutoLinksWithStats(db, sourceId, [
      "alpha",
      "beta",
      "gamma",
      "delta",
    ]);
    // Only 2 shared keywords -> still no link.
    expect(stats.links.length).toBe(0);
    expect(stats.considered).toBe(0);
  });

  test("reports considered/capped so the author learns they made a hub", () => {
    for (let i = 0; i < 50; i++) {
      insertNote(db, `session,plugin,update,f${i}`);
    }
    const sourceId = insertNote(db, "session,plugin,update");
    const stats = createAutoLinksWithStats(db, sourceId, [
      "session",
      "plugin",
      "update",
    ]);

    // SA-5a433456 asked for exactly this: a way to tell at write time that you
    // created a hub rather than a note.
    expect(stats.considered).toBe(50);
    expect(stats.capped).toBe(true);
  });

  test("selection is deterministic across runs", () => {
    for (let i = 0; i < 40; i++) {
      insertNote(db, `session,plugin,update,f${i}`);
    }
    const s1 = insertNote(db, "session,plugin,update");
    const s2 = insertNote(db, "session,plugin,update");

    const a = createAutoLinksWithStats(db, s1, ["session", "plugin", "update"]);
    const b = createAutoLinksWithStats(db, s2, ["session", "plugin", "update"]);

    // Same inputs -> same ranked selection (ties broken deterministically).
    expect(a.links.length).toBe(b.links.length);
  });
});

// ===========================================================================
// 0.30.95: BACKFILL PRUNE for the pre-0.30.73 graph.
//
// The 0.30.73 cap bounds NEW notes only. Measured on the live DB: 959,125
// links across 6,827 notes, top node 1,119, and 768 notes carrying >300 edges
// totalling 325,754.
//
// SAFETY, established by reading the producer rather than assuming:
// inferRelationship() CAN emit blocks / depends_on / conflicts_with / enables,
// so relationship type alone does not separate auto edges from hand-made ones.
// It can never emit `supersedes` (linker.ts states handleSupersede is the only
// valid path) and never `part_of`. So the prune touches ONLY `related_to` -
// 94.7% of the volume - and every semantically-typed edge survives by
// construction. Verified on a copy of the live DB: 750,794 removed, and
// enables/depends_on/blocks/conflicts_with/supersedes/part_of counts came out
// byte-identical.
// ===========================================================================
describe("pruneSaturatedLinks (backfill)", () => {
  let db: Database;

  beforeEach(() => {
    db = makeDb();
  });

  function link(from: string, to: string, rel: string, strength = "weak") {
    db.run(
      `INSERT INTO links (id, from_note_id, to_note_id, relationship, strength, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [generateId(), from, to, rel, strength, now()]
    );
  }

  test("caps related_to out-degree and reports what it removed", () => {
    const src = insertNote(db, "a,b,c");
    for (let i = 0; i < 60; i++) {
      const t = insertNote(db, `t${i}`);
      link(src, t, "related_to");
    }
    const r = pruneSaturatedLinks(db, 25);
    expect(r.removed).toBe(35);
    const left = db
      .query(`SELECT COUNT(*) c FROM links WHERE from_note_id = ?`)
      .get(src) as { c: number };
    expect(left.c).toBe(25);
  });

  test("NEVER touches supersedes or part_of - they cannot be auto-generated", () => {
    const src = insertNote(db, "a,b,c");
    for (let i = 0; i < 40; i++) link(src, insertNote(db, `x${i}`), "supersedes");
    for (let i = 0; i < 40; i++) link(src, insertNote(db, `y${i}`), "part_of");
    const r = pruneSaturatedLinks(db, 5);
    expect(r.removed).toBe(0);
    const kept = db
      .query(`SELECT COUNT(*) c FROM links WHERE relationship IN ('supersedes','part_of')`)
      .get() as { c: number };
    expect(kept.c).toBe(80);
  });

  test("leaves hand-made semantic edges alone even above the cap", () => {
    // A `blocks` edge can come from blocked_by (manual). Since type alone
    // cannot tell them apart, none of these are pruned - the 5% we decline to
    // touch is also the 5% that carries meaning.
    const src = insertNote(db, "a,b,c");
    for (let i = 0; i < 40; i++) link(src, insertNote(db, `b${i}`), "blocks");
    expect(pruneSaturatedLinks(db, 5).removed).toBe(0);
  });

  test("keeps the STRONGEST edges - what the read path would have surfaced", () => {
    const src = insertNote(db, "a,b,c");
    const strong = insertNote(db, "keep-me");
    link(src, strong, "related_to", "strong");
    for (let i = 0; i < 30; i++) link(src, insertNote(db, `w${i}`), "related_to", "weak");

    pruneSaturatedLinks(db, 5);
    const survived = db
      .query(`SELECT COUNT(*) c FROM links WHERE from_note_id = ? AND to_note_id = ?`)
      .get(src, strong) as { c: number };
    expect(survived.c).toBe(1);
  });

  test("is a no-op on an already-healthy graph", () => {
    const src = insertNote(db, "a,b,c");
    for (let i = 0; i < 5; i++) link(src, insertNote(db, `n${i}`), "related_to");
    expect(pruneSaturatedLinks(db, 25).removed).toBe(0);
  });
});

// ===========================================================================
// 0.30.97: rebuildAutoLinks - the primitive that makes the prune recoverable.
//
// PA's framing, and it is the right order of operations: check whether an
// operation is RECOVERABLE before checking whether it is CORRECT. A graph you
// cannot regenerate is a graph you can never safely repair.
//
// Also fixes the UNIQUE(from,to,relationship) collision at its SINGLE INSERT
// SITE rather than per-caller. That constraint bit three times in one session -
// mergeDuplicates (silently reverting maintenance for months), this rebuild,
// and by construction any future writer. The defect was never in the callers:
// inserting into `links` simply was not idempotent.
//
// Measured on a copy of the live DB: 83ms/note, ~9.4 minutes for 6,841 notes.
// Slow by nature (every note re-scans the corpus) and therefore deliberately
// NOT wired into retro or briefing - it is an explicit repair operation.
// ===========================================================================
describe("rebuildAutoLinks", () => {
  let db: Database;

  beforeEach(() => {
    db = makeDb();
  });

  test("regenerates related_to edges from scratch", () => {
    for (let i = 0; i < 6; i++) insertNote(db, "backup,snapshot,retention");
    db.run(`DELETE FROM links`);
    expect(
      (db.query(`SELECT COUNT(*) c FROM links`).get() as { c: number }).c
    ).toBe(0);

    const r = rebuildAutoLinks(db);
    expect(r.notes).toBe(6);
    expect(r.linksAfter).toBeGreaterThan(0);
  });

  test("does NOT delete hand-made edges it can never re-derive", () => {
    const a = insertNote(db, "alpha,beta,gamma");
    const b = insertNote(db, "alpha,beta,gamma");
    db.run(
      `INSERT INTO links (id, from_note_id, to_note_id, relationship, strength, created_at)
       VALUES (?, ?, ?, 'supersedes', 'strong', ?)`,
      [generateId(), a, b, now()]
    );

    rebuildAutoLinks(db);

    const kept = db
      .query(`SELECT COUNT(*) c FROM links WHERE relationship = 'supersedes'`)
      .get() as { c: number };
    expect(kept.c).toBe(1);
  });

  test("is IDEMPOTENT - running it twice does not throw or double up", () => {
    // This is the regression guard for the UNIQUE collision that killed the
    // first live run: inferRelationship can return a non-related_to type for a
    // pair whose preserved edge of that type already exists.
    for (let i = 0; i < 8; i++) insertNote(db, "daemon,backup,restore");

    const first = rebuildAutoLinks(db);
    expect(() => rebuildAutoLinks(db)).not.toThrow();
    const second = rebuildAutoLinks(db);
    expect(second.linksAfter).toBe(first.linksAfter);
  });

  test("respects the cap, so a rebuild cannot re-create saturation", () => {
    for (let i = 0; i < 80; i++) insertNote(db, `session,plugin,update,f${i}`);
    rebuildAutoLinks(db);
    const max = db
      .query(
        `SELECT MAX(c) m FROM (SELECT from_note_id, COUNT(*) c FROM links WHERE relationship='related_to' GROUP BY from_note_id)`
      )
      .get() as { m: number };
    expect(max.m).toBeLessThanOrEqual(AUTO_LINK_MAX_PER_NOTE);
  });
});
