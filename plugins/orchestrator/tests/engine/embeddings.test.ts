import { describe, test, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { applyMigrations } from "../../mcp/db/schema";
import { EmbeddingClient, blobToVector } from "../../mcp/engine/embeddings";
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

describe("EmbeddingClient", () => {
  test("embed() returns vectors from sidecar", async () => {
    const mockVector = Array(768).fill(0.1);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ vectors: [mockVector] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })) as any;
    try {
      const client = new EmbeddingClient("http://localhost:9999");
      const result = await client.embed(["hello world"]);
      expect(result).not.toBeNull();
      expect(result![0].length).toBe(768);
      expect(result![0][0]).toBeCloseTo(0.1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("embed() returns null when sidecar is unavailable", async () => {
    const client = new EmbeddingClient("http://localhost:1");
    const result = await client.embed(["hello"]);
    expect(result).toBeNull();
  });

  test("isAvailable() returns false when sidecar is down", async () => {
    const client = new EmbeddingClient("http://localhost:1");
    const available = await client.isAvailable();
    expect(available).toBe(false);
  });

  test("isAvailable() returns true when sidecar is healthy", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ status: "ready", model: "bge-m3", dim: 768 }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )) as any;
    try {
      const client = new EmbeddingClient("http://localhost:9999");
      const available = await client.isAvailable();
      expect(available).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("embedIfAvailable stores embedding in DB", async () => {
    const mockVector = Array(768).fill(0.5);
    const originalFetch = globalThis.fetch;
    // Mock both health check and embed
    let callCount = 0;
    globalThis.fetch = (async (url: string) => {
      const urlStr = typeof url === "string" ? url : (url as any).toString();
      if (urlStr.includes("/health")) {
        return new Response(
          JSON.stringify({ status: "ready", model: "bge-m3", dim: 768 }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      return new Response(JSON.stringify({ vectors: [mockVector] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as any;

    try {
      const db = new Database(":memory:");
      applyMigrations(db, "project");
      const noteId = insertNote(db, { content: "test embedding content" });

      const client = new EmbeddingClient("http://localhost:9999");
      const success = await client.embedIfAvailable(
        db,
        noteId,
        "test embedding content"
      );
      expect(success).toBe(true);

      // Verify stored in DB
      const row = db
        .query("SELECT * FROM embeddings WHERE note_id = ?")
        .get(noteId) as any;
      expect(row).not.toBeNull();
      expect(row.model).toBe("bge-m3");
      expect(row.note_id).toBe(noteId);

      // Verify the vector can be recovered
      const vec = blobToVector(row.vector);
      expect(vec.length).toBe(768);
      expect(vec[0]).toBeCloseTo(0.5);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("embedIfAvailable returns false when sidecar is down", async () => {
    const db = new Database(":memory:");
    applyMigrations(db, "project");
    const noteId = insertNote(db, { content: "test content" });

    const client = new EmbeddingClient("http://localhost:1");
    const success = await client.embedIfAvailable(db, noteId, "test content");
    expect(success).toBe(false);

    // Verify nothing stored
    const row = db
      .query("SELECT * FROM embeddings WHERE note_id = ?")
      .get(noteId);
    expect(row).toBeNull();
  });

  test("backfill embeds notes without embeddings", async () => {
    const mockVector = Array(768).fill(0.2);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      const urlStr = typeof url === "string" ? url : (url as any).toString();
      if (urlStr.includes("/health")) {
        return new Response(
          JSON.stringify({ status: "ready", model: "bge-m3", dim: 768 }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      // Parse the request body to return the right number of vectors
      const reqBody = JSON.parse(init?.body as string) as { texts: string[] };
      const vectors = reqBody.texts.map(() => mockVector);
      return new Response(JSON.stringify({ vectors }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as any;

    try {
      const db = new Database(":memory:");
      applyMigrations(db, "project");

      // Insert 3 notes, none have embeddings
      insertNote(db, { content: "note about backups" });
      insertNote(db, { content: "note about docker" });
      insertNote(db, { content: "note about testing" });

      const client = new EmbeddingClient("http://localhost:9999");
      const count = await client.backfill(db);
      expect(count).toBe(3);

      // Verify all have embeddings now
      const rows = db.query("SELECT COUNT(*) as cnt FROM embeddings").get() as {
        cnt: number;
      };
      expect(rows.cnt).toBe(3);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("backfill returns 0 when sidecar is down", async () => {
    const db = new Database(":memory:");
    applyMigrations(db, "project");
    insertNote(db, { content: "orphan note" });

    const client = new EmbeddingClient("http://localhost:1");
    const count = await client.backfill(db);
    expect(count).toBe(0);
  });

  test("removeEmbedding deletes from DB", () => {
    const db = new Database(":memory:");
    applyMigrations(db, "project");
    const noteId = insertNote(db, { content: "to be removed" });

    // Manually insert an embedding
    const vec = new Float32Array(768).fill(0.3);
    db.run(
      "INSERT INTO embeddings (note_id, vector, model, embedded_at) VALUES (?, ?, ?, ?)",
      [noteId, Buffer.from(vec.buffer), "bge-m3", now()]
    );

    // Verify it exists
    const before = db
      .query("SELECT * FROM embeddings WHERE note_id = ?")
      .get(noteId);
    expect(before).not.toBeNull();

    const client = new EmbeddingClient("http://localhost:9999");
    client.removeEmbedding(db, noteId);

    // Verify it's gone
    const after = db
      .query("SELECT * FROM embeddings WHERE note_id = ?")
      .get(noteId);
    expect(after).toBeNull();
  });
});

describe("blobToVector", () => {
  test("converts Buffer to Float32Array", () => {
    const original = new Float32Array([1.0, 2.0, 3.0]);
    const blob = Buffer.from(original.buffer);
    const result = blobToVector(blob);
    expect(result.length).toBe(3);
    expect(result[0]).toBeCloseTo(1.0);
    expect(result[2]).toBeCloseTo(3.0);
  });

  test("handles empty buffer", () => {
    const original = new Float32Array([]);
    const blob = Buffer.from(original.buffer);
    const result = blobToVector(blob);
    expect(result.length).toBe(0);
  });

  test("preserves precision across round-trip", () => {
    const original = new Float32Array([
      0.123456789, -0.987654321, 3.14159265,
    ]);
    const blob = Buffer.from(original.buffer);
    const result = blobToVector(blob);
    expect(result[0]).toBeCloseTo(0.123456789, 5);
    expect(result[1]).toBeCloseTo(-0.987654321, 5);
    expect(result[2]).toBeCloseTo(3.14159265, 5);
  });
});
