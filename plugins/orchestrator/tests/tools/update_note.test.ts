import { describe, test, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { applyMigrations } from "../../mcp/db/schema";
import { handleRemember } from "../../mcp/tools/remember";
import { snapshotRevision, appendToNoteContent } from "../../mcp/tools/update_note_helpers";

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

  test("appendToNoteContent updates keywords", async () => {
    const created = await handleRemember(projectDb, globalDb, { content: "original about apples", type: "decision" });
    const before = projectDb.query("SELECT keywords FROM notes WHERE id = ?").get(created.note_id!) as any;
    expect(before.keywords).toContain("apples");
    appendToNoteContent(projectDb, created.note_id!, "update about bananas and oranges");
    const after = projectDb.query("SELECT keywords FROM notes WHERE id = ?").get(created.note_id!) as any;
    expect(after.keywords).toContain("apples");
    expect(after.keywords).toContain("bananas");
    expect(after.keywords).toContain("oranges");
  });

  test("helper append is preserved when row is re-read after append", async () => {
    // This test documents the pattern server.ts must follow:
    // after appendToNoteContent, re-read row to see the appended content
    const created = await handleRemember(projectDb, globalDb, { content: "first", type: "decision" });

    appendToNoteContent(projectDb, created.note_id!, "second");
    const freshRow = projectDb.query("SELECT content FROM notes WHERE id = ?").get(created.note_id!) as any;
    expect(freshRow.content).toContain("first");
    expect(freshRow.content).toContain("second");
    // If server.ts used stale row here, it would only see "first"
  });
});

describe("R2.3: update_note snapshots revisions before mutations", () => {
  let projectDb: Database;
  let globalDb: Database;

  beforeEach(() => {
    projectDb = makeDb("project");
    globalDb = makeDb("global");
  });

  test("content replacement snapshots pre-change state", async () => {
    const created = await handleRemember(projectDb, globalDb, { content: "v1", type: "decision" });

    // Simulate the server handler's mutation path: snapshot then UPDATE
    snapshotRevision(projectDb, created.note_id!, "sess-1");
    projectDb.run(`UPDATE notes SET content = 'v2', updated_at = ? WHERE id = ?`, [new Date().toISOString(), created.note_id!]);

    const revs = projectDb.query("SELECT content FROM note_revisions WHERE note_id = ? ORDER BY revised_at ASC").all(created.note_id!) as any[];
    expect(revs).toHaveLength(1);
    expect(revs[0].content).toBe("v1");

    const cur = projectDb.query("SELECT content FROM notes WHERE id = ?").get(created.note_id!) as any;
    expect(cur.content).toBe("v2");
  });

  test("append_content path does NOT snapshot (old content preserved inline)", async () => {
    const created = await handleRemember(projectDb, globalDb, { content: "v1", type: "decision" });

    // Simulate the server handler's append path: appendToNoteContent only, no snapshot
    appendToNoteContent(projectDb, created.note_id!, "addendum");

    const revs = projectDb.query("SELECT COUNT(*) AS c FROM note_revisions WHERE note_id = ?").get(created.note_id!) as any;
    expect(revs.c).toBe(0);
  });
});
