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

  test("stores a decision note in project DB", async () => {
    const result = await handleRemember(projectDb, globalDb, {
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

  test("stores user_pattern in global DB", async () => {
    const result = await handleRemember(projectDb, globalDb, {
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

  test("detects duplicates and promotes confidence", async () => {
    const first = await handleRemember(projectDb, globalDb, {
      content: "Always use TypeScript strict mode",
      type: "convention",
    });
    expect(first.stored).toBe(true);

    const second = await handleRemember(projectDb, globalDb, {
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

  test("writes user_model entry for user_pattern notes", async () => {
    const result = await handleRemember(projectDb, globalDb, {
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

  test("auto-generates keywords", async () => {
    const result = await handleRemember(projectDb, globalDb, {
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

  // === v0.18 source_session plumbing regression guards ===
  //
  // These tests verify that the session_id passed into handleRemember actually
  // lands in the notes.source_session column. The cross-session discovery
  // pipeline depends on this: without source_session set, sibling sessions'
  // briefings will never surface this note under "new since your last briefing".
  //
  // Before v0.18, handleRemember did not accept session_id at all. Between
  // v0.18 and v0.19.1 we only had integration-level evidence that it worked.
  // These are the unit-level regression guards that were previously missing.

  test("writes source_session column when session_id provided", async () => {
    const result = await handleRemember(projectDb, globalDb, {
      content: "Session-attributed decision note",
      type: "decision",
      session_id: "source-session-test-1",
    });

    expect(result.stored).toBe(true);
    const note = projectDb
      .query("SELECT source_session FROM notes WHERE id = ?")
      .get(result.note_id!) as { source_session: string | null };
    expect(note.source_session).toBe("source-session-test-1");
  });

  test("writes NULL source_session when session_id omitted", async () => {
    const result = await handleRemember(projectDb, globalDb, {
      content: "Unattributed insight note",
      type: "insight",
    });

    expect(result.stored).toBe(true);
    const note = projectDb
      .query("SELECT source_session FROM notes WHERE id = ?")
      .get(result.note_id!) as { source_session: string | null };
    expect(note.source_session).toBeNull();
  });

  test("source_session persists through the full note insert flow", async () => {
    // Multi-note sequence from the same session. All should share source_session.
    const ids: string[] = [];
    for (const content of [
      "First thought about backup design",
      "Second thought about restore flow",
      "Third thought about hibernation encryption",
    ]) {
      const result = await handleRemember(projectDb, globalDb, {
        content,
        type: "insight",
        session_id: "multi-note-session",
      });
      expect(result.stored).toBe(true);
      ids.push(result.note_id!);
    }

    const rows = projectDb
      .query(
        `SELECT id, source_session FROM notes WHERE id IN (?, ?, ?) ORDER BY created_at ASC`
      )
      .all(ids[0], ids[1], ids[2]) as Array<{
      id: string;
      source_session: string | null;
    }>;

    expect(rows.length).toBe(3);
    for (const row of rows) {
      expect(row.source_session).toBe("multi-note-session");
    }
  });

  test("source_session writes to global DB for user_pattern notes", async () => {
    // user_pattern routes to global DB via GLOBAL_TYPES routing
    const result = await handleRemember(projectDb, globalDb, {
      content: "User prefers structured answers",
      type: "user_pattern",
      session_id: "global-routing-session",
    });

    expect(result.stored).toBe(true);
    // Note should be in global DB, not project DB
    const globalNote = globalDb
      .query("SELECT source_session FROM notes WHERE id = ?")
      .get(result.note_id!) as { source_session: string | null } | null;
    expect(globalNote).toBeTruthy();
    expect(globalNote!.source_session).toBe("global-routing-session");
  });
});
