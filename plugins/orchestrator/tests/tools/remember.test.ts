import { describe, test, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { applyMigrations } from "../../mcp/db/schema";
import { handleRemember } from "../../mcp/tools/remember";
import { generateId, now } from "../../mcp/utils";

function makeDb(type: "project" | "global"): Database {
  const db = new Database(":memory:");
  applyMigrations(db, type);
  return db;
}

describe("remember tool", () => {
  let projectDb: Database;
  let globalDb: Database;

  beforeEach(() => {
    projectDb = makeDb("project");
    globalDb = makeDb("global");
  });

  test("stores a decision note in project DB", () => {
    const result = handleRemember(projectDb, globalDb, {
      content: "Use event-driven architecture for all backend services",
      type: "decision",
      context: "Architecture discussion about backend design",
      tags: "backend,architecture",
    });

    expect(result.stored).toBe(true);
    expect(result.duplicate).toBe(false);
    expect(result.note_id).toBeTruthy();

    // Verify it's in project DB
    const note = projectDb
      .query("SELECT * FROM notes WHERE id = ?")
      .get(result.note_id!) as any;
    expect(note).toBeTruthy();
    expect(note.type).toBe("decision");
    expect(note.content).toBe(
      "Use event-driven architecture for all backend services"
    );

    // Verify NOT in global DB
    const globalNote = globalDb
      .query("SELECT * FROM notes WHERE id = ?")
      .get(result.note_id!) as any;
    expect(globalNote).toBeNull();
  });

  test("stores user_pattern in global DB", () => {
    const result = handleRemember(projectDb, globalDb, {
      content: "User prefers complete removals in one pass",
      type: "user_pattern",
    });

    expect(result.stored).toBe(true);
    expect(result.note_id).toBeTruthy();

    // Verify it's in global DB
    const note = globalDb
      .query("SELECT * FROM notes WHERE id = ?")
      .get(result.note_id!) as any;
    expect(note).toBeTruthy();
    expect(note.type).toBe("user_pattern");

    // Verify NOT in project DB
    const projectNote = projectDb
      .query("SELECT * FROM notes WHERE id = ?")
      .get(result.note_id!) as any;
    expect(projectNote).toBeNull();
  });

  test("detects duplicates and promotes confidence", () => {
    const first = handleRemember(projectDb, globalDb, {
      content: "Always use TypeScript strict mode",
      type: "convention",
    });
    expect(first.stored).toBe(true);

    const second = handleRemember(projectDb, globalDb, {
      content: "Always use TypeScript strict mode",
      type: "convention",
    });
    expect(second.stored).toBe(false);
    expect(second.duplicate).toBe(true);
    expect(second.promoted).toBe(true);
    expect(second.note_id).toBe(first.note_id);

    // Verify confidence was promoted from medium to high
    const note = projectDb
      .query("SELECT confidence FROM notes WHERE id = ?")
      .get(first.note_id!) as any;
    expect(note.confidence).toBe("high");
  });

  test("writes user_model entry for user_pattern notes", () => {
    const result = handleRemember(projectDb, globalDb, {
      content: "User prefers complete removals in one pass",
      type: "user_pattern",
      context: "Observed during code refactoring session",
    });

    expect(result.stored).toBe(true);

    // Check user_model table in global DB
    const entry = globalDb
      .query("SELECT * FROM user_model WHERE observation = ?")
      .get("User prefers complete removals in one pass") as any;
    expect(entry).toBeTruthy();
    expect(entry.dimension).toBe("preference");
    expect(entry.confidence).toBe("medium");
  });

  test("auto-generates keywords", () => {
    const result = handleRemember(projectDb, globalDb, {
      content: "Backup snapshot engine handles incremental backups efficiently",
      type: "architecture",
      context: "backup system design review",
    });

    expect(result.stored).toBe(true);

    const note = projectDb
      .query("SELECT keywords FROM notes WHERE id = ?")
      .get(result.note_id!) as any;
    expect(note.keywords).toBeTruthy();
    expect(note.keywords.length).toBeGreaterThan(0);
    // Should contain meaningful words from content
    expect(note.keywords.toLowerCase()).toContain("backup");
  });
});
