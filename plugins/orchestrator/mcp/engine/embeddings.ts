import type { Database } from "bun:sqlite";
import { chunkText } from "./chunking";

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

/**
 * The model whose vectors are CURRENTLY VALID. Stored on every row and
 * required to match at query time.
 *
 * 0.47.0 switched from bge-m3 (1024-dim, multilingual, ~1.8GB resident) to
 * bge-small-en-v1.5 (384-dim, English, ~130MB). Measured on a 300-note subset
 * with identical probes and chunking, mean rank of the correct note:
 *   whole-note bge-m3   63.2
 *   chunked    bge-m3   32.0
 *   chunked    bge-small 11.4   <- two probes at #1
 * plus 82ms/chunk vs 575ms. The multilingual model was spending its capacity
 * on cross-lingual structure this English-only corpus never uses.
 *
 * Vectors from different models share no coordinate system, so rows written by
 * an older model must be IGNORED rather than compared. Search filters on this
 * value; un-matching notes simply fall back to keyword until re-embedded.
 */
export const ACTIVE_EMBED_MODEL = "bge-small-en-v1.5";

/**
 * HuggingFace repo for ACTIVE_EMBED_MODEL, passed explicitly to the sidecar.
 *
 * Passing it makes THIS file authoritative. The Python default and this
 * constant would otherwise be two independent sources of truth for the same
 * decision, and a drift between them writes rows tagged with one model that
 * were actually produced by another - silently poisoning the corpus with
 * mixed, incomparable vectors that all claim to be comparable.
 */
export const ACTIVE_EMBED_MODEL_REPO = "BAAI/bge-small-en-v1.5";

/**
 * Vector width of ACTIVE_EMBED_MODEL. Used to VERIFY a sidecar before adopting
 * it, because dimension is a property of the weights actually loaded, while
 * the model NAME reported by /health was a hardcoded literal until 0.47.1 and
 * therefore not trustworthy on an older sidecar.
 */
export const ACTIVE_EMBED_DIM = 384;

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
    // 0.46.0: embed PASSAGES, not just the whole note.
    //
    // The note-level vector is still written to `embeddings` - the
    // near-duplicate gate and auto-linker ask "is this whole note like that
    // whole note?", which is a document-level question. But RETRIEVAL asks
    // "which note contains this idea?", and a document average cannot answer
    // it: measured 2026-08-08, paraphrase probes ranked the correct note
    // #205-#3247 of 7148 while keyword ranked the same notes #1. Chunking won
    // 5/5 probes in a controlled A/B (mean rank 63 -> 32 within a 300-note
    // subset). Chunks also fit inside the tokenizer's 512-token window, which
    // was silently truncating 3402 of 7148 notes.
    const chunks = chunkText(content);
    if (chunks.length === 0) return false;

    // One call: note-level vector first, then every chunk.
    const vectors = await this.embed([content, ...chunks]);
    if (!vectors || vectors.length !== chunks.length + 1) return false;

    const ts = new Date().toISOString();
    db.run(
      `INSERT OR REPLACE INTO embeddings (note_id, vector, model, embedded_at)
       VALUES (?, ?, ?, ?)`,
      [noteId, Buffer.from(vectors[0].buffer), ACTIVE_EMBED_MODEL, ts]
    );

    // Replace wholesale - a shortened note must not keep its old tail chunks,
    // or deleted text stays searchable forever.
    db.run(`DELETE FROM note_chunks WHERE note_id = ?`, [noteId]);
    const stmt = db.prepare(
      `INSERT INTO note_chunks (note_id, chunk_index, vector, model, embedded_at)
       VALUES (?, ?, ?, ?, ?)`
    );
    for (let i = 0; i < chunks.length; i++) {
      stmt.run(noteId, i, Buffer.from(vectors[i + 1].buffer), ACTIVE_EMBED_MODEL, ts);
    }

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
          stmt.run(batch[j].id, blob, ACTIVE_EMBED_MODEL, ts);
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
   * Give existing notes passage vectors (0.46.0 migration path).
   *
   * DELIBERATE, NOT AUTOMATIC. This is the lesson from 0.44.0/0.45.1: a
   * startup path that quietly sweeps the whole corpus is how a plugin brings a
   * machine to its knees. Nothing calls this on its own - it is invoked by an
   * explicit maintenance run, and search degrades gracefully in the meantime
   * because notes without chunks still score off their note-level vector.
   *
   * RESUMABLE BY CONSTRUCTION: the population is "notes with no chunk rows",
   * re-evaluated at call time. Interrupt it, run it again, and it picks up
   * where it stopped - no cursor to persist and no frozen work-list to go
   * stale while the fleet keeps writing.
   *
   * `limit` bounds a single run so it can be done in sessions rather than one
   * multi-hour block.
   */
  async backfillChunks(
    db: Database,
    batchSize: number = 8,
    limit?: number,
  ): Promise<BackfillResult> {
    const rows = db
      .query(
        `SELECT n.id, n.content FROM notes n
         WHERE NOT EXISTS (SELECT 1 FROM note_chunks c WHERE c.note_id = n.id)
         ORDER BY length(n.content) DESC${limit ? ` LIMIT ${Math.max(1, Math.floor(limit))}` : ``}`
      )
      .all() as Array<{ id: string; content: string }>;

    const result: BackfillResult = {
      embedded: 0,
      failed: 0,
      attempted: rows.length,
      batchesTotal: Math.ceil(rows.length / batchSize),
      batchesFailed: 0,
    };
    if (rows.length === 0) return result;

    // Longest notes first: they are the ones the old whole-note vector served
    // worst, so an interrupted run still delivers the biggest wins.
    for (let i = 0; i < rows.length; i += batchSize) {
      const batch = rows.slice(i, i + batchSize);
      try {
        for (const note of batch) {
          const ok = await this.embedIfAvailable(db, note.id, note.content);
          if (ok) result.embedded++;
          else { result.failed++; }
        }
      } catch (err) {
        console.error(`[embed] Chunk backfill batch ${i / batchSize + 1} failed:`, err);
        result.failed += batch.length;
        result.batchesFailed++;
      }
    }
    return result;
  }

  /**
   * Remove the embedding for a note.
   */
  removeEmbedding(db: Database, noteId: string): void {
    db.run("DELETE FROM embeddings WHERE note_id = ?", [noteId]);
    // Chunks are ON DELETE CASCADE from notes, but a note that merely lost its
    // embedding (a failed refresh) must not keep stale passages behind.
    try { db.run("DELETE FROM note_chunks WHERE note_id = ?", [noteId]); } catch { /* pre-migration db */ }
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
