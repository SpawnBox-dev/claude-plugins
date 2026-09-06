#!/usr/bin/env bun
/**
 * POST-RELOAD CHECK for the orphan-watcher fix (WI 6cf7437a, note d628d93a).
 *
 * WHAT IT IS FOR. Activating self-retirement requires a reload, and the process
 * orphaned BY that reload runs pre-fix code that cannot retire itself. It must
 * be killed by hand, ONCE, and the fleet verified, BEFORE any measurement is
 * believed. A delivery rate measured with an orphan still alive is the exact
 * number that misled two agents for fourteen hours.
 *
 * =========================================================================
 * ARM 1 HAS NOW BEEN WRONG TWICE, IN OPPOSITE DIRECTIONS, AND THE TWO
 * FAILURES TOGETHER ARE THE ARGUMENT FOR WHAT IT FINALLY BECAME.
 *
 *   v1  COUNT vs emit-log receivers. Counted a HISTORICAL set including a
 *       departed session: 5 allowed against 4 real. FALSE NEGATIVE.
 *   v2  COUNT vs live registry sessions. Passed at 4-vs-4 while two orphans
 *       were alive, because two orphans plus two healthy is also four.
 *       FALSE NEGATIVE, on the fault it exists to catch.
 *   PA's parallel attempt: VERSION MISMATCH. Flagged a healthy fleet whose
 *       reload was still propagating, and produced a kill order against a
 *       live session's only watcher. FALSE POSITIVE.
 *
 * EVERY CHEAP PROXY HAS NOW FAILED IN ONE DIRECTION OR THE OTHER, and the
 * reason is the same each time: an orphan is defined by OWNERSHIP - no
 * session is attached to it - and neither a count nor a version encodes
 * ownership. A count cannot separate "four healthy" from "two healthy plus
 * two orphans". A version cannot separate "abandoned" from "has not reloaded
 * yet". Only the parent-child relation says who owns what, so that is what
 * arm 1 now tests, and version is demoted to a NOTE that says in as many
 * words that a mixed-version fleet is not a fault.
 *
 * IT ALSO CLOSES THE HOLE PA FLAGGED: a SAME-VERSION restart defeats both
 * version-identity and bundle-age, since the orphan's path and start time
 * both match the survivor's. It does not defeat ownership - the orphan and
 * the survivor share a root claude.exe, and that is visible whatever the
 * version says.
 * =========================================================================
 *
 * FOUR ARMS, IN THIS ORDER, AND THE ORDER IS THE POINT:
 *   1. OWNERSHIP          - group watchers by their root claude.exe. A root
 *                           with two watchers has an orphan; a watcher with
 *                           NO live claude.exe ancestor is abandoned outright.
 *   2. CODE CURRENCY      - is every watcher running the newest bundle? NOT an
 *                           orphan test (see above). It gates arm 4 only
 *                           because measuring THE FIX across a fleet where one
 *                           session still runs pre-fix code is meaningless.
 *   3. scan_gap SINCE RELOAD - the acceptance criterion. A gap detector either
 *                           fires or it does not; a rate can drift. It is also
 *                           the only DURABLE one here: arms 1 and 2 are
 *                           bootstrap instruments for a transition, arm 3
 *                           fires on the symptom and does not care what caused
 *                           it.
 *   4. DELIVERY           - reported LAST and explicitly as a LOWER BOUND,
 *                           because its denominator is `sent` rows and a
 *                           watcher that consumed bytes and emitted nothing
 *                           writes none. It cannot see this bug's mechanism.
 *
 * IT REFUSES TO REPORT A RATE IF ARM 1 OR 2 FAILS. That refusal is the whole
 * value: the failure mode being guarded against is a confident number produced
 * on a fleet that still has an orphan in it.
 *
 * Usage:  bun scripts/post-reload-check.mjs            # report only
 *         bun scripts/post-reload-check.mjs --kill     # also kill orphans
 *         bun scripts/post-reload-check.mjs --selftest # prove arm 1 can FAIL
 */
import { readFileSync, statSync, existsSync, readdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { homedir } from "os";
import { execSync } from "child_process";

const doKill = process.argv.includes("--kill");
const STATE = join(
  "C:", "Users", "Jarid", "OneDrive", "AppDev", "mc-server-project", "spawnbox",
  ".orchestrator-state", "agent-channel",
);
const CACHE = join(homedir(), ".claude", "plugins", "cache", "spawnbox-dev-claude-plugins", "orchestrator");
const HERE = dirname(fileURLToPath(import.meta.url));

/** Newest installed bundle across all version dirs - the code a fresh process
 *  would load. Chosen by MTIME not by version label, deliberately: hot-deploy
 *  put a 15:55 build inside a directory named 0.69.10. */
function newestBundle() {
  let best = null;
  for (const d of existsSync(CACHE) ? readdirSync(CACHE) : []) {
    const p = join(CACHE, d, "dist", "server.js");
    if (!existsSync(p)) continue;
    const m = statSync(p).mtime.getTime();
    if (!best || m > best.mtime) best = { path: p, mtime: m, version: d };
  }
  return best;
}

function watchers() {
  const out = execSync(
    `powershell -NoProfile -ExecutionPolicy Bypass -File "${join(HERE, "watcher-inventory.ps1")}"`,
    { encoding: "utf8" },
  );
  return out.split("\n").map((l) => l.trim()).filter(Boolean).map((l) => {
    const [pid, iso, version, root] = l.split("|");
    return { pid: Number(pid), started: iso, ms: new Date(iso).getTime(), version, root };
  }).sort((a, b) => a.ms - b.ms);
}

/**
 * THE ARM 1 PREDICATE, kept as a pure function of the inventory so --selftest
 * can drive it with fixtures. A check whose failure branch has never executed
 * is a check nobody has tested, and this one has now shipped broken twice.
 */
export function classifyOwnership(rows) {
  const byRoot = new Map();
  const abandoned = [];
  for (const r of rows) {
    if (!r.root || r.root === "NONE") { abandoned.push(r); continue; }
    if (!byRoot.has(r.root)) byRoot.set(r.root, []);
    byRoot.get(r.root).push(r);
  }
  const doubled = [...byRoot.entries()].filter(([, v]) => v.length > 1);
  return { byRoot, doubled, abandoned, ok: doubled.length === 0 && abandoned.length === 0 };
}

/**
 * Which session each watcher actually serves, from `sessions.instance`
 * (INSTANCE_TOKEN, which is `${process.pid}-...`). Supporting evidence, NOT the
 * arm-1 predicate, and the distinction is load-bearing: EVERY watcher rewrites
 * this column for its own session on each 30s heartbeat, so with an orphan
 * present the value FLICKERS between the two pids rather than reporting both.
 * It names ownership reliably on a healthy fleet and degrades to noise on a
 * sick one, which is the opposite of what a detector needs - hence advisory.
 */
function claimedBy() {
  const { Database } = require("bun:sqlite");
  const db = new Database(join(STATE, "agent_channel.db"), { readonly: true });
  try {
    const now = Date.now();
    const map = new Map();
    for (const r of db.query("SELECT id8, instance, last_heartbeat_at FROM sessions").all()) {
      if (now - new Date(r.last_heartbeat_at).getTime() > 90_000) continue;
      const pid = typeof r.instance === "string" && /^\d+-/.test(r.instance) ? r.instance.split("-")[0] : null;
      if (pid) map.set(Number(pid), r.id8);
    }
    return map;
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------- self-test
if (process.argv.includes("--selftest")) {
  const cases = [
    { name: "healthy: one watcher per distinct root", rows: [
      { pid: 1, root: "100" }, { pid: 2, root: "200" }, { pid: 3, root: "300" } ], want: true },
    { name: "MIXED VERSIONS, distinct roots - must NOT fail (PA's false positive)", rows: [
      { pid: 1, root: "100", version: "0.69.10" }, { pid: 2, root: "200", version: "0.69.11" } ], want: true },
    { name: "orphan: two watchers share a root", rows: [
      { pid: 1, root: "100" }, { pid: 2, root: "100" }, { pid: 3, root: "200" } ], want: false },
    { name: "SAME-VERSION orphan - the hole version/age arms cannot see", rows: [
      { pid: 1, root: "100", version: "0.69.11" }, { pid: 2, root: "100", version: "0.69.11" } ], want: false },
    { name: "abandoned: no live claude.exe ancestor", rows: [
      { pid: 1, root: "NONE" }, { pid: 2, root: "200" } ], want: false },
    { name: "four watchers, four roots - the 4-vs-4 that passed v2 falsely", rows: [
      { pid: 1, root: "1" }, { pid: 2, root: "2" }, { pid: 3, root: "3" }, { pid: 4, root: "4" } ], want: true },
    { name: "four watchers, TWO roots - same count, real orphans", rows: [
      { pid: 1, root: "1" }, { pid: 2, root: "1" }, { pid: 3, root: "2" }, { pid: 4, root: "2" } ], want: false },
  ];
  let bad = 0;
  for (const c of cases) {
    const got = classifyOwnership(c.rows).ok;
    const pass = got === c.want;
    if (!pass) bad++;
    console.log(`  ${pass ? "ok  " : "FAIL"}  ${c.name}  (ok=${got}, want=${c.want})`);
  }
  console.log(
    bad === 0
      ? "\n  arm 1 fires on doubled roots, abandoned watchers and the SAME-VERSION case,\n" +
        "  and stays quiet on a mixed-version fleet. Both historical failure modes covered."
      : `\n  ${bad} case(s) failed.`,
  );
  process.exit(bad === 0 ? 0 : 1);
}

const log = existsSync(join(STATE, "emit-log.jsonl"))
  ? readFileSync(join(STATE, "emit-log.jsonl"), "utf8").split("\n").filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)
  : [];

const bundle = newestBundle();
const procs = watchers();
let claims = new Map();
try {
  claims = claimedBy();
} catch (e) {
  console.log(`WARNING: registry unreadable (${String(e).slice(0, 60)}); session names omitted.`);
}

const own = classifyOwnership(procs);

console.log("=== ARM 1: ownership (root claude.exe), not count, not version ===");
for (const p of procs) {
  const who = claims.get(p.pid);
  console.log(
    `  ${String(p.pid).padStart(7)}  ${p.started}  v${p.version}  root=${p.root}` +
      (who ? `  serves ${who}` : "  (unclaimed in registry)"),
  );
}
for (const [root, v] of own.doubled) {
  console.log(`  ORPHAN: root ${root} owns ${v.length} watchers - ${v.map((x) => x.pid).join(", ")}`);
}
for (const a of own.abandoned) {
  console.log(`  ABANDONED: ${a.pid} has no live claude.exe ancestor`);
}
console.log(`  ${own.ok ? "PASS" : "FAIL"} - one watcher per session, each owned by a live claude.exe`);

console.log("\n=== ARM 2: code currency (NOT an orphan test) ===");
console.log(`  newest bundle: ${bundle ? `${bundle.version} @ ${new Date(bundle.mtime).toISOString()}` : "none found"}`);
//
// AGE ALONE IS NOT CURRENCY, and this arm passed at 16:30:15Z while a v0.69.10
// watcher was serving PA. Process age was a proxy for "started before the
// bundle existed, so it cannot contain it" - sound in one direction only. It is
// blind to the case that actually happens here: a process started AFTER the
// bundle but launched from an OLDER version directory. pid 33980 began at
// 16:16:57Z, fifteen minutes after the 0.69.11 bundle's mtime, running 0.69.10.
//
// So test the VERSION DIRECTORY the process was launched from, which is what
// "running the installed code" actually means, and keep the age test as a
// second clause for the case the command line cannot be parsed.
const stale = bundle
  ? procs.filter((p) => (p.version && p.version !== "unknown"
      ? p.version !== bundle.version
      : p.ms < bundle.mtime))
  : [];
for (const p of stale) {
  const who = claims.get(p.pid);
  const why = p.version && p.version !== "unknown"
    ? `launched from the ${p.version} directory, installed is ${bundle.version}`
    : `started ${p.started} - PREDATES the bundle, cannot contain it`;
  console.log(`    ${p.pid}${who ? ` (${who})` : ""} - ${why}`);
}
const arm2 = bundle !== null && stale.length === 0;
console.log(`  ${arm2 ? "PASS" : "FAIL"} - every watcher is running the newest installed code`);
console.log("  A MIXED-VERSION FLEET IS NOT A FAULT. A reload propagates per session,");
console.log("  so old-version watchers are expected mid-rollout. This arm gates arm 4");
console.log("  only because a rate measured across mixed code does not measure the fix.");

if (doKill && (own.doubled.length || own.abandoned.length)) {
  console.log("\n=== KILLING orphans (identity re-verified per PID) ===");
  //
  // WHICH ONE SURVIVES. This rule was "keep the newest" until a live case
  // showed that is wrong: at 16:10:46 a FRESH watcher spawned pointing at the
  // STALE 0.69.10 directory, alongside a 0.69.11 watcher started nine minutes
  // earlier. Keeping the newest would have kept the old build and killed the
  // current one - helping the wrong survivor win. THE NEWER PROCESS IS NOT
  // AUTOMATICALLY THE CORRECT ONE, and start time does not encode correctness.
  //
  // So: prefer the watcher whose version matches the newest INSTALLED bundle,
  // and fall back to newest-wins only when none matches (and say so out loud,
  // because that fallback is the branch that was wrong).
  const keeper = (v) => {
    const matching = bundle ? v.filter((x) => x.version === bundle.version) : [];
    if (matching.length) return matching.slice().sort((a, b) => b.ms - a.ms)[0];
    console.log(`    NOTE: no watcher on root ${v[0].root} matches installed ${bundle?.version}; falling back to newest-wins`);
    return v.slice().sort((a, b) => b.ms - a.ms)[0];
  };
  const targets = [
    ...own.doubled.flatMap(([, v]) => { const k = keeper(v); return v.filter((x) => x.pid !== k.pid); }),
    ...own.abandoned,
  ];
  for (const [root, v] of own.doubled) {
    console.log(`    root ${root}: keeping ${keeper(v).pid} (v${keeper(v).version})`);
  }
  for (const p of targets) {
    try {
      const ok = execSync(
        `powershell -NoProfile -Command "$p = Get-CimInstance Win32_Process -Filter 'ProcessId=${p.pid}' -ErrorAction SilentlyContinue; ` +
          `if ($p -and $p.CommandLine -like '*orchestrator*server.js*') { Stop-Process -Id ${p.pid} -Force; 'killed' } else { 'skipped' }"`,
        { encoding: "utf8" },
      ).trim();
      console.log(`    ${p.pid}: ${ok}`);
    } catch (e) {
      console.log(`    ${p.pid}: kill failed - ${String(e).slice(0, 80)}`);
    }
  }
}

console.log("\n=== ARM 3: scan_gap (the acceptance criterion) ===");
const gaps = log.filter((r) => r.event === "scan_gap");
const newest = procs.length ? procs[procs.length - 1].started : null;
const since = newest ? gaps.filter((g) => g.ts > newest) : [];
console.log(`  total ever: ${gaps.length}   since the newest watcher started: ${since.length}`);
for (const g of since) {
  console.log(`    ${g.ts} ${g.sender_id8}->${g.receiver_id8} ${(g.scan_to ?? 0) - (g.scan_from ?? 0)} bytes never read`);
}
console.log(`  ${since.length === 0 ? "CLEAN" : "GAPS PRESENT"} - necessary, NOT sufficient: it cannot see`);
console.log("  bytes an orphan consumed and never told anyone about.");

console.log("\n=== ARM 4: delivery ===");
if (!own.ok || !arm2) {
  console.log("  REFUSED. Arm 1 or 2 failed, so any rate here would be measured on a fleet");
  console.log("  that still contains an orphan, or that is not uniformly running the fix -");
  console.log("  which is the precise number that misled this investigation for fourteen hours.");
} else {
  const receipts = new Set(log.filter((r) => r.event === "received" && r.emit_id).map((r) => r.emit_id));
  const first = log.find((r) => r.event === "received")?.ts;
  const pool = first ? log.filter((r) => r.event === "sent" && r.emit_id && r.ts >= first) : [];
  const ok = pool.filter((r) => receipts.has(r.emit_id)).length;
  console.log(`  ${ok}/${pool.length} by receipt` + (pool.length ? ` = ${((ok / pool.length) * 100).toFixed(0)}%` : ""));
  console.log("  LOWER BOUND ONLY: the denominator is `sent` rows, and a watcher that");
  console.log("  consumed bytes and emitted nothing writes none - so this metric is");
  console.log("  structurally blind to this bug's own mechanism.");
}
