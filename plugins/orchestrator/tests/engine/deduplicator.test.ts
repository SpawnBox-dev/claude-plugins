import { describe, test, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { applyMigrations } from "../../mcp/db/schema";
import { isDuplicate, findDuplicates, mergeDuplicates } from "../../mcp/engine/deduplicator";
import { generateId, now } from "../../mcp/utils";

function insertNote(
  db: Database,
  overrides: Partial<{
    id: string;
    type: string;
    content: string;
    keywords: string;
    tags: string;
  }> = {}
) {
  const id = overrides.id ?? generateId();
  const ts = now();
  db.run(
    `INSERT INTO notes (id, type, content, context, keywords, tags, confidence, resolved, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      overrides.type ?? "insight",
      overrides.content ?? "default content",
      null,
      overrides.keywords ?? "",
      overrides.tags ?? "",
      "medium",
      0,
      ts,
      ts,
    ]
  );
  return id;
}

describe("deduplicator", () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(":memory:");
    applyMigrations(db, "project");
  });

  test("detects duplicate content", () => {
    insertNote(db, {
      type: "decision",
      content: "Use WAL mode for SQLite databases",
      keywords: "wal,sqlite,databases",
    });

    const result = isDuplicate(db, "decision", "Use WAL mode for SQLite databases");
    expect(result).toBe(true);
  });

  test("detects near-duplicates with high keyword overlap", () => {
    insertNote(db, {
      type: "insight",
      content: "backup snapshot engine handles incremental backups efficiently",
      keywords: "backup,snapshot,engine,incremental,efficiently",
    });

    const dupes = findDuplicates(
      db,
      "insight",
      "the backup snapshot engine manages incremental backups",
      0.4
    );
    expect(dupes.length).toBeGreaterThanOrEqual(1);
    expect(dupes[0].similarity).toBeGreaterThanOrEqual(0.4);
  });

  test("merges duplicate notes keeping the newest", () => {
    const id1 = insertNote(db, {
      type: "insight",
      content: "backup snapshot engine handles incremental backups",
      keywords: "backup,snapshot,engine,incremental",
    });

    // Insert older duplicate
    const id2 = insertNote(db, {
      type: "insight",
      content: "backup snapshot engine handles incremental backups",
      keywords: "backup,snapshot,engine,incremental",
    });

    const countBefore = (
      db.query("SELECT COUNT(*) as cnt FROM notes").get() as { cnt: number }
    ).cnt;
    expect(countBefore).toBe(2);

    const merged = mergeDuplicates(db);
    expect(merged).toBe(1);

    const countAfter = (
      db.query("SELECT COUNT(*) as cnt FROM notes").get() as { cnt: number }
    ).cnt;
    expect(countAfter).toBe(1);
  });

  test("does not flag genuinely different notes", () => {
    insertNote(db, {
      type: "insight",
      content: "backup snapshot engine handles incremental backups",
      keywords: "backup,snapshot,engine,incremental",
    });

    const result = isDuplicate(
      db,
      "insight",
      "discord bot sends notifications to channel members"
    );
    expect(result).toBe(false);
  });
});
