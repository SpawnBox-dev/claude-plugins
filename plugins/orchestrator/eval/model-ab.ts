/**
 * A/B two embedding models on the SAME subset, same probes, same pooling.
 * Only the model differs.
 *
 * bge-small-en-v1.5 (384-dim, ~130MB) is what ships today.
 * bge-base-en-v1.5  (768-dim, ~440MB) is the next size up in the same family -
 * same training recipe and same query instruction, so this isolates capacity.
 *
 * Also times throughput, because a quality win that triples embed cost has to
 * be worth it: the corpus re-embed is ~17.5k chunks.
 */
import { Database } from "bun:sqlite";
import { DB_PATH, PORT_FILE } from "./harness";
import { chunkText } from "../mcp/engine/chunking";
import { EmbeddingClient, QUERY_INSTRUCTION } from "../mcp/engine/embeddings";
import { cosineSimilarity } from "../mcp/engine/hybrid_search";

const E = import.meta.dir;
const S = import.meta.dir;
const W_MAX = 0.6, W_MEAN = 0.4;

const para = JSON.parse(await Bun.file(`${E}/probes-para.json`).text()) as Array<{ target: string; query: string }>;
const span = JSON.parse(await Bun.file(`${E}/probes-span.json`).text()) as Array<{ target: string; query: string }>;
const db = new Database(DB_PATH, { readonly: true });
const needed = new Set([...para.map((p) => p.target), ...span.map((p) => p.target)]);
const all = db.query(`SELECT id, content FROM notes WHERE superseded_by IS NULL ORDER BY id`).all() as Array<{ id: string; content: string }>;
const h = (s: string) => { let x = 2166136261; for (let i = 0; i < s.length; i++) { x ^= s.charCodeAt(i); x = Math.imul(x, 16777619); } return Math.abs(x); };
const subset = [...all.filter((n) => needed.has(n.id)), ...all.filter((n) => !needed.has(n.id) && h(n.id) % 11 === 0).slice(0, 600)];

const flat: Array<{ id: string; text: string }> = [];
for (const n of subset) for (const c of chunkText(n.content)) flat.push({ id: n.id, text: c });
console.log(`subset ${subset.length} notes | ${flat.length} chunks`);

async function arm(name: string, port: string) {
  const client = new EmbeddingClient(`http://127.0.0.1:${port}`);
  const t0 = Date.now();
  const vecs: Float32Array[] = [];
  for (let i = 0; i < flat.length; i += 16) {
    const r = await client.embed(flat.slice(i, i + 16).map((f) => f.text));
    if (!r) throw new Error("embed failed " + name);
    vecs.push(...r);
  }
  const msPerChunk = (Date.now() - t0) / flat.length;
  const byNote = new Map<string, Float32Array[]>();
  flat.forEach((f, i) => { const a = byNote.get(f.id) ?? []; a.push(vecs[i]); byNote.set(f.id, a); });

  async function ev(probes: Array<{ target: string; query: string }>) {
    const qv: Float32Array[] = [];
    for (let i = 0; i < probes.length; i += 16) {
      const r = await client.embed(probes.slice(i, i + 16).map((p) => QUERY_INSTRUCTION + p.query));
      qv.push(...r!);
    }
    const ranks = probes.map((p, i) => {
      const scored: Array<[string, number]> = [];
      for (const [id, cs] of byNote) {
        let mx = -1, sum = 0;
        for (const v of cs) { const s = cosineSimilarity(qv[i], v); if (s > mx) mx = s; sum += s; }
        scored.push([id, W_MAX * mx + W_MEAN * (sum / cs.length)]);
      }
      scored.sort((a, b) => b[1] - a[1]);
      return scored.findIndex(([id]) => id === p.target) + 1;
    });
    const ok = ranks.filter((r) => r > 0);
    return {
      r6: (ranks.filter((r) => r > 0 && r <= 6).length / ranks.length) * 100,
      r20: (ranks.filter((r) => r > 0 && r <= 20).length / ranks.length) * 100,
      mrr: ranks.reduce((a, r) => a + (r > 0 && r <= 50 ? 1 / r : 0), 0) / ranks.length,
      med: [...ok].sort((a, b) => a - b)[Math.floor(ok.length / 2)],
    };
  }
  return { name, msPerChunk, dim: vecs[0].length, para: await ev(para), span: await ev(span) };
}

const smallPort = (await Bun.file(PORT_FILE).text()).trim();
const basePort = (await Bun.file(process.env.ORCHESTRATOR_EVAL_ALT_PORT_FILE ?? `${S}/base.port`).text()).trim();

const results = [await arm("bge-small (shipped)", smallPort), await arm("bge-base", basePort)];

console.log("\nmodel                 dim   ms/chunk | PARA R@6  R@20   med | SPAN R@6  R@20   med");
console.log("-".repeat(88));
for (const r of results) {
  console.log(
    r.name.padEnd(22) + String(r.dim).padStart(4) + r.msPerChunk.toFixed(0).padStart(9) + "  |" +
      (r.para.r6.toFixed(1) + "%").padStart(9) + (r.para.r20.toFixed(1) + "%").padStart(7) + String(r.para.med).padStart(6) + "  |" +
      (r.span.r6.toFixed(1) + "%").padStart(9) + (r.span.r20.toFixed(1) + "%").padStart(7) + String(r.span.med).padStart(6),
  );
}
const full = 17500;
console.log(`\nfull-corpus re-embed estimate (${full} chunks):`);
for (const r of results) console.log(`  ${r.name.padEnd(22)} ${((full * r.msPerChunk) / 1000 / 60).toFixed(0)} min`);
