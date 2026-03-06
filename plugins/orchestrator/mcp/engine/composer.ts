import type { Database } from "bun:sqlite";
import type { Briefing, ContextPackage, NoteSummary } from "../types";
import { truncate } from "../utils";

/** Convert a DB row to a NoteSummary. */
function toSummary(row: any): NoteSummary {
  return {
    id: row.id,
    type: row.type,
    content: row.content,
    confidence: row.confidence,
    created_at: row.created_at,
    keywords: row.keywords
      ? row.keywords
          .split(",")
          .map((k: string) => k.trim())
          .filter((k: string) => k.length > 0)
      : [],
  };
}

/**
 * Compose a session briefing from project and global databases.
 */
export function composeBriefing(
  projectDb: Database,
  globalDb: Database
): Briefing {
  // Check if notes table is empty
  const noteCount = (
    projectDb.query("SELECT COUNT(*) as cnt FROM notes").get() as { cnt: number }
  ).cnt;

  if (noteCount === 0) {
    return {
      open_threads: [],
      recent_decisions: [],
      neglected_areas: [],
      drift_warning: null,
      user_model_summary: [],
      suggested_focus: null,
      suggested_intensity: "tactical",
      is_first_run: true,
    };
  }

  // Open threads: unresolved open_threads and commitments, last 5
  const openThreads = projectDb
    .query(
      `SELECT id, type, content, confidence, created_at, keywords
       FROM notes
       WHERE type IN ('open_thread', 'commitment') AND resolved = 0
       ORDER BY updated_at DESC
       LIMIT 5`
    )
    .all()
    .map(toSummary);

  // Recent decisions: last 5
  const recentDecisions = projectDb
    .query(
      `SELECT id, type, content, confidence, created_at, keywords
       FROM notes
       WHERE type = 'decision'
       ORDER BY created_at DESC
       LIMIT 5`
    )
    .all()
    .map(toSummary);

  // Neglected areas: tags with notes but none updated in 7+ days
  const sevenDaysAgo = new Date(
    Date.now() - 7 * 24 * 60 * 60 * 1000
  ).toISOString();

  // Get all distinct tags
  const allTagRows = projectDb
    .query(
      `SELECT DISTINCT tags FROM notes WHERE tags IS NOT NULL AND tags != ''`
    )
    .all() as Array<{ tags: string }>;

  const tagSet = new Set<string>();
  for (const row of allTagRows) {
    for (const tag of row.tags.split(",").map((t: string) => t.trim())) {
      if (tag) tagSet.add(tag);
    }
  }

  const neglectedAreas: string[] = [];
  for (const tag of tagSet) {
    const recentCount = (
      projectDb
        .query(
          `SELECT COUNT(*) as cnt FROM notes
           WHERE tags LIKE ? AND updated_at >= ?`
        )
        .get(`%${tag}%`, sevenDaysAgo) as { cnt: number }
    ).cnt;

    if (recentCount === 0) {
      neglectedAreas.push(tag);
    }
  }

  // Drift detection: if 80%+ of last 10 notes share the same top tag
  let driftWarning: string | null = null;
  const recentNotes = projectDb
    .query(
      `SELECT tags FROM notes
       WHERE tags IS NOT NULL AND tags != ''
       ORDER BY created_at DESC
       LIMIT 10`
    )
    .all() as Array<{ tags: string }>;

  if (recentNotes.length >= 5) {
    const tagFreq = new Map<string, number>();
    for (const row of recentNotes) {
      for (const tag of row.tags.split(",").map((t: string) => t.trim())) {
        if (tag) tagFreq.set(tag, (tagFreq.get(tag) ?? 0) + 1);
      }
    }
    const topTag = [...tagFreq.entries()].sort((a, b) => b[1] - a[1])[0];
    if (topTag && topTag[1] / recentNotes.length >= 0.8) {
      driftWarning = `Focus drift detected: ${Math.round((topTag[1] / recentNotes.length) * 100)}% of recent notes are about "${topTag[0]}"`;
    }
  }

  // User model summary: top 3 high-confidence observations from global DB
  const userModelSummary: string[] = [];
  try {
    const observations = globalDb
      .query(
        `SELECT observation FROM user_model
         WHERE confidence = 'high'
         ORDER BY updated_at DESC
         LIMIT 3`
      )
      .all() as Array<{ observation: string }>;
    for (const obs of observations) {
      userModelSummary.push(obs.observation);
    }
  } catch {
    // user_model table may not exist in project DB
  }

  // Suggested focus: first open thread
  const suggestedFocus =
    openThreads.length > 0 ? truncate(openThreads[0].content, 100) : null;

  // Suggested intensity
  const suggestedIntensity =
    openThreads.length > 3 ? "strategic" : "tactical";

  return {
    open_threads: openThreads,
    recent_decisions: recentDecisions,
    neglected_areas: neglectedAreas,
    drift_warning: driftWarning,
    user_model_summary: userModelSummary,
    suggested_focus: suggestedFocus,
    suggested_intensity: suggestedIntensity,
    is_first_run: false,
  };
}

/**
 * Compose a context package for a specific domain, drawing from both databases.
 */
export function composeContextPackage(
  projectDb: Database,
  globalDb: Database,
  domain: string
): ContextPackage {
  const pattern = `%${domain}%`;

  function queryByType(
    db: Database,
    type: string,
    limit = 5
  ): NoteSummary[] {
    return db
      .query(
        `SELECT id, type, content, confidence, created_at, keywords
         FROM notes
         WHERE type = ? AND (tags LIKE ? OR keywords LIKE ?)
         ORDER BY
           CASE confidence WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END,
           updated_at DESC
         LIMIT ?`
      )
      .all(type, pattern, pattern, limit)
      .map((row: any) => ({
        ...toSummary(row),
        content: truncate(row.content, 100),
      }));
  }

  // Query project DB for most categories
  const conventions = queryByType(projectDb, "convention");
  const antiPatterns = queryByType(projectDb, "anti_pattern");
  const qualityGates = queryByType(projectDb, "quality_gate");
  const architecture = queryByType(projectDb, "architecture");
  const constraints = queryByType(projectDb, "dependency");
  const recentDecisions = queryByType(projectDb, "decision");

  // Tool capabilities come from global DB only
  const toolCapabilities = queryByType(globalDb, "tool_capability");

  return {
    conventions,
    tool_capabilities: toolCapabilities,
    anti_patterns: antiPatterns,
    quality_gates: qualityGates,
    architecture,
    constraints,
    recent_decisions: recentDecisions,
  };
}
