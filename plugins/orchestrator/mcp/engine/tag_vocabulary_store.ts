/**
 * Observation half of tag governance (WI cbf82684). The DECISION lives in
 * `tag_vocabulary.ts` and is pure and unit-tested; this reads the one fact it
 * needs and never throws.
 *
 * WHY IT IS CACHED. The vocabulary is derived from every tagged note - 10,806
 * of them as of 2026-09-07 - and a write path that rebuilt it per call would
 * put a full-table scan in front of every `note()`. The vocabulary also moves
 * slowly by nature: it took a busy seven-agent night to add 1,382 tags, so a
 * cache measured in minutes cannot be meaningfully stale for the purpose of
 * "does this tag already exist".
 *
 * WHY IT NEVER THROWS. This is advisory. A governance layer that can fail a
 * write is worse than no governance layer - the same reason the install-mismatch
 * and scan-gap diagnostics are wrapped: a tool must never lose a caller's note
 * because a nicety broke.
 */

import type { Database } from "bun:sqlite";
import { buildVocabulary, type TagStat, type TagVocabulary } from "./tag_vocabulary";
import { parseTagList } from "../utils";

/** How long a built vocabulary stays usable. Five minutes is far shorter than
 *  the corpus's observed rate of change and far longer than a burst of writes
 *  from one session. */
const CACHE_TTL_MS = 5 * 60_000;

let cached: TagVocabulary | null = null;
let cachedAtMs = 0;

/** Exported for tests: drop the cache so a fixture DB is not shadowed by a
 *  vocabulary built from a previous one. */
export function resetTagVocabularyCache(): void {
  cached = null;
  cachedAtMs = 0;
}

/**
 * Current tag vocabulary, or null if it cannot be read.
 *
 * Null is a real answer and callers must treat it as "no advice available"
 * rather than "no established tags exist" - the second would turn an unreadable
 * database into a claim that every tag is novel.
 */
export function getTagVocabulary(db: Database, nowMs = Date.now()): TagVocabulary | null {
  if (cached && nowMs - cachedAtMs < CACHE_TTL_MS) return cached;
  try {
    const rows = db
      .query(`SELECT tags FROM notes WHERE tags IS NOT NULL AND tags != ''`)
      .all() as Array<{ tags: string | null }>;

    const counts = new Map<string, number>();
    for (const r of rows) {
      // parseTagList, not a raw split: it is the same reader the write path
      // uses, so the vocabulary counts exactly the tokens that get stored -
      // including healing the JSON-array-stringified rows (c658ce38).
      for (const t of parseTagList(r.tags)) {
        counts.set(t, (counts.get(t) ?? 0) + 1);
      }
    }
    const stats: TagStat[] = [...counts.entries()].map(([tag, count]) => ({ tag, count }));
    cached = buildVocabulary(stats);
    cachedAtMs = nowMs;
    return cached;
  } catch {
    // Unreadable vocabulary must never break a write.
    return null;
  }
}
