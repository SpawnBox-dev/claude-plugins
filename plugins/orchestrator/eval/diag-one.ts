/**
 * Single-case fusion diagnostic. Takes an id8 that the span eval reported as
 * "lost by fusion" and answers the one question that distinguishes the live
 * hypotheses: where does the LINKER rank this note in its own vector leg?
 *
 * SEMANTIC_RESERVED force-injects vecScores[0..1], so a target at linker rank
 * 1 or 2 CANNOT be dropped. If the diagnostic shows rank 1, the reserve is not
 * firing. If it shows rank > 2, the eval's chunk-only ranking and the linker's
 * fused ranking disagree, and the reserve is protecting the wrong notes.
 */
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { DB_PATH, getClient, type Probe } from "./harness";
import { findRelatedNotesHybrid, CHUNK_MAX_WEIGHT, CHUNK_MEAN_WEIGHT } from "../mcp/engine/linker";
import { blobToVector, ACTIVE_EMBED_MODEL, QUERY_INSTRUCTION } from "../mcp/engine/embeddings";
import { cosineSimilarity } from "../mcp/engine/hybrid_search";

const ID8 = process.argv[2] ?? "03c9465e";
const LIMIT = Number(process.argv[3] ?? 6);
const LAMBDA = Number(process.argv[4] ?? 0.7);

const probes: Probe[] = JSON.parse(
  await Bun.file(join(import.meta.dir, "probes-span.json")).text(),
);
const probe = probes.find((p) => p.target.startsWith(ID8));
if (!probe) throw new Error(`no probe targets ${ID8}`);

const db = new Database(DB_PATH, { readonly: true });
const client = await getClient();
const qv = (await client.embed([QUERY_INSTRUCTION + probe.query]))?.[0];
if (!qv) throw new Error("no query vector - is the sidecar serving the active model?");

const chunkRows = db
  .query(`SELECT note_id, vector FROM note_chunks WHERE model = ?`)
  .all(ACTIVE_EMBED_MODEL) as Array<{ note_id: string; vector: Buffer }>;
const agg = new Map<string, { max: number; sum: number; n: number }>();
for (const r of chunkRows) {
  const s = cosineSimilarity(qv, blobToVector(r.vector));
  const cur = agg.get(r.note_id);
  if (!cur) agg.set(r.note_id, { max: s, sum: s, n: 1 });
  else {
    if (s > cur.max) cur.max = s;
    cur.sum += s;
    cur.n++;
  }
}
const chunkOnly: Array<[string, number]> = [];
for (const [id, a] of agg) {
  chunkOnly.push([id, CHUNK_MAX_WEIGHT * a.max + CHUNK_MEAN_WEIGHT * (a.sum / a.n)]);
}
chunkOnly.sort((a, b) => b[1] - a[1]);

// linker's vecScores: note-level rows, preferring the chunked score, plus
// chunked notes that have no note-level row.
const embRows = db
  .query(`SELECT note_id, vector FROM embeddings WHERE model = ?`)
  .all(ACTIVE_EMBED_MODEL) as Array<{ note_id: string; vector: Buffer }>;
const fused: Array<[string, number]> = [];
const seen = new Set<string>();
const byId = new Map(chunkOnly);
for (const r of embRows) {
  seen.add(r.note_id);
  const c = byId.get(r.note_id);
  fused.push([r.note_id, c !== undefined ? c : cosineSimilarity(qv, blobToVector(r.vector))]);
}
for (const [id, s] of chunkOnly) if (!seen.has(id)) fused.push([id, s]);
fused.sort((a, b) => b[1] - a[1]);

const rankIn = (arr: Array<[string, number]>) =>
  arr.findIndex(([id]) => id === probe.target) + 1;

const got = await findRelatedNotesHybrid(db, probe.query, LIMIT, qv, LAMBDA);

console.log(`target ${probe.target.slice(0, 8)}  |  corpus ${agg.size} chunked / ${embRows.length} note-level`);
console.log(`  eval rank   (chunks only)      : ${rankIn(chunkOnly)}`);
console.log(`  linker rank (vecScores as run) : ${rankIn(fused)}`);
console.log(`  reserve protects ranks 1-2 -> ${rankIn(fused) <= 2 ? "TARGET IS PROTECTED" : "target NOT protected"}`);
console.log(`  returned: ${got.map((n) => n.id.slice(0, 8)).join(", ")}`);
console.log(`  target returned? ${got.some((n) => n.id === probe.target)}`);
console.log(`  linker vector top-3: ${fused.slice(0, 3).map(([id], i) => `${i + 1}:${id.slice(0, 8)}`).join("  ")}`);
