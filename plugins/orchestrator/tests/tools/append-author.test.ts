import { describe, test, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { applyMigrations } from "../../mcp/db/schema";
import { appendToNoteContent } from "../../mcp/tools/update_note_helpers";
import { generateId, now } from "../../mcp/utils";

// ===========================================================================
// WI fe3ec978 gap 6: an append left no structured author.
//
// Jarid (via PA, 2026-09-05): the KB should be consistent and correct as
// standing practice, so progress can be reconstructed from it alone. "Who said
// this, when" was a regex over prose.
//
// NOT DONE VIA snapshotRevision, which was the proposed fix. Measured on this
// KB: 7,802 append events vs 1,115 revision rows - appends outnumber snapshotted
// rewrites 7:1 - and snapshotRevision copies the FULL prior body, so the cost is
// quadratic in appends per note (b2bdd253: 279 appends x 328 KB ~= 87 MB of
// near-identical copies; 349 MB upper bound across the KB, on a 776 MB db).
// The author goes in the marker instead: no schema change, no storage growth.
// ===========================================================================

const SID = "28e29d5d-3c7a-4992-9dea-b95c91f1b979";

function seedNote(db: Database, content: string): string {
  const id = generateId();
  const ts = now();
  db.run(
    `INSERT INTO notes (id, type, content, context, keywords, tags, confidence, resolved, created_at, updated_at, code_refs, signal, superseded_by)
     VALUES (?, 'insight', ?, NULL, '', '', 'medium', 0, ?, ?, NULL, 0, NULL)`,
    [id, content, ts, ts]
  );
  return id;
}

describe("append records its author (WI fe3ec978 gap 6)", () => {
  let db: Database;
  beforeEach(() => {
    db = new Database(":memory:");
    applyMigrations(db, "project");
  });

  test("stamps the session that appended", () => {
    const id = seedNote(db, "original body");
    appendToNoteContent(db, id, "the appended text", null, SID);

    const row = db.query("SELECT content FROM notes WHERE id = ?").get(id) as { content: string };
    expect(row.content).toContain("· session 28e29d5d");
    expect(row.content).toContain("the appended text");
    expect(row.content).toContain("original body");
  });

  test("OMITS the author segment when no session is known", () => {
    // A placeholder would be worse than absence - it would read as a real
    // author to anyone parsing later.
    const id = seedNote(db, "original body");
    appendToNoteContent(db, id, "anonymous append", null);

    const row = db.query("SELECT content FROM notes WHERE id = ?").get(id) as { content: string };
    expect(row.content).not.toContain("session");
    expect(row.content).toContain("anonymous append");
  });

  test("REGRESSION: the existing marker assertion still holds", () => {
    // update_note.test.ts asserts /\n\n--- \d{4}-\d{2}-\d{2}T/. The author
    // segment goes AFTER the timestamp precisely so that stays true; putting it
    // first would have broken a test in another file.
    const id = seedNote(db, "body");
    appendToNoteContent(db, id, "x", null, SID);
    const row = db.query("SELECT content FROM notes WHERE id = ?").get(id) as { content: string };
    expect(row.content).toMatch(/\n\n--- \d{4}-\d{2}-\d{2}T/);
  });

  test("the marker is machine-readable: timestamp AND author parse out", () => {
    // The point of the change - not prose, a stable shape a reader can parse.
    const id = seedNote(db, "body");
    appendToNoteContent(db, id, "payload", null, SID);
    const row = db.query("SELECT content FROM notes WHERE id = ?").get(id) as { content: string };

    const m = row.content.match(/\n\n--- (\S+) · session ([0-9a-f]{8}) ---\n(.*)$/s);
    expect(m).not.toBeNull();
    expect(new Date(m![1]).toString()).not.toBe("Invalid Date");
    expect(m![2]).toBe("28e29d5d");
    expect(m![3]).toBe("payload");
  });

  test("successive appends each carry their own author", () => {
    const id = seedNote(db, "body");
    appendToNoteContent(db, id, "first", null, SID);
    appendToNoteContent(db, id, "second", null, "641a3fdf-aaaa-bbbb-cccc-dddddddddddd");
    const row = db.query("SELECT content FROM notes WHERE id = ?").get(id) as { content: string };
    expect(row.content).toContain("· session 28e29d5d");
    expect(row.content).toContain("· session 641a3fdf");
  });
});
