import type { Database } from "bun:sqlite";

/**
 * Per-request ceiling for a /embed call.
 *
 * 0.44.1: was an inline 30_000, which made backfill's old batch of 32
 * structurally impossible. MEASURED on the live 7083-note KB (CPU ONNX bge-m3):
 * batch=8 -> 24.7s, batch=16 -> 34.0s, batch=32 -> 92.4s, on payloads totalling
 * only ~12.7KB. So the cost is model time, not bytes, and 30s left a batch of 8
 * almost no headroom while guaranteeing 16 and 32 could never succeed.
 */
const EMBED_TIMEOUT_MS = 120_000;

/** What a backfill pass actually did. See backfill() for why this is not a number. */
export interface BackfillResult {
  /** Notes successfully embedded and written. */
  embedded: number;
  /** Notes that were selected for repair but lost to a failed batch. */
  failed: number;
  /** Notes selected by the staleness predicate this run. */
  attempted: number;
  batchesTotal: number;
  batchesFailed: number;
}

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
      const timeout = setTimeout(() => controller.abort(), EMBED_TIMEOUT_MS);
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
   *
   * RETURNS A RESULT OBJECT, NOT A COUNT (0.44.1). It used to return a bare
   * number, and that number could not distinguish "nothing needed repair" from
   * "every single batch failed" - both are zero. That is exactly what happened
   * on the first live repair run: all batches timed out, backfill logged to
   * stderr and returned 0, and the run read as a clean no-op. A check that
   * cannot say no is indistinguishable from one that found nothing. Callers
   * that care about repair actually happening must inspect `failed` /
   * `batchesFailed`, not just `embedded`.
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
  async backfill(
    db: Database,
    batchSize: number = 8,
    opts: { includeStale?: boolean } = {},
  ): Promise<BackfillResult> {
    // 0.45.1 - THE STALE SWEEP IS OPT-IN, AND THIS DEFAULT IS LOAD-BEARING.
    //
    // backfill() runs AUTOMATICALLY on every MCP server startup (server.ts,
    // three call sites). Historically it selected only rows with NO embedding,
    // which on an established KB is ~zero work - a startup no-op.
    //
    // 0.44.0 widened the predicate to include STALE rows so the staleness
    // backlog could be repaired. That silently converted the startup no-op
    // into a full-backlog job: 1350 notes on this KB, fired by EVERY session
    // on EVERY start, each note costing seconds of CPU-bound ONNX inference in
    // a shared Python sidecar. 0.44.1 then raised the timeout and shrank the
    // batch, which made it worse in practice - it stopped failing fast at 30s
    // and started grinding successfully for hours. Measured live: one sidecar
    // at 1.8GB RSS and 617 CPU-seconds within minutes of a plugin reload, on a
    // machine that had already been brought to a halt once.
    //
    // Repairing a backlog is a DELIBERATE maintenance action, not something a
    // process does to its user on startup. Startup fills only what is MISSING
    // (bounded, near-zero on an established KB); the stale sweep is requested
    // explicitly by the repair path.
    const staleClause = opts.includeStale
      ? ` OR e.embedded_at IS NULL OR e.embedded_at < n.updated_at`
      : ``;
    const allRows = db
      .query(
        `SELECT n.id, n.content FROM notes n
         LEFT JOIN embeddings e ON n.id = e.note_id
         WHERE e.note_id IS NULL${staleClause}`
      )
      .all() as Array<{ id: string; content: string }>;

    const result: BackfillResult = {
      embedded: 0,
      failed: 0,
      attempted: allRows.length,
      batchesTotal: Math.ceil(allRows.length / batchSize),
      batchesFailed: 0,
    };
    if (allRows.length === 0) return result;

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
          result.failed += batch.length;
          result.batchesFailed++;
          continue;
        }

        const ts = new Date().toISOString();
        for (let j = 0; j < batch.length; j++) {
          const blob = Buffer.from(vectors[j].buffer);
          stmt.run(batch[j].id, blob, "bge-m3", ts);
        }
        result.embedded += batch.length;
      } catch (err) {
        console.error(`[embed] Backfill batch ${i / batchSize + 1} failed, skipping ${batch.length} notes:`, err);
        result.failed += batch.length;
        result.batchesFailed++;
        continue;
      }
    }

    return result;
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
