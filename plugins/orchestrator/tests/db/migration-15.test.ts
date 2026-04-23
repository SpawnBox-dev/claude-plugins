import { describe, test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { applyMigrations } from "../../mcp/db/schema";

describe("migration 15: note_revisions + link UNIQUE index", () => {
  test("creates note_revisions table with expected columns", () => {
    const db = new Database(":memory:");
    applyMigrations(db, "project");
    const cols = db.query("PRAGMA table_info(note_revisions)").all() as Array<{ name: string }>;
    const names = cols.map((c) => c.name);
    for (const expected of ["id", "note_id", "content", "context", "tags", "keywords", "confidence", "revised_at", "revised_by_session"]) {
      expect(names).toContain(expected);
    }
  });

  test("creates idx_note_revisions_note_id", () => {
    const db = new Database(":memory:");
    applyMigrations(db, "project");
    const idx = db.query("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_note_revisions_note_id'").get();
    expect(idx).toBeTruthy();
  });

  test("creates idx_links_unique_edge UNIQUE index", () => {
    const db = new Database(":memory:");
    applyMigrations(db, "project");
    const idx = db.query("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_links_unique_edge'").get() as any;
    expect(idx).toBeTruthy();
    expect(idx.sql).toContain("UNIQUE");
  });

  test("UNIQUE index rejects duplicate (from, to, relationship) triples", () => {
    const db = new Database(":memory:");
    applyMigrations(db, "project");
    const ts = "2026-04-23T12:00:00Z";
    db.run(`INSERT INTO notes (id, type, content, confidence, resolved, created_at, updated_at) VALUES ('a', 'decision', 'x', 'medium', 0, ?, ?)`, [ts, ts]);
    db.run(`INSERT INTO notes (id, type, content, confidence, resolved, created_at, updated_at) VALUES ('b', 'decision', 'y', 'medium', 0, ?, ?)`, [ts, ts]);
    db.run(`INSERT INTO links (id, from_note_id, to_note_id, relationship, strength, created_at) VALUES ('l1', 'a', 'b', 'related_to', 'strong', ?)`, [ts]);
    let threw = false;
    try {
      db.run(`INSERT INTO links (id, from_note_id, to_note_id, relationship, strength, created_at) VALUES ('l2', 'a', 'b', 'related_to', 'strong', ?)`, [ts]);
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });

  test("UNIQUE index allows same pair with DIFFERENT relationship", () => {
    const db = new Database(":memory:");
    applyMigrations(db, "project");
    const ts = "2026-04-23T12:00:00Z";
    db.run(`INSERT INTO notes (id, type, content, confidence, resolved, created_at, updated_at) VALUES ('a', 'decision', 'x', 'medium', 0, ?, ?)`, [ts, ts]);
    db.run(`INSERT INTO notes (id, type, content, confidence, resolved, created_at, updated_at) VALUES ('b', 'decision', 'y', 'medium', 0, ?, ?)`, [ts, ts]);
    db.run(`INSERT INTO links (id, from_note_id, to_note_id, relationship, strength, created_at) VALUES ('l1', 'a', 'b', 'related_to', 'strong', ?)`, [ts]);
    db.run(`INSERT INTO links (id, from_note_id, to_note_id, relationship, strength, created_at) VALUES ('l2', 'a', 'b', 'supersedes', 'strong', ?)`, [ts]);
    const count = (db.query("SELECT COUNT(*) AS c FROM links").get() as any).c;
    expect(count).toBe(2);
  });

  test("dedup runs on migration - pre-existing duplicate links collapse to one", () => {
    const db = new Database(":memory:");
    db.exec(`CREATE TABLE IF NOT EXISTS migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)`);
    db.exec(`CREATE TABLE IF NOT EXISTS notes (id TEXT PRIMARY KEY, type TEXT NOT NULL, content TEXT NOT NULL, context TEXT, keywords TEXT, tags TEXT, source TEXT, confidence TEXT, last_validated TEXT, resolved INTEGER, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
    db.exec(`CREATE TABLE IF NOT EXISTS links (id TEXT PRIMARY KEY, from_note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE, to_note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE, relationship TEXT NOT NULL, strength TEXT, created_at TEXT NOT NULL)`);
    for (let v = 1; v <= 14; v++) db.run(`INSERT INTO migrations (version, name, applied_at) VALUES (?, ?, ?)`, [v, `v${v}`, "2026-01-01"]);
    const ts = "2026-04-23T12:00:00Z";
    db.run(`INSERT INTO notes (id, type, content, confidence, resolved, created_at, updated_at) VALUES ('a', 'decision', 'x', 'medium', 0, ?, ?)`, [ts, ts]);
    db.run(`INSERT INTO notes (id, type, content, confidence, resolved, created_at, updated_at) VALUES ('b', 'decision', 'y', 'medium', 0, ?, ?)`, [ts, ts]);
    db.run(`INSERT INTO links (id, from_note_id, to_note_id, relationship, strength, created_at) VALUES ('l1', 'a', 'b', 'related_to', 'strong', '2026-01-01')`);
    db.run(`INSERT INTO links (id, from_note_id, to_note_id, relationship, strength, created_at) VALUES ('l2', 'a', 'b', 'related_to', 'strong', '2026-02-01')`);
    db.run(`INSERT INTO links (id, from_note_id, to_note_id, relationship, strength, created_at) VALUES ('l3', 'a', 'b', 'related_to', 'strong', '2026-03-01')`);
    applyMigrations(db, "project");
    const count = (db.query("SELECT COUNT(*) AS c FROM links WHERE from_note_id = 'a' AND to_note_id = 'b' AND relationship = 'related_to'").get() as any).c;
    expect(count).toBe(1);
    const kept = (db.query("SELECT id FROM links WHERE from_note_id = 'a' AND to_note_id = 'b' AND relationship = 'related_to'").get() as any);
    expect(kept.id).toBe("l1");
  });

  test("is idempotent - second apply is a no-op", () => {
    const db = new Database(":memory:");
    applyMigrations(db, "project");
    expect(() => applyMigrations(db, "project")).not.toThrow();
  });

  test("INSERT OR IGNORE on links does not throw on duplicate triple, does not insert", () => {
    const db = new Database(":memory:");
    applyMigrations(db, "project");
    const ts = "2026-04-23T12:00:00Z";
    db.run(`INSERT INTO notes (id, type, content, confidence, resolved, created_at, updated_at) VALUES ('a', 'decision', 'x', 'medium', 0, ?, ?)`, [ts, ts]);
    db.run(`INSERT INTO notes (id, type, content, confidence, resolved, created_at, updated_at) VALUES ('b', 'decision', 'y', 'medium', 0, ?, ?)`, [ts, ts]);
    db.run(`INSERT INTO links (id, from_note_id, to_note_id, relationship, strength, created_at) VALUES ('l1', 'a', 'b', 'blocks', 'strong', ?)`, [ts]);
    let threw = false;
    try {
      db.run(`INSERT OR IGNORE INTO links (id, from_note_id, to_note_id, relationship, strength, created_at) VALUES ('l2', 'a', 'b', 'blocks', 'strong', ?)`, [ts]);
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
    const count = (db.query("SELECT COUNT(*) AS c FROM links WHERE from_note_id = 'a' AND to_note_id = 'b' AND relationship = 'blocks'").get() as any).c;
    expect(count).toBe(1);
  });
});
