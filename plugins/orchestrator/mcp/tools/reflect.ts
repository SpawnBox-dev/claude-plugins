import type { Database } from "bun:sqlite";
import type { NoteSummary } from "../types";
import { existsSync } from "node:fs";
import path from "node:path";
import { computeAutonomyScore } from "../engine/scorer";
import { decayAllSignals } from "../engine/signal";
import { mergeDuplicates } from "../engine/deduplicator";
import { now, parseCodeRefs } from "../utils";

export interface ReflectInput {
  focus?: string;
}

export interface ReflectResult {
  signals_decayed: number;
  duplicates_found: number;
  duplicates_merged: number;
  orphan_notes: number;
  autonomy_scores: Record<string, string>;
  revalidation_queue: Array<{ id: string; content: string; type: string }>;
  trajectory_updates: number;
  /** R5: count of code_ref paths checked against the filesystem during retro. */
  code_refs_checked: number;
  /** R5: count of code_refs that pointed at a path which does not exist. */
  code_refs_broken: number;
  message: string;
}

const DOMAINS = ["frontend", "backend", "cloud", "infra", "testing"];

export function handleReflect(
  projectDb: Database,
  globalDb: Database,
  input: ReflectInput
): ReflectResult {
  // R5.2 Critical-2: wrap project-DB maintenance in a transaction and global-DB
  // maintenance in a separate transaction so partial failure rolls back
  // cleanly. Without this, a mid-pass throw (e.g. during autonomy scoring)
  // leaves decay + merge already committed. The next auto-retro run then
  // double-decays already-decayed notes. With transactions, the throw
  // propagates out of handleReflect with the work rolled back, and the
  // caller's finally block still advances the cursor so we don't re-attempt
  // the same broken state on the next startup.
  const timestamp = now();
  let projectDecayed = 0;
  let projectMerged = 0;
  let orphanCount = 0;
  let revalidationRows: Array<{ id: string; content: string; type: string }> = [];
  const autonomyScores: Record<string, string> = {};
  // autonomyInputs: computed under projectDb read; written under globalDb tx.
  const autonomyInputs: Array<{
    domain: string;
    score: string;
    recipe_count: number;
    gate_count: number;
    anti_pattern_count: number;
  }> = [];

  projectDb.transaction(() => {
    projectDecayed = decayAllSignals(projectDb);
    projectMerged = mergeDuplicates(projectDb);

    // Count orphan notes (notes with no links in either direction)
    orphanCount = (
      projectDb
        .query(
          `SELECT COUNT(*) as cnt FROM notes n
           WHERE NOT EXISTS (SELECT 1 FROM links l WHERE l.from_note_id = n.id OR l.to_note_id = n.id)`
        )
        .get() as { cnt: number }
    ).cnt;

    // Get low-confidence unresolved notes for revalidation
    revalidationRows = projectDb
      .query(
        `SELECT id, content, type FROM notes
         WHERE confidence = 'low' AND resolved = 0
         ORDER BY updated_at ASC
         LIMIT 10`
      )
      .all() as Array<{ id: string; content: string; type: string }>;

    // Compute autonomy scores for each domain (reads projectDb; writes
    // happen below under the global-db transaction).
    for (const domain of DOMAINS) {
      const result = computeAutonomyScore(projectDb, domain);
      autonomyScores[domain] = result.score;
      autonomyInputs.push({
        domain,
        score: result.score,
        recipe_count: result.recipe_count,
        gate_count: result.gate_count,
        anti_pattern_count: result.anti_pattern_count,
      });
    }
  })();

  // User model trajectory analysis + autonomy upsert all happen under the
  // global-db transaction so a partial failure leaves global-db consistent.
  let globalDecayed = 0;
  let globalMerged = 0;
  let trajectoryUpdates = 0;
  globalDb.transaction(() => {
    globalDecayed = decayAllSignals(globalDb);
    globalMerged = mergeDuplicates(globalDb);

    for (const row of autonomyInputs) {
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
            `${row.domain}-score`,
            "current",
            row.domain,
            row.score,
            row.recipe_count,
            row.gate_count,
            row.anti_pattern_count,
            timestamp,
          ]
        );
      } catch {
        // autonomy_scores table might not exist if global DB isn't initialized
      }
    }

    try {
      // Look at user_pattern notes created in last 7 days
      const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
      const recentPatterns = globalDb
        .query(
          `SELECT content FROM notes
           WHERE type = 'user_pattern' AND created_at >= ?
           ORDER BY created_at DESC`
        )
        .all(sevenDaysAgo) as Array<{ content: string }>;

      if (recentPatterns.length >= 3) {
        // If there are many recent user_pattern notes, user preferences are evolving
        const entries = globalDb
          .query(`SELECT id, dimension, trajectory, updated_at FROM user_model`)
          .all() as Array<{ id: string; dimension: string; trajectory: string; updated_at: string }>;

        for (const entry of entries) {
          const entryAge = Date.now() - new Date(entry.updated_at).getTime();
          const staleMs = 14 * 24 * 60 * 60 * 1000; // 14 days

          if (entryAge > staleMs && entry.trajectory !== "regressing") {
            // Old entry not reinforced - might be regressing
            globalDb.run(
              `UPDATE user_model SET trajectory = 'regressing', updated_at = ? WHERE id = ?`,
              [timestamp, entry.id]
            );
            trajectoryUpdates++;
          } else if (entryAge < 3 * 24 * 60 * 60 * 1000 && entry.trajectory !== "improving") {
            // Recently reinforced - improving
            globalDb.run(
              `UPDATE user_model SET trajectory = 'improving', updated_at = ? WHERE id = ?`,
              [timestamp, entry.id]
            );
            trajectoryUpdates++;
          }
        }
      }
    } catch {
      // user_model operations are best-effort
    }
  })();

  const totalDecayed = projectDecayed + globalDecayed;
  const totalMerged = projectMerged + globalMerged;

  // R5: code_refs verification pass. When CLAUDE_PROJECT_DIR (or the
  // orchestrator fallback) is set, iterate non-resolved notes that declare
  // code_refs and check each path against the filesystem.
  // R5.2 Important-4: verification includes SUPERSEDED notes (they are still
  // agent-visible via lookup({include_superseded: true}), so broken refs are
  // worth knowing about). Resolved notes are still skipped - resolved threads
  // are settled, not worth re-checking.
  let codeRefsChecked = 0;
  let codeRefsBroken = 0;
  const projectRoot =
    process.env.CLAUDE_PROJECT_DIR ||
    process.env.ORCHESTRATOR_PROJECT_ROOT ||
    null;

  if (projectRoot) {
    try {
      const rows = projectDb
        .query(
          `SELECT id, code_refs FROM notes
           WHERE code_refs IS NOT NULL AND resolved = 0`
        )
        .all() as Array<{ id: string; code_refs: string }>;

      for (const row of rows) {
        const refs = parseCodeRefs(row.code_refs);
        if (!refs) continue;
        for (const ref of refs) {
          codeRefsChecked++;
          const fullPath = path.join(projectRoot, ref);
          if (!existsSync(fullPath)) {
            codeRefsBroken++;
          }
        }
      }
    } catch {
      // code_refs column might not exist on very old DBs that never migrated.
      // Graceful degradation: skip verification, leave counters at 0.
    }
  }

  const message = [
    `Reflection complete.`,
    totalDecayed > 0 ? `${totalDecayed} note signal(s) decayed.` : null,
    totalMerged > 0 ? `${totalMerged} duplicate note(s) merged.` : null,
    orphanCount > 0 ? `${orphanCount} orphan note(s) with no links.` : null,
    revalidationRows.length > 0
      ? `${revalidationRows.length} note(s) queued for revalidation.`
      : null,
    trajectoryUpdates > 0
      ? `${trajectoryUpdates} user model trajectory update(s).`
      : null,
    codeRefsChecked > 0
      ? `code_refs verified: ${codeRefsChecked} refs across notes; ${codeRefsBroken} broken (missing files).`
      : null,
  ]
    .filter(Boolean)
    .join(" ");

  return {
    signals_decayed: totalDecayed,
    duplicates_found: totalMerged,
    duplicates_merged: totalMerged,
    orphan_notes: orphanCount,
    autonomy_scores: autonomyScores,
    revalidation_queue: revalidationRows,
    trajectory_updates: trajectoryUpdates,
    code_refs_checked: codeRefsChecked,
    code_refs_broken: codeRefsBroken,
    message,
  };
}
