import { describe, test, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { applyMigrations } from "../../mcp/db/schema";
import { findRelatedNotes, findRelatedNotesHybrid, createAutoLinks, inferRelationship } from "../../mcp/engine/linker";
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
    `INSERT INTO notes (id, type, content, context, keywords, tags, confidence, resolved, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      overrides.type ?? "insight",
      overrides.content ?? "default content",
      overrides.context ?? null,
      overrides.keywords ?? "",
      overrides.tags ?? "",
      overrides.confidence ?? "medium",
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

  test("infers relationship types based on note types", () => {
    // R3.7: decision <-> open_thread no longer infers supersedes (too strong
    // a claim from keyword overlap alone). handleSupersede is the only valid
    // path for supersedes edges; auto-linker defaults to related_to here.
    expect(inferRelationship("decision", "open_thread")).toBe("related_to");
    expect(inferRelationship("quality_gate", "convention")).toBe("blocks");
    expect(inferRelationship("dependency", "architecture")).toBe("depends_on");
    expect(inferRelationship("anti_pattern", "convention")).toBe("conflicts_with");
    expect(inferRelationship("architecture", "convention")).toBe("enables");
    expect(inferRelationship("risk", "commitment")).toBe("blocks");
    expect(inferRelationship("insight", "insight")).toBe("related_to");
  });

  test("auto-links use inferred relationship types", () => {
    const decisionId = insertNote(db, {
      type: "decision",
      content: "decided to use backup snapshots for data",
      keywords: "backup,snapshot,data,decided",
    });
    insertNote(db, {
      type: "open_thread",
      content: "need to figure out backup strategy for data",
      keywords: "backup,strategy,data,figure",
    });

    const links = createAutoLinks(db, decisionId, [
      "backup",
      "snapshot",
      "data",
      "decided",
    ]);

    expect(links.length).toBeGreaterThanOrEqual(1);
    // R3.7: decision -> open_thread is now "related_to" (was "supersedes",
    // which produced false-positive supersede chains on keyword overlap).
    expect(links[0].relationship).toBe("related_to");
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

  test("findRelatedNotesHybrid falls back to FTS5 when no queryVector provided", async () => {
    insertNote(db, {
      content: "broker convention for telemetry",
      keywords: "broker,convention,telemetry",
    });
    const results = await findRelatedNotesHybrid(db, "broker telemetry", 10);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].content).toContain("broker");
  });

  test("findRelatedNotesHybrid uses vector similarity when queryVector provided", async () => {
    const id = insertNote(db, {
      content: "broker convention for telemetry",
      keywords: "broker,convention,telemetry",
    });
    // Insert a mock embedding
    const mockVec = new Float32Array(768).fill(0.5);
    const blob = Buffer.from(mockVec.buffer);
    db.run(
      `INSERT INTO embeddings (note_id, vector, model, embedded_at) VALUES (?, ?, ?, ?)`,
      [id, blob, "bge-m3", new Date().toISOString()]
    );

    const queryVec = new Float32Array(768).fill(0.5);
    const results = await findRelatedNotesHybrid(db, "broker telemetry", 10, queryVec);
    expect(results.length).toBeGreaterThan(0);
  });

  test("findRelatedNotesHybrid merges FTS and vector results via RRF", async () => {
    // Note 1: strong FTS match, has embedding
    const id1 = insertNote(db, {
      content: "backup snapshot engine handles incremental backups",
      keywords: "backup,snapshot,engine,incremental",
    });
    // Note 2: weaker FTS match, has embedding pointing same direction as query
    const id2 = insertNote(db, {
      content: "backup retention policy for old snapshots",
      keywords: "backup,retention,policy,snapshots",
    });
    // Note 3: no FTS match, but has embedding
    const id3 = insertNote(db, {
      content: "discord bot sends notifications to channels",
      keywords: "discord,bot,notifications,channels",
    });

    // Give all three embeddings
    const vec1 = new Float32Array(768).fill(0.3);
    const vec2 = new Float32Array(768).fill(0.6);
    const vec3 = new Float32Array(768).fill(0.9);
    const ts = new Date().toISOString();
    for (const [id, vec] of [[id1, vec1], [id2, vec2], [id3, vec3]] as [string, Float32Array][]) {
      db.run(
        `INSERT INTO embeddings (note_id, vector, model, embedded_at) VALUES (?, ?, ?, ?)`,
        [id, Buffer.from(vec.buffer), "bge-m3", ts]
      );
    }

    // Query vector similar to vec2
    const queryVec = new Float32Array(768).fill(0.6);
    const results = await findRelatedNotesHybrid(db, "backup snapshot", 10, queryVec);
    expect(results.length).toBeGreaterThanOrEqual(2);
    // All returned results should have valid ids
    for (const r of results) {
      expect(r.id).toBeTruthy();
      expect(r.content).toBeTruthy();
    }
  });

  test("findRelatedNotesHybrid respects limit", async () => {
    for (let i = 0; i < 5; i++) {
      insertNote(db, {
        content: `broker telemetry note number ${i}`,
        keywords: "broker,telemetry",
      });
    }
    const results = await findRelatedNotesHybrid(db, "broker telemetry", 2);
    expect(results.length).toBeLessThanOrEqual(2);
  });

  test("findRelatedNotes handles hyphenated query terms (regression for x-ray bug)", () => {
    insertNote(db, {
      content: "X-ray detection and mining anomaly analysis",
      keywords: "xray,detection,mining,anomaly",
      tags: "x-ray-detection,mining,investigation",
    });
    insertNote(db, {
      content: "Burst detection rate calculation",
      keywords: "burst,detection,rate",
    });

    // Bug: pre-v0.20.1 this returned zero results because FTS5 parsed the
    // hyphen in "x-ray" as a NOT operator, the catch block swallowed the
    // syntax error, and the caller saw no matches.
    const results = findRelatedNotes(db, "x-ray detection", 10);
    expect(results.length).toBeGreaterThanOrEqual(1);
    // The hyphenated note should be findable
    expect(results.some((r) => r.content.includes("X-ray"))).toBe(true);
  });

  test("findRelatedNotes handles underscore query terms", () => {
    insertNote(db, {
      content: "rcon guard token extraction",
      keywords: "rcon,guard,token",
    });

    // Same bug pattern - underscore is an FTS5 token separator in the
    // unicode61 tokenizer, so "rcon_guard" needs to split into ["rcon", "guard"]
    // to match what's stored in the index.
    const results = findRelatedNotes(db, "rcon_guard token", 10);
    expect(results.length).toBeGreaterThanOrEqual(1);
  });

  test("findRelatedNotes handles multi-term query with hyphens mixed in", () => {
    insertNote(db, {
      content: "Mining investigation finds x-ray false positive and burst detection",
      keywords: "mining,investigation,xray,false,positive",
    });

    // This was the original failing query from the v0.20 live test -
    // 8 keywords including hyphenated "x-ray".
    const results = findRelatedNotes(
      db,
      "player investigation mining anomaly detection false positive x-ray",
      10
    );
    expect(results.length).toBeGreaterThanOrEqual(1);
  });
});

describe("R3.7: inferRelationship no longer produces supersedes edges", () => {
  test("decision -> open_thread returns related_to (not supersedes)", () => {
    expect(inferRelationship("decision", "open_thread")).toBe("related_to");
  });

  test("open_thread -> decision returns related_to (not supersedes)", () => {
    expect(inferRelationship("open_thread", "decision")).toBe("related_to");
  });
});
