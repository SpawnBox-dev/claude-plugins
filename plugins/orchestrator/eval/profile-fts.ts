/**
 * WI eb678a70 follow-up. The first profile showed the chunk read (116 ms) and
 * the cosine scan (13 ms) are ~1% of a 16-second lookup. This times the legs I
 * had NOT measured, so the fix targets what is actually slow rather than what
 * I assumed was slow.
 */
import { Database } from "bun:sqlite";
import { DB_PATH } from "./harness";

const QUERY = process.argv[2] ?? "how does the agent channel detect a dead session";
const REPS = Number(process.argv[3] ?? 3);
const db = new Database(DB_PATH, { readonly: true });

function timeIt(label: string, fn: () => unknown, reps = REPS) {
  const ts: number[] = [];
  let last: any;
  for (let i = 0; i < reps; i++) {
    const a = performance.now();
    last = fn();
    ts.push(performance.now() - a);
  }
  ts.sort((a, b) => a - b);
  const med = ts[Math.floor(ts.length / 2)];
  console.log(`  ${label.padEnd(40)} median ${med.toFixed(1).padStart(9)} ms`);
  return { med, last };
}

// Exactly how findRelatedNotes builds its FTS query.
const terms = QUERY.toLowerCase().replace(/[^a-z0-9]+/g, " ").split(/\s+/).filter((w) => w.length > 2);
const ftsQuery = terms.join(" OR ");
console.log(`terms: ${terms.length} -> "${ftsQuery}"\n`);

const counts = db.query(`SELECT (SELECT COUNT(*) FROM notes) AS n, (SELECT COUNT(*) FROM notes_fts) AS f`).get() as any;
console.log(`notes: ${counts.n}, fts rows: ${counts.f}\n`);

timeIt("FTS MATCH + bm25 + JOIN, LIMIT 20", () =>
  db.query(
    `SELECT n.id, bm25(notes_fts, 1.0, 0.5, 2.0) AS rank
       FROM notes_fts JOIN notes n ON notes_fts.rowid = n.rowid
      WHERE notes_fts MATCH ? AND n.superseded_by IS NULL
      ORDER BY rank ASC LIMIT ?`,
  ).all(ftsQuery, 20),
);

timeIt("same WITHOUT bm25() ordering", () =>
  db.query(
    `SELECT n.id FROM notes_fts JOIN notes n ON notes_fts.rowid = n.rowid
      WHERE notes_fts MATCH ? AND n.superseded_by IS NULL LIMIT ?`,
  ).all(ftsQuery, 20),
);

timeIt("MATCH only, no JOIN, COUNT", () =>
  db.query(`SELECT COUNT(*) AS c FROM notes_fts WHERE notes_fts MATCH ?`).get(ftsQuery),
);

// how many rows does that OR actually match? that is the real driver
const hits = db.query(`SELECT COUNT(*) AS c FROM notes_fts WHERE notes_fts MATCH ?`).get(ftsQuery) as any;
console.log(`\nrows matching the OR query: ${hits.c}  (of ${counts.n} notes)`);

// single-term costs, to see whether one term is pathological
console.log("\nper-term MATCH cost:");
for (const t of terms) {
  const r = db.query(`SELECT COUNT(*) AS c FROM notes_fts WHERE notes_fts MATCH ?`).get(t) as any;
  const a = performance.now();
  db.query(`SELECT COUNT(*) AS c FROM notes_fts WHERE notes_fts MATCH ?`).get(t);
  const ms = performance.now() - a;
  console.log(`  ${t.padEnd(14)} matches ${String(r.c).padStart(6)}   ${ms.toFixed(1).padStart(7)} ms`);
}
