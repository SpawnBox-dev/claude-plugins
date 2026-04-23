import { describe, test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { applyMigrations } from "../../mcp/db/schema";

describe("migration 14: superseded_by", () => {
  test("adds superseded_by and superseded_at columns to fresh DB", () => {
    const db = new Database(":memory:");
    applyMigrations(db, "project");
    const cols = db.query("PRAGMA table_info(notes)").all() as Array<{ name: string }>;
    const names = cols.map((c) => c.name);
    expect(names).toContain("superseded_by");
    expect(names).toContain("superseded_at");
  });

  test("creates idx_notes_superseded_by index", () => {
    const db = new Database(":memory:");
    applyMigrations(db, "project");
    const idx = db
      .query("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_notes_superseded_by'")
      .get();
    expect(idx).toBeTruthy();
  });

  test("is idempotent - second apply is a no-op", () => {
    const db = new Database(":memory:");
    applyMigrations(db, "project");
    expect(() => applyMigrations(db, "project")).not.toThrow();
  });

  test("applies to existing DB with migrations 1-13 already applied", () => {
    const db = new Database(":memory:");
    db.exec(`CREATE TABLE migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)`);
    db.exec(`CREATE TABLE notes (id TEXT PRIMARY KEY, type TEXT NOT NULL, content TEXT NOT NULL, context TEXT, keywords TEXT, tags TEXT, source TEXT, confidence TEXT DEFAULT 'medium', last_validated TEXT, resolved INTEGER DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
    db.exec(`CREATE TABLE links (id TEXT PRIMARY KEY, from_note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE, to_note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE, relationship TEXT NOT NULL, strength TEXT, created_at TEXT NOT NULL)`);
    for (let v = 1; v <= 13; v++) {
      db.run("INSERT INTO migrations (version, name, applied_at) VALUES (?, ?, ?)", [v, `v${v}`, "2026-01-01"]);
    }
    applyMigrations(db, "project");
    const cols = db.query("PRAGMA table_info(notes)").all() as Array<{ name: string }>;
    expect(cols.map((c) => c.name)).toContain("superseded_by");
  });

  test("existing notes get NULL for superseded_by", () => {
    const db = new Database(":memory:");
    applyMigrations(db, "project");
    db.run(
      `INSERT INTO notes (id, type, content, keywords, tags, confidence, resolved, created_at, updated_at)
       VALUES ('test-1', 'decision', 'c', 'k', 't', 'medium', 0, '2026-01-01', '2026-01-01')`
    );
    const row = db.query("SELECT superseded_by, superseded_at FROM notes WHERE id = 'test-1'").get() as any;
    expect(row.superseded_by).toBeNull();
    expect(row.superseded_at).toBeNull();
  });
});
