/**
 * WI eb678a70: where does a lookup actually spend its time?
 *
 * The work item records 54.3 MB read per query and 13.6M multiply-adds, but
 * those are UPPER BOUNDS on I/O and arithmetic, not latency. SQLite's page
 * cache probably keeps the blobs in RAM, and blobToVector aliases rather than
 * copies when the buffer is 4-aligned. Sizing a fix off the byte count without
 * measuring would repeat tonight's mistake of reasoning instead of measuring
 * (convention 7449ac5b).
 *
 * Breaks one query into its three costs so the fix targets the real one:
 *   1. SQL read of note_chunks   - what a cache would remove
 *   2. decode + cosine scan      - what an ANN index would remove
 *   3. everything else (FTS, RRF, boost, MMR, reserve)
 */
import { Database } from "bun:sqlite";
import { DB_PATH, getClient } from "./harness";
import { findRelatedNotesHybrid } from "../mcp/engine/linker";
import { blobToVector, ACTIVE_EMBED_MODEL, QUERY_INSTRUCTION } from "../mcp/engine/embeddings";
import { cosineSimilarity } from "../mcp/engine/hybrid_search";

const QUERY = process.argv[2] ?? "how does the agent channel detect a dead session";
const REPS = Number(process.argv[3] ?? 3);

const db = new Database(DB_PATH, { readonly: true });
const client = await getClient();

const t0 = performance.now();
const qv = (await client.embed([QUERY_INSTRUCTION + QUERY]))?.[0];
const embedMs = performance.now() - t0;
if (!qv) throw new Error("no query vector - sidecar model mismatch?");

function timeIt(label: string, fn: () => unknown, reps = REPS) {
  const ts: number[] = [];
  for (let i = 0; i < reps; i++) {
    const a = performance.now();
    fn();
    ts.push(performance.now() - a);
  }
  ts.sort((a, b) => a - b);
  const med = ts[Math.floor(ts.length / 2)];
  console.log(`  ${label.padEnd(34)} median ${med.toFixed(1).padStart(8)} ms   (min ${ts[0].toFixed(1)}, max ${ts[ts.length - 1].toFixed(1)})`);
  return med;
}

const nChunks = (db.query(`SELECT COUNT(*) AS n FROM note_chunks WHERE model = ?`).get(ACTIVE_EMBED_MODEL) as any).n;
console.log(`corpus: ${nChunks} chunks @ ${ACTIVE_EMBED_MODEL}`);
console.log(`query embed (sidecar round-trip): ${embedMs.toFixed(1)} ms\n`);

// 1. the raw SQL read - exactly what linker.ts does
let rows: any[] = [];
const sqlMs = timeIt("1. SELECT note_chunks (SQL read)", () => {
  rows = db.query(`SELECT note_id, vector FROM note_chunks WHERE model = ?`).all(ACTIVE_EMBED_MODEL) as any[];
});

// 2. decode + cosine over those rows
const scanMs = timeIt("2. blobToVector + cosine scan", () => {
  let acc = 0;
  for (const r of rows) acc += cosineSimilarity(qv, blobToVector(r.vector));
  return acc;
});

// 3. the whole pipeline
const totalMs = await (async () => {
  const ts: number[] = [];
  for (let i = 0; i < REPS; i++) {
    const a = performance.now();
    await findRelatedNotesHybrid(db, QUERY, 6, qv, 0.7);
    ts.push(performance.now() - a);
  }
  ts.sort((x, y) => x - y);
  const med = ts[Math.floor(ts.length / 2)];
  console.log(`  ${"3. findRelatedNotesHybrid (FULL)".padEnd(34)} median ${med.toFixed(1).padStart(8)} ms   (min ${ts[0].toFixed(1)}, max ${ts[ts.length - 1].toFixed(1)})`);
  return med;
})();

console.log(`\nBREAKDOWN of the ${totalMs.toFixed(0)} ms query:`);
const pct = (x: number) => `${((x / totalMs) * 100).toFixed(0)}%`;
console.log(`  SQL read of chunks        ${sqlMs.toFixed(0).padStart(6)} ms  ${pct(sqlMs).padStart(5)}  <- a cached corpus removes this`);
console.log(`  decode + cosine scan      ${scanMs.toFixed(0).padStart(6)} ms  ${pct(scanMs).padStart(5)}  <- an ANN index removes this`);
const other = totalMs - sqlMs - scanMs;
console.log(`  FTS + RRF + boost + MMR   ${other.toFixed(0).padStart(6)} ms  ${pct(other).padStart(5)}  <- untouched by either fix`);
console.log(`\nPlus ${embedMs.toFixed(0)} ms of sidecar embed, which no local caching can remove.`);
