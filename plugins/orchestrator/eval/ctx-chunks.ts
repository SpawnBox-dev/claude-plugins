/**
 * EXPERIMENT: contextualized chunks.
 *
 * A chunk from the middle of a note carries no indication of what the note is
 * ABOUT. Passage 7 of an architecture note reads like disembodied prose, so a
 * query about the note's subject may not match any single passage well even
 * when the note is exactly right.
 *
 * Standard remedy: prepend a short context header (type + headline) to each
 * passage BEFORE embedding, so every vector knows its parent's topic.
 *
 * Run as a controlled A/B on a SUBSET so it costs minutes, not a full
 * re-embed. Both arms score the identical subset with the identical probes;
 * only the embedded text differs. Ranks are within-subset, comparable to each
 * other but not to full-corpus numbers.
 */
import { Database } from "bun:sqlite";
import { DB_PATH, getClient } from "./harness";
import { chunkText } from "../mcp/engine/chunking";
import { QUERY_INSTRUCTION } from "../mcp/engine/embeddings";
import { cosineSimilarity } from "../mcp/engine/hybrid_search";

const E = import.meta.dir;
const W_MAX = 0.6, W_MEAN = 0.4;

const para = JSON.parse(await Bun.file(`${E}/probes-para.json`).text()) as Array<{ target: string; query: string }>;
const span = JSON.parse(await Bun.file(`${E}/probes-span.json`).text()) as Array<{ target: string; query: string }>;

const db = new Database(DB_PATH, { readonly: true });
const needed = new Set([...para.map((p) => p.target), ...span.map((p) => p.target)]);

// Subset = every probe target + deterministic fillers, capped for runtime.
const all = db.query(`SELECT id, type, content FROM notes WHERE superseded_by IS NULL ORDER BY id`).all() as Array<{ id: string; type: string; content: string }>;
const h = (s: string) => { let x = 2166136261; for (let i = 0; i < s.length; i++) { x ^= s.charCodeAt(i); x = Math.imul(x, 16777619); } return Math.abs(x); };
const fillers = all.filter((n) => !needed.has(n.id) && h(n.id) % 11 === 0).slice(0, 600);
const subset = [...all.filter((n) => needed.has(n.id)), ...fillers];
console.log(`subset: ${subset.length} notes (${needed.size} targets + ${fillers.length} fillers)`);

/** The context header prepended in the treatment arm. */
function header(n: { type: string; content: string }): string {
  const headline = n.content.replace(/\s+/g, " ").replace(/^[*#\s]+/, "").slice(0, 110).trim();
  return `[${n.type}] ${headline}\n\n`;
}

const client = await getClient();

async function embedAll(texts: string[]): Promise<Float32Array[]> {
  const out: Float32Array[] = [];
  for (let i = 0; i < texts.length; i += 16) {
    const r = await client.embed(texts.slice(i, i + 16));
    if (!r) throw new Error("embed failed");
    out.push(...r);
    if (i % 320 === 0) process.stdout.write(`\r    ${i}/${texts.length}`);
  }
  process.stdout.write("\r                    \r");
  return out;
}

async function buildArm(withContext: boolean) {
  const flat: Array<{ id: string; text: string }> = [];
  for (const n of subset) {
    const hdr = withContext ? header(n) : "";
    for (const c of chunkText(n.content)) flat.push({ id: n.id, text: hdr + c });
  }
  console.log(`  ${withContext ? "contextualized" : "bare"}: ${flat.length} chunks`);
  const vecs = await embedAll(flat.map((f) => f.text));
  const byNote = new Map<string, Float32Array[]>();
  flat.forEach((f, i) => {
    const a = byNote.get(f.id) ?? [];
    a.push(vecs[i]);
    byNote.set(f.id, a);
  });
  return byNote;
}

function score(corpus: Map<string, Float32Array[]>, qv: Float32Array, target: string): number {
  const scored: Array<[string, number]> = [];
  for (const [id, cs] of corpus) {
    let mx = -1, sum = 0;
    for (const v of cs) { const s = cosineSimilarity(qv, v); if (s > mx) mx = s; sum += s; }
    scored.push([id, W_MAX * mx + W_MEAN * (sum / cs.length)]);
  }
  scored.sort((a, b) => b[1] - a[1]);
  return scored.findIndex(([id]) => id === target) + 1;
}

async function report(name: string, corpus: Map<string, Float32Array[]>, probes: Array<{ target: string; query: string }>) {
  const qv = await embedAll(probes.map((p) => QUERY_INSTRUCTION + p.query));
  const ranks = probes.map((p, i) => score(corpus, qv[i], p.target));
  const ok = ranks.filter((r) => r > 0);
  const med = [...ok].sort((a, b) => a - b)[Math.floor(ok.length / 2)];
  return {
    name,
    r6: (ranks.filter((r) => r > 0 && r <= 6).length / ranks.length) * 100,
    r20: (ranks.filter((r) => r > 0 && r <= 20).length / ranks.length) * 100,
    mrr: ranks.reduce((a, r) => a + (r > 0 && r <= 50 ? 1 / r : 0), 0) / ranks.length,
    med,
  };
}

console.log("\nbuilding arms...");
const bare = await buildArm(false);
const ctx = await buildArm(true);

const out: any[] = [];
for (const [label, corpus] of [["bare", bare], ["contextualized", ctx]] as const) {
  out.push({ set: "PARA", ...(await report(label, corpus, para)) });
  out.push({ set: "SPAN", ...(await report(label, corpus, span)) });
}
console.log("\nset   arm             R@6      R@20     MRR@50   medRank");
console.log("-".repeat(58));
for (const r of out) {
  console.log(
    r.set.padEnd(6) + r.name.padEnd(16) + (r.r6.toFixed(1) + "%").padStart(6) + (r.r20.toFixed(1) + "%").padStart(9) + r.mrr.toFixed(4).padStart(10) + String(r.med).padStart(9),
  );
}
