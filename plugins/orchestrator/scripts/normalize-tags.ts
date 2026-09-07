#!/usr/bin/env bun
/**
 * TAG NORMALISATION BACKFILL (WI cbf82684).
 *
 *   bun scripts/normalize-tags.ts                 # dry run - reports, writes nothing
 *   bun scripts/normalize-tags.ts --apply         # commits, after snapshotting
 *   bun scripts/normalize-tags.ts --db <path>     # override the project DB
 *
 * WHAT IT DOES, AND THE BOUNDARY IS THE POINT. It rewrites tag SPELLINGS to the
 * form the corpus already uses - `anti-pattern` -> `anti_pattern`,
 * `lane:portal` -> `lane:PORTAL`. It does NOT consolidate meaning. The 17,448
 * singletons are not touched, because folding `customer-reported` into
 * `discord_sourced` is a judgement about what someone meant, 17,448 times, on
 * notes other lanes authored. That is a read-and-judge pass, not a job.
 *
 * WHY IT SHARES CODE WITH THE WRITE PATH RATHER THAN REIMPLEMENTING. It calls
 * the same `decideTags` that `note()` now calls, so the backfill and every
 * future write cannot disagree about what canonical means. A second
 * implementation would drift the first time either side was tuned, and the
 * corpus would end up with two canonical forms - which is the bug.
 *
 * WHY IT MUST NOT RUN ON A MIXED FLEET. Canonicalisation happens at WRITE time
 * in whichever MCP server handles the write. Until every window runs >= 0.69.17,
 * ungoverned sessions keep writing `lane:portal` behind the backfill. Running
 * early is not harmful, it is just wasted - and it makes the before/after
 * numbers unreadable.
 *
 * SAFETY, in the order it matters:
 *   1. DRY RUN BY DEFAULT. `--apply` is required to write anything.
 *   2. POSITIVE AND NEGATIVE CONTROLS RUN FIRST, and a failed control ABORTS
 *      before any write. A backfill that silently ran against the wrong
 *      database is the failure this guards - there are four `.db` files in this
 *      tree and three of them are decoys.
 *   3. EVERY TOUCHED NOTE IS SNAPSHOTTED to `note_revisions` before the update,
 *      so the whole run is reversible from the table the schema already keeps.
 *   4. ONE TRANSACTION. Partial application would leave the corpus in a state
 *      neither the old nor the new rules describe.
 */

import { Database } from "bun:sqlite";
import { buildVocabulary, decideTags, type TagStat } from "../mcp/engine/tag_vocabulary";
import { parseTagList } from "../mcp/utils";

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const dbFlag = args.indexOf("--db");
const DB_PATH =
  dbFlag >= 0 && args[dbFlag + 1]
    ? args[dbFlag + 1]
    : (process.env.ORCHESTRATOR_PROJECT_ROOT ??
       "C:/Users/Jarid/OneDrive/AppDev/mc-server-project/spawnbox") + "/.orchestrator/project.db";

function fail(msg: string): never {
  console.error(`\n*** ABORTED: ${msg}\n`);
  process.exit(1);
}

console.log(`db     : ${DB_PATH}`);
console.log(`mode   : ${APPLY ? "APPLY (will write)" : "DRY RUN (writes nothing)"}`);
console.log();

const db = new Database(DB_PATH, { readonly: !APPLY });

// ── read the corpus ────────────────────────────────────────────────────────
const rows = db
  .query(`SELECT id, tags FROM notes WHERE tags IS NOT NULL AND tags != ''`)
  .all() as Array<{ id: string; tags: string }>;

if (rows.length === 0) fail("no tagged notes found - wrong database?");

const counts = new Map<string, number>();
for (const r of rows) for (const t of parseTagList(r.tags)) counts.set(t, (counts.get(t) ?? 0) + 1);
const stats: TagStat[] = [...counts.entries()].map(([tag, count]) => ({ tag, count }));
const vocab = buildVocabulary(stats);

// ── controls, BEFORE any write ─────────────────────────────────────────────
console.log("=== CONTROLS ===");
const posTag = "work_item";
const posCount = vocab.counts.get(posTag) ?? 0;
const negCount = vocab.counts.get("zzq-not-a-real-tag-9471") ?? 0;
console.log(`  POSITIVE  \`${posTag}\` uses            : ${posCount}`);
console.log(`  NEGATIVE  junk-tag uses               : ${negCount}`);
if (posCount < 100) fail(`positive control failed - \`${posTag}\` has ${posCount} uses, expected many. Wrong or empty database.`);
if (negCount !== 0) fail("negative control failed - a junk tag has uses. Matching is broken.");

// A known collision must actually canonicalise, and a known-correct tag must
// not move. Without this pair, "0 changes" and "the logic is inert" look alike.
const probeFix = decideTags(["anti-pattern"], vocab)[0];
const probeKeep = decideTags(["work_item"], vocab)[0];
console.log(`  CANONICALISES  anti-pattern -> ${probeFix.output} (${probeFix.action})`);
console.log(`  LEAVES ALONE   work_item    -> ${probeKeep.output} (${probeKeep.action})`);
if (probeFix.action !== "canonicalised") fail("the canonicaliser did not fire on a known collision - it would report a false clean.");
if (probeKeep.action !== "kept") fail("the canonicaliser moved a known-correct tag.");
console.log();

// ── plan the rewrite ───────────────────────────────────────────────────────
interface Change { id: string; before: string; after: string; pairs: Array<[string, string]> }
const changes: Change[] = [];
const pairTally = new Map<string, number>();

for (const r of rows) {
  const parsed = parseTagList(r.tags);
  const decisions = decideTags(parsed, vocab);
  // CANONICALISATION ONLY. `novel` decisions carry suggestions for a human;
  // acting on them here would be the meaning-consolidation this job refuses.
  const pairs: Array<[string, string]> = [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const d of decisions) {
    if (d.action === "canonicalised") pairs.push([d.input, d.output]);
    if (!seen.has(d.output)) { seen.add(d.output); out.push(d.output); }
  }
  if (pairs.length === 0) continue;
  const after = out.join(",");
  if (after === r.tags) continue;
  changes.push({ id: r.id, before: r.tags, after, pairs });
  for (const [a, b] of pairs) {
    const k = `${a} -> ${b}`;
    pairTally.set(k, (pairTally.get(k) ?? 0) + 1);
  }
}

const totalApps = [...pairTally.values()].reduce((a, b) => a + b, 0);
console.log("=== PLAN ===");
console.log(`  notes in corpus          : ${rows.length.toLocaleString()}`);
console.log(`  notes to rewrite         : ${changes.length.toLocaleString()}`);
console.log(`  tag applications changed : ${totalApps.toLocaleString()}`);
console.log(`  distinct rewrites        : ${pairTally.size}`);
console.log();
console.log("=== REWRITES, most frequent first ===");
for (const [k, n] of [...pairTally.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40)) {
  console.log(`  ${String(n).padStart(4)}x  ${k}`);
}
if (pairTally.size > 40) console.log(`  ... and ${pairTally.size - 40} more`);
console.log();

if (changes.length > 0) {
  console.log("=== SAMPLE (first 3 notes, full before/after) ===");
  for (const c of changes.slice(0, 3)) {
    console.log(`  ${c.id}`);
    console.log(`    before: ${c.before}`);
    console.log(`    after : ${c.after}`);
  }
  console.log();
}

if (!APPLY) {
  console.log("DRY RUN - nothing written. Re-run with --apply to commit.");
  console.log("Run it only when every window is on >= 0.69.17 and the fleet is quiet.");
  process.exit(0);
}

if (changes.length === 0) {
  console.log("Nothing to do.");
  process.exit(0);
}

// ── apply, snapshotting first, in one transaction ──────────────────────────
const stamp = new Date().toISOString();
const session = process.env.ORCHESTRATOR_SESSION_ID ?? "normalize-tags-backfill";

const snapshot = db.prepare(
  `INSERT INTO note_revisions (id, note_id, content, context, tags, keywords, confidence, code_refs, revised_at, revised_by_session)
   SELECT lower(hex(randomblob(16))), id, content, context, tags, keywords, confidence, code_refs, ?, ? FROM notes WHERE id = ?`,
);
const update = db.prepare(`UPDATE notes SET tags = ?, updated_at = ? WHERE id = ?`);

const run = db.transaction((list: Change[]) => {
  for (const c of list) {
    snapshot.run(stamp, session, c.id);
    update.run(c.after, stamp, c.id);
  }
});
run(changes);

console.log(`APPLIED: ${changes.length} notes rewritten, ${totalApps} tag applications normalised.`);
console.log(`Every touched note was snapshotted to note_revisions at ${stamp} (revised_by_session=${session}).`);

// ── post-condition: the collisions we set out to fix are gone ──────────────
const after = db
  .query(`SELECT tags FROM notes WHERE tags IS NOT NULL AND tags != ''`)
  .all() as Array<{ tags: string }>;
const afterCounts = new Map<string, number>();
for (const r of after) for (const t of parseTagList(r.tags)) afterCounts.set(t, (afterCounts.get(t) ?? 0) + 1);

let residual = 0;
for (const [from] of pairTally) {
  const tag = from.split(" -> ")[0];
  residual += afterCounts.get(tag) ?? 0;
}
console.log(`POST-CHECK: remaining uses of the rewritten spellings: ${residual} (expected 0).`);
if (residual !== 0) {
  console.error("*** post-check FAILED - some rewritten spellings survive. Investigate before trusting the run.");
  process.exit(1);
}
