import { Database } from "bun:sqlite";
import { DB_PATH, loadCorpus, evaluate, fmt, getClient, type Probe, type Variant, type EvalResult } from "./harness";

const E = import.meta.dir;

const which = process.argv[2] ?? "span";
const probes: Probe[] = JSON.parse(await Bun.file(`${E}/probes-${which}.json`).text());

const db = new Database(DB_PATH, { readonly: true });
const corpus = await loadCorpus(db);
const client = await getClient();
console.log(`corpus: ${corpus.size} notes | probes: ${probes.length} (${which})\n`);

// BGE models are trained ASYMMETRICALLY for retrieval: passages are embedded
// bare, queries are embedded with an instruction. We embed both bare, which
// puts the query in the wrong region of the space.
const BGE_Q = "Represent this sentence for searching relevant passages: ";

const variants: Variant[] = [
  { name: "baseline (no prefix, max-pool)", pool: "max" },
  { name: "BGE query instruction", queryPrefix: BGE_Q, pool: "max" },
  { name: "BGE instruction + max/mean blend", queryPrefix: BGE_Q, pool: "max+mean" },
  { name: "mean-pool (no prefix)", pool: "mean" },
  { name: "short prefix 'query: '", queryPrefix: "query: ", pool: "max" },
];

const results: EvalResult[] = [];
for (const v of variants) {
  const r = await evaluate(client, corpus, probes, v);
  results.push(r);
  console.log(`  done: ${v.name}`);
}
console.log("\n" + fmt(results));
