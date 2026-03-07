import { describe, expect, it } from "bun:test";
import { extractKeywords, truncate, generateId } from "../mcp/utils";

describe("extractKeywords", () => {
  it("extracts meaningful keywords from text", () => {
    const text =
      "The backup snapshot engine handles incremental backups for the server. It creates snapshots and manages backup retention.";
    const keywords = extractKeywords(text);
    expect(keywords).toContain("backup");
    expect(keywords).toContain("snapshot");
    expect(keywords).not.toContain("the");
    expect(keywords).not.toContain("for");
  });

  it("returns at most 20 keywords", () => {
    const text = Array.from({ length: 50 }, (_, i) => `word${i}`).join(" ");
    const keywords = extractKeywords(text);
    expect(keywords.length).toBeLessThanOrEqual(20);
  });

  it("expands synonyms for domain terms", () => {
    const text = "backup engine handles data";
    const keywords = extractKeywords(text);
    // "backup" should trigger synonym expansion
    expect(keywords).toContain("backup");
    expect(keywords).toContain("snapshot");
  });

  it("handles empty string", () => {
    const keywords = extractKeywords("");
    expect(keywords).toEqual([]);
  });
});

describe("truncate", () => {
  it("truncates long strings with ellipsis", () => {
    const long = "a".repeat(200);
    const result = truncate(long, 100);
    expect(result.length).toBe(100);
    expect(result.endsWith("...")).toBe(true);
  });

  it("leaves short strings unchanged", () => {
    const short = "hello world";
    expect(truncate(short)).toBe(short);
  });
});

describe("generateId", () => {
  it("generates unique UUIDs", () => {
    const id1 = generateId();
    const id2 = generateId();
    expect(id1).not.toBe(id2);
    // UUID v4 format
    expect(id1).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
    expect(id2).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
  });
});
