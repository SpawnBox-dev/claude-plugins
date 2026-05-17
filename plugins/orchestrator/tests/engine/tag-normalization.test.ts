import { describe, expect, test } from "bun:test";
import { parseTagList, normalizeTagString } from "../../mcp/utils";

// c658ce38: tags column is contractually comma-separated, but callers have
// passed JSON-array-stringified values, which got baked into stored rows and
// produced char-split garbage in the briefing's Neglected Areas / drift.

describe("parseTagList", () => {
  test("clean comma-separated input -> trimmed list (common-path parity)", () => {
    expect(parseTagList("a,b,c")).toEqual(["a", "b", "c"]);
    expect(parseTagList("a, b ,  c ")).toEqual(["a", "b", "c"]);
    expect(parseTagList("solo")).toEqual(["solo"]);
  });

  test("empty / null / undefined / whitespace -> []", () => {
    expect(parseTagList("")).toEqual([]);
    expect(parseTagList("   ")).toEqual([]);
    expect(parseTagList(null)).toEqual([]);
    expect(parseTagList(undefined)).toEqual([]);
  });

  test("JSON-array-stringified value is parsed (the root input shape)", () => {
    expect(parseTagList('["a","b","c"]')).toEqual(["a", "b", "c"]);
    expect(parseTagList('[ "x" , "y" ]')).toEqual(["x", "y"]);
  });

  test("historical baked-in garbage heals on read (the c658ce38 symptom)", () => {
    // What composer used to char-split into ["combat / "design-decision" / "enrichment"]
    expect(parseTagList('["combat","design-decision","enrichment"]')).toEqual([
      "combat",
      "design-decision",
      "enrichment",
    ]);
    // The form actually stored after a stringified array was comma-split with
    // a leading type prefix (seen on real work items).
    expect(parseTagList('work_item,["work_item","bug","x"]')).toEqual([
      "work_item",
      "bug",
      "x",
    ]);
  });

  test("order-preserving de-duplication", () => {
    expect(parseTagList("a,a,b,a,c,b")).toEqual(["a", "b", "c"]);
  });

  test("legitimate kebab/colon tags are untouched", () => {
    expect(parseTagList("area:orchestrator-plugin, discord_thread:123, owner:SA-1")).toEqual([
      "area:orchestrator-plugin",
      "discord_thread:123",
      "owner:SA-1",
    ]);
  });

  test("non-string array elements are coerced, never throws", () => {
    expect(parseTagList("[1,\"b\",true]")).toEqual(["1", "b", "true"]);
  });
});

describe("normalizeTagString", () => {
  test("canonicalizes any form to clean CSV for storage", () => {
    expect(normalizeTagString('["a","b"]')).toBe("a,b");
    expect(normalizeTagString("a, b ,c")).toBe("a,b,c");
    expect(normalizeTagString('work_item,["work_item","bug"]')).toBe("work_item,bug");
  });

  test("empty / garbage-only -> '' (cleared)", () => {
    expect(normalizeTagString("")).toBe("");
    expect(normalizeTagString(null)).toBe("");
    expect(normalizeTagString('[]')).toBe("");
  });
});
