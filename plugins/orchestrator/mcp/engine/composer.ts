import type { Database } from "bun:sqlite";
import type { Briefing, BriefingSection, ContextPackage, CurationCandidate, NoteSummary, UserProfileEntry } from "../types";
import { truncate, parseCodeRefs, parseTagList, normalizeTagString } from "../utils";

// R3.3: curation candidates thresholds
const STALE_DAYS = 30;
const MIN_SIGNAL_FOR_CURATION = 1.0;
const MAX_CANDIDATES_PER_CATEGORY = 10;

/**
 * R3.3: Fetch notes that look like maintenance targets.
 *   - stale_but_surfaced: updated_at > STALE_DAYS days ago AND signal >= MIN_SIGNAL_FOR_CURATION
 *     (notes being READ but never UPDATED - prime candidates for re-verification)
 *   - low_confidence_but_surfaced: confidence = 'low' AND signal >= MIN_SIGNAL_FOR_CURATION
 *     (notes being cited but never validated)
 *
 * Both categories exclude resolved, superseded, checkpoint, and work_item notes.
 * When a note qualifies for both, the stale reason wins (stronger signal).
 */
function fetchCurationCandidates(db: Database): CurationCandidate[] {
  const staleCutoff = new Date(Date.now() - STALE_DAYS * 24 * 60 * 60 * 1000).toISOString();

  const staleRows = db.query(
    `SELECT id, type, content, confidence, created_at, updated_at, source_session, superseded_by,
            keywords, tags, status, priority, due_date, code_refs, COALESCE(signal, 0) AS note_signal
     FROM notes
     WHERE updated_at < ?
       AND COALESCE(signal, 0) >= ?
       AND resolved = 0
       AND superseded_by IS NULL
       AND type NOT IN ('checkpoint', 'work_item')
     ORDER BY COALESCE(signal, 0) DESC
     LIMIT ?`
  ).all(staleCutoff, MIN_SIGNAL_FOR_CURATION, MAX_CANDIDATES_PER_CATEGORY) as any[];

  const lowConfRows = db.query(
    `SELECT id, type, content, confidence, created_at, updated_at, source_session, superseded_by,
            keywords, tags, status, priority, due_date, code_refs, COALESCE(signal, 0) AS note_signal
     FROM notes
     WHERE confidence = 'low'
       AND COALESCE(signal, 0) >= ?
       AND resolved = 0
       AND superseded_by IS NULL
       AND type NOT IN ('checkpoint', 'work_item')
     ORDER BY COALESCE(signal, 0) DESC
     LIMIT ?`
  ).all(MIN_SIGNAL_FOR_CURATION, MAX_CANDIDATES_PER_CATEGORY) as any[];

  const toCandidate = (row: any, reason: CurationCandidate["reason"]): CurationCandidate => {
    const updatedMs = new Date(row.updated_at).getTime();
    const ageDays = Math.floor((Date.now() - updatedMs) / (24 * 60 * 60 * 1000));
    return {
      note: toSummary(row),
      reason,
      stale_age_days: reason === "stale_but_surfaced" ? ageDays : undefined,
      signal: row.note_signal,
    };
  };

  // De-duplicate by note id - if a note qualifies for both, prefer stale reason (stronger signal)
  const seen = new Set<string>();
  const results: CurationCandidate[] = [];

  for (const row of staleRows) {
    if (!seen.has(row.id)) {
      seen.add(row.id);
      results.push(toCandidate(row, "stale_but_surfaced"));
    }
  }

  for (const row of lowConfRows) {
    if (!seen.has(row.id)) {
      seen.add(row.id);
      results.push(toCandidate(row, "low_confidence_but_surfaced"));
    }
  }

  return results;
}

/** Convert a DB row to a NoteSummary. */
function toSummary(row: any): NoteSummary {
  return {
    id: row.id,
    type: row.type,
    content: row.content,
    confidence: row.confidence,
    created_at: row.created_at,
    updated_at: row.updated_at,
    source_session: row.source_session ?? null,
    superseded_by: row.superseded_by ?? null,
    keywords: row.keywords
      ? row.keywords
          .split(",")
          .map((k: string) => k.trim())
          .filter((k: string) => k.length > 0)
      : [],
    // c658ce38: heal JSON-array-stringified / baked-garbage tags for every
    // display path (decisions, work items, cross-session, curation) - they
    // all render NoteSummary.tags as `{${tags}}`. Clean csv is a no-op here.
    tags: row.tags ? normalizeTagString(row.tags) || null : null,
    status: row.status ?? null,
    priority: row.priority ?? null,
    due_date: row.due_date ?? null,
    code_refs: parseCodeRefs(row.code_refs ?? null),
  };
}

/**
 * Compose a session briefing from project and global databases.
 * Optionally filter to specific sections to reduce context cost.
 */
/** How far ahead the briefing surfaces dated commitments. 30 days is long
 *  enough that a monthly-cadence external deadline (a credit offer, a registry
 *  filing) is seen with time to ACT, and short enough that the section stays
 *  short. */
export const UPCOMING_HORIZON_DAYS = 30;

/** Minimum notes carrying a tag before it counts as an "area" at all. Below
 *  this it is a label someone used once, not a domain that can go dormant.
 *  Measured: 6,823 of 10,292 live tags are used exactly once. */
export const NEGLECTED_MIN_CLUSTER = 10;
/** Retained for tests/consumers that reason about render width. The actual
 *  truncation lives in orient.ts, which pages honestly (count + how to get the
 *  rest); the composer only RANKS. */
export const NEGLECTED_RENDER_CAP = 12;

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
      upcoming_work: [],
      neglected_areas: [],
      drift_warning: null,
      user_model_summary: [],
      user_profile: [],
      suggested_focus: null,
      suggested_intensity: "tactical",
      is_first_run: true,
      cross_session: null,
      curation_candidates: [],
    };
  }

  // Open threads: unresolved open_threads and commitments, last 5.
  // R3.2: signal as secondary sort so hot threads float above cold at the
  // same update time.
  const openThreads = include("open_threads")
    ? projectDb
        .query(
          `SELECT id, type, content, confidence, created_at, updated_at, source_session, superseded_by, keywords, tags, due_date, code_refs
           FROM notes
           WHERE type IN ('open_thread', 'commitment') AND resolved = 0
           ORDER BY COALESCE(signal, 0) DESC, updated_at DESC
           LIMIT 5`
        )
        .all()
        .map(toSummary)
    : [];

  // Recent decisions: last 5.
  // R3.2: signal as secondary sort so hot decisions surface above cold at
  // the same creation time.
  const recentDecisions = include("decisions")
    ? projectDb
        .query(
          `SELECT id, type, content, confidence, created_at, updated_at, source_session, superseded_by, keywords, tags, due_date, code_refs
           FROM notes
           WHERE type = 'decision'
           ORDER BY COALESCE(signal, 0) DESC, created_at DESC
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

    // 0.30.92: SINGLE PASS. This was the briefing timeout.
    //
    // The previous shape was a textbook N+1: build the set of distinct tags,
    // then run ONE `SELECT COUNT(*) ... WHERE tags LIKE '%tag%'` PER TAG. With
    // a leading wildcard no index applies, so each iteration is a full table
    // scan with string matching.
    //
    // MEASURED on the live DB (6,827 notes, 8,888+ distinct tags): this section
    // ALONE exceeds 240s, while work_items / open_threads / decisions are ~0.1s
    // each. That is the >120s `briefing` timeout four of six sessions reported
    // - not corpus size, and not the 61s duplicate merge, which turned out to
    // be a smaller second cost sitting beside this one.
    //
    // Same answer in one pass: read every note's tags and updated_at once, and
    // record the most recent activity per tag as we go. O(notes x tags-per-note)
    // instead of O(distinct-tags x notes).
    //
    // SEMANTIC FIX, deliberate and worth knowing: the old query matched tags by
    // SUBSTRING (`LIKE '%map%'` was satisfied by a note tagged `roadmap`), while
    // the tag SET was built with parseTagList. So a tag could be judged "active"
    // on the strength of an unrelated tag that merely contained it, and would
    // then never be reported as neglected. This uses exact tag equality on both
    // sides, so results are more accurate as well as faster - expect a few tags
    // to newly appear as neglected that substring collisions had been masking.
    const rows = projectDb
      .query(
        `SELECT tags, updated_at, type, status, resolved FROM notes WHERE tags IS NOT NULL AND tags != ''`
      )
      .all() as Array<{
      tags: string;
      updated_at: string;
      type: string;
      status: string | null;
      resolved: number;
    }>;

    // tag -> whether any note carrying it was updated within the window, and
    // how many notes carry it at all.
    const tagRecent = new Map<string, boolean>();
    const tagCount = new Map<string, number>();
    const tagOpen = new Map<string, number>();
    for (const row of rows) {
      const isRecent = (row.updated_at ?? "") >= sevenDaysAgo;
      // Unfinished business carrying this tag: a work item not yet done, or an
      // unresolved thread.
      const isOpen =
        (row.type === "work_item" && !!row.status && row.status !== "done") ||
        (row.type === "open_thread" && row.resolved === 0);
      // c658ce38: parseTagList heals JSON-array-stringified tag values so a
      // bracket/quote artifact never becomes a fake "neglected area".
      for (const tag of parseTagList(row.tags)) {
        tagCount.set(tag, (tagCount.get(tag) ?? 0) + 1);
        if (isOpen) tagOpen.set(tag, (tagOpen.get(tag) ?? 0) + 1);
        if (isRecent) tagRecent.set(tag, true);
        else if (!tagRecent.has(tag)) tagRecent.set(tag, false);
      }
    }

    // 0.31.2: REQUIRE A REAL CLUSTER, and rank by size.
    //
    // This section emitted 9,359 "neglected areas" - output no reader can act
    // on, rendered at every session start. Making it fast (0.30.92, 240s ->
    // 0.07s) did not make it useful; fast garbage is still garbage.
    //
    // MEASURED on the live DB, which is what decided the shape: 10,292 distinct
    // tags across 6,827 notes, and 6,823 of those tags are used EXACTLY ONCE.
    // Two-thirds of "areas" are one-off labels, not groupings - so the list was
    // dominated by singletons that were never a domain in the first place. Tags
    // outnumbering notes means tagging has stopped clustering anything.
    //
    // Requiring a real cluster reduces it to something a person would read:
    // >=10 notes leaves 282 candidates, and the top of that list is genuinely
    // meaningful - preview (139), dns (131), go-live (130), lemon-squeezy (80).
    // THAT answers "what would a reader do differently if this were correct?" -
    // a dormant 131-note domain is worth knowing about; a tag used once is not.
    //
    // Counts are carried in the label because "dns (131 notes)" is actionable
    // while a bare "dns" is not, and it keeps neglected_areas a string[].
    // SECOND AXIS: rank by UNFINISHED BUSINESS, not by size.
    //
    // Size alone still surfaced noise, just less of it. The top clusters by
    // note count were preview (139), dns (131), go-live (130), lemon-squeezy
    // (80) - and three of those are quiet because the work FINISHED or was
    // SUPERSEDED (LS was replaced by Polar; GA shipped; the preview period
    // ended). "Neglected" is the wrong word for a domain that is simply done,
    // and a reader learns to skip a 40-line list as readily as a 9,000-line one.
    //
    // PA proposed filtering on "does the cluster have open work". MEASURED, that
    // binary does NOT separate them: lemon-squeezy still carries 4 open items,
    // go-live 3, preview 6 - retired domains keep stale open items nobody
    // closed. So the filter alone would have kept exactly the entries it was
    // meant to remove.
    //
    // Ranking by OPEN COUNT does work, and demotes them without a special case:
    // ga 37 open, performance 14, area:infrastructure 11, cleanup 10, refactor 9
    // - while lemon-squeezy (4) and go-live (3) fall out of the rendered top 12
    // on their own. Requiring >= 1 open item also drops the 77 fully-finished
    // clusters outright.
    //
    // "ga: 37 open / 79 notes" answers the test - a reader does something
    // differently with that. "go-live" alone was never actionable.
    const ranked = [...tagRecent.entries()]
      .filter(
        ([tag, recent]) =>
          !recent &&
          (tagCount.get(tag) ?? 0) >= NEGLECTED_MIN_CLUSTER &&
          (tagOpen.get(tag) ?? 0) > 0
      )
      .sort((a, b) => (tagOpen.get(b[0]) ?? 0) - (tagOpen.get(a[0]) ?? 0));

    // NOTE: no cap here on purpose. orient.ts already pages this section
    // honestly - explicit withheld count PLUS how to retrieve the rest - and
    // capping in the composer truncated BEFORE that logic ran, which silently
    // dropped the retrieval hint. That is the "never a silent drop" contract
    // the AC(c) test guards, and my first attempt broke it. Rank here, render
    // and page there.
    neglectedAreas = ranked.map(
      ([tag]) => `${tag}: ${tagOpen.get(tag)} open / ${tagCount.get(tag)} notes`
    );
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
        for (const tag of parseTagList(row.tags)) {
          tagFreq.set(tag, (tagFreq.get(tag) ?? 0) + 1);
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
  let upcomingWork: NoteSummary[] = [];

  if (include("work_items")) {
    // R3.2: priority tier remains the primary sort (critical still beats
    // high regardless of signal); signal is the tiebreaker WITHIN a priority
    // tier so hot work items float above cold at the same priority.
    activeWork = projectDb
      .query(
        `SELECT id, type, content, confidence, created_at, updated_at, source_session, superseded_by, keywords, tags, status, priority, due_date, code_refs
         FROM notes
         WHERE type = 'work_item' AND status IN ('active', 'planned')
         ORDER BY
           CASE priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END,
           COALESCE(signal, 0) DESC,
           updated_at DESC
         LIMIT 10`
      )
      .all()
      .map(toSummary);

    // R3.2: hot blocked items surface above cold so repeated attention
    // bubbles stuck work to the top.
    blockedWork = projectDb
      .query(
        `SELECT id, type, content, confidence, created_at, updated_at, source_session, superseded_by, keywords, tags, status, priority, due_date, code_refs
         FROM notes
         WHERE type = 'work_item' AND status = 'blocked'
         ORDER BY COALESCE(signal, 0) DESC, updated_at DESC
         LIMIT 5`
      )
      .all()
      .map(toSummary);

    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    // R3.2: signal as secondary sort so completions that were heavily
    // referenced right before being marked done show up first.
    recentlyCompleted = projectDb
      .query(
        `SELECT id, type, content, confidence, created_at, updated_at, source_session, superseded_by, keywords, tags, status, priority, due_date, code_refs
         FROM notes
         WHERE type = 'work_item' AND status = 'done' AND updated_at >= ?
         ORDER BY COALESCE(signal, 0) DESC, updated_at DESC
         LIMIT 5`
      )
      .all(oneDayAgo)
      .map(toSummary);

    // Overdue work items: due_date is in the past and not done
    const todayStr = new Date().toISOString().slice(0, 10);
    overdueWork = projectDb
      .query(
        `SELECT id, type, content, confidence, created_at, updated_at, source_session, superseded_by, keywords, tags, status, priority, due_date, code_refs
         FROM notes
         WHERE type = 'work_item' AND due_date IS NOT NULL AND due_date < ?
         AND status != 'done' AND resolved = 0
         ORDER BY due_date ASC
         LIMIT 10`
      )
      .all(todayStr)
      .map(toSummary);

    // 0.30.74: UPCOMING dated commitments - due within the horizon, NOT yet
    // due, and deliberately NOT filtered by status.
    //
    // Reported by SA-90bf73bd 2026-07-27 with money attached. Two layers, and
    // you only see the gap with both:
    //   1. A dated item sitting in `planned`/`proposed` is invisible to the
    //      default "what's active?" sweep most agents orient with. Their
    //      CA$600 credit watch is `planned` because that is semantically
    //      HONEST for a watch item - and that honesty is exactly what hid it.
    //   2. OVERDUE fires only AFTER the date passes. For a hard EXTERNAL
    //      deadline that is the one moment the warning is worthless: you
    //      cannot act on a lapsed offer. The concrete risk was a CA$350 credit
    //      expiring silently, after which the item recording it would have
    //      dutifully appeared under OVERDUE.
    //
    // Status and deadlines are ORTHOGONAL concerns; letting status gate the
    // visibility of a date is the defect. Deadlines do not care about
    // workflow state, so neither does this query.
    const horizon = new Date(Date.now() + UPCOMING_HORIZON_DAYS * 86400000)
      .toISOString()
      .slice(0, 10);
    upcomingWork = projectDb
      .query(
        `SELECT id, type, content, confidence, created_at, updated_at, source_session, superseded_by, keywords, tags, status, priority, due_date, code_refs
         FROM notes
         WHERE type = 'work_item' AND due_date IS NOT NULL
         AND due_date >= ? AND due_date <= ?
         AND status != 'done' AND resolved = 0
         ORDER BY due_date ASC
         LIMIT 10`
      )
      .all(todayStr, horizon)
      .map(toSummary);
  }

  // R3.3: curation candidates - maintenance-worthy notes surfaced at briefing time
  const curation_candidates = include("curation_candidates")
    ? fetchCurationCandidates(projectDb)
    : [];

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
    upcoming_work: upcomingWork,
    neglected_areas: neglectedAreas,
    drift_warning: driftWarning,
    user_model_summary: userModelSummary,
    user_profile: userProfile,
    suggested_focus: suggestedFocus,
    suggested_intensity: suggestedIntensity,
    is_first_run: false,
    cross_session: null,
    curation_candidates,
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
        `SELECT id, type, content, confidence, created_at, updated_at, source_session, superseded_by, keywords, tags, due_date, code_refs
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
