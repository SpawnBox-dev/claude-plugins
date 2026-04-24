import { describe, test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { applyMigrations } from "../../mcp/db/schema";

describe("migration 17: add_code_refs column", () => {
  test("adds code_refs column to notes table", () => {
    const db = new Database(":memory:");
    applyMigrations(db, "project");
    const cols = db.query("PRAGMA table_info(notes)").all() as Array<{
      name: string;
      type: string;
    }>;
    const codeRefsCol = cols.find((c) => c.name === "code_refs");
    expect(codeRefsCol).toBeTruthy();
    expect(codeRefsCol!.type.toUpperCase()).toBe("TEXT");
  });

  test("column is nullable and defaults to NULL on existing rows", () => {
    const db = new Database(":memory:");
    applyMigrations(db, "project");
    // Insert a note without specifying code_refs.
    db.run(
      `INSERT INTO notes (id, type, content, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
      ["note-1", "decision", "some decision", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"]
    );
    const row = db.query("SELECT code_refs FROM notes WHERE id = ?").get("note-1") as any;
    expect(row.code_refs).toBeNull();
  });

  test("idempotent: applying migrations twice does not throw", () => {
    const db = new Database(":memory:");
    applyMigrations(db, "project");
    expect(() => applyMigrations(db, "project")).not.toThrow();
  });

  test("idempotent against manual pre-existing column", () => {
    // Simulate a DB where code_refs was added by hand before migration 17 ran.
    const db = new Database(":memory:");
    // Bootstrap the minimum notes schema. Run migrations 1-16 first.
    applyMigrations(db, "project");
    // Clear migration 17's row so the customApply will re-run. Dropping
    // migration version 17 simulates a DB that hadn't yet recorded the migration.
    db.run("DELETE FROM migrations WHERE version = 17");
    // Now re-apply: the column exists, so customApply should skip the ALTER.
    expect(() => applyMigrations(db, "project")).not.toThrow();
    // Column is still present.
    const cols = db.query("PRAGMA table_info(notes)").all() as Array<{ name: string }>;
    expect(cols.some((c) => c.name === "code_refs")).toBe(true);
  });

  test("stored JSON round-trips through SQLite as plain TEXT", () => {
    const db = new Database(":memory:");
    applyMigrations(db, "project");
    const refs = ["mcp/server.ts", "mcp/engine/signal.ts"];
    db.run(
      `INSERT INTO notes (id, type, content, created_at, updated_at, code_refs)
       VALUES (?, ?, ?, ?, ?, ?)`,
      ["note-refs", "decision", "x", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z", JSON.stringify(refs)]
    );
    const row = db.query("SELECT code_refs FROM notes WHERE id = ?").get("note-refs") as any;
    expect(row.code_refs).toBe(JSON.stringify(refs));
    expect(JSON.parse(row.code_refs)).toEqual(refs);
  });
});
