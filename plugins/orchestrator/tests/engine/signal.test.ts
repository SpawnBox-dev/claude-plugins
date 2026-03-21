import { describe, test, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { applyMigrations } from "../../mcp/db/schema";
import {
  depositSignal,
  depositSignalBatch,
  decayAllSignals,
  signalBoost,
  confidenceMultiplier,
} from "../../mcp/engine/signal";
import { generateId, now } from "../../mcp/utils";

function insertNote(db: Database, id?: string): string {
  const noteId = id ?? generateId();
  const ts = now();
  db.run(
    `INSERT INTO notes (id, type, content, keywords, confidence, resolved, created_at, updated_at, signal)
     VALUES (?, 'insight', 'test content', '', 'medium', 0, ?, ?, 0)`,
    [noteId, ts, ts]
  );
  return noteId;
}

describe("signal", () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(":memory:");
    applyMigrations(db, "project");
  });

  test("depositSignal increments signal", () => {
    const id = insertNote(db);
    depositSignal(db, id);
    const row = db.query("SELECT signal FROM notes WHERE id = ?").get(id) as any;
    expect(row.signal).toBeCloseTo(1.0);

    depositSignal(db, id);
    const row2 = db.query("SELECT signal FROM notes WHERE id = ?").get(id) as any;
    expect(row2.signal).toBeCloseTo(2.0);
  });

  test("depositSignal with custom amount", () => {
    const id = insertNote(db);
    depositSignal(db, id, 0.3);
    const row = db.query("SELECT signal FROM notes WHERE id = ?").get(id) as any;
    expect(row.signal).toBeCloseTo(0.3);
  });

  test("depositSignalBatch deposits on multiple notes", () => {
    const id1 = insertNote(db);
    const id2 = insertNote(db);
    depositSignalBatch(db, [id1, id2], 1.0);

    const r1 = db.query("SELECT signal FROM notes WHERE id = ?").get(id1) as any;
    const r2 = db.query("SELECT signal FROM notes WHERE id = ?").get(id2) as any;
    expect(r1.signal).toBeCloseTo(1.0);
    expect(r2.signal).toBeCloseTo(1.0);
  });

  test("decayAllSignals reduces signal based on time", () => {
    const id = insertNote(db);
    // Set signal to 10.0 with last_accessed_at 14 days ago
    const fourteenDaysAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
    db.run("UPDATE notes SET signal = 10.0, last_accessed_at = ? WHERE id = ?", [fourteenDaysAgo, id]);

    const count = decayAllSignals(db);
    expect(count).toBe(1);

    const row = db.query("SELECT signal FROM notes WHERE id = ?").get(id) as any;
    // 10 * 0.95^14 ~ 4.88
    expect(row.signal).toBeGreaterThan(4.0);
    expect(row.signal).toBeLessThan(6.0);
  });

  test("decayAllSignals zeroes out dust (tiny signal, capped decay)", () => {
    const id = insertNote(db);
    const longAgo = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000).toISOString();
    db.run("UPDATE notes SET signal = 0.005, last_accessed_at = ? WHERE id = ?", [longAgo, id]);

    decayAllSignals(db);
    const row = db.query("SELECT signal FROM notes WHERE id = ?").get(id) as any;
    // 0.005 * 0.95^14 (capped) ≈ 0.0024 → below 0.01 → zeroed
    expect(row.signal).toBe(0);
  });

  test("decayAllSignals caps at 14 days (vacation protection)", () => {
    const id = insertNote(db);
    // 90 days away - without cap would be 0.95^90 ≈ 0.01, with cap it's 0.95^14 ≈ 0.49
    const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
    db.run("UPDATE notes SET signal = 10.0, last_accessed_at = ? WHERE id = ?", [ninetyDaysAgo, id]);

    decayAllSignals(db);
    const row = db.query("SELECT signal FROM notes WHERE id = ?").get(id) as any;
    // 10 * 0.95^14 ≈ 4.88 (not 10 * 0.95^90 ≈ 0.1)
    expect(row.signal).toBeGreaterThan(4.0);
    expect(row.signal).toBeLessThan(6.0);
  });

  test("decayAllSignals skips notes with no signal", () => {
    const id = insertNote(db);
    // signal is 0, should be skipped
    const count = decayAllSignals(db);
    expect(count).toBe(0);
  });

  test("signalBoost returns 1.0 for zero signal", () => {
    expect(signalBoost(0)).toBeCloseTo(1.0);
  });

  test("signalBoost increases with signal", () => {
    expect(signalBoost(10)).toBeGreaterThan(signalBoost(1));
    expect(signalBoost(100)).toBeGreaterThan(signalBoost(10));
  });

  test("confidenceMultiplier values", () => {
    expect(confidenceMultiplier("high")).toBeCloseTo(1.2);
    expect(confidenceMultiplier("medium")).toBeCloseTo(1.0);
    expect(confidenceMultiplier("low")).toBeCloseTo(0.8);
  });
});
