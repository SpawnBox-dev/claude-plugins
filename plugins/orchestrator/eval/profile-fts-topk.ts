/**
 * WI eb678a70, third hypothesis. The first two were refuted by measurement:
 *   - built-in `ORDER BY rank` is 2x SLOWER than the custom bm25 call, not faster
 *   - stopword removal gives only 2.7x and still leaves 3.7 s
 *
 * Both previous variants JOIN notes_fts to notes in the same statement. FTS5
 * documents a top-K fast path for `ORDER BY rank LIMIT n` queried against the
 * fts table ALONE - the join may be defeating it by forcing every matched row
 * to be materialised and scored before the limit applies.
 *
 * So: rank inside the index with a LIMIT, THEN fetch the survivors' rows.
 * Same ranking semantics, a fraction of the rows scored.
 *
 * Correctness is checked, not assumed: every variant prints its top-5 ids.
 */
import { Database } from "bun:sqlite";
import { DB_PATH } from "./harness";

const QUERY = process.argv[2] ?? "how does the agent channel detect a dead session";
const REPS = Number(process.argv[3] ?? 3);
const db = new Database(DB_PATH, { readonly: true });

const terms = QUERY.toLowerCase().replace(/[^a-z0-9]+/g, " ").split(/\s+/).filter((w) => w.length > 2);
const q = terms.join(" OR ");
console.log(`query: ${q}\n`);

function bench(label: string, fn: () => any[]) {
  const ts: number[] = [];
  let rows: any[] = [];
  for (let i = 0; i < REPS; i++) {
    const a = performance.now();
    rows = fn();
    ts.push(performance.now() - a);
  }
  ts.sort((x, y) => x - y);
  const med = ts[Math.floor(ts.length / 2)];
  const top = rows.slice(0, 5).map((r) => String(r.id ?? r.rowid).slice(0, 8)).join(",");
  console.log(`  ${label.padEnd(44)} ${med.toFixed(1).padStart(9)} ms   top5: ${top}`);
  return { med, top, rows };
}

// CURRENT: join + custom bm25 in ORDER BY
const cur = bench("CURRENT: join + custom bm25 ORDER BY", () =>
  db.query(
    `SELECT n.id, bm25(notes_fts, 1.0, 0.5, 2.0) AS rank
       FROM notes_fts JOIN notes n ON notes_fts.rowid = n.rowid
      WHERE notes_fts MATCH ? AND n.superseded_by IS NULL
      ORDER BY rank ASC LIMIT ?`,
  ).all(q, 20) as any[],
);

// B: rank in the index alone with LIMIT, then hydrate
const topk = bench("B: fts-only ORDER BY rank LIMIT, then hydrate", () => {
  const ids = db.query(
    `SELECT rowid FROM notes_fts WHERE notes_fts MATCH ? ORDER BY rank LIMIT ?`,
  ).all(q, 60) as any[];
  if (!ids.length) return [];
  const marks = ids.map(() => "?").join(",");
  return db.query(
    `SELECT id FROM notes WHERE rowid IN (${marks}) AND superseded_by IS NULL LIMIT 20`,
  ).all(...ids.map((r) => r.rowid)) as any[];
});

// C: same, but keep custom weights by scoring only the survivors
const topkW = bench("C: fts-only top-K, custom bm25 on survivors", () => {
  const ids = db.query(
    `SELECT rowid FROM notes_fts WHERE notes_fts MATCH ? ORDER BY rank LIMIT ?`,
  ).all(q, 60) as any[];
  if (!ids.length) return [];
  const marks = ids.map(() => "?").join(",");
  return db.query(
    `SELECT n.id, bm25(notes_fts, 1.0, 0.5, 2.0) AS rank
       FROM notes_fts JOIN notes n ON notes_fts.rowid = n.rowid
      WHERE notes_fts MATCH ? AND n.rowid IN (${marks}) AND n.superseded_by IS NULL
      ORDER BY rank ASC LIMIT 20`,
  ).all(q, ...ids.map((r) => r.rowid)) as any[];
});

console.log(`\nspeedup vs current (${cur.med.toFixed(0)} ms):`);
console.log(`  B (built-in top-K)            ${(cur.med / topk.med).toFixed(1)}x`);
console.log(`  C (top-K + custom weights)    ${(cur.med / topkW.med).toFixed(1)}x`);
console.log(`\nTOP-5 IDENTICAL to current?`);
console.log(`  B: ${topk.top === cur.top}`);
console.log(`  C: ${topkW.top === cur.top}   <- C preserves the weights, so this is the one that should match`);
