import { describe, test, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { applyMigrations } from "../../mcp/db/schema";
import { handleRecall } from "../../mcp/tools/recall";
import { handleRemember } from "../../mcp/tools/remember";

// ===========================================================================
// 0.30.72: `lookup({code_ref})` with NO query/id/type/tag must work.
//
// This was the R5 reverse-index - documented as the THIRD retrieval path in
// the lookup tool description AND in the plugin's CLAUDE.md - and it was
// unreachable on its own. The entry gate at recall.ts read
// `if (input.type || input.tag)`, so a code_ref-only call fell through to
// "Provide either a query, an id, or a type/tag filter". The code_ref WHERE
// condition already existed inside that block; only the gate omitted it.
//
// The reason this stayed invisible for so long is the sharp part: the
// PreToolUse hook instructs agents to run that exact call before editing any
// file with tagged notes. It is easy advice to skip, so nobody hit the
// rejection and reported it - the plugin was quietly spending a per-turn
// advisory slot on a call that could not succeed. Found 2026-07-27 by
// following the plugin's own hook instruction.
// ===========================================================================

function makeDb(type: "project" | "global"): Database {
  const db = new Database(":memory:");
  applyMigrations(db, type);
  return db;
}

describe("lookup({code_ref}) with no other filter", () => {
  let projectDb: Database;
  let globalDb: Database;

  beforeEach(async () => {
    projectDb = makeDb("project");
    globalDb = makeDb("global");

    await handleRemember(projectDb, globalDb, {
      content: "The daemon owns updates and renames itself to self-update",
      type: "architecture",
      tags: "daemon",
      code_refs: ["src-tauri/src/bin/daemon/main.rs"],
    });
    await handleRemember(projectDb, globalDb, {
      content: "Unrelated note about the landing page hero carousel",
      type: "architecture",
      tags: "landing",
      code_refs: ["spawnbox-landing/src/pages/index.astro"],
    });
  });

  test("returns the notes tagged with that path", async () => {
    const result = await handleRecall(projectDb, globalDb, {
      code_ref: "src-tauri/src/bin/daemon/main.rs",
    });

    expect(result.results.length).toBe(1);
    expect(result.results[0].content).toContain("daemon owns updates");
    // Regression guard: the old behavior was this exact rejection string.
    expect(result.message).not.toContain("Provide either a query");
  });

  test("does not return notes tagged with a different path", async () => {
    const result = await handleRecall(projectDb, globalDb, {
      code_ref: "spawnbox-landing/src/pages/index.astro",
    });
    expect(result.results.length).toBe(1);
    expect(result.results[0].content).toContain("hero carousel");
  });

  test("an unmatched path returns empty results, not an argument error", async () => {
    const result = await handleRecall(projectDb, globalDb, {
      code_ref: "does/not/exist.ts",
    });
    expect(result.results.length).toBe(0);
    expect(result.message).not.toContain("Provide either a query");
    expect(result.message).toContain("code_ref");
  });

  test("still composes with type and tag filters", async () => {
    const both = await handleRecall(projectDb, globalDb, {
      code_ref: "src-tauri/src/bin/daemon/main.rs",
      type: "architecture",
    });
    expect(both.results.length).toBe(1);

    const mismatch = await handleRecall(projectDb, globalDb, {
      code_ref: "src-tauri/src/bin/daemon/main.rs",
      type: "decision",
    });
    expect(mismatch.results.length).toBe(0);
  });

  test("a genuinely empty call is still refused", async () => {
    const result = await handleRecall(projectDb, globalDb, {});
    expect(result.message).toContain("Provide either a query");
  });
});
