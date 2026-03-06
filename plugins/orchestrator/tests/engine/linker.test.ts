import { describe, test, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { applyMigrations } from "../../mcp/db/schema";
import { findRelatedNotes, createAutoLinks } from "../../mcp/engine/linker";
import { generateId, now } from "../../mcp/utils";

function insertNote(
  db: Database,
  overrides: Partial<{
    id: string;
    type: string;
    content: string;
    context: string;
    keywords: string;
    tags: string;
    confidence: string;
    resolved: number;
  }> = {}
) {
  const id = overrides.id ?? generateId();
  const ts = now();
  db.run(
    `INSERT INTO notes (id, type, content, context, keywords, tags, confidence, last_validated, resolved, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      overrides.type ?? "insight",
      overrides.content ?? "default content",
      overrides.context ?? null,
      overrides.keywords ?? "",
      overrides.tags ?? "",
      overrides.confidence ?? "medium",
      ts,
      overrides.resolved ?? 0,
      ts,
      ts,
    ]
  );
  return id;
}

describe("linker", () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(":memory:");
    applyMigrations(db, "project");
  });

  test("finds related notes by keyword overlap", () => {
    insertNote(db, {
      content: "backup snapshot engine handles incremental backups",
      keywords: "backup,snapshot,engine,incremental",
    });
    insertNote(db, {
      content: "backup retention policy for old snapshots",
      keywords: "backup,retention,policy,snapshots",
    });
    insertNote(db, {
      content: "discord bot sends notifications to channels",
      keywords: "discord,bot,notifications,channels",
    });

    const results = findRelatedNotes(db, "backup snapshot");
    expect(results.length).toBeGreaterThanOrEqual(1);
    // The backup-related notes should appear
    expect(results.some((r) => r.content.includes("backup"))).toBe(true);
    // Discord note should not be top result
    if (results.length >= 2) {
      expect(results[0].content.includes("backup")).toBe(true);
    }
  });

  test("creates auto-links between related notes", () => {
    const id1 = insertNote(db, {
      content: "backup engine design",
      keywords: "backup,engine,design,snapshot,retention",
    });
    const id2 = insertNote(db, {
      content: "snapshot retention policy",
      keywords: "snapshot,retention,policy,backup,archive",
    });
    insertNote(db, {
      content: "unrelated discord bot",
      keywords: "discord,bot,notifications",
    });

    const links = createAutoLinks(db, id1, [
      "backup",
      "engine",
      "design",
      "snapshot",
      "retention",
    ]);

    expect(links.length).toBeGreaterThanOrEqual(1);
    // Should link to id2 (shares backup, snapshot, retention)
    expect(links.some((l) => l.to_note_id === id2)).toBe(true);
    // Should NOT link to the discord note (no keyword overlap >= 2)
    expect(
      links.some((l) => l.to_note_id !== id1 && l.to_note_id !== id2)
    ).toBe(false);

    // Verify persisted to DB
    const dbLinks = db
      .query("SELECT * FROM links WHERE from_note_id = ?")
      .all(id1) as any[];
    expect(dbLinks.length).toBe(links.length);
  });

  test("does not self-link", () => {
    const id1 = insertNote(db, {
      content: "backup snapshot engine",
      keywords: "backup,snapshot,engine",
    });

    const links = createAutoLinks(db, id1, ["backup", "snapshot", "engine"]);
    expect(links.every((l) => l.from_note_id !== l.to_note_id)).toBe(true);
    expect(links.every((l) => l.to_note_id !== id1)).toBe(true);
  });
});
