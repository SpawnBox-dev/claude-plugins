import { describe, test, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { applyMigrations } from "../../mcp/db/schema";
import { handleRemember } from "../../mcp/tools/remember";
import { appendToNoteContent } from "../../mcp/tools/update_note_helpers";

function makeDb(type: "project" | "global"): Database {
  const db = new Database(":memory:");
  applyMigrations(db, type);
  return db;
}

describe("update_note append_content mode", () => {
  let projectDb: Database;
  let globalDb: Database;

  beforeEach(() => {
    projectDb = makeDb("project");
    globalDb = makeDb("global");
  });

  test("appendToNoteContent adds a timestamped segment", async () => {
    const created = await handleRemember(projectDb, globalDb, { content: "original line", type: "decision" });
    const result = appendToNoteContent(projectDb, created.note_id!, "new segment");
    expect(result.appended).toBe(true);
    const row = projectDb.query("SELECT content FROM notes WHERE id = ?").get(created.note_id!) as any;
    expect(row.content).toContain("original line");
    expect(row.content).toContain("new segment");
    expect(row.content).toMatch(/\n\n--- \d{4}-\d{2}-\d{2}T/);
  });

  test("appendToNoteContent on missing id returns appended:false", () => {
    const result = appendToNoteContent(projectDb, "nonexistent", "x");
    expect(result.appended).toBe(false);
  });

  test("appendToNoteContent updates updated_at", async () => {
    const created = await handleRemember(projectDb, globalDb, { content: "x", type: "decision" });
    const before = projectDb.query("SELECT updated_at FROM notes WHERE id = ?").get(created.note_id!) as any;
    await new Promise((r) => setTimeout(r, 10));
    appendToNoteContent(projectDb, created.note_id!, "more");
    const after = projectDb.query("SELECT updated_at FROM notes WHERE id = ?").get(created.note_id!) as any;
    expect(after.updated_at).not.toBe(before.updated_at);
  });
});
