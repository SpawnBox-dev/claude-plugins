import type { Database } from "bun:sqlite";
import type { NoteSummary } from "../types";
import { decayConfidence, computeAutonomyScore } from "../engine/scorer";
import { mergeDuplicates } from "../engine/deduplicator";
import { now } from "../utils";

export interface ReflectInput {
  focus?: string;
}

export interface ReflectResult {
  confidence_decayed: number;
  duplicates_found: number;
  duplicates_merged: number;
  orphan_notes: number;
  autonomy_scores: Record<string, string>;
  revalidation_queue: Array<{ id: string; content: string; type: string }>;
  message: string;
}

const DOMAINS = ["frontend", "backend", "cloud", "infra", "testing"];

export function handleReflect(
  projectDb: Database,
  globalDb: Database,
  input: ReflectInput
): ReflectResult {
  // Decay confidence on stale notes in both DBs
  const projectDecayed = decayConfidence(projectDb);
  const globalDecayed = decayConfidence(globalDb);
  const totalDecayed = projectDecayed + globalDecayed;

  // Merge duplicate notes in both DBs
  const projectMerged = mergeDuplicates(projectDb);
  const globalMerged = mergeDuplicates(globalDb);
  const totalMerged = projectMerged + globalMerged;

  // Count orphan notes (notes with no links in either direction)
  const orphanCount = (
    projectDb
      .query(
        `SELECT COUNT(*) as cnt FROM notes n
         WHERE NOT EXISTS (SELECT 1 FROM links l WHERE l.from_note_id = n.id OR l.to_note_id = n.id)`
      )
      .get() as { cnt: number }
  ).cnt;

  // Get low-confidence unresolved notes for revalidation
  const revalidationRows = projectDb
    .query(
      `SELECT id, content, type FROM notes
       WHERE confidence = 'low' AND resolved = 0
       ORDER BY updated_at ASC
       LIMIT 10`
    )
    .all() as Array<{ id: string; content: string; type: string }>;

  // Compute autonomy scores for each domain
  const autonomyScores: Record<string, string> = {};
  const timestamp = now();

  for (const domain of DOMAINS) {
    const result = computeAutonomyScore(projectDb, domain);
    autonomyScores[domain] = result.score;

    // Upsert into global DB
    try {
      globalDb.run(
        `INSERT INTO autonomy_scores (id, project, domain, score, recipe_count, gate_count, anti_pattern_count, last_assessed)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(project, domain) DO UPDATE SET
           score = excluded.score,
           recipe_count = excluded.recipe_count,
           gate_count = excluded.gate_count,
           anti_pattern_count = excluded.anti_pattern_count,
           last_assessed = excluded.last_assessed`,
        [
          `${domain}-score`,
          "current",
          domain,
          result.score,
          result.recipe_count,
          result.gate_count,
          result.anti_pattern_count,
          timestamp,
        ]
      );
    } catch {
      // autonomy_scores table might not exist if global DB isn't initialized
    }
  }

  const message = [
    `Reflection complete.`,
    totalDecayed > 0 ? `${totalDecayed} note(s) had confidence decayed.` : null,
    totalMerged > 0 ? `${totalMerged} duplicate note(s) merged.` : null,
    orphanCount > 0 ? `${orphanCount} orphan note(s) with no links.` : null,
    revalidationRows.length > 0
      ? `${revalidationRows.length} note(s) queued for revalidation.`
      : null,
  ]
    .filter(Boolean)
    .join(" ");

  return {
    confidence_decayed: totalDecayed,
    duplicates_found: totalMerged,
    duplicates_merged: totalMerged,
    orphan_notes: orphanCount,
    autonomy_scores: autonomyScores,
    revalidation_queue: revalidationRows,
    message,
  };
}
