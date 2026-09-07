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
 * in whichever MCP server handles the write. Until every window runs >= 0.69.18,
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
 *   5. COMPARE-AND-SWAP PER NOTE. The plan is computed from a read taken ~4.7
 *      minutes before the commit (measured, see the apply block), and peers are
 *      writing this same column. A note whose tags moved since the plan is
 *      SKIPPED AND NAMED rather than overwritten, so a concurrent `add_tags`
 *      cannot be silently discarded. Re-run to pick the skipped ones up.
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

// `{ readonly: false }` IS NOT "OPEN FOR WRITING" - it is no flags at all, and
// bun:sqlite raises SQLITE_MISUSE (errno 21) at open. The original spelling meant
// `--apply` could never run: it printed "APPLY (will write)" and then died on line
// one of the work, which is why the apply path had no executed specimen until
// 2026-09-07. Verified on bun 1.3.10. The mode must be stated positively.
const db = new Database(DB_PATH, APPLY ? { readwrite: true } : { readonly: true });

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

  // A NOTE CARRYING BOTH SPELLINGS RETURNS NO DECISION FOR THE SECOND ONE.
  // `decideTags` short-circuits on `emitted.has(output)`, so when a note already
  // holds the canonical form, the variant beside it is dropped from the decisions
  // array rather than reported as canonicalised. Keying the plan off `pairs` then
  // skipped the note entirely - and that is not an edge case, it is THE case: this
  // corpus's largest collision is `anti_pattern` (1018) against `anti-pattern` (53),
  // and the notes that carry both are exactly the ones a filter on either spelling
  // gets wrong. Measured 2026-09-07 against a copy of the live DB: 55 applications
  // across 53 notes were being silently left behind - 41 `anti-pattern`, 12
  // `quality-gate`, 2 `work-item` - every one of them a both-spellings note, and
  // NONE of them a note carrying the variant alone.
  //
  // So the plan is driven off the STRING, which is the thing the job actually
  // changes, and the dropped inputs are re-decided one at a time purely to
  // attribute them in the report.
  const decided = new Set(decisions.map((d) => d.input));
  for (const t of parsed) {
    const tag = t.trim();
    if (!tag || decided.has(tag)) continue;
    const solo = decideTags([tag], vocab)[0];
    if (solo && solo.output !== tag) pairs.push([tag, solo.output]);
  }

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
  console.log("Run it only when every window is on >= 0.69.18. (0.69.17 shipped a normaliser that");
  console.log("stripped separators rather than unifying them, so a fleet on it writes the wrong canon.)");
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
const readCurrent = db.prepare(`SELECT tags FROM notes WHERE id = ?`);

// COMPARE-AND-SWAP, BECAUSE THE PLANNING PASS IS NOT INSTANT AND THE FLEET IS NOT
// PAUSED. The plan is computed from a read taken at process start, and on the live
// corpus that read-to-commit gap is a RANGE, not a number: 30 s, 120 s and 281 s
// measured on the same box on 2026-09-07 over ~10,870 notes. The spread is page
// cache and memory pressure, not corpus size - the slow readings were taken while
// ~4.6 GB sat in orphaned embed sidecars and the 810 MB database could not stay
// cached. Do not quote a single figure here; the point is only that the gap is
// large enough for a peer to write inside it, and it widens exactly when the box
// is busiest, which is when peers are most likely to be writing.
// A blind `UPDATE ... WHERE id = ?` writes a
// whole-column value derived from that stale read, so any `update_note(add_tags:)`
// a peer session lands inside the gap is overwritten and the peer's tag is gone -
// silently, and with no error anywhere. `update_note` is itself a read-modify-write
// on this column (server.ts ~2194-2210), so this is last-writer-wins between two
// writers of the same shape, not a hazard the backfill invents.
//
// So: re-read each note INSIDE the transaction and apply only if it still holds the
// exact string the plan was computed from. A note that moved is SKIPPED and NAMED,
// which turns silent loss into a visible, re-runnable remainder. This is strictly
// better than excluding rows by a "written in the last N minutes" lookback, because
// a lookback taken before a 4.7-minute planning pass cannot see a write that lands
// during it.
const skipped: Array<{ id: string; expected: string; found: string }> = [];

const run = db.transaction((list: Change[]) => {
  for (const c of list) {
    const now = readCurrent.get(c.id) as { tags: string | null } | undefined;
    const current = now?.tags ?? "";
    if (current !== c.before) {
      skipped.push({ id: c.id, expected: c.before, found: current });
      continue;
    }
    snapshot.run(stamp, session, c.id);
    update.run(c.after, stamp, c.id);
  }
});
run(changes);

const applied = changes.length - skipped.length;
console.log(`APPLIED: ${applied} notes rewritten (of ${changes.length} planned).`);
console.log(`Every touched note was snapshotted to note_revisions at ${stamp} (revised_by_session=${session}).`);
if (skipped.length > 0) {
  console.log();
  console.log(`SKIPPED ${skipped.length} note(s) - their tags changed after the plan was computed, so applying`);
  console.log(`the planned value would have discarded a concurrent write. Nothing was lost; re-run to pick them up.`);
  for (const s of skipped) {
    console.log(`  ${s.id}`);
    console.log(`    planned from: ${s.expected}`);
    console.log(`    found now   : ${s.found}`);
  }
}

// ── post-condition: the collisions we set out to fix are gone ──────────────
const after = db
  .query(`SELECT tags FROM notes WHERE tags IS NOT NULL AND tags != ''`)
  .all() as Array<{ tags: string }>;
const afterCounts = new Map<string, number>();
for (const r of after) for (const t of parseTagList(r.tags)) afterCounts.set(t, (afterCounts.get(t) ?? 0) + 1);

const rewrittenFrom = new Set([...pairTally.keys()].map((k) => k.split(" -> ")[0]));
let residual = 0;
for (const tag of rewrittenFrom) residual += afterCounts.get(tag) ?? 0;

// A SKIPPED NOTE IS AN EXPECTED SURVIVOR, NOT A FAILURE. The bar is 0 only when
// every planned row applied; when the CAS declined some, the old spellings that
// remain must be exactly the ones sitting on those notes and no others - which is
// a sharper check than "0", because it fails if the run left a spelling behind
// ANYWHERE ELSE.
let allowed = 0;
for (const s of skipped) for (const t of parseTagList(s.found)) if (rewrittenFrom.has(t)) allowed++;

console.log(`POST-CHECK: remaining uses of the rewritten spellings: ${residual} (expected ${allowed}${skipped.length > 0 ? `, all on the ${skipped.length} skipped note(s)` : ""}).`);
if (residual !== allowed) {
  console.error("*** post-check FAILED - rewritten spellings survive somewhere other than the skipped notes. Investigate before trusting the run.");
  process.exit(1);
}
