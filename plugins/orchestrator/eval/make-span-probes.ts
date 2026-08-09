/**
 * Generate PROBE SET A: held-out verbatim spans.
 *
 * Deterministic (seeded by note id, no Math.random) so runs are comparable.
 * Spans are taken from the MIDDLE of a note - the region the old whole-note
 * vector represented worst and the 512-token truncation discarded entirely.
 *
 * These are lexically easy by construction. That is the point: they measure
 * whether retrieval works at all and catch regressions. They do NOT measure
 * semantic ability - probe set B does that.
 */
import { Database } from "bun:sqlite";
import { DB_PATH, type Probe } from "./harness";

const db = new Database(DB_PATH, { readonly: true });

// Notes long enough to have a middle worth sampling, spread across types.
const rows = db
  .query(
    `SELECT id, type, content FROM notes
     WHERE length(content) BETWEEN 1200 AND 20000
       AND superseded_by IS NULL
     ORDER BY id
     LIMIT 4000`,
  )
  .all() as Array<{ id: string; type: string; content: string }>;

// Simple deterministic hash so the sample is stable across runs.
function h(s: string): number {
  let x = 2166136261;
  for (let i = 0; i < s.length; i++) {
    x ^= s.charCodeAt(i);
    x = Math.imul(x, 16777619);
  }
  return Math.abs(x);
}

const TARGET_N = 200;
const picked = rows.filter((r) => h(r.id) % Math.max(1, Math.floor(rows.length / TARGET_N)) === 0).slice(0, TARGET_N);

const probes: Probe[] = [];
for (const r of picked) {
  const text = r.content.replace(/\s+/g, " ").trim();
  // Take ~30 words starting around 45-60% through the note.
  const words = text.split(" ");
  if (words.length < 120) continue;
  const start = Math.floor(words.length * (0.45 + (h(r.id) % 15) / 100));
  const span = words.slice(start, start + 30).join(" ");
  if (span.length < 80) continue;
  probes.push({ target: r.id, query: span, kind: "span" });
}

await Bun.write(
  join(import.meta.dir, "probes-span.json"),
  JSON.stringify(probes, null, 1),
);
console.log(`wrote ${probes.length} span probes from ${rows.length} candidate notes`);
