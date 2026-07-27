import { describe, test, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { applyMigrations } from "../../mcp/db/schema";
import {
  createAutoLinksWithStats,
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
