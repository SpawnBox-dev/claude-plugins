import { describe, test, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { applyMigrations } from "../../mcp/db/schema";
import { handleRecall } from "../../mcp/tools/recall";
import { handleRemember } from "../../mcp/tools/remember";
import { generateId, now } from "../../mcp/utils";

function makeDb(type: "project" | "global"): Database {
  const db = new Database(":memory:");
  applyMigrations(db, type);
  return db;
}

describe("recall tool", () => {
  let projectDb: Database;
  let globalDb: Database;

  beforeEach(() => {
    projectDb = makeDb("project");
    globalDb = makeDb("global");
  });

  test("returns matching notes for a query", () => {
    // Seed notes
    handleRemember(projectDb, globalDb, {
      content: "Backup snapshot engine handles incremental backups efficiently",
      type: "architecture",
      tags: "backup",
    });
    handleRemember(projectDb, globalDb, {
      content: "Discord bot integration for server notifications",
      type: "architecture",
      tags: "discord",
    });

    const result = handleRecall(projectDb, globalDb, {
      query: "backup snapshot",
    });

    expect(result.results.length).toBeGreaterThanOrEqual(1);
    expect(result.results.some((r) => r.content.includes("backup"))).toBe(
      true
    );
    expect(result.detail).toBeNull();
  });

  test("returns empty for unrelated queries", () => {
    handleRemember(projectDb, globalDb, {
      content: "Backup snapshot engine handles incremental backups",
      type: "architecture",
    });

    const result = handleRecall(projectDb, globalDb, {
      query: "kubernetes deployment helm chart",
    });

    expect(result.results.length).toBe(0);
    expect(result.message).toContain("No notes found");
  });

  test("filters by type when specified", () => {
    handleRemember(projectDb, globalDb, {
      content: "Backup architecture uses snapshot engine for incremental data",
      type: "architecture",
    });
    handleRemember(projectDb, globalDb, {
      content: "Decided to use backup snapshots for data protection",
      type: "decision",
    });

    const result = handleRecall(projectDb, globalDb, {
      query: "backup snapshot",
      type: "decision",
    });

    // All results should be decisions
    for (const r of result.results) {
      expect(r.type).toBe("decision");
    }
  });

  test("returns full note detail by ID", () => {
    const stored = handleRemember(projectDb, globalDb, {
      content: "Event-driven architecture for all backend services",
      type: "decision",
    });

    const result = handleRecall(projectDb, globalDb, {
      id: stored.note_id!,
    });

    expect(result.detail).toBeTruthy();
    expect(result.detail!.id).toBe(stored.note_id!);
    expect(result.detail!.content).toBe(
      "Event-driven architecture for all backend services"
    );
    expect(result.detail!.type).toBe("decision");
    expect(Array.isArray(result.detail!.links)).toBe(true);
  });

  test("supports depth parameter for multi-hop graph traversal", () => {
    // Create a chain: A -> B -> C via shared keywords
    handleRemember(projectDb, globalDb, {
      content: "Backup engine design for incremental snapshot storage",
      type: "architecture",
      tags: "backup",
    });
    handleRemember(projectDb, globalDb, {
      content: "Snapshot storage uses content-addressable blobs for backup data",
      type: "architecture",
      tags: "backup",
    });
    handleRemember(projectDb, globalDb, {
      content: "Content-addressable blob deduplication in storage layer",
      type: "architecture",
      tags: "storage",
    });

    // Get the first note's ID
    const firstNote = projectDb
      .query("SELECT id FROM notes ORDER BY created_at ASC LIMIT 1")
      .get() as { id: string };

    // Depth 1: only direct links
    const shallow = handleRecall(projectDb, globalDb, {
      id: firstNote.id,
      depth: 1,
    });

    // Depth 3: multi-hop traversal
    const deep = handleRecall(projectDb, globalDb, {
      id: firstNote.id,
      depth: 3,
    });

    // Deep traversal should find at least as many links as shallow
    expect(deep.detail!.links.length).toBeGreaterThanOrEqual(
      shallow.detail!.links.length
    );
  });
});
