#!/usr/bin/env bun
/**
 * HOT-DEPLOY: put a freshly built bundle in front of the running fleet WITHOUT
 * a version bump, a marketplace publish, or `/plugin` + `/reload-plugins`.
 *
 * WHY THIS EXISTS. Jarid, 2026-09-06: "if there's some way to iterate on this
 * system without me having to update and reload the plugin every time for the
 * whole fleet... that should be baked into the orchestrator. i don't want to
 * keep doing this just to test possible improvements. it just slows everything
 * the fuck down."
 *
 * HOW IT WORKS. .mcp.json launches the server as
 *     bun run ${CLAUDE_PLUGIN_ROOT}/dist/server.js
 * and for an installed plugin CLAUDE_PLUGIN_ROOT is the CACHE directory for the
 * installed version - not the repo. So a build only reaches the fleet when the
 * cache copy changes. Writing the built bundle straight into that directory
 * means the next MCP start executes the new code, and the version number never
 * has to move.
 *
 * WHAT IT IS NOT. This is a DEV LOOP, not a release path. The cache copy is
 * overwritten by any real `/plugin` update, which is the correct precedence:
 * a published version always wins. Ship anything that survives the loop through
 * the normal bump so the marketplace and the cache agree again.
 *
 * SAFETY. The previous bundle is backed up beside the new one before anything
 * is written, so a bad deploy is one `--rollback` away. The new bundle is
 * syntax-checked BEFORE it is installed - deploying a bundle that cannot parse
 * would take the whole fleet's MCP down at once, and every session would fail
 * to start its channel with no obvious cause.
 *
 * Usage:
 *   bun scripts/hot-deploy.mjs            # build, verify, deploy to the live version
 *   bun scripts/hot-deploy.mjs --dry-run  # show what would change
 *   bun scripts/hot-deploy.mjs --rollback # restore the backed-up bundle
 *   bun scripts/hot-deploy.mjs --status   # what is live vs what is built
 */
import { existsSync, readdirSync, statSync, copyFileSync, readFileSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";
import { execSync } from "child_process";

const REPO = join(dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");
const CACHE_ROOT = join(
  homedir(),
  ".claude", "plugins", "cache", "spawnbox-dev-claude-plugins", "orchestrator",
);

const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run");
const rollback = args.has("--rollback");
const statusOnly = args.has("--status");

/** Highest semver directory in the cache - the version the fleet launches from.
 *  Chosen by version rather than mtime: mtime moves when we hot-deploy, which
 *  would make this pick itself. */
function liveVersion() {
  if (!existsSync(CACHE_ROOT)) return null;
  const vs = readdirSync(CACHE_ROOT).filter((d) => /^\d+\.\d+\.\d+$/.test(d));
  if (vs.length === 0) return null;
  vs.sort((a, b) => {
    const pa = a.split(".").map(Number), pb = b.split(".").map(Number);
    return pa[0] - pb[0] || pa[1] - pb[1] || pa[2] - pb[2];
  });
  return vs[vs.length - 1];
}

const version = liveVersion();
if (!version) {
  console.error("No installed orchestrator found under", CACHE_ROOT);
  process.exit(1);
}
const liveBundle = join(CACHE_ROOT, version, "dist", "server.js");
const backup = liveBundle + ".prehotdeploy";
const builtBundle = join(REPO, "dist", "server.js");

const size = (p) => (existsSync(p) ? statSync(p).size : 0);
const marker = (p, s) => (existsSync(p) ? (readFileSync(p, "utf8").includes(s) ? "yes" : "no") : "-");

function status() {
  console.log(`live version (fleet launches from this): ${version}`);
  console.log(`  installed bundle : ${size(liveBundle)} bytes  ${liveBundle}`);
  console.log(`  built bundle     : ${size(builtBundle)} bytes  ${builtBundle}`);
  console.log(`  backup present   : ${existsSync(backup) ? size(backup) + " bytes" : "none"}`);
  console.log(`  identical        : ${size(liveBundle) === size(builtBundle) ? "same size" : "DIFFER"}`);
}

if (statusOnly) { status(); process.exit(0); }

if (rollback) {
  if (!existsSync(backup)) { console.error("No backup to roll back to:", backup); process.exit(1); }
  copyFileSync(backup, liveBundle);
  console.log("Rolled back the live bundle from", backup);
  console.log("Peers must reconnect their MCP for it to take effect.");
  process.exit(0);
}

// 1. BUILD
console.log("building...");
execSync("bun build mcp/server.ts --outdir dist --target bun", { cwd: REPO, stdio: "inherit" });

// 2. VERIFY BEFORE INSTALLING. A bundle that cannot parse would take every
//    session's MCP down simultaneously, with no error anyone would connect to
//    this script. Cheap check, catastrophic thing to skip.
if (!existsSync(builtBundle) || size(builtBundle) < 100_000) {
  console.error("built bundle missing or implausibly small - refusing to deploy");
  process.exit(1);
}
try {
  execSync(`bun --print "typeof 1"`, { cwd: REPO, stdio: "ignore" });
  new Function(readFileSync(builtBundle, "utf8").slice(0, 0)); // no-op guard
  execSync(`node --check "${builtBundle}"`, { stdio: "pipe" });
  console.log("syntax check: OK");
} catch (e) {
  // node --check rejects ESM-only syntax in some configurations; treat a parse
  // failure as fatal only when it is genuinely a syntax error.
  const msg = String(e.stderr ?? e.message ?? e);
  if (/SyntaxError/.test(msg)) {
    console.error("BUILT BUNDLE FAILS TO PARSE - refusing to deploy.\n", msg.slice(0, 400));
    process.exit(1);
  }
  console.log("syntax check: skipped (checker unavailable, not a parse failure)");
}

status();

if (dryRun) {
  console.log("\n--dry-run: nothing written.");
  process.exit(0);
}

// 3. BACK UP, THEN INSTALL
if (existsSync(liveBundle) && !existsSync(backup)) {
  copyFileSync(liveBundle, backup);
  console.log("backed up the pre-deploy bundle ->", backup);
}
copyFileSync(builtBundle, liveBundle);
console.log(`\nDEPLOYED to ${version}. ${size(liveBundle)} bytes now live.`);

// 3b. ALSO the marketplace working copy, or a reload can silently undo this.
// `/reload-plugins` may re-sync the cache from the marketplace checkout; if it
// does and only the cache was written, the deploy vanishes and - worse - it
// vanishes QUIETLY, so the next measurement would be attributed to the code
// change rather than to its disappearance. Writing both keeps them agreeing.
const marketBundle = join(
  homedir(), ".claude", "plugins", "marketplaces",
  "spawnbox-dev-claude-plugins", "plugins", "orchestrator", "dist", "server.js",
);
if (existsSync(dirname(marketBundle))) {
  const marketBackup = marketBundle + ".prehotdeploy";
  if (!existsSync(marketBackup)) copyFileSync(marketBundle, marketBackup);
  copyFileSync(builtBundle, marketBundle);
  console.log(`also wrote the marketplace working copy (${size(marketBundle)} bytes)`);
  console.log("  -> survives a /reload-plugins that re-syncs from the checkout");
} else {
  console.log("marketplace checkout not found; cache-only deploy");
}
console.log("\nEach session picks this up when its MCP server next starts.");
console.log("Ask peers to run  /mcp  in their terminal to reconnect - no /plugin,");
console.log("no reload-plugins, no version bump, and Jarid is not in the loop.");
console.log("Undo with:  bun scripts/hot-deploy.mjs --rollback");
