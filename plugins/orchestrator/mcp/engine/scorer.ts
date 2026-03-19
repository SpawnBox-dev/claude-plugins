import type { Database } from "bun:sqlite";
import type { AutonomyLevel, ConfidenceLevel } from "../types";
import { now } from "../utils";

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
 *
 * Primary types (autonomy_recipe, quality_gate, anti_pattern) represent
 * actionable domain knowledge. Secondary types (convention, architecture)
 * contribute at half weight since they represent understanding rather than
 * operational recipes.
 */
export function computeAutonomyScore(
  db: Database,
  domain: string
): {
  score: AutonomyLevel;
  recipe_count: number;
  gate_count: number;
  anti_pattern_count: number;
  convention_count: number;
  architecture_count: number;
} {
  const pattern = `%${domain}%`;

  function countByType(type: string): number {
    return (
      db
        .query(
          `SELECT COUNT(*) as cnt FROM notes
           WHERE type = ?
             AND (tags LIKE ? OR keywords LIKE ?)`
        )
        .get(type, pattern, pattern) as { cnt: number }
    ).cnt;
  }

  const recipeCount = countByType("autonomy_recipe");
  const gateCount = countByType("quality_gate");
  const antiPatternCount = countByType("anti_pattern");
  const conventionCount = countByType("convention");
  const architectureCount = countByType("architecture");

  // Primary types count fully, secondary types at half weight
  const total =
    recipeCount +
    gateCount +
    antiPatternCount +
    Math.floor((conventionCount + architectureCount) / 2);

  const score: AutonomyLevel =
    total >= 15 ? "mature" : total >= 5 ? "developing" : "sparse";

  return {
    score,
    recipe_count: recipeCount,
    gate_count: gateCount,
    anti_pattern_count: antiPatternCount,
    convention_count: conventionCount,
    architecture_count: architectureCount,
  };
}
