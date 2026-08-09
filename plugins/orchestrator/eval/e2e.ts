/**
 * END-TO-END evaluation: the ACTUAL retrieval path, not just the vector leg.
 *
 * Everything else in this directory scores raw cosine over chunks. That
 * measures the EMBEDDING, and it is the right instrument for model and pooling
 * choices - but it cannot see FTS, RRF, the signal/confidence boost, MMR
 * diversification or the semantic reserve. Those are exactly the layers work
 * item 27d1da01 is about, and while they were unmeasurable any change to them
 * was a coin flip that would feel like progress.
 *
 * This runs `findRelatedNotesHybrid` - the same function `lookup` calls - so a
 * fusion change can be judged the same way a model change already can.
 *
 * It also reports the VECTOR-ONLY rank alongside, because the interesting
 * failure is not "retrieval missed" but "the embedding found it and the
 * pipeline threw it away". That gap is the fusion loss, quantified.
 */
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { DB_PATH, getClient, type Probe } from "./harness";
import { findRelatedNotesHybrid, CHUNK_MAX_WEIGHT, CHUNK_MEAN_WEIGHT } from "../mcp/engine/linker";
import { blobToVector, ACTIVE_EMBED_MODEL, QUERY_INSTRUCTION } from "../mcp/engine/embeddings";
import { cosineSimilarity } from "../mcp/engine/hybrid_search";

const setName = process.argv[2] ?? "para";
const LIMIT = Number(process.argv[3] ?? 6);
/**
 * MMR lambda: 1.0 = pure relevance, lower = more diversity pressure.
 * `recall` passes 0.7 today. Exposed here because widening the candidate pool
 * made results WORSE (42.1% -> 15.8%), which points at diversification rather
 * than pool size - more candidates means more for MMR to diversify AWAY from
 * the target.
 */
const LAMBDA = Number(process.argv[4] ?? 0.7);
const probes: Probe[] = JSON.parse(await Bun.file(join(import.meta.dir, `probes-${setName}.json`)).text());

const db = new Database(DB_PATH, { readonly: true });
const client = await getClient();

// Vector-leg reference, scored exactly as the linker scores it.
const chunkRows = db.query(`SELECT note_id, vector FROM note_chunks WHERE model = ?`).all(ACTIVE_EMBED_MODEL) as Array<{ note_id: string; vector: Buffer }>;
const chunks = new Map<string, Float32Array[]>();
for (const r of chunkRows) {
  const a = chunks.get(r.note_id) ?? [];
  a.push(blobToVector(r.vector));
  chunks.set(r.note_id, a);
}
console.log(`corpus ${chunks.size} notes | ${chunkRows.length} chunks | probes ${probes.length} (${setName}) | limit ${LIMIT}\n`);

let e2eHit = 0;
let vecTop = 0;      // target was in the vector leg's top LIMIT
let lostByFusion = 0; // vector found it, pipeline dropped it
const lost: Array<{ id8: string; vecRank: number }> = [];

for (const p of probes) {
  const qv = (await client.embed([QUERY_INSTRUCTION + p.query]))?.[0];
  if (!qv) continue;

  const scored: Array<[string, number]> = [];
  for (const [id, cs] of chunks) {
    let mx = -1, sum = 0;
    for (const v of cs) { const s = cosineSimilarity(qv, v); if (s > mx) mx = s; sum += s; }
    scored.push([id, CHUNK_MAX_WEIGHT * mx + CHUNK_MEAN_WEIGHT * (sum / cs.length)]);
  }
  scored.sort((a, b) => b[1] - a[1]);
  const vecRank = scored.findIndex(([id]) => id === p.target) + 1;

  const results = await findRelatedNotesHybrid(db, p.query, LIMIT, qv, LAMBDA, false);
  const hit = results.some((r) => r.id === p.target);

  if (hit) e2eHit++;
  if (vecRank > 0 && vecRank <= LIMIT) vecTop++;
  if (!hit && vecRank > 0 && vecRank <= LIMIT) {
    lostByFusion++;
    lost.push({ id8: p.target.slice(0, 8), vecRank });
  }
}

const pct = (n: number) => ((n / probes.length) * 100).toFixed(1) + "%";
console.log(`vector leg alone,  target in top ${LIMIT}: ${vecTop}/${probes.length}  (${pct(vecTop)})`);
console.log(`FULL PIPELINE,     target in top ${LIMIT}: ${e2eHit}/${probes.length}  (${pct(e2eHit)})`);
console.log(`\nLOST BY FUSION (embedding ranked it top-${LIMIT}, pipeline dropped it): ${lostByFusion}`);
for (const l of lost) console.log(`   ${l.id8} was vector rank #${l.vecRank}`);
console.log(
  `\nA nonzero "lost by fusion" is the 27d1da01 tax, measured. A change to RRF,\n` +
  `the signal boost or the reserve should drive it toward zero WITHOUT reducing\n` +
  `the full-pipeline hit count (which would mean it just stopped finding things).`,
);
