import { join } from "node:path";
import { homedir } from "node:os";
/**
 * Retrieval evaluation harness.
 *
 * Runs entirely OFFLINE against the live DB + sidecar. No plugin build, no
 * fleet update, no disruption - so ranking variants can be iterated freely and
 * only the WINNER gets shipped.
 *
 * PROBES ARE HELD OUTSIDE THE KNOWLEDGE BASE, deliberately. The five probes
 * used earlier today are now burned: they were quoted in notes and commit
 * messages, so the notes discussing them became near-exact matches and the
 * benchmark started answering itself. Nothing in this directory may be written
 * into a note.
 *
 * PROBE SET A - HELD-OUT SPAN (automatic, scalable, objective).
 *   Query = a verbatim span from the middle of a note; target = that note.
 *   Lexically easy by construction, so it measures whether retrieval works AT
 *   ALL and catches gross regressions. A variant that hurts set A is broken.
 *
 * PROBE SET B - PARAPHRASE (hand-written, small, the real semantic test).
 *   Query expresses a note's idea in deliberately different words. This is the
 *   only thing embeddings buy over BM25, so it is the metric that decides.
 *
 * METRICS: recall@6 (does it reach a default result list), recall@20, and
 * MRR@50 (rank quality, not just presence).
 */
import { Database } from "bun:sqlite";
import { EmbeddingClient, blobToVector, ACTIVE_EMBED_MODEL } from "../mcp/engine/embeddings";
import { cosineSimilarity } from "../mcp/engine/hybrid_search";

/**
 * Knowledge base to evaluate against. Defaults to the current project's DB;
 * override with ORCHESTRATOR_EVAL_DB to point at any other corpus.
 */
export const DB_PATH =
  process.env.ORCHESTRATOR_EVAL_DB ??
  join(
    process.env.ORCHESTRATOR_PROJECT_ROOT || process.env.CLAUDE_PROJECT_DIR || process.cwd(),
    ".orchestrator",
    "project.db",
  );

/** Sidecar port file. Defaults to the shared per-user location (0.45.1+). */
export const PORT_FILE =
  process.env.ORCHESTRATOR_EVAL_PORT_FILE ??
  join(homedir(), ".claude", "orchestrator", "sidecar.port");

export interface Probe {
  target: string; // full note id
  query: string;
  kind: "span" | "paraphrase";
}

export interface Variant {
  name: string;
  /** Wraps the query before embedding (BGE retrieval instruction, etc). */
  queryPrefix?: string;
  /** Pool chunk scores per note. */
  pool?: "max" | "mean" | "max+mean";
}

export async function loadCorpus(db: Database) {
  const rows = db
    .query(`SELECT note_id, chunk_index, vector FROM note_chunks WHERE model = ?`)
    .all(ACTIVE_EMBED_MODEL) as Array<{ note_id: string; chunk_index: number; vector: Buffer }>;
  const byNote = new Map<string, Float32Array[]>();
  for (const r of rows) {
    const arr = byNote.get(r.note_id) ?? [];
    arr.push(blobToVector(r.vector));
    byNote.set(r.note_id, arr);
  }
  return byNote;
}

function poolScore(qv: Float32Array, chunks: Float32Array[], mode: Variant["pool"]): number {
  let max = -1;
  let sum = 0;
  for (const c of chunks) {
    const s = cosineSimilarity(qv, c);
    if (s > max) max = s;
    sum += s;
  }
  const mean = chunks.length ? sum / chunks.length : -1;
  if (mode === "mean") return mean;
  if (mode === "max+mean") return 0.8 * max + 0.2 * mean;
  return max;
}

export interface EvalResult {
  variant: string;
  n: number;
  recall6: number;
  recall20: number;
  mrr50: number;
  medianRank: number;
}

export async function evaluate(
  client: EmbeddingClient,
  corpus: Map<string, Float32Array[]>,
  probes: Probe[],
  variant: Variant,
): Promise<EvalResult> {
  const ranks: number[] = [];
  const BATCH = 16;
  const texts = probes.map((p) => (variant.queryPrefix ?? "") + p.query);

  const qvecs: Float32Array[] = [];
  for (let i = 0; i < texts.length; i += BATCH) {
    const out = await client.embed(texts.slice(i, i + BATCH));
    if (!out) throw new Error("embed failed");
    qvecs.push(...out);
  }

  for (let i = 0; i < probes.length; i++) {
    const qv = qvecs[i];
    const scored: Array<[string, number]> = [];
    for (const [id, chunks] of corpus) scored.push([id, poolScore(qv, chunks, variant.pool)]);
    scored.sort((a, b) => b[1] - a[1]);
    const rank = scored.findIndex(([id]) => id === probes[i].target) + 1;
    ranks.push(rank > 0 ? rank : Number.MAX_SAFE_INTEGER);
  }

  const sorted = [...ranks].sort((a, b) => a - b);
  return {
    variant: variant.name,
    n: probes.length,
    recall6: ranks.filter((r) => r <= 6).length / ranks.length,
    recall20: ranks.filter((r) => r <= 20).length / ranks.length,
    mrr50: ranks.reduce((a, r) => a + (r <= 50 ? 1 / r : 0), 0) / ranks.length,
    medianRank: sorted[Math.floor(sorted.length / 2)],
  };
}

export function fmt(rs: EvalResult[]): string {
  const pad = (s: string, n: number) => s.padEnd(n);
  let out = pad("variant", 34) + pad("R@6", 8) + pad("R@20", 8) + pad("MRR@50", 9) + "medRank\n";
  out += "-".repeat(70) + "\n";
  for (const r of rs) {
    out +=
      pad(r.variant, 34) +
      pad((r.recall6 * 100).toFixed(1) + "%", 8) +
      pad((r.recall20 * 100).toFixed(1) + "%", 8) +
      pad(r.mrr50.toFixed(4), 9) +
      String(r.medianRank === Number.MAX_SAFE_INTEGER ? "miss" : r.medianRank) +
      "\n";
  }
  return out;
}

export async function getClient(): Promise<EmbeddingClient> {
  const port = (await Bun.file(PORT_FILE).text()).trim();
  return new EmbeddingClient(`http://127.0.0.1:${port}`);
}
