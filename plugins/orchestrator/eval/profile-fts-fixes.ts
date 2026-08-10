/**
 * WI eb678a70. bm25() ordering costs ~11s because the OR query matches 95% of
 * the corpus. Two candidate fixes, MEASURED rather than argued:
 *
 *  A) ORDER BY rank        - FTS5's built-in ranking. Documented to be
 *                            optimizable; a custom bm25(...) call in ORDER BY
 *                            may defeat that and force full computation.
 *  B) drop stopwords       - shrink the match set at the source.
 *  C) both.
 *
 * Correctness matters as much as speed: a faster query that returns different
 * notes is not a fix. So each variant reports its top-5 ids for comparison.
 */
import { Database } from "bun:sqlite";
import { DB_PATH } from "./harness";

const QUERY = process.argv[2] ?? "how does the agent channel detect a dead session";
const REPS = Number(process.argv[3] ?? 3);
const db = new Database(DB_PATH, { readonly: true });

// English stopwords that carry no retrieval signal but explode the match set.
const STOP = new Set([
  "the","and","for","are","but","not","you","all","can","her","was","one","our",
  "out","day","get","has","him","his","how","its","new","now","old","see","two",
  "way","who","did","does","done","this","that","with","from","have","what",
  "when","where","which","were","been","they","them","there","their","would",
  "could","should","into","than","then","some","such","only","also","just",
]);

const raw = QUERY.toLowerCase().replace(/[^a-z0-9]+/g, " ").split(/\s+/).filter((w) => w.length > 2);
const kept = raw.filter((w) => !STOP.has(w));
const orAll = raw.join(" OR ");
const orKept = (kept.length ? kept : raw).join(" OR ");

console.log(`all terms  (${raw.length}): ${orAll}`);
console.log(`no-stop    (${kept.length}): ${orKept}\n`);

for (const [label, q] of [["all terms", orAll], ["no stopwords", orKept]] as const) {
  const c = db.query(`SELECT COUNT(*) AS c FROM notes_fts WHERE notes_fts MATCH ?`).get(q) as any;
  console.log(`match-set size, ${label}: ${c.c}`);
}
console.log();

function bench(label: string, sql: string, q: string) {
  const ts: number[] = [];
  let rows: any[] = [];
  for (let i = 0; i < REPS; i++) {
    const a = performance.now();
    rows = db.query(sql).all(q, 20) as any[];
    ts.push(performance.now() - a);
  }
  ts.sort((x, y) => x - y);
  const med = ts[Math.floor(ts.length / 2)];
  const top = rows.slice(0, 5).map((r) => String(r.id).slice(0, 8)).join(",");
  console.log(`  ${label.padEnd(38)} ${med.toFixed(1).padStart(9)} ms   top5: ${top}`);
  return { med, top };
}

const CUSTOM = `SELECT n.id, bm25(notes_fts, 1.0, 0.5, 2.0) AS rank
   FROM notes_fts JOIN notes n ON notes_fts.rowid = n.rowid
  WHERE notes_fts MATCH ? AND n.superseded_by IS NULL
  ORDER BY rank ASC LIMIT ?`;

const BUILTIN = `SELECT n.id
   FROM notes_fts JOIN notes n ON notes_fts.rowid = n.rowid
  WHERE notes_fts MATCH ? AND n.superseded_by IS NULL
  ORDER BY rank LIMIT ?`;

console.log("CURRENT (custom bm25 weights):");
const a1 = bench("all terms", CUSTOM, orAll);
const a2 = bench("no stopwords", CUSTOM, orKept);

console.log("\nVARIANT A (FTS5 built-in `ORDER BY rank`):");
const b1 = bench("all terms", BUILTIN, orAll);
const b2 = bench("no stopwords", BUILTIN, orKept);

console.log(`\nspeedups vs current/all-terms (${a1.med.toFixed(0)} ms):`);
console.log(`  stopwords only      ${(a1.med / a2.med).toFixed(1)}x`);
console.log(`  built-in rank only  ${(a1.med / b1.med).toFixed(1)}x`);
console.log(`  both                ${(a1.med / b2.med).toFixed(1)}x`);
console.log(`\nSAME TOP-5? current-vs-builtin (all terms): ${a1.top === b1.top}`);
console.log(`             current-vs-stopwordless        : ${a1.top === a2.top}`);
