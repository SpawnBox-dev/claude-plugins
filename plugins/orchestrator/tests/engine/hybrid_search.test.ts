import { describe, test, expect } from "bun:test";
import { cosineSimilarity, reciprocalRankFusion, maximalMarginalRelevance } from "../../mcp/engine/hybrid_search";
import { signalBoost } from "../../mcp/engine/signal";

describe("cosineSimilarity", () => {
  test("identical vectors return 1.0", () => {
    const v = new Float32Array([1, 0, 0]);
    expect(cosineSimilarity(v, v)).toBeCloseTo(1.0);
  });
  test("orthogonal vectors return 0.0", () => {
    expect(cosineSimilarity(new Float32Array([1, 0, 0]), new Float32Array([0, 1, 0]))).toBeCloseTo(0.0);
  });
  test("opposite vectors return -1.0", () => {
    expect(cosineSimilarity(new Float32Array([1, 0, 0]), new Float32Array([-1, 0, 0]))).toBeCloseTo(-1.0);
  });
  test("zero vector returns 0.0", () => {
    expect(cosineSimilarity(new Float32Array([0, 0, 0]), new Float32Array([1, 0, 0]))).toBeCloseTo(0.0);
  });
});

describe("reciprocalRankFusion", () => {
  test("notes in both lists rank higher", () => {
    const fts = new Map([["a", 1], ["b", 2], ["c", 3]]);
    const vec = new Map([["b", 1], ["d", 2], ["a", 3]]);
    const result = reciprocalRankFusion(fts, vec, 60);
    expect(result[0].id).toBe("b"); // rank 2+1 = best combined
    expect(result[1].id).toBe("a"); // rank 1+3
  });
  test("notes in only one list still appear", () => {
    const result = reciprocalRankFusion(new Map([["a", 1]]), new Map([["b", 1]]), 60);
    expect(result.length).toBe(2);
  });
});

describe("maximalMarginalRelevance", () => {
  test("suppresses similar items in favor of diverse ones", () => {
    const items: import("../../mcp/engine/hybrid_search").MMRItem[] = [
      { id: "a", score: 0.9, vector: new Float32Array([1, 0, 0]) },
      { id: "b", score: 0.85, vector: new Float32Array([0.99, 0.1, 0]) }, // very similar to a
      { id: "c", score: 0.7, vector: new Float32Array([0, 1, 0]) },       // orthogonal to a
    ];
    const result = maximalMarginalRelevance(items, 3, 0.7);
    expect(result[0].id).toBe("a"); // highest score
    expect(result[1].id).toBe("c"); // diverse from a, beats b despite lower score
  });
  test("empty input returns empty", () => {
    expect(maximalMarginalRelevance([], 5, 0.7)).toEqual([]);
  });
  test("topK limits output size", () => {
    const items: import("../../mcp/engine/hybrid_search").MMRItem[] = [
      { id: "a", score: 0.9, vector: new Float32Array([1, 0, 0]) },
      { id: "b", score: 0.8, vector: new Float32Array([0, 1, 0]) },
      { id: "c", score: 0.7, vector: new Float32Array([0, 0, 1]) },
    ];
    const result = maximalMarginalRelevance(items, 2, 0.7);
    expect(result.length).toBe(2);
  });
});

describe("signalBoost", () => {
  test("zero signal returns 1.0", () => {
    expect(signalBoost(0)).toBeCloseTo(1.0);
  });
  test("higher signal gives higher boost", () => {
    expect(signalBoost(10)).toBeGreaterThan(signalBoost(0));
  });
});
