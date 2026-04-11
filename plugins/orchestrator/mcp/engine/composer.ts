import type { Database } from "bun:sqlite";
import type { Briefing, BriefingSection, ContextPackage, NoteSummary, UserProfileEntry } from "../types";
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
    tags: row.tags ?? null,
    status: row.status ?? null,
    priority: row.priority ?? null,
    due_date: row.due_date ?? null,
  };
}

/**
 * Compose a session briefing from project and global databases.
 * Optionally filter to specific sections to reduce context cost.
 */
export function composeBriefing(
  projectDb: Database,
  globalDb: Database,
  sections?: BriefingSection[]
): Briefing {
  const include = (section: BriefingSection) =>
    !sections || sections.length === 0 || sections.includes(section);

  // Check if notes table is empty
  const noteCount = (
    projectDb.query("SELECT COUNT(*) as cnt FROM notes").get() as { cnt: number }
  ).cnt;

  if (noteCount === 0) {
    return {
      open_threads: [],
      recent_decisions: [],
      active_work: [],
      blocked_work: [],
      recently_completed: [],
      overdue_work: [],
      neglected_areas: [],
      drift_warning: null,
      user_model_summary: [],
      user_profile: [],
      suggested_focus: null,
      suggested_intensity: "tactical",
      is_first_run: true,
      cross_session: null,
    };
  }

  // Open threads: unresolved open_threads and commitments, last 5
  const openThreads = include("open_threads")
    ? projectDb
        .query(
          `SELECT id, type, content, confidence, created_at, keywords, tags, due_date
           FROM notes
           WHERE type IN ('open_thread', 'commitment') AND resolved = 0
           ORDER BY updated_at DESC
           LIMIT 5`
        )
        .all()
        .map(toSummary)
    : [];

  // Recent decisions: last 5
  const recentDecisions = include("decisions")
    ? projectDb
        .query(
          `SELECT id, type, content, confidence, created_at, keywords, tags, due_date
           FROM notes
           WHERE type = 'decision'
           ORDER BY created_at DESC
           LIMIT 5`
        )
        .all()
        .map(toSummary)
    : [];

  // Neglected areas: tags with notes but none updated in 7+ days
  let neglectedAreas: string[] = [];
  if (include("neglected")) {
    const sevenDaysAgo = new Date(
      Date.now() - 7 * 24 * 60 * 60 * 1000
    ).toISOString();

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
  }

  // Drift detection: if 80%+ of last 10 notes share the same top tag
  let driftWarning: string | null = null;
  if (include("drift")) {
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
  }

  // User model summary + structured profile
  const userModelSummary: string[] = [];
  let userProfile: UserProfileEntry[] = [];
  if (include("user_model")) {
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

      // Structured user profile - all entries
      const profileRows = globalDb
        .query(
          `SELECT dimension, observation, confidence, trajectory,
                  (SELECT COUNT(*) FROM user_model um2 WHERE um2.dimension = user_model.dimension) as evidence_count
           FROM user_model
           ORDER BY
             CASE confidence WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END,
             updated_at DESC`
        )
        .all() as Array<{
        dimension: string;
        observation: string;
        confidence: string;
        trajectory: string;
        evidence_count: number;
      }>;

      userProfile = profileRows.map((r) => ({
        dimension: r.dimension as UserProfileEntry["dimension"],
        observation: r.observation,
        confidence: r.confidence as UserProfileEntry["confidence"],
        trajectory: r.trajectory as UserProfileEntry["trajectory"],
        evidence_count: r.evidence_count,
      }));
    } catch {
      // user_model table may not exist in project DB
    }
  }

  // Active work items: status = active or planned, ordered by priority
  let activeWork: NoteSummary[] = [];
  let blockedWork: NoteSummary[] = [];
  let recentlyCompleted: NoteSummary[] = [];
  let overdueWork: NoteSummary[] = [];

  if (include("work_items")) {
    activeWork = projectDb
      .query(
        `SELECT id, type, content, confidence, created_at, keywords, tags, status, priority, due_date
         FROM notes
         WHERE type = 'work_item' AND status IN ('active', 'planned')
         ORDER BY
           CASE priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END,
           updated_at DESC
         LIMIT 10`
      )
      .all()
      .map(toSummary);

    blockedWork = projectDb
      .query(
        `SELECT id, type, content, confidence, created_at, keywords, tags, status, priority, due_date
         FROM notes
         WHERE type = 'work_item' AND status = 'blocked'
         ORDER BY updated_at DESC
         LIMIT 5`
      )
      .all()
      .map(toSummary);

    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    recentlyCompleted = projectDb
      .query(
        `SELECT id, type, content, confidence, created_at, keywords, tags, status, priority, due_date
         FROM notes
         WHERE type = 'work_item' AND status = 'done' AND updated_at >= ?
         ORDER BY updated_at DESC
         LIMIT 5`
      )
      .all(oneDayAgo)
      .map(toSummary);

    // Overdue work items: due_date is in the past and not done
    const todayStr = new Date().toISOString().slice(0, 10);
    overdueWork = projectDb
      .query(
        `SELECT id, type, content, confidence, created_at, keywords, tags, status, priority, due_date
         FROM notes
         WHERE type = 'work_item' AND due_date IS NOT NULL AND due_date < ?
         AND status != 'done' AND resolved = 0
         ORDER BY due_date ASC
         LIMIT 10`
      )
      .all(todayStr)
      .map(toSummary);
  }

  // Suggested focus: overdue first, then active by priority, then open threads
  const suggestedFocus = overdueWork.length > 0
    ? truncate(overdueWork[0].content, 100)
    : activeWork.length > 0
      ? truncate(activeWork[0].content, 100)
      : openThreads.length > 0
        ? truncate(openThreads[0].content, 100)
        : null;

  // Suggested intensity
  const totalActive = openThreads.length + activeWork.length + overdueWork.length;
  const suggestedIntensity =
    totalActive > 5 ? "strategic" : totalActive > 2 ? "tactical" : "trivial";

  return {
    open_threads: openThreads,
    recent_decisions: recentDecisions,
    active_work: activeWork,
    blocked_work: blockedWork,
    recently_completed: recentlyCompleted,
    overdue_work: overdueWork,
    neglected_areas: neglectedAreas,
    drift_warning: driftWarning,
    user_model_summary: userModelSummary,
    user_profile: userProfile,
    suggested_focus: suggestedFocus,
    suggested_intensity: suggestedIntensity,
    is_first_run: false,
    cross_session: null,
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
        `SELECT id, type, content, confidence, created_at, keywords, tags, due_date
         FROM notes
         WHERE type = ? AND (tags LIKE ? OR keywords LIKE ? OR content LIKE ?)
         ORDER BY
           CASE confidence WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END,
           updated_at DESC
         LIMIT ?`
      )
      .all(type, pattern, pattern, pattern, limit)
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

/**
 * Compose a structured user profile from the global user_model table.
 */
export function composeUserProfile(globalDb: Database): {
  entries: UserProfileEntry[];
  summary: string;
} {
  try {
    const rows = globalDb
      .query(
        `SELECT dimension, observation, confidence, trajectory, evidence,
                created_at, updated_at
         FROM user_model
         ORDER BY dimension,
           CASE confidence WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END,
           updated_at DESC`
      )
      .all() as Array<{
      dimension: string;
      observation: string;
      confidence: string;
      trajectory: string;
      evidence: string;
      created_at: string;
      updated_at: string;
    }>;

    const entries: UserProfileEntry[] = rows.map((r) => ({
      dimension: r.dimension as UserProfileEntry["dimension"],
      observation: r.observation,
      confidence: r.confidence as UserProfileEntry["confidence"],
      trajectory: r.trajectory as UserProfileEntry["trajectory"],
      evidence_count: r.evidence ? r.evidence.split("\n").filter(Boolean).length : 0,
    }));

    // Group by dimension for summary
    const byDimension = new Map<string, UserProfileEntry[]>();
    for (const entry of entries) {
      const existing = byDimension.get(entry.dimension) ?? [];
      existing.push(entry);
      byDimension.set(entry.dimension, existing);
    }

    const summaryLines: string[] = [];
    for (const [dim, dimEntries] of byDimension) {
      const label = dim.replace(/_/g, " ");
      const highConf = dimEntries.filter((e) => e.confidence === "high");
      const items = highConf.length > 0 ? highConf : dimEntries.slice(0, 2);
      for (const item of items) {
        const traj = item.trajectory !== "stable" ? ` (${item.trajectory})` : "";
        summaryLines.push(`**${label}**: ${item.observation}${traj}`);
      }
    }

    return {
      entries,
      summary: summaryLines.length > 0
        ? summaryLines.join("\n")
        : "No user profile data yet. User patterns will be captured as the agent learns preferences.",
    };
  } catch {
    return {
      entries: [],
      summary: "User model table not initialized.",
    };
  }
}
