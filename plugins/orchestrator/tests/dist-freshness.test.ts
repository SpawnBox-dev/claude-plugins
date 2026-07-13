import { describe, expect, test } from "bun:test";
import { statSync, readdirSync } from "fs";
import { join } from "path";

// SHIP-GATE (risk 206a0af3, detection lever: code-reviewer on a flap-code change).
// `.mcp.json` runs dist/server.js, NOT mcp/*.ts source. If any mcp/ file is edited
// WITHOUT `bun run build`, the runtime executes the STALE bundle forever - the exact
// trap that made 0.30.56-0.30.65's code inert (a month of shipped-but-never-live
// fixes). This is the "guard at the layer that lies" (df25cb43 pattern): fail LOUDLY
// in the suite when dist/server.js is older than the newest mcp/ source file, so a
// stale bundle can never reach a commit/publish again.
//
// mtime rationale: OneDrive preserves mtime on sync and git-checkout stamps ALL files
// to the same time (dist == source -> passes), so this only fires on the real trap -
// a source EDIT with no rebuild (source mtime > dist mtime). The fix is always
// `bun run build`.

const ORCH_ROOT = join(import.meta.dir, "..");

function newestSourceMtimeMs(dir: string): { mtime: number; file: string } {
  let newest = { mtime: 0, file: "" };
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      const sub = newestSourceMtimeMs(p);
      if (sub.mtime > newest.mtime) newest = sub;
    } else if (e.name.endsWith(".ts")) {
      const m = statSync(p).mtimeMs;
      if (m > newest.mtime) newest = { mtime: m, file: p };
    }
  }
  return newest;
}

describe("dist bundle freshness (build-gate, risk 206a0af3)", () => {
  test("dist/server.js is at least as new as the newest mcp/ source file - run `bun run build` if this fails", () => {
    const distMtime = statSync(join(ORCH_ROOT, "dist", "server.js")).mtimeMs;
    const newestSrc = newestSourceMtimeMs(join(ORCH_ROOT, "mcp"));
    if (distMtime < newestSrc.mtime) {
      throw new Error(
        `dist/server.js is STALE (older than ${newestSrc.file}). ` +
          `The runtime executes dist/server.js, so your mcp/ change is INERT until you ` +
          `run \`bun run build\` and commit the regenerated dist in the same changeset.`,
      );
    }
    expect(distMtime).toBeGreaterThanOrEqual(newestSrc.mtime);
  });
});
