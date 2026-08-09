/**
 * WHY THIS EXISTS: the span eval reports 47 targets that the embedding ranked
 * in the top 6 and the pipeline then dropped - and 35 of those were the vector
 * leg's #1 result. That should be IMPOSSIBLE: SEMANTIC_RESERVED force-injects
 * the top-2 vector notes into the final set, displacing from the tail.
 *
 * Two hypotheses, and they need different fixes:
 *   (A) the reserve never fires - an inert guard;
 *   (B) the eval's vector rank != the linker's, because the linker blends
 *       note-level `embeddings` rows into vecScores while the eval ranks on
 *       chunks alone.
 *
 * This distinguishes them by recomputing BOTH rankings for a losing probe and
 * reporting where the target sits in each. No guessing about what the code
 * "should" do (convention 7449ac5b).
 */
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { DB_PATH, getClient, type Probe } from "./harness";
import {
  findRelatedNotesHybrid,
  CHUNK_MAX_WEIGHT,
  CHUNK_MEAN_WEIGHT,
} from "../mcp/engine/linker";
import { blobToVector, ACTIVE_EMBED_MODEL, QUERY_INSTRUCTION } from "../mcp/engine/embeddings";
import { cosineSimilarity } from "../mcp/engine/hybrid_search";

const LIMIT = Number(process.argv[2] ?? 6);
const LAMBDA = Number(process.argv[3] ?? 0.7);
const MAX_CASES = Number(process.argv[4] ?? 6);

const probes: Probe[] = JSON.parse(
  await Bun.file(join(import.meta.dir, "probes-span.json")).text(),
);
const db = new Database(DB_PATH, { readonly: true });
const client = await getClient();

// ---- chunk-only ranking, exactly as e2e.ts computes it -------------------
const chunkRows = db
  .query(`SELECT note_id, vector FROM note_chunks WHERE model = ?`)
  .all(ACTIVE_EMBED_MODEL) as Array<{ note_id: string; vector: Buffer }>;
const chunks = new Map<string, Float32Array[]>();
for (const r of chunkRows) {
  const a = chunks.get(r.note_id) ?? [];
  a.push(blobToVector(r.vector));
  chunks.set(r.note_id, a);
}

// ---- note-level rows, the ingredient the eval does NOT have --------------
const embRows = db
  .query(`SELECT note_id, vector FROM embeddings WHERE model = ?`)
  .all(ACTIVE_EMBED_MODEL) as Array<{ note_id: string; vector: Buffer }>;

console.log(
  `corpus ${chunks.size} chunked notes | ${embRows.length} note-level rows | limit ${LIMIT} lambda ${LAMBDA}\n`,
);

function chunkScore(qv: Float32Array, cs: Float32Array[]): number {
  let max = -Infinity,
    sum = 0;
  for (const c of cs) {
    const s = cosineSimilarity(qv, c);
    if (s > max) max = s;
    sum += s;
  }
  return CHUNK_MAX_WEIGHT * max + CHUNK_MEAN_WEIGHT * (sum / cs.length);
}

let examined = 0;
for (const p of probes) {
  if (examined >= MAX_CASES) break;
  const qv = (await client.embed([QUERY_INSTRUCTION + p.query]))?.[0];
  if (!qv) continue;

  // eval-style rank (chunks only)
  const evalScored: Array<[string, number]> = [];
  for (const [id, cs] of chunks) evalScored.push([id, chunkScore(qv, cs)]);
  evalScored.sort((a, b) => b[1] - a[1]);
  const evalRank = evalScored.findIndex(([id]) => id === p.target) + 1;
  if (evalRank === 0 || evalRank > LIMIT) continue; // only look at eval-found cases

  // linker-style rank (chunks, PLUS note-level rows for notes without chunks)
  const linkerScored: Array<[string, number]> = [];
  const seen = new Set<string>();
  for (const r of embRows) {
    seen.add(r.note_id);
    const cs = chunks.get(r.note_id);
    linkerScored.push([
      r.note_id,
      cs ? chunkScore(qv, cs) : cosineSimilarity(qv, blobToVector(r.vector)),
    ]);
  }
  for (const [id, cs] of chunks) {
    if (!seen.has(id)) linkerScored.push([id, chunkScore(qv, cs)]);
  }
  linkerScored.sort((a, b) => b[1] - a[1]);
  const linkerRank = linkerScored.findIndex(([id]) => id === p.target) + 1;

  const got = await findRelatedNotesHybrid(db, p.query, LIMIT, qv, LAMBDA);
  const hit = got.some((n) => n.id === p.target);
  if (hit) continue; // not a loss - skip

  examined++;
  console.log(`LOSS #${examined}  target ${p.target.slice(0, 8)}`);
  console.log(`   eval rank (chunks only) : ${evalRank}`);
  console.log(`   linker rank (as fused)  : ${linkerRank}`);
  console.log(
    `   in linker's reserved top-2? ${linkerRank > 0 && linkerRank <= 2 ? "YES - reserve SHOULD have injected it" : "no"}`,
  );
  console.log(`   returned ids            : ${got.map((n) => n.id.slice(0, 8)).join(", ")}`);
  const top = linkerScored.slice(0, 3).map(([id], i) => `${i + 1}:${id.slice(0, 8)}`);
  console.log(`   linker vector top-3     : ${top.join("  ")}\n`);
}

if (examined === 0) console.log("no losses reproduced in the probes examined");
