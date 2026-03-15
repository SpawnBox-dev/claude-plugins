import type { Database } from "bun:sqlite";

/**
 * Client for the Python embedding sidecar (ONNX bge-m3).
 *
 * All methods gracefully degrade: they return null/false/0 when the
 * sidecar is unavailable - they never throw.
 */
export class EmbeddingClient {
  private baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  /**
   * Check if the sidecar is up and ready.
   * GET /health, 2s timeout, returns true only if status=ready.
   */
  async isAvailable(): Promise<boolean> {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 2000);
      const res = await fetch(`${this.baseUrl}/health`, {
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (!res.ok) return false;
      const body = (await res.json()) as { status?: string };
      return body.status === "ready";
    } catch {
      return false;
    }
  }

  /**
   * Embed an array of texts via the sidecar.
   * POST /embed, 30s timeout, returns null on any error.
   */
  async embed(texts: string[]): Promise<Float32Array[] | null> {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30_000);
      const res = await fetch(`${this.baseUrl}/embed`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ texts }),
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (!res.ok) return null;
      const body = (await res.json()) as { vectors: number[][] };
      return body.vectors.map((v) => new Float32Array(v));
    } catch {
      return null;
    }
  }

  /**
   * Embed a single note and store the vector in the embeddings table.
   * Returns true on success, false if sidecar is down or embedding fails.
   */
  async embedIfAvailable(
    db: Database,
    noteId: string,
    content: string
  ): Promise<boolean> {
    const vectors = await this.embed([content]);
    if (!vectors || vectors.length === 0) return false;

    const vector = vectors[0];
    const blob = Buffer.from(vector.buffer);

    db.run(
      `INSERT OR REPLACE INTO embeddings (note_id, vector, model, embedded_at)
       VALUES (?, ?, ?, ?)`,
      [noteId, blob, "bge-m3", new Date().toISOString()]
    );

    return true;
  }

  /**
   * Find all notes without embeddings, batch embed them, and store.
   * Returns the count of newly embedded notes (0 on failure or nothing to do).
   */
  async backfill(db: Database, batchSize: number = 100): Promise<number> {
    const rows = db
      .query(
        `SELECT n.id, n.content FROM notes n
         LEFT JOIN embeddings e ON n.id = e.note_id
         WHERE e.note_id IS NULL
         LIMIT ?`
      )
      .all(batchSize) as Array<{ id: string; content: string }>;

    if (rows.length === 0) return 0;

    const texts = rows.map((r) => r.content);
    const vectors = await this.embed(texts);
    if (!vectors || vectors.length !== rows.length) return 0;

    const ts = new Date().toISOString();
    const stmt = db.prepare(
      `INSERT OR REPLACE INTO embeddings (note_id, vector, model, embedded_at)
       VALUES (?, ?, ?, ?)`
    );

    for (let i = 0; i < rows.length; i++) {
      const blob = Buffer.from(vectors[i].buffer);
      stmt.run(rows[i].id, blob, "bge-m3", ts);
    }

    return rows.length;
  }

  /**
   * Remove the embedding for a note.
   */
  removeEmbedding(db: Database, noteId: string): void {
    db.run("DELETE FROM embeddings WHERE note_id = ?", [noteId]);
  }
}

/**
 * Convert a BLOB (Buffer) back to a Float32Array.
 * Copies the buffer to ensure proper alignment.
 */
export function blobToVector(blob: Buffer): Float32Array {
  const copy = blob.buffer.slice(
    blob.byteOffset,
    blob.byteOffset + blob.byteLength
  );
  return new Float32Array(copy);
}
