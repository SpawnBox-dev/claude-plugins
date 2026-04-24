import { describe, test, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { applyMigrations } from "../../mcp/db/schema";
import { handleOrient } from "../../mcp/tools/orient";

function makeDb(type: "project" | "global"): Database {
  const db = new Database(":memory:");
  applyMigrations(db, type);
  return db;
}

describe("R3.3: curation_candidates surface maintenance targets", () => {
  let projectDb: Database;
  let globalDb: Database;

  beforeEach(() => {
    projectDb = makeDb("project");
    globalDb = makeDb("global");
  });

  test("stale-but-surfaced: old + high signal note appears as candidate", () => {
    const oldDate = new Date(Date.now() - 45 * 24 * 60 * 60 * 1000).toISOString();
    const recentDate = new Date().toISOString();
    projectDb.run(
      `INSERT INTO notes (id, type, content, keywords, tags, confidence, resolved, created_at, updated_at, signal)
       VALUES ('stale-hot', 'architecture', 'old hot note', 'x', '', 'medium', 0, ?, ?, 5.0)`,
      [oldDate, oldDate]
    );
    projectDb.run(
      `INSERT INTO notes (id, type, content, keywords, tags, confidence, resolved, created_at, updated_at, signal)
       VALUES ('stale-cold', 'architecture', 'old cold note', 'x', '', 'medium', 0, ?, ?, 0)`,
      [oldDate, oldDate]
    );
    projectDb.run(
      `INSERT INTO notes (id, type, content, keywords, tags, confidence, resolved, created_at, updated_at, signal)
       VALUES ('fresh', 'architecture', 'fresh note', 'x', '', 'medium', 0, ?, ?, 5.0)`,
      [recentDate, recentDate]
    );
    const result = handleOrient(projectDb, globalDb, { event: "startup" });
    const ids = result.briefing.curation_candidates.map((c) => c.note.id);
    expect(ids).toContain("stale-hot");
    expect(ids).not.toContain("stale-cold"); // no signal, not being accessed
    expect(ids).not.toContain("fresh"); // not stale
    const staleHot = result.briefing.curation_candidates.find((c) => c.note.id === "stale-hot");
    expect(staleHot?.reason).toBe("stale_but_surfaced");
  });

  test("low-confidence-but-surfaced: low-confidence + high signal appears as candidate", () => {
    const recentDate = new Date().toISOString();
    projectDb.run(
      `INSERT INTO notes (id, type, content, keywords, tags, confidence, resolved, created_at, updated_at, signal)
       VALUES ('low-hot', 'insight', 'low confidence but accessed', 'x', '', 'low', 0, ?, ?, 3.0)`,
      [recentDate, recentDate]
    );
    projectDb.run(
      `INSERT INTO notes (id, type, content, keywords, tags, confidence, resolved, created_at, updated_at, signal)
       VALUES ('low-cold', 'insight', 'low confidence not accessed', 'x', '', 'low', 0, ?, ?, 0)`,
      [recentDate, recentDate]
    );
    const result = handleOrient(projectDb, globalDb, { event: "startup" });
    const ids = result.briefing.curation_candidates.map((c) => c.note.id);
    expect(ids).toContain("low-hot");
    expect(ids).not.toContain("low-cold");
    const lowHot = result.briefing.curation_candidates.find((c) => c.note.id === "low-hot");
    expect(lowHot?.reason).toBe("low_confidence_but_surfaced");
  });

  test("excludes superseded notes", () => {
    const oldDate = new Date(Date.now() - 45 * 24 * 60 * 60 * 1000).toISOString();
    projectDb.run(
      `INSERT INTO notes (id, type, content, keywords, tags, confidence, resolved, created_at, updated_at, signal, superseded_by)
       VALUES ('stale-superseded', 'architecture', 'superseded', 'x', '', 'medium', 0, ?, ?, 5.0, 'replacement')`,
      [oldDate, oldDate]
    );
    const result = handleOrient(projectDb, globalDb, { event: "startup" });
    const ids = result.briefing.curation_candidates.map((c) => c.note.id);
    expect(ids).not.toContain("stale-superseded");
  });

  test("excludes resolved notes", () => {
    const oldDate = new Date(Date.now() - 45 * 24 * 60 * 60 * 1000).toISOString();
    projectDb.run(
      `INSERT INTO notes (id, type, content, keywords, tags, confidence, resolved, created_at, updated_at, signal)
       VALUES ('stale-resolved', 'open_thread', 'old resolved', 'x', '', 'medium', 1, ?, ?, 5.0)`,
      [oldDate, oldDate]
    );
    const result = handleOrient(projectDb, globalDb, { event: "startup" });
    const ids = result.briefing.curation_candidates.map((c) => c.note.id);
    expect(ids).not.toContain("stale-resolved");
  });

  test("excludes checkpoints and work_items (lifecycle-managed)", () => {
    const oldDate = new Date(Date.now() - 45 * 24 * 60 * 60 * 1000).toISOString();
    projectDb.run(
      `INSERT INTO notes (id, type, content, keywords, tags, confidence, resolved, created_at, updated_at, signal)
       VALUES ('stale-checkpoint', 'checkpoint', 'old checkpoint', 'x', '', 'medium', 0, ?, ?, 5.0)`,
      [oldDate, oldDate]
    );
    projectDb.run(
      `INSERT INTO notes (id, type, content, keywords, tags, confidence, resolved, created_at, updated_at, signal)
       VALUES ('stale-wi', 'work_item', 'old work item', 'x', '', 'medium', 0, ?, ?, 5.0)`,
      [oldDate, oldDate]
    );
    const result = handleOrient(projectDb, globalDb, { event: "startup" });
    const ids = result.briefing.curation_candidates.map((c) => c.note.id);
    expect(ids).not.toContain("stale-checkpoint");
    expect(ids).not.toContain("stale-wi");
  });

  test("capped at 10 per category, ordered by signal DESC", () => {
    const oldDate = new Date(Date.now() - 45 * 24 * 60 * 60 * 1000).toISOString();
    // Create 15 stale-hot notes with varying signal
    for (let i = 0; i < 15; i++) {
      projectDb.run(
        `INSERT INTO notes (id, type, content, keywords, tags, confidence, resolved, created_at, updated_at, signal)
         VALUES (?, 'architecture', ?, 'x', '', 'medium', 0, ?, ?, ?)`,
        [`stale-${i}`, `n${i}`, oldDate, oldDate, i * 1.0 + 1.0] // signal 1..15
      );
    }
    const result = handleOrient(projectDb, globalDb, { event: "startup" });
    const staleCandidates = result.briefing.curation_candidates.filter((c) => c.reason === "stale_but_surfaced");
    expect(staleCandidates.length).toBe(10);
    // Top entry should have highest signal (id 'stale-14' with signal 15)
    expect(staleCandidates[0].note.id).toBe("stale-14");
  });

  test("section omitted when sections filter does NOT include curation_candidates", () => {
    const oldDate = new Date(Date.now() - 45 * 24 * 60 * 60 * 1000).toISOString();
    projectDb.run(
      `INSERT INTO notes (id, type, content, keywords, tags, confidence, resolved, created_at, updated_at, signal)
       VALUES ('stale-hot', 'architecture', 'hot stale', 'x', '', 'medium', 0, ?, ?, 5.0)`,
      [oldDate, oldDate]
    );
    const result = handleOrient(projectDb, globalDb, { event: "startup", sections: ["work_items"] });
    expect(result.briefing.curation_candidates).toEqual([]);
  });
});
