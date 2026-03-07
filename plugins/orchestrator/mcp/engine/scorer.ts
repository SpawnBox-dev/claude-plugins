import type { Database } from "bun:sqlite";
import type { AutonomyLevel, ConfidenceLevel } from "../types";
import { now } from "../utils";

/**
 * Decay confidence of stale, unresolved notes to 'low'.
 * Returns the number of rows affected.
 */
export function decayConfidence(db: Database, staleDays = 30): number {
  const cutoff = new Date(
    Date.now() - staleDays * 24 * 60 * 60 * 1000
  ).toISOString();

  const result = db.run(
    `UPDATE notes
     SET confidence = 'low', updated_at = ?
     WHERE confidence != 'low'
       AND last_validated < ?
       AND resolved = 0`,
    [new Date().toISOString(), cutoff]
  );

  return result.changes;
}

/**
 * Promote confidence of an existing note when a near-duplicate is found.
 * low -> medium -> high. Also refreshes last_validated.
 * Returns the new confidence level.
 */
export function promoteConfidence(
  db: Database,
  noteId: string
): ConfidenceLevel {
  const row = db
    .query(`SELECT confidence FROM notes WHERE id = ?`)
    .get(noteId) as { confidence: string } | null;

  if (!row) return "medium";

  const current = row.confidence as ConfidenceLevel;
  const promoted: ConfidenceLevel =
    current === "low" ? "medium" : current === "medium" ? "high" : "high";

  const timestamp = now();
  db.run(
    `UPDATE notes SET confidence = ?, last_validated = ?, updated_at = ? WHERE id = ?`,
    [promoted, timestamp, timestamp, noteId]
  );

  return promoted;
}

/**
 * Compute an autonomy score for a given domain.
 * Counts relevant notes by type and returns a maturity assessment.
 */
export function computeAutonomyScore(
  db: Database,
  domain: string
): {
  score: AutonomyLevel;
  recipe_count: number;
  gate_count: number;
  anti_pattern_count: number;
} {
  const pattern = `%${domain}%`;

  const recipeCount = (
    db
      .query(
        `SELECT COUNT(*) as cnt FROM notes
         WHERE type = 'autonomy_recipe'
           AND (tags LIKE ? OR keywords LIKE ?)`
      )
      .get(pattern, pattern) as { cnt: number }
  ).cnt;

  const gateCount = (
    db
      .query(
        `SELECT COUNT(*) as cnt FROM notes
         WHERE type = 'quality_gate'
           AND (tags LIKE ? OR keywords LIKE ?)`
      )
      .get(pattern, pattern) as { cnt: number }
  ).cnt;

  const antiPatternCount = (
    db
      .query(
        `SELECT COUNT(*) as cnt FROM notes
         WHERE type = 'anti_pattern'
           AND (tags LIKE ? OR keywords LIKE ?)`
      )
      .get(pattern, pattern) as { cnt: number }
  ).cnt;

  const total = recipeCount + gateCount + antiPatternCount;
  const score: AutonomyLevel =
    total >= 15 ? "mature" : total >= 5 ? "developing" : "sparse";

  return {
    score,
    recipe_count: recipeCount,
    gate_count: gateCount,
    anti_pattern_count: antiPatternCount,
  };
}
