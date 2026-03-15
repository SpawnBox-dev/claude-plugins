import { describe, test, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { applyMigrations } from "../../mcp/db/schema";
import { handleCheckSimilar } from "../../mcp/tools/check_similar";
import { generateId, now } from "../../mcp/utils";

function makeDb(): Database {
  const db = new Database(":memory:");
  applyMigrations(db, "project");
  return db;
}

/**
 * Create a known unit vector for testing.
 * Returns a Float32Array where only the given index is 1.0, rest are 0.
 */
function unitVector(dim: number, index: number): Float32Array {
  const v = new Float32Array(dim);
  v[index] = 1.0;
  return v;
}

function insertNote(
  db: Database,
  opts: { id: string; type: string; content: string; resolved?: number }
): void {
  const ts = now();
  db.run(
    `INSERT INTO notes (id, type, content, keywords, tags, confidence, last_validated, resolved, created_at, updated_at)
     VALUES (?, ?, ?, '', '', 'medium', ?, ?, ?, ?)`,
    [opts.id, opts.type, opts.content, ts, opts.resolved ?? 0, ts, ts]
  );
}

function insertEmbedding(db: Database, noteId: string, vector: Float32Array): void {
  const blob = Buffer.from(vector.buffer);
  db.run(
    `INSERT INTO embeddings (note_id, vector, model, embedded_at)
     VALUES (?, ?, 'bge-m3', ?)`,
    [noteId, blob, now()]
  );
}

describe("check_similar tool", () => {
  let db: Database;

  beforeEach(() => {
    db = makeDb();
  });

  test("finds similar note with matching vector (similarity ~1.0)", () => {
    const noteId = generateId();
    const vector = unitVector(384, 0);

    insertNote(db, { id: noteId, type: "decision", content: "Always use event-driven architecture" });
    insertEmbedding(db, noteId, vector);

    // Query with the same vector should yield similarity ~1.0
    const result = handleCheckSimilar(db, vector, {
      proposed_action: "Use event-driven architecture for services",
    });

    expect(result.results.length).toBe(1);
    expect(result.results[0].id).toBe(noteId);
    expect(result.results[0].similarity).toBeCloseTo(1.0, 5);
    expect(result.results[0].type).toBe("decision");
    expect(result.results[0].content).toBe("Always use event-driven architecture");
  });

  test("null queryVector returns empty with unavailable message", () => {
    const noteId = generateId();
    const vector = unitVector(384, 0);

    insertNote(db, { id: noteId, type: "decision", content: "Some decision" });
    insertEmbedding(db, noteId, vector);

    const result = handleCheckSimilar(db, null, {
      proposed_action: "anything",
    });

    expect(result.results).toEqual([]);
    expect(result.message).toContain("unavailable");
  });

  test("type filtering works - insight excluded when filtering for decisions only", () => {
    const decisionId = generateId();
    const insightId = generateId();
    const vector = unitVector(384, 0);

    insertNote(db, { id: decisionId, type: "decision", content: "Use TypeScript strict mode" });
    insertEmbedding(db, decisionId, vector);

    insertNote(db, { id: insightId, type: "insight", content: "TypeScript is popular" });
    insertEmbedding(db, insightId, vector);

    // Filter only decisions
    const result = handleCheckSimilar(db, vector, {
      proposed_action: "Enable strict mode in TS config",
      types: ["decision"],
    });

    expect(result.results.length).toBe(1);
    expect(result.results[0].id).toBe(decisionId);
    expect(result.results[0].type).toBe("decision");
  });

  test("resolved notes are excluded", () => {
    const activeId = generateId();
    const resolvedId = generateId();
    const vector = unitVector(384, 0);

    insertNote(db, { id: activeId, type: "decision", content: "Active decision about APIs" });
    insertEmbedding(db, activeId, vector);

    insertNote(db, { id: resolvedId, type: "decision", content: "Resolved decision about APIs", resolved: 1 });
    insertEmbedding(db, resolvedId, vector);

    const result = handleCheckSimilar(db, vector, {
      proposed_action: "New API decision",
    });

    // Only the active note should appear
    expect(result.results.length).toBe(1);
    expect(result.results[0].id).toBe(activeId);
  });

  test("notes below threshold are excluded", () => {
    const noteId = generateId();
    // Create two orthogonal vectors - cosine similarity = 0
    const noteVector = unitVector(384, 0);
    const queryVector = unitVector(384, 1);

    insertNote(db, { id: noteId, type: "decision", content: "Unrelated decision" });
    insertEmbedding(db, noteId, noteVector);

    const result = handleCheckSimilar(db, queryVector, {
      proposed_action: "Something completely different",
      threshold: 0.5,
    });

    expect(result.results).toEqual([]);
  });

  test("results sorted descending by similarity", () => {
    const id1 = generateId();
    const id2 = generateId();

    // Vector 1: [1, 0, 0, ...]
    const v1 = unitVector(384, 0);
    // Vector 2: mix of dimensions 0 and 1 (less similar to pure dim-0 query)
    const v2 = new Float32Array(384);
    v2[0] = 0.5;
    v2[1] = 0.866; // normalized: sqrt(0.25 + 0.75) = 1.0

    insertNote(db, { id: id1, type: "convention", content: "Convention A" });
    insertEmbedding(db, id1, v1);

    insertNote(db, { id: id2, type: "decision", content: "Decision B" });
    insertEmbedding(db, id2, v2);

    // Query along dimension 0 - id1 should be more similar
    const queryVector = unitVector(384, 0);
    const result = handleCheckSimilar(db, queryVector, {
      proposed_action: "test",
    });

    expect(result.results.length).toBe(2);
    expect(result.results[0].id).toBe(id1);
    expect(result.results[0].similarity).toBeGreaterThan(result.results[1].similarity);
  });

  test("uses default types when none specified", () => {
    const decisionId = generateId();
    const workItemId = generateId();
    const vector = unitVector(384, 0);

    insertNote(db, { id: decisionId, type: "decision", content: "A decision" });
    insertEmbedding(db, decisionId, vector);

    // work_item is not in the default types
    insertNote(db, { id: workItemId, type: "work_item", content: "A work item" });
    insertEmbedding(db, workItemId, vector);

    const result = handleCheckSimilar(db, vector, {
      proposed_action: "test",
    });

    // Only decision should appear (default types: decision, convention, anti_pattern)
    expect(result.results.length).toBe(1);
    expect(result.results[0].id).toBe(decisionId);
  });

  test("limits results to 10", () => {
    const vector = unitVector(384, 0);

    // Insert 15 decision notes with the same vector
    for (let i = 0; i < 15; i++) {
      const id = generateId();
      insertNote(db, { id, type: "decision", content: `Decision ${i}` });
      insertEmbedding(db, id, vector);
    }

    const result = handleCheckSimilar(db, vector, {
      proposed_action: "test",
    });

    expect(result.results.length).toBeLessThanOrEqual(10);
  });
});
