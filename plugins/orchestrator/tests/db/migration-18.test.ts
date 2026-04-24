import { describe, test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { applyMigrations } from "../../mcp/db/schema";

describe("migration 18: add_code_refs_to_note_revisions", () => {
  test("adds code_refs column to note_revisions table", () => {
    const db = new Database(":memory:");
    applyMigrations(db, "project");
    const cols = db.query("PRAGMA table_info(note_revisions)").all() as Array<{
      name: string;
      type: string;
    }>;
    const codeRefsCol = cols.find((c) => c.name === "code_refs");
    expect(codeRefsCol).toBeTruthy();
    expect(codeRefsCol!.type.toUpperCase()).toBe("TEXT");
  });

  test("column is nullable and defaults to NULL on pre-existing rows", () => {
    const db = new Database(":memory:");
    applyMigrations(db, "project");
    // Create a minimal note, then a revision row without code_refs.
    db.run(
      `INSERT INTO notes (id, type, content, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
      ["note-a", "decision", "x", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"]
    );
    db.run(
      `INSERT INTO note_revisions (id, note_id, content, revised_at)
       VALUES (?, ?, ?, ?)`,
      ["rev-a", "note-a", "x", "2026-01-01T00:00:00Z"]
    );
    const row = db
      .query("SELECT code_refs FROM note_revisions WHERE id = ?")
      .get("rev-a") as any;
    expect(row.code_refs).toBeNull();
  });

  test("idempotent: re-applying migrations does not throw", () => {
    const db = new Database(":memory:");
    applyMigrations(db, "project");
    expect(() => applyMigrations(db, "project")).not.toThrow();
  });

  test("idempotent against manual pre-existing column", () => {
    const db = new Database(":memory:");
    applyMigrations(db, "project");
    db.run("DELETE FROM migrations WHERE version = 18");
    expect(() => applyMigrations(db, "project")).not.toThrow();
    const cols = db.query("PRAGMA table_info(note_revisions)").all() as Array<{ name: string }>;
    expect(cols.some((c) => c.name === "code_refs")).toBe(true);
  });

  test("stored JSON round-trips through SQLite as plain TEXT", () => {
    const db = new Database(":memory:");
    applyMigrations(db, "project");
    db.run(
      `INSERT INTO notes (id, type, content, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
      ["note-b", "decision", "x", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"]
    );
    const refs = ["mcp/server.ts", "mcp/engine/signal.ts"];
    db.run(
      `INSERT INTO note_revisions (id, note_id, content, revised_at, code_refs)
       VALUES (?, ?, ?, ?, ?)`,
      ["rev-b", "note-b", "x", "2026-01-01T00:00:00Z", JSON.stringify(refs)]
    );
    const row = db
      .query("SELECT code_refs FROM note_revisions WHERE id = ?")
      .get("rev-b") as any;
    expect(row.code_refs).toBe(JSON.stringify(refs));
    expect(JSON.parse(row.code_refs)).toEqual(refs);
  });

  test("global DB also gets the code_refs column on note_revisions", () => {
    const db = new Database(":memory:");
    applyMigrations(db, "global");
    const cols = db.query("PRAGMA table_info(note_revisions)").all() as Array<{
      name: string;
      type: string;
    }>;
    expect(cols.some((c) => c.name === "code_refs")).toBe(true);
  });
});
