import { describe, test, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { applyMigrations } from "../../mcp/db/schema";
import {
  findDuplicates,
  mergeDuplicates,
  MIN_SHARED_KEYWORDS,
} from "../../mcp/engine/deduplicator";

function makeDb(type: "project" | "global"): Database {
  const db = new Database(":memory:");
  applyMigrations(db, type);
  return db;
}

describe("R3.5a: findDuplicates requires minimum shared keywords", () => {
  let db: Database;

  beforeEach(() => {
    db = makeDb("project");
  });

  test("exports MIN_SHARED_KEYWORDS constant = 3", () => {
    expect(MIN_SHARED_KEYWORDS).toBe(3);
  });

  test("2-shared-keyword with high Jaccard no longer triggers dedup", () => {
    const ts = "2026-04-23T12:00:00Z";
    // Candidate stored keywords: 2 tokens. Input extracts 3 tokens; intersection=2,
    // union=3, Jaccard=0.67 (above 0.6). Old behavior: match. New behavior: no match
    // because intersection (2) < MIN_SHARED_KEYWORDS (3).
    db.run(
      `INSERT INTO notes (id, type, content, keywords, confidence, resolved, created_at, updated_at)
       VALUES ('a', 'decision', 'note with alpha beta', 'alpha,beta', 'medium', 0, ?, ?)`,
      [ts, ts]
    );

    const matches = findDuplicates(db, "decision", "alpha beta gamma");
    // Exact content does not match, so no 1.0 similarity result.
    expect(matches.every((m) => m.similarity < 1.0)).toBe(true);
    // New behavior: intersection < 3 => no Jaccard match returned.
    expect(matches.length).toBe(0);
  });

  test("3+ shared keywords with high Jaccard still triggers dedup", () => {
    const ts = "2026-04-23T12:00:00Z";
    db.run(
      `INSERT INTO notes (id, type, content, keywords, confidence, resolved, created_at, updated_at)
       VALUES ('a', 'decision', 'note with alpha beta gamma', 'alpha,beta,gamma', 'medium', 0, ?, ?)`,
      [ts, ts]
    );

    // Input keywords extracted: {alpha, beta, gamma, delta}.
    // intersection = {alpha, beta, gamma} = 3, union = 4, Jaccard = 0.75.
    const matches = findDuplicates(db, "decision", "alpha beta gamma delta");
    expect(matches.length).toBeGreaterThan(0);
    expect(matches[0].id).toBe("a");
    expect(matches[0].similarity).toBeGreaterThanOrEqual(0.6);
  });

  test("exact content match still triggers regardless of keyword count", () => {
    const ts = "2026-04-23T12:00:00Z";
    db.run(
      `INSERT INTO notes (id, type, content, keywords, confidence, resolved, created_at, updated_at)
       VALUES ('a', 'decision', 'short', 'x', 'medium', 0, ?, ?)`,
      [ts, ts]
    );

    // Exact-content-match path bypasses the keyword-count gate.
    const matches = findDuplicates(db, "decision", "short");
    expect(matches.length).toBe(1);
    expect(matches[0].similarity).toBe(1.0);
  });
});

describe("R3.5a: mergeDuplicates requires minimum shared keywords", () => {
  let db: Database;

  beforeEach(() => {
    db = makeDb("project");
  });

  test("does NOT merge notes with only 2 shared keywords and Jaccard >= 0.6", () => {
    const ts1 = "2026-04-23T12:00:00Z";
    const ts2 = "2026-04-23T12:01:00Z";
    // Two distinct notes whose keywords share 2 tokens with Jaccard ~0.67.
    // Before R3.5a: they would be merged. After: they must NOT be merged.
    db.run(
      `INSERT INTO notes (id, type, content, keywords, confidence, resolved, created_at, updated_at)
       VALUES ('a', 'insight', 'first note mentions alpha beta', 'alpha,beta', 'medium', 0, ?, ?)`,
      [ts1, ts1]
    );
    db.run(
      `INSERT INTO notes (id, type, content, keywords, confidence, resolved, created_at, updated_at)
       VALUES ('b', 'insight', 'second note mentions alpha beta gamma', 'alpha,beta,gamma', 'medium', 0, ?, ?)`,
      [ts2, ts2]
    );

    const countBefore = (
      db.query("SELECT COUNT(*) as cnt FROM notes").get() as { cnt: number }
    ).cnt;
    expect(countBefore).toBe(2);

    const merged = mergeDuplicates(db);
    expect(merged).toBe(0);

    const countAfter = (
      db.query("SELECT COUNT(*) as cnt FROM notes").get() as { cnt: number }
    ).cnt;
    expect(countAfter).toBe(2);
  });

  test("still merges exact duplicates regardless of keyword count", () => {
    const ts1 = "2026-04-23T12:00:00Z";
    const ts2 = "2026-04-23T12:01:00Z";
    db.run(
      `INSERT INTO notes (id, type, content, keywords, confidence, resolved, created_at, updated_at)
       VALUES ('a', 'insight', 'identical content here', 'x,y', 'medium', 0, ?, ?)`,
      [ts1, ts1]
    );
    db.run(
      `INSERT INTO notes (id, type, content, keywords, confidence, resolved, created_at, updated_at)
       VALUES ('b', 'insight', 'identical content here', 'x,y', 'medium', 0, ?, ?)`,
      [ts2, ts2]
    );

    const merged = mergeDuplicates(db);
    expect(merged).toBe(1);
  });

  test("still merges notes with 3+ shared keywords and Jaccard >= 0.6", () => {
    const ts1 = "2026-04-23T12:00:00Z";
    const ts2 = "2026-04-23T12:01:00Z";
    db.run(
      `INSERT INTO notes (id, type, content, keywords, confidence, resolved, created_at, updated_at)
       VALUES ('a', 'insight', 'first alpha beta gamma', 'alpha,beta,gamma', 'medium', 0, ?, ?)`,
      [ts1, ts1]
    );
    db.run(
      `INSERT INTO notes (id, type, content, keywords, confidence, resolved, created_at, updated_at)
       VALUES ('b', 'insight', 'second alpha beta gamma delta', 'alpha,beta,gamma,delta', 'medium', 0, ?, ?)`,
      [ts2, ts2]
    );

    const merged = mergeDuplicates(db);
    expect(merged).toBe(1);
  });
});
