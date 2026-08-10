/**
 * Per-probe evaluation output, so results can be SEGMENTED and PAIRED without
 * re-running the corpus scan.
 *
 * e2e.ts prints only totals, which has cost twice:
 *  - real queries turn out to be several distinct retrieval TASKS (exact-id
 *    lookup / keyword-soup / natural-language). Pooling them into one recall
 *    number hides that fusion may be right for one and wrong for another.
 *  - a paired significance test needs per-probe hit/miss for both arms. Without
 *    it, the lambda comparison could only be eyeballed as "+4 probes", which is
 *    why it was called within-noise rather than measured.
 *
 * Emits one JSON object per probe to stdout; bucket and test offline.
 */
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { DB_PATH, getClient, type Probe } from "./harness";
import { findRelatedNotesHybrid, CHUNK_MAX_WEIGHT, CHUNK_MEAN_WEIGHT } from "../mcp/engine/linker";
import { blobToVector, ACTIVE_EMBED_MODEL, QUERY_INSTRUCTION } from "../mcp/engine/embeddings";
import { cosineSimilarity } from "../mcp/engine/hybrid_search";

const setName = process.argv[2] ?? "real";
const LIMIT = Number(process.argv[3] ?? 6);
const LAMBDA = Number(process.argv[4] ?? 0.7);

const probes: Probe[] = JSON.parse(
  await Bun.file(join(import.meta.dir, `probes-${setName}.json`)).text(),
);
const db = new Database(DB_PATH, { readonly: true });
const client = await getClient();

const chunkRows = db
  .query(`SELECT note_id, vector FROM note_chunks WHERE model = ?`)
  .all(ACTIVE_EMBED_MODEL) as Array<{ note_id: string; vector: Buffer }>;
const chunks = new Map<string, Float32Array[]>();
for (const r of chunkRows) {
  const a = chunks.get(r.note_id) ?? [];
  a.push(blobToVector(r.vector));
  chunks.set(r.note_id, a);
}

console.error(`corpus ${chunks.size} notes | probes ${probes.length} (${setName}) | limit ${LIMIT} lambda ${LAMBDA}`);

for (const p of probes) {
  const qv = (await client.embed([QUERY_INSTRUCTION + p.query]))?.[0];
  if (!qv) continue;

  const scored: Array<[string, number]> = [];
  for (const [id, cs] of chunks) {
    let max = -Infinity, sum = 0;
    for (const c of cs) {
      const s = cosineSimilarity(qv, c);
      if (s > max) max = s;
      sum += s;
    }
    scored.push([id, CHUNK_MAX_WEIGHT * max + CHUNK_MEAN_WEIGHT * (sum / cs.length)]);
  }
  scored.sort((a, b) => b[1] - a[1]);
  const vecRank = scored.findIndex(([id]) => id === p.target) + 1;

  const got = await findRelatedNotesHybrid(db, p.query, LIMIT, qv, LAMBDA);
  const pipeRank = got.findIndex((n) => n.id === p.target) + 1;

  console.log(JSON.stringify({
    target: p.target,
    query: p.query,
    vec_rank: vecRank || null,
    vec_hit: vecRank > 0 && vecRank <= LIMIT,
    pipe_rank: pipeRank || null,
    pipe_hit: pipeRank > 0,
  }));
}
