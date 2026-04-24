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
 * Synonym map for domain-specific terms.
 * When a keyword matches a synonym group, all terms in that group
 * are added as keywords, improving cross-note linking.
 */
const SYNONYM_GROUPS: string[][] = [
  ["backup", "snapshot", "restore", "archive"],
  ["auth", "authentication", "login", "signin", "sign-in", "oidc", "kinde"],
  ["billing", "payment", "subscription", "stripe", "lemon"],
  ["deploy", "deployment", "ci", "cd", "pipeline", "release"],
  ["docker", "container", "image", "compose"],
  ["wsl", "linux", "distro", "ubuntu"],
  ["frontend", "ui", "component", "react", "tsx"],
  ["backend", "rust", "tauri", "handler", "command"],
  ["database", "sqlite", "db", "migration", "schema", "query"],
  ["player", "user", "session", "uuid"],
  ["event", "eventbus", "broadcast", "listener", "emit"],
  ["poller", "polling", "telemetry", "datapack", "rcon"],
  ["discord", "bot", "webhook", "guild"],
  ["cloud", "worker", "cloudflare", "wrangler", "d1", "r2"],
  ["test", "testing", "vitest", "spec", "assertion"],
  ["map", "tile", "region", "atlas", "chunk"],
  ["perf", "performance", "latency", "throughput", "instrument"],
  ["error", "bug", "fix", "issue", "broken"],
  ["config", "settings", "configuration", "preference"],
  ["encrypt", "encryption", "aes", "decrypt"],
  ["hibernate", "hibernation", "compress", "archive"],
  ["observer", "connect", "disconnect", "reconnect", "visibility"],
  ["http", "api", "endpoint", "route", "request"],
  ["store", "zustand", "state", "selector"],
];

// Build a lookup: word -> set of synonyms
const synonymLookup = new Map<string, Set<string>>();
for (const group of SYNONYM_GROUPS) {
  const groupSet = new Set(group);
  for (const word of group) {
    synonymLookup.set(word, groupSet);
  }
}

/**
 * Extract meaningful keywords from text.
 * Lowercases, strips punctuation, filters stop words,
 * expands synonyms, counts frequency, and returns the top 20 keywords.
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

    // Expand synonyms (add related terms with lower weight)
    const synonyms = synonymLookup.get(word);
    if (synonyms) {
      for (const syn of synonyms) {
        if (syn !== word && !freq.has(syn)) {
          freq.set(syn, 0.5);
        }
      }
    }
  }

  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
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
 * Includes note IDs so resolve workflow works without DB queries.
 */
export function summarizeForBriefing(
  notes: NoteSummary[],
  maxTokens = 200
): string {
  const maxChars = maxTokens * 4;
  const lines: string[] = [];
  let charCount = 0;

  for (const note of notes) {
    const tagStr = note.tags ? ` {${note.tags}}` : "";
    const line = `- **${note.id}** [${note.type}]${tagStr} ${truncate(note.content, 120)}`;
    if (charCount + line.length > maxChars) break;
    lines.push(line);
    charCount += line.length + 1; // +1 for newline
  }

  return lines.join("\n");
}

/**
 * Format a relative time string from an ISO timestamp.
 */
export function relativeTime(isoTimestamp: string): string {
  const then = new Date(isoTimestamp).getTime();
  const now = Date.now();
  const diffMs = now - then;
  const diffMin = Math.floor(diffMs / 60000);
  const diffHr = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHr / 24);

  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffHr < 24) return `${diffHr}h ago`;
  if (diffDay < 7) return `${diffDay}d ago`;
  return `${Math.floor(diffDay / 7)}w ago`;
}

/**
 * R5: Parse a serialized code_refs JSON array from the notes.code_refs column.
 * Returns null when the stored value is null/empty, not valid JSON, not an
 * array, or contains non-string elements. Treats an empty array as null so
 * downstream renderers consistently skip the "code_refs: []" noise.
 */
export function parseCodeRefs(raw: string | null): string[] | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.every((x) => typeof x === "string")) {
      return parsed.length > 0 ? parsed : null;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * R5: Serialize a code_refs array for the notes.code_refs column.
 * Trims each ref, drops empty strings, normalizes paths, and de-duplicates.
 * Returns null when the input is null/undefined/empty so the caller can bind
 * a single consistent NULL value instead of an empty JSON array.
 *
 * R5.2 Minor-2: path normalization. Leading "./" is stripped and backslashes
 * are converted to forward slashes so "./mcp/server.ts", "mcp\\server.ts",
 * and "mcp/server.ts" all store identically. Trailing slashes are preserved
 * so a directory-ref ("src/") remains distinct from a file-ref ("src").
 */
export function stringifyCodeRefs(refs: string[] | null | undefined): string | null {
  if (!refs || refs.length === 0) return null;
  const cleaned = Array.from(
    new Set(
      refs
        .map((r) => {
          let p = r.trim();
          p = p.replace(/\\/g, "/");
          if (p.startsWith("./")) p = p.slice(2);
          return p;
        })
        .filter((r) => r.length > 0)
    )
  );
  return cleaned.length > 0 ? JSON.stringify(cleaned) : null;
}

/**
 * Compact age formatter for inline rendering in lookup envelopes.
 * Examples: "just now", "3m", "3h", "5d", "2w", "62d"
 *
 * Differs from relativeTime: omits "ago" suffix for terseness and collapses
 * week output back to days once we cross ~2 months (for trend-visibility
 * instead of inflating noisy weeks).
 */
export function formatAge(iso: string, now: Date = new Date()): string {
  const then = new Date(iso);
  const diffMs = now.getTime() - then.getTime();
  if (!Number.isFinite(diffMs)) return "unknown";
  if (diffMs < 0) return "just now";
  if (diffMs < 60_000) return "just now";
  const diffMin = Math.floor(diffMs / 60_000);
  if (diffMin < 60) return `${diffMin}m`;
  const diffH = Math.floor(diffMin / 60);
  if (diffH < 24) return `${diffH}h`;
  const diffD = Math.floor(diffH / 24);
  if (diffD < 14) return `${diffD}d`;
  if (diffD < 60) return `${Math.floor(diffD / 7)}w`;
  return `${diffD}d`;
}
