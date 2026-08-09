import { describe, test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "fs";
import { join } from "path";
import { applyMigrations } from "../../mcp/db/schema";
import { EmbeddingClient, ACTIVE_EMBED_MODEL } from "../../mcp/engine/embeddings";
import { generateId, now } from "../../mcp/utils";
import { CHUNK_TARGET_CHARS } from "../../mcp/engine/chunking";

// 0.46.0 - passage-level retrieval.
//
// Controlled A/B on the live KB (300-note subset, same model, same probes):
// chunked max-pool beat whole-note vectors on 5/5 paraphrase probes, mean rank
// 63.2 -> 32.0. Root causes it addresses: (1) the tokenizer discarded
// everything past 512 tokens, affecting 3402 of 7148 notes; (2) one vector
// cannot represent a multi-topic document, so specific ideas averaged away.

function makeDb(): Database {
  const db = new Database(":memory:");
  applyMigrations(db, "project");
  return db;
}

function insertNote(db: Database, content: string) {
  const id = generateId();
  const ts = now();
  db.run(
    `INSERT INTO notes (id, type, content, context, keywords, tags, confidence, resolved, created_at, updated_at)
     VALUES (?, 'insight', ?, NULL, '', '', 'medium', 0, ?, ?)`,
    [id, content, ts, ts]
  );
  return id;
}

/** Deterministic stub: one distinct unit vector per distinct text. */
function stubClient() {
  const c = new EmbeddingClient("http://127.0.0.1:1");
  (c as any).embed = async (texts: string[]) =>
    texts.map((t) => {
      const v = new Float32Array(8);
      for (let i = 0; i < t.length; i++) v[i % 8] += t.charCodeAt(i) % 7;
      const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
      return v.map((x) => x / n) as Float32Array;
    });
  return c;
}

describe("0.46.0: embedding writes passage vectors", () => {
  test("a long note produces MULTIPLE chunk rows", async () => {
    const db = makeDb();
    const id = insertNote(db, "topic sentence. ".repeat(600)); // ~9600 chars
    const ok = await stubClient().embedIfAvailable(db, id, "topic sentence. ".repeat(600));
    expect(ok).toBe(true);
    const n = (db.query(`SELECT COUNT(*) c FROM note_chunks WHERE note_id = ?`).get(id) as any).c;
    expect(n).toBeGreaterThan(3);
  });

  test("a short note produces exactly one chunk", async () => {
    const db = makeDb();
    const id = insertNote(db, "short note");
    await stubClient().embedIfAvailable(db, id, "short note");
    const n = (db.query(`SELECT COUNT(*) c FROM note_chunks WHERE note_id = ?`).get(id) as any).c;
    expect(n).toBe(1);
  });

  test("the note-level vector is STILL written (the gate depends on it)", async () => {
    const db = makeDb();
    const id = insertNote(db, "x".repeat(CHUNK_TARGET_CHARS * 3));
    await stubClient().embedIfAvailable(db, id, "x".repeat(CHUNK_TARGET_CHARS * 3));
    const n = (db.query(`SELECT COUNT(*) c FROM embeddings WHERE note_id = ?`).get(id) as any).c;
    expect(n).toBe(1);
  });

  test("re-embedding a SHORTENED note drops its old tail chunks", async () => {
    // Otherwise deleted text stays searchable forever - the note would keep
    // matching passages it no longer contains.
    const db = makeDb();
    const id = insertNote(db, "long text here. ".repeat(600));
    const c = stubClient();
    await c.embedIfAvailable(db, id, "long text here. ".repeat(600));
    const before = (db.query(`SELECT COUNT(*) c FROM note_chunks WHERE note_id = ?`).get(id) as any).c;
    expect(before).toBeGreaterThan(3);

    await c.embedIfAvailable(db, id, "now it is short");
    const after = (db.query(`SELECT COUNT(*) c FROM note_chunks WHERE note_id = ?`).get(id) as any).c;
    expect(after).toBe(1);
  });

  test("deleting a note cascades its chunks away", async () => {
    const db = makeDb();
    const id = insertNote(db, "y".repeat(CHUNK_TARGET_CHARS * 2));
    await stubClient().embedIfAvailable(db, id, "y".repeat(CHUNK_TARGET_CHARS * 2));
    db.run(`PRAGMA foreign_keys = ON`);
    db.run(`DELETE FROM notes WHERE id = ?`, [id]);
    const n = (db.query(`SELECT COUNT(*) c FROM note_chunks WHERE note_id = ?`).get(id) as any).c;
    expect(n).toBe(0);
  });
});

describe("0.46.0: WIRING - retrieval scores by best passage", () => {
  const LINKER = readFileSync(join(import.meta.dir, "..", "..", "mcp", "engine", "linker.ts"), "utf8");

  test("the vector leg reads note_chunks", () => {
    expect(LINKER).toContain("FROM note_chunks");
  });

  test("it is MAX-DOMINANT, blended with mean (0.50.0 refinement)", () => {
    // 0.46.0 asserted pure max-pooling, reasoning that averaging would
    // re-create the dilution chunking exists to fix. MEASUREMENT REFINED THAT
    // RATHER THAN OVERTURNING IT: on a held-out probe set, pure MEAN was much
    // worse than pure max (span R@6 66.7% vs 77.1%), so the instinct held -
    // but 0.6*max + 0.4*mean beat BOTH, on both probe sets.
    //
    // The guard therefore keeps the load-bearing half of the original claim -
    // max must DOMINATE - while allowing the measured blend. A future change
    // that lets mean win is the regression this still catches.
    expect(/a\.max > /.test(LINKER) || /sim > cur\.max/.test(LINKER)).toBe(true);
    const wMax = Number(LINKER.match(/CHUNK_MAX_WEIGHT = ([\d.]+)/)?.[1] ?? 0);
    const wMean = Number(LINKER.match(/CHUNK_MEAN_WEIGHT = ([\d.]+)/)?.[1] ?? 1);
    expect(wMax).toBeGreaterThan(wMean);
    expect(wMax + wMean).toBeCloseTo(1, 5);
  });

  test("notes without chunks still fall back to the note-level vector", () => {
    // During a partial backfill, un-chunked notes must not vanish from search.
    expect(/chunked !== undefined/.test(LINKER)).toBe(true);
    expect(LINKER).toContain("FROM embeddings e");
  });

  test("the fallback membership test is a Set, not a scan", () => {
    // This runs per query across the whole corpus; an array scan here is
    // quadratic and would show up as search latency.
    expect(/seen\.has\(/.test(LINKER)).toBe(true);
  });
});

describe("0.46.0: backfillChunks is deliberate and resumable", () => {
  test("only touches notes that have no chunks yet", async () => {
    const db = makeDb();
    const a = insertNote(db, "first note body");
    const b = insertNote(db, "second note body");
    const c = stubClient();
    await c.embedIfAvailable(db, a, "first note body");

    const res = await c.backfillChunks(db);
    // a already had chunks, so only b is attempted. Re-running is therefore
    // safe and cheap - the population is recomputed, not remembered.
    expect(res.attempted).toBe(1);
    expect(res.embedded).toBe(1);
  });

  test("a second run is a clean no-op", async () => {
    const db = makeDb();
    insertNote(db, "only note");
    const c = stubClient();
    await c.backfillChunks(db);
    const again = await c.backfillChunks(db);
    expect(again.attempted).toBe(0);
    expect(again.embedded).toBe(0);
  });

  test("limit bounds a single run so it can be done in sessions", async () => {
    const db = makeDb();
    for (let i = 0; i < 5; i++) insertNote(db, "note body " + i);
    const res = await stubClient().backfillChunks(db, 8, 2);
    expect(res.attempted).toBe(2);
  });

  test("NOTHING calls it automatically - it is opt-in only", () => {
    // The 0.44.0 lesson: a sweep wired into startup is how this plugin halted
    // a machine twice in one day.
    //
    // Match a CALL, not the identifier. The first version of this guard
    // rejected any mention, so naming backfillChunks in a status message -
    // exactly where a user needs to be told how to fix stale vectors - tripped
    // it. A guard that forbids talking about the thing is too blunt to keep.
    const SERVER = readFileSync(join(import.meta.dir, "..", "..", "mcp", "server.ts"), "utf8");
    expect(/\.backfillChunks\s*\(/.test(SERVER)).toBe(false);
  });
});

describe("0.47.0: model identity is single-sourced and enforced", () => {
  const EMB = readFileSync(join(import.meta.dir, "..", "..", "mcp", "engine", "embeddings.ts"), "utf8");
  const LINKER = readFileSync(join(import.meta.dir, "..", "..", "mcp", "engine", "linker.ts"), "utf8");
  const SERVER = readFileSync(join(import.meta.dir, "..", "..", "mcp", "server.ts"), "utf8");
  const PY = readFileSync(join(import.meta.dir, "..", "..", "sidecar", "embed_server.py"), "utf8");

  test("the TS repo constant matches the sidecar default", () => {
    // Two sources of truth for the same decision means a drift writes rows
    // tagged with one model but produced by another - mixed vectors that all
    // claim to be comparable.
    const ts = EMB.match(/ACTIVE_EMBED_MODEL_REPO = "([^"]+)"/);
    const py = PY.match(/--model", default="([^"]+)"/);
    expect(ts).not.toBeNull();
    expect(py).not.toBeNull();
    expect(ts![1]).toBe(py![1]);
  });

  test("the sidecar is launched with an explicit model", () => {
    expect(SERVER).toContain("ACTIVE_EMBED_MODEL_REPO");
    expect(/"--model", ACTIVE_EMBED_MODEL_REPO/.test(SERVER)).toBe(true);
  });

  test("BOTH vector queries filter on the active model", () => {
    // A vector from a previous model is not merely worse - it is a different
    // coordinate system and a different length.
    expect(/FROM note_chunks WHERE model = \?/.test(LINKER)).toBe(true);
    expect(/FROM embeddings e WHERE e\.model = \?/.test(LINKER)).toBe(true);
  });

  test("stored rows are tagged with the active model, never a literal", () => {
    expect(EMB).not.toContain('"bge-m3", ts');
    expect(EMB).toContain("ACTIVE_EMBED_MODEL, ts");
  });
});

describe("0.47.1: a sidecar must serve the RIGHT model to be adopted", () => {
  const SERVER = readFileSync(join(import.meta.dir, "..", "..", "mcp", "server.ts"), "utf8");
  const PY = readFileSync(join(import.meta.dir, "..", "..", "sidecar", "embed_server.py"), "utf8");

  test("reuse verifies the vector DIMENSION, not just health", () => {
    // Across a model change the OLD sidecar is still alive and still healthy,
    // so a health-only check adopts it and every vector written is produced by
    // the previous model while tagged with the new one.
    expect(SERVER).toContain("ACTIVE_EMBED_DIM");
    expect(/dim === ACTIVE_EMBED_DIM/.test(SERVER)).toBe(true);
  });

  test("a wrong-model sidecar is refused rather than adopted", () => {
    expect(SERVER).toContain("Not adopting it");
  });

  test("/health reports the model actually loaded, not a literal", () => {
    // It returned "bge-m3" regardless of --model, so a sidecar serving
    // bge-small still announced itself as bge-m3.
    expect(PY).toContain('"model": _model_id');
    expect(/"model": "bge-m3"/.test(PY)).toBe(false);
  });
});

describe("0.51.0: a MODEL CHANGE is self-healing", () => {
  test("backfillChunks re-embeds notes whose chunks are from a previous model", async () => {
    const db = makeDb();
    const id = insertNote(db, "a note that was chunked under an older model");
    const ts = now();
    // Fully chunked, but under a DIFFERENT model - which is exactly the state
    // a model switch leaves behind. The old predicate ("no chunks at all")
    // matched nothing here, so the migration reported a clean run having done
    // zero work.
    db.run(
      "INSERT INTO note_chunks (note_id, chunk_index, vector, model, embedded_at) VALUES (?, 0, ?, ?, ?)",
      [id, Buffer.from(new Float32Array([0.1]).buffer), "some-older-model", ts]
    );

    const res = await stubClient().backfillChunks(db);
    expect(res.attempted).toBe(1);
    expect(res.embedded).toBe(1);

    const rows = db.query("SELECT model FROM note_chunks WHERE note_id = ?").all(id) as any[];
    expect(rows.every((r) => r.model === ACTIVE_EMBED_MODEL)).toBe(true);
  });
});
