/**
 * Hybrid search utilities - pure functions for ranking and diversity.
 * No DB access, no sidecar, just math.
 */

export interface RRFResult {
  id: string;
  score: number;
}

export interface MMRItem {
  id: string;
  score: number;
  vector: Float32Array;
}

/**
 * Cosine similarity between two vectors.
 * Returns dot(a,b) / (||a|| * ||b||), or 0 if either norm is 0.
 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (denom === 0) return 0;
  return dot / denom;
}

/**
 * Reciprocal Rank Fusion: merges two ranked lists into a single score.
 * RRF_score(item) = 1/(k + rank_in_A) + 1/(k + rank_in_B)
 * Items in only one list get a single-source score.
 * Returns results sorted descending by score.
 */
export function reciprocalRankFusion(
  ftsRanks: Map<string, number>,
  vecRanks: Map<string, number>,
  k: number = 60,
): RRFResult[] {
  const scores = new Map<string, number>();

  for (const [id, rank] of ftsRanks) {
    scores.set(id, (scores.get(id) ?? 0) + 1 / (k + rank));
  }

  for (const [id, rank] of vecRanks) {
    scores.set(id, (scores.get(id) ?? 0) + 1 / (k + rank));
  }

  const results: RRFResult[] = [];
  for (const [id, score] of scores) {
    results.push({ id, score });
  }

  results.sort((a, b) => b.score - a.score);
  return results;
}

/**
 * Maximal Marginal Relevance: selects diverse items from a ranked list.
 * First item is always the highest-scored.
 * Each subsequent: MMR = lambda * relevance - (1-lambda) * max_sim_to_selected
 * Uses cosineSimilarity for inter-item similarity.
 */
export function maximalMarginalRelevance(
  items: MMRItem[],
  topK: number,
  lambda: number = 0.7,
): MMRItem[] {
  if (items.length === 0) return [];

  const selected: MMRItem[] = [];
  const remaining = new Set(items.map((_, i) => i));

  // Find the item with the highest score
  let bestIdx = 0;
  let bestScore = -Infinity;
  for (const i of remaining) {
    if (items[i].score > bestScore) {
      bestScore = items[i].score;
      bestIdx = i;
    }
  }

  selected.push(items[bestIdx]);
  remaining.delete(bestIdx);

  while (selected.length < topK && remaining.size > 0) {
    let bestMMR = -Infinity;
    let bestCandidate = -1;

    for (const i of remaining) {
      const relevance = items[i].score;

      // Max similarity to any already-selected item
      let maxSim = -Infinity;
      for (const s of selected) {
        const sim = cosineSimilarity(items[i].vector, s.vector);
        if (sim > maxSim) maxSim = sim;
      }

      const mmr = lambda * relevance - (1 - lambda) * maxSim;

      if (mmr > bestMMR) {
        bestMMR = mmr;
        bestCandidate = i;
      }
    }

    if (bestCandidate === -1) break;

    selected.push(items[bestCandidate]);
    remaining.delete(bestCandidate);
  }

  return selected;
}

