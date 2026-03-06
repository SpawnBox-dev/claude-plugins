import type { Database } from "bun:sqlite";
import { extractKeywords } from "../utils";

interface DuplicateMatch {
  id: string;
  content: string;
  similarity: number;
}

/**
 * Check if content is a duplicate of an existing note of the same type.
 */
export function isDuplicate(
  db: Database,
  type: string,
  content: string,
  threshold = 0.6
): boolean {
  return findDuplicates(db, type, content, threshold).length > 0;
}

/**
 * Find duplicate or near-duplicate notes of the same type.
 * Uses exact match first, then Jaccard similarity on keywords.
 */
export function findDuplicates(
  db: Database,
  type: string,
  content: string,
  threshold = 0.6
): DuplicateMatch[] {
  const normalizedContent = content.trim().toLowerCase();
  const inputKeywords = new Set(extractKeywords(content));
  const matches: DuplicateMatch[] = [];

  // Get all notes of the same type
  const candidates = db
    .query(`SELECT id, content, keywords FROM notes WHERE type = ?`)
    .all(type) as Array<{ id: string; content: string; keywords: string }>;

  for (const candidate of candidates) {
    // Check exact match (case-insensitive, trimmed)
    if (candidate.content.trim().toLowerCase() === normalizedContent) {
      matches.push({ id: candidate.id, content: candidate.content, similarity: 1.0 });
      continue;
    }

    // Check keyword overlap via Jaccard similarity
    const candidateKeywords = new Set(
      candidate.keywords
        ? candidate.keywords
            .split(",")
            .map((k) => k.trim().toLowerCase())
            .filter((k) => k.length > 0)
        : extractKeywords(candidate.content)
    );

    if (inputKeywords.size === 0 && candidateKeywords.size === 0) continue;

    const intersection = new Set(
      [...inputKeywords].filter((k) => candidateKeywords.has(k))
    );
    const union = new Set([...inputKeywords, ...candidateKeywords]);
    const similarity = union.size > 0 ? intersection.size / union.size : 0;

    if (similarity >= threshold) {
      matches.push({ id: candidate.id, content: candidate.content, similarity });
    }
  }

  // Sort by similarity descending
  matches.sort((a, b) => b.similarity - a.similarity);
  return matches;
}
