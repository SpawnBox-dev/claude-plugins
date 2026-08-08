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
   * Find all notes whose embedding is MISSING or STALE, batch embed them, and
   * store. Loops in chunks, continues past failed batches (logs, skips).
   * Returns the total count of newly embedded notes.
   *
   * 0.44.0: this used to select `WHERE e.note_id IS NULL` - missing rows only.
   * A stale row is present, so it was skipped forever and staleness was
   * PERMANENT once created; nothing in the codebase re-embedded. That made
   * this the reason defects 1/2/4 could not self-heal (insight 44d445bb).
   *
   * The staleness predicate is `embedded_at < updated_at`, which deliberately
   * OVER-selects: updated_at also moves on tags-only, status-only and
   * code_refs-only edits that leave the embeddable text unchanged. That is the
   * right trade here - re-embedding is idempotent and merely costs sidecar
   * time, whereas under-selecting would leave real staleness in place. Do NOT
   * "tighten" this into a content-equality check without a content_hash
   * column; comparing against a marker-parse silently misses full-`content`
   * rewrites, which leave no marker.
   */
  async backfill(db: Database, batchSize: number = 32): Promise<number> {
    const allRows = db
      .query(
        `SELECT n.id, n.content FROM notes n
         LEFT JOIN embeddings e ON n.id = e.note_id
         WHERE e.note_id IS NULL
            OR e.embedded_at IS NULL
            OR e.embedded_at < n.updated_at`
      )
      .all() as Array<{ id: string; content: string }>;

    if (allRows.length === 0) return 0;

    let totalEmbedded = 0;
    const stmt = db.prepare(
      `INSERT OR REPLACE INTO embeddings (note_id, vector, model, embedded_at)
       VALUES (?, ?, ?, ?)`
    );

    for (let i = 0; i < allRows.length; i += batchSize) {
      const batch = allRows.slice(i, i + batchSize);
      const texts = batch.map((r) => r.content);

      try {
        const vectors = await this.embed(texts);
        if (!vectors || vectors.length !== batch.length) {
          console.error(`[embed] Backfill batch ${i / batchSize + 1} returned unexpected result, skipping ${batch.length} notes`);
          continue;
        }

        const ts = new Date().toISOString();
        for (let j = 0; j < batch.length; j++) {
          const blob = Buffer.from(vectors[j].buffer);
          stmt.run(batch[j].id, blob, "bge-m3", ts);
        }
        totalEmbedded += batch.length;
      } catch (err) {
        console.error(`[embed] Backfill batch ${i / batchSize + 1} failed, skipping ${batch.length} notes:`, err);
        continue;
      }
    }

    return totalEmbedded;
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
