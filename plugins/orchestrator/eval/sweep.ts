/**
 * Sweep pooling / blending / whole-note-vector combinations on the paraphrase
 * set. No re-embedding required - all of these are scoring-time changes, so
 * they are free to try and free to revert.
 *
 * Signals available per note:
 *   max(chunk)   - best passage. Sharp, but a single lucky passage can win.
 *   mean(chunk)  - whole-note gist spread across passages.
 *   noteVec      - the note-level vector in `embeddings`, i.e. the old
 *                  whole-document embedding, still maintained for the gate.
 */
import { Database } from "bun:sqlite";
import { DB_PATH, getClient } from "./harness";
import { blobToVector, ACTIVE_EMBED_MODEL } from "../mcp/engine/embeddings";
import { cosineSimilarity } from "../mcp/engine/hybrid_search";

const E = import.meta.dir;
const BGE_Q = "Represent this sentence for searching relevant passages: ";

const probes = JSON.parse(await Bun.file(`${E}/probes-${process.argv[2] ?? "para"}.json`).text()) as Array<{ target: string; query: string }>;
const db = new Database(DB_PATH, { readonly: true });

const chunkRows = db.query(`SELECT note_id, vector FROM note_chunks WHERE model = ?`).all(ACTIVE_EMBED_MODEL) as Array<{ note_id: string; vector: Buffer }>;
const noteRows = db.query(`SELECT note_id, vector FROM embeddings WHERE model = ?`).all(ACTIVE_EMBED_MODEL) as Array<{ note_id: string; vector: Buffer }>;
const chunks = new Map<string, Float32Array[]>();
for (const r of chunkRows) {
  const a = chunks.get(r.note_id) ?? [];
  a.push(blobToVector(r.vector));
  chunks.set(r.note_id, a);
}
const noteVec = new Map<string, Float32Array>();
for (const r of noteRows) noteVec.set(r.note_id, blobToVector(r.vector));
console.log(`corpus ${chunks.size} notes | ${chunkRows.length} chunks | probes ${probes.length}\n`);

const client = await getClient();
const qvecs: Float32Array[] = [];
for (let i = 0; i < probes.length; i += 16) {
  const out = await client.embed(probes.slice(i, i + 16).map((p) => BGE_Q + p.query));
  qvecs.push(...out!);
}

interface Combo { name: string; wMax: number; wMean: number; wNote: number }
const combos: Combo[] = [
  { name: "max only", wMax: 1, wMean: 0, wNote: 0 },
  { name: "mean only", wMax: 0, wMean: 1, wNote: 0 },
  { name: "noteVec only", wMax: 0, wMean: 0, wNote: 1 },
  { name: "0.8max + 0.2mean", wMax: 0.8, wMean: 0.2, wNote: 0 },
  { name: "0.6max + 0.4mean", wMax: 0.6, wMean: 0.4, wNote: 0 },
  { name: "0.5max + 0.5mean", wMax: 0.5, wMean: 0.5, wNote: 0 },
  { name: "0.3max + 0.7mean", wMax: 0.3, wMean: 0.7, wNote: 0 },
  { name: "0.5max + 0.5noteVec", wMax: 0.5, wMean: 0, wNote: 0.5 },
  { name: "0.4max + 0.3mean + 0.3note", wMax: 0.4, wMean: 0.3, wNote: 0.3 },
  { name: "0.34/0.33/0.33", wMax: 0.34, wMean: 0.33, wNote: 0.33 },
];

const rows: string[] = [];
for (const c of combos) {
  const ranks: number[] = [];
  for (let i = 0; i < probes.length; i++) {
    const qv = qvecs[i];
    const scored: Array<[string, number]> = [];
    for (const [id, cs] of chunks) {
      let mx = -1, sum = 0;
      for (const v of cs) { const s = cosineSimilarity(qv, v); if (s > mx) mx = s; sum += s; }
      const mean = sum / cs.length;
      const nv = noteVec.get(id);
      const ns = nv ? cosineSimilarity(qv, nv) : 0;
      scored.push([id, c.wMax * mx + c.wMean * mean + c.wNote * ns]);
    }
    scored.sort((a, b) => b[1] - a[1]);
    ranks.push(scored.findIndex(([id]) => id === probes[i].target) + 1);
  }
  const ok = ranks.filter((r) => r > 0);
  const med = [...ok].sort((a, b) => a - b)[Math.floor(ok.length / 2)];
  rows.push(
    c.name.padEnd(30) +
      ((ranks.filter((r) => r > 0 && r <= 6).length / ranks.length) * 100).toFixed(1).padStart(6) + "%" +
      ((ranks.filter((r) => r > 0 && r <= 20).length / ranks.length) * 100).toFixed(1).padStart(8) + "%" +
      (ranks.reduce((a, r) => a + (r > 0 && r <= 50 ? 1 / r : 0), 0) / ranks.length).toFixed(4).padStart(10) +
      String(med).padStart(9),
  );
}
console.log("combo".padEnd(30) + "R@6".padStart(7) + "R@20".padStart(9) + "MRR@50".padStart(10) + "medRank".padStart(9));
console.log("-".repeat(65));
console.log(rows.join("\n"));
