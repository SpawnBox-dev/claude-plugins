/**
 * Decide the shippable configuration on BOTH probe sets at once.
 *
 * The paraphrase-set winner (three-signal blend with the whole-note vector)
 * REGRESSED the span set badly - 77.1% -> 68.8% R@6. Optimising on the
 * semantic set alone would have shipped that. A change only ships if it is
 * non-negative on spans (does retrieval still work at all?) AND positive on
 * paraphrases (the thing embeddings are for).
 */
import { Database } from "bun:sqlite";
import { DB_PATH, getClient } from "./harness";
import { blobToVector, ACTIVE_EMBED_MODEL } from "../mcp/engine/embeddings";
import { cosineSimilarity } from "../mcp/engine/hybrid_search";

const E = import.meta.dir;
const BGE_Q = "Represent this sentence for searching relevant passages: ";

const db = new Database(DB_PATH, { readonly: true });
const chunkRows = db.query(`SELECT note_id, vector FROM note_chunks WHERE model = ?`).all(ACTIVE_EMBED_MODEL) as Array<{ note_id: string; vector: Buffer }>;
const chunks = new Map<string, Float32Array[]>();
for (const r of chunkRows) {
  const a = chunks.get(r.note_id) ?? [];
  a.push(blobToVector(r.vector));
  chunks.set(r.note_id, a);
}
const client = await getClient();

async function run(setName: string, prefix: string, wMax: number, wMean: number) {
  const probes = JSON.parse(await Bun.file(`${E}/probes-${setName}.json`).text()) as Array<{ target: string; query: string }>;
  const qv: Float32Array[] = [];
  for (let i = 0; i < probes.length; i += 16) {
    const out = await client.embed(probes.slice(i, i + 16).map((p) => prefix + p.query));
    qv.push(...out!);
  }
  const ranks: number[] = [];
  for (let i = 0; i < probes.length; i++) {
    const scored: Array<[string, number]> = [];
    for (const [id, cs] of chunks) {
      let mx = -1, sum = 0;
      for (const v of cs) { const s = cosineSimilarity(qv[i], v); if (s > mx) mx = s; sum += s; }
      scored.push([id, wMax * mx + wMean * (sum / cs.length)]);
    }
    scored.sort((a, b) => b[1] - a[1]);
    ranks.push(scored.findIndex(([id]) => id === probes[i].target) + 1);
  }
  const ok = ranks.filter((r) => r > 0);
  return {
    r6: (ranks.filter((r) => r > 0 && r <= 6).length / ranks.length) * 100,
    r20: (ranks.filter((r) => r > 0 && r <= 20).length / ranks.length) * 100,
    mrr: ranks.reduce((a, r) => a + (r > 0 && r <= 50 ? 1 / r : 0), 0) / ranks.length,
    med: [...ok].sort((a, b) => a - b)[Math.floor(ok.length / 2)],
  };
}

const configs = [
  { name: "SHIPPED TODAY (max, no prefix)", prefix: "", wMax: 1, wMean: 0 },
  { name: "prefix only (max)", prefix: BGE_Q, wMax: 1, wMean: 0 },
  { name: "blend only (0.6/0.4, no prefix)", prefix: "", wMax: 0.6, wMean: 0.4 },
  { name: "prefix + blend 0.6/0.4", prefix: BGE_Q, wMax: 0.6, wMean: 0.4 },
  { name: "prefix + blend 0.7/0.3", prefix: BGE_Q, wMax: 0.7, wMean: 0.3 },
];

console.log("config".padEnd(34) + "| SPAN (192): R@6  MRR   med | PARA (19): R@6   R@20  med");
console.log("-".repeat(96));
for (const c of configs) {
  const s = await run("span", c.prefix, c.wMax, c.wMean);
  const p = await run("para", c.prefix, c.wMax, c.wMean);
  console.log(
    c.name.padEnd(34) +
      "| " + (s.r6.toFixed(1) + "%").padStart(6) + s.mrr.toFixed(4).padStart(8) + String(s.med).padStart(6) +
      "  | " + (p.r6.toFixed(1) + "%").padStart(6) + (p.r20.toFixed(1) + "%").padStart(7) + String(p.med).padStart(6),
  );
}
