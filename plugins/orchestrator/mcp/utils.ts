import { v4 as uuidv4 } from "uuid";
import type { NoteSummary } from "./types";

/** Generate a UUID v4 identifier. */
export function generateId(): string {
  return uuidv4();
}

/** Current time as ISO-8601 string. */
export function now(): string {
  return new Date().toISOString();
}

// Comprehensive English stop words
const STOP_WORDS = new Set([
  "a", "an", "the", "and", "or", "but", "in", "on", "at", "to", "for",
  "of", "with", "by", "from", "is", "it", "as", "be", "was", "were",
  "been", "being", "have", "has", "had", "do", "does", "did", "will",
  "would", "could", "should", "may", "might", "shall", "can", "need",
  "dare", "ought", "used", "not", "no", "nor", "so", "yet", "both",
  "each", "few", "more", "most", "other", "some", "such", "than",
  "too", "very", "just", "about", "above", "after", "again", "all",
  "also", "am", "any", "are", "because", "before", "below", "between",
  "during", "here", "how", "if", "into", "its", "let", "me", "my",
  "myself", "now", "off", "once", "only", "our", "out", "over", "own",
  "same", "she", "he", "her", "him", "his", "hers", "that", "their",
  "them", "then", "there", "these", "they", "this", "those", "through",
  "under", "until", "up", "we", "what", "when", "where", "which",
  "while", "who", "whom", "why", "you", "your", "yours", "i",
]);

/**
 * Extract meaningful keywords from text.
 * Lowercases, strips punctuation, filters stop words,
 * counts frequency, and returns the top 15 keywords.
 */
export function extractKeywords(text: string): string[] {
  if (!text.trim()) return [];

  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s_-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOP_WORDS.has(w));

  const freq = new Map<string, number>();
  for (const word of words) {
    freq.set(word, (freq.get(word) ?? 0) + 1);
  }

  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)
    .map(([word]) => word);
}

/**
 * Truncate text to maxLength characters, appending "..." if truncated.
 */
export function truncate(text: string, maxLength = 100): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength - 3) + "...";
}

/**
 * Summarize notes as a bullet list for briefings,
 * respecting an approximate token budget (1 token ~= 4 chars).
 */
export function summarizeForBriefing(
  notes: NoteSummary[],
  maxTokens = 200
): string {
  const maxChars = maxTokens * 4;
  const lines: string[] = [];
  let charCount = 0;

  for (const note of notes) {
    const line = `- [${note.type}] ${truncate(note.content, 120)}`;
    if (charCount + line.length > maxChars) break;
    lines.push(line);
    charCount += line.length + 1; // +1 for newline
  }

  return lines.join("\n");
}
