import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { mergeTags } from "../mcp/utils";

// ===========================================================================
// 0.40.0: additive tags, and the wiring that delivers them.
//
// THE NEAR-MISS (SA-df343a05, 2026-07-29). They passed `add_tags` to
// update_work_item. It did not exist. The non-strict schema swallowed it
// silently and returned a success-shaped result - the only tell was an empty
// change list inside an otherwise cheerful message.
//
// The obvious recovery is to retry with `tags`, which REPLACES wholesale. That
// would have wiped `discord_sourced`, the reporter's handle, and a
// `discord_thread:<id>` linkage off a CRITICAL data-loss work item, while
// trying to ANNOTATE it. The thread id is the only pointer back to the human
// who reported the bug; losing it is not recoverable from inside the KB.
//
// The documented workaround was read-modify-write - which is what an agent
// skips under time pressure, and which races another session regardless.
//
// THE ASYMMETRY THAT ALLOWED IT: `content` has had an additive counterpart
// since 0.30.72 (`append_content`), added after a near-clobber of exactly this
// shape. `tags` has identical replace-wholesale semantics and never got one.
// One axis protected, the identical sibling left open for months.
//
// TESTS BOTH HALVES ON PURPOSE. 0.37.0 shipped a guard with thirteen passing
// tests that could never fire, because every one exercised a pure function
// while the delivery boundary went uncrossed. mergeTags being correct proves
// nothing about whether `add_tags` reaches it.
// ===========================================================================

const SERVER_SRC = readFileSync(
  join(import.meta.dir, "..", "mcp", "server.ts"),
  "utf-8"
);

describe("0.40.0: mergeTags semantics", () => {
  test("THE NEAR-MISS CASE: provenance tags survive an annotation", () => {
    const existing = "discord_sourced,asianrizz,discord_thread:1494124708646486126";
    const merged = mergeTags(existing, "stale-commitment,awaiting-user-since:2026-07-29");
    for (const t of ["discord_sourced", "asianrizz", "discord_thread:1494124708646486126"]) {
      expect(merged).toContain(t);
    }
    expect(merged).toContain("stale-commitment");
  });

  test("union, not replacement", () => {
    expect(mergeTags("a,b", "c")).toBe("a,b,c");
  });

  test("dedupes case-insensitively but keeps the original casing", () => {
    expect(mergeTags("Discord_Sourced", "discord_sourced")).toBe("Discord_Sourced");
  });

  test("order is stable - existing first, additions appended", () => {
    // Stability matters because tags are rendered and diffed by humans; a
    // reshuffle on every annotation makes real changes hard to spot.
    expect(mergeTags("z,a", "m")).toBe("z,a,m");
  });

  test("handles empty and null on either side without inventing a tag", () => {
    expect(mergeTags(null, "a")).toBe("a");
    expect(mergeTags("a", null)).toBe("a");
    expect(mergeTags(null, null)).toBe("");
    expect(mergeTags("", "")).toBe("");
  });

  test("is NEVER destructive - output is a superset of input", () => {
    // The property that makes it safe to reach for by default. If this can
    // fail, the parameter has become a second way to lose provenance.
    const existing = "keep1,keep2,keep3";
    for (const addition of ["", "new", "keep1", "keep1,new"]) {
      const merged = mergeTags(existing, addition);
      for (const t of ["keep1", "keep2", "keep3"]) expect(merged).toContain(t);
    }
  });
});

describe("0.40.0: add_tags is actually wired into both tools", () => {
  test("both update_note and update_work_item DECLARE add_tags", () => {
    // Two occurrences: one schema entry per tool.
    const declarations = SERVER_SRC.match(/add_tags: z\.string\(\)\.optional\(\)/g) ?? [];
    expect(declarations.length).toBe(2);
  });

  test("both handlers DESTRUCTURE it - declaring without reading is the 0.37.0 defect", () => {
    const destructures = SERVER_SRC.match(/async \(\{[^}]*\badd_tags\b[^}]*\}\)/g) ?? [];
    expect(destructures.length).toBe(2);
  });

  test("both handlers CALL mergeTags - destructuring without using it is the same defect", () => {
    const uses = SERVER_SRC.match(/mergeTags\(/g) ?? [];
    expect(uses.length).toBeGreaterThanOrEqual(2);
  });

  test("both tools REFUSE tags + add_tags together", () => {
    // Accepting both would apply one and discard the other, which is the
    // silent-swallow shape this parameter exists to remove.
    const guards = SERVER_SRC.match(/Cannot provide both tags and add_tags/g) ?? [];
    expect(guards.length).toBe(2);
  });

  test("the `tags` description warns that it replaces wholesale", () => {
    // The parameter stays available - full replacement is legitimate - but the
    // hazard has to be visible at the point of use, not only in a note.
    expect(SERVER_SRC).toContain("REPLACES the existing set wholesale");
  });
});
