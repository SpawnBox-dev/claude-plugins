import type { Database } from "bun:sqlite";
import { generateId, now } from "../utils";

export interface SessionRegistryRow {
  session_id: string;
  started_at: string;
  last_active_at: string;
  current_task: string | null;
  agent_model: string | null;
  notes_surfaced: number;
  compaction_count: number;
  concierge_agent_id: string | null;
  last_briefing_at: string | null;
}

export interface SessionAnnotation {
  already_sent: boolean;
  sent_turns_ago: number | null;
  sent_to_other_sessions: Array<{ session_id: string; turn: number }>;
  /** Count of distinct OTHER sessions that surfaced this note in the last
   *  2 hours. Use to render a "🔥 hot" badge. Subset of sent_to_other_sessions
   *  which has a 7-day window. */
  hot_across_sessions: number;
  activation_score: number;
}

/** Summary of a note created by another session since the caller's last briefing. */
export interface CrossSessionNewNote {
  id: string;
  type: string;
  content: string;
  tags: string | null;
  created_at: string;
  source_session: string;
}

/** A note that other active sessions have been surfacing heavily recently. */
export interface CrossSessionHotNote {
  id: string;
  type: string;
  content: string;
  tags: string | null;
  distinct_sessions: number;
  surfacings: number;
}

export interface CrossSessionUpdates {
  new_notes: CrossSessionNewNote[];
  hot_notes: CrossSessionHotNote[];
  active_session_count: number;
  since: string | null;
}

export class SessionTracker {
  private turnCounters = new Map<string, number>();

  constructor(private db: Database) {}

  /** Get and increment per-session turn counter (in-memory). */
  nextTurn(sessionId: string): number {
    const current = this.turnCounters.get(sessionId) ?? 0;
    const next = current + 1;
    this.turnCounters.set(sessionId, next);
    return next;
  }

  /** Get the current turn number for a session without incrementing. */
  getCurrentTurn(sessionId: string): number {
    return this.turnCounters.get(sessionId) ?? 0;
  }

  /** Register a session (INSERT OR IGNORE) and update last_active_at. */
  registerSession(sessionId: string, model?: string): void {
    const timestamp = now();
    this.db.run(
      `INSERT OR IGNORE INTO session_registry
       (session_id, started_at, last_active_at, agent_model, notes_surfaced, compaction_count, last_briefing_at)
       VALUES (?, ?, ?, ?, 0, 0, NULL)`,
      [sessionId, timestamp, timestamp, model ?? null]
    );
    this.db.run(
      `UPDATE session_registry SET last_active_at = ? WHERE session_id = ?`,
      [timestamp, sessionId]
    );
  }

  /** Retrieve a session row, or null if not found. */
  getSession(sessionId: string): SessionRegistryRow | null {
    return (
      this.db
        .query(`SELECT * FROM session_registry WHERE session_id = ?`)
        .get(sessionId) as SessionRegistryRow | null
    );
  }

  /**
   * Log that a note was surfaced in a session.
   * Inserts into session_log and increments the session's notes_surfaced counter.
   */
  logSurfaced(
    sessionId: string,
    noteId: string,
    turnNumber: number,
    deliveryType: "fresh" | "refresh" | "reference"
  ): void {
    const id = generateId();
    const timestamp = now();
    this.db.run(
      `INSERT INTO session_log (id, session_id, note_id, surfaced_at, turn_number, delivery_type)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [id, sessionId, noteId, timestamp, turnNumber, deliveryType]
    );
    this.db.run(
      `UPDATE session_registry SET notes_surfaced = notes_surfaced + 1 WHERE session_id = ?`,
      [sessionId]
    );
  }

  /**
   * Returns a map of noteId -> {turn, type} for the most recent delivery per note.
   * ORDER BY turn_number DESC so first entry per noteId wins.
   */
  getNotesSurfaced(
    sessionId: string
  ): Map<string, { turn: number; type: string }> {
    const rows = this.db
      .query(
        `SELECT note_id, turn_number, delivery_type
         FROM session_log
         WHERE session_id = ?
         ORDER BY turn_number DESC`
      )
      .all(sessionId) as Array<{
      note_id: string;
      turn_number: number;
      delivery_type: string;
    }>;

    const result = new Map<string, { turn: number; type: string }>();
    for (const row of rows) {
      // First entry per noteId wins (most recent delivery)
      if (!result.has(row.note_id)) {
        result.set(row.note_id, {
          turn: row.turn_number,
          type: row.delivery_type,
        });
      }
    }
    return result;
  }

  /**
   * Annotate a note result with session awareness:
   * - already_sent: whether this note was previously surfaced in this session
   * - sent_turns_ago: how many turns ago it was last sent (null if never)
   * - sent_to_other_sessions: other sessions that surfaced this note in the last 7 days
   * - activation_score: from notes.signal (pheromone signal strength)
   */
  annotateResult(
    sessionId: string,
    noteId: string,
    currentTurn: number
  ): SessionAnnotation {
    // Check if note was surfaced in this session
    const selfRow = this.db
      .query(
        `SELECT turn_number FROM session_log
         WHERE session_id = ? AND note_id = ?
         ORDER BY turn_number DESC LIMIT 1`
      )
      .get(sessionId, noteId) as { turn_number: number } | null;

    const already_sent = selfRow !== null;
    const sent_turns_ago = selfRow !== null ? currentTurn - selfRow.turn_number : null;

    // Check cross-session: other sessions that surfaced this note in last 7 days
    const sevenDaysAgo = new Date(
      Date.now() - 7 * 24 * 60 * 60 * 1000
    ).toISOString();

    const crossRows = this.db
      .query(
        `SELECT session_id, turn_number FROM session_log
         WHERE note_id = ? AND session_id != ? AND surfaced_at > ?
         ORDER BY surfaced_at DESC`
      )
      .all(noteId, sessionId, sevenDaysAgo) as Array<{
      session_id: string;
      turn_number: number;
    }>;

    const sent_to_other_sessions = crossRows.map((r) => ({
      session_id: r.session_id,
      turn: r.turn_number,
    }));

    // Hot count: distinct OTHER sessions that surfaced this note in last 2h
    const twoHoursAgo = new Date(
      Date.now() - 2 * 60 * 60 * 1000
    ).toISOString();
    const hotRow = this.db
      .query(
        `SELECT COUNT(DISTINCT session_id) as cnt FROM session_log
         WHERE note_id = ? AND session_id != ? AND surfaced_at > ?`
      )
      .get(noteId, sessionId, twoHoursAgo) as { cnt: number } | null;
    const hot_across_sessions = hotRow?.cnt ?? 0;

    // Get activation_score from notes.signal (pheromone strength)
    const noteRow = this.db
      .query(`SELECT signal FROM notes WHERE id = ?`)
      .get(noteId) as { signal: number } | null;

    const activation_score = noteRow?.signal ?? 0;

    return {
      already_sent,
      sent_turns_ago,
      sent_to_other_sessions,
      hot_across_sessions,
      activation_score,
    };
  }

  /** Update the current_task for a session. */
  updateCurrentTask(sessionId: string, task: string): void {
    this.db.run(
      `UPDATE session_registry SET current_task = ?, last_active_at = ? WHERE session_id = ?`,
      [task, now(), sessionId]
    );
  }

  /**
   * Returns sibling sessions active within the last 24 hours, with their
   * current_task. Used by the hook surface to inject one-line activity
   * awareness when present. Capped at 5 to keep additionalContext tight.
   */
  getActiveSiblings(sessionId: string): Array<{
    session_id: string;
    current_task: string | null;
    last_active_at: string;
  }> {
    const twentyFourHoursAgo = new Date(
      Date.now() - 24 * 60 * 60 * 1000
    ).toISOString();
    return this.db
      .query(
        `SELECT session_id, current_task, last_active_at FROM session_registry
         WHERE session_id != ? AND last_active_at > ?
         ORDER BY last_active_at DESC
         LIMIT 5`
      )
      .all(sessionId, twentyFourHoursAgo) as Array<{
        session_id: string;
        current_task: string | null;
        last_active_at: string;
      }>;
  }

  /**
   * Update a session's last_briefing_at cursor. Called at the end of
   * handleOrient so the NEXT briefing can compute "new since last briefing"
   * against a stable cursor.
   *
   * IMPORTANT: accepts an explicit `at` timestamp so the caller can pass
   * the SAME value it used as the upper bound in getCrossSessionUpdates.
   * Without this, there is a read/write race: between read and write, a
   * sibling session could insert notes whose created_at falls in
   * (read_cursor, write_cursor]. The cursor jumps past them and they are
   * silently skipped on the next briefing. Passing the same timestamp for
   * both operations closes the window.
   */
  updateLastBriefing(sessionId: string, at?: string): void {
    const ts = at ?? now();
    this.db.run(
      `UPDATE session_registry SET last_briefing_at = ?, last_active_at = ? WHERE session_id = ?`,
      [ts, ts, sessionId]
    );
  }

  /**
   * Fetch cross-session updates for a session: notes other active sessions
   * have created since this session's last briefing, plus notes that other
   * active sessions have been surfacing heavily in the last 2 hours.
   *
   * "Active session" = last_active_at within the past 24 hours and not the
   * caller's own session. If no last_briefing_at cursor exists, we fall
   * back to started_at so the first briefing still shows recent activity.
   */
  /**
   * Fetch cross-session updates for `sessionId`.
   *
   * `upperBound` (optional) caps the "since this moment" lookup so the
   * caller can also pass the SAME value to updateLastBriefing() and avoid
   * the read/write cursor race. If omitted, the query has no upper bound
   * and behaves as "everything since last briefing, through right now".
   */
  getCrossSessionUpdates(
    sessionId: string,
    upperBound?: string
  ): CrossSessionUpdates {
    const me = this.getSession(sessionId);
    const twentyFourHoursAgo = new Date(
      Date.now() - 24 * 60 * 60 * 1000
    ).toISOString();
    // On first briefing (no cursor yet), look back 24h so a freshly started
    // session catches up on what sibling sessions have been doing. Subsequent
    // briefings use the persisted cursor from the previous call.
    const since = me?.last_briefing_at ?? twentyFourHoursAgo;

    // Count other active sessions (excluding self) for context
    const activeCount = (
      this.db
        .query(
          `SELECT COUNT(*) as cnt FROM session_registry
           WHERE session_id != ? AND last_active_at > ?`
        )
        .get(sessionId, twentyFourHoursAgo) as { cnt: number }
    ).cnt;

    // Notes created by other active sessions since the caller's last briefing.
    // Exclude notes the caller has already surfaced this session (via
    // session_log) to avoid repeating things they've already seen. If the
    // caller passed an upperBound, cap the query so updateLastBriefing can
    // advance the cursor to that exact moment without losing notes created
    // in the gap between read and write.
    const upperClause = upperBound ? "AND n.created_at <= ?" : "";
    const newNotesParams = upperBound
      ? [sessionId, since, upperBound, twentyFourHoursAgo, sessionId]
      : [sessionId, since, twentyFourHoursAgo, sessionId];

    const newNotesRows = this.db
      .query(
        `SELECT n.id, n.type, n.content, n.tags, n.created_at, n.source_session
         FROM notes n
         WHERE n.source_session IS NOT NULL
           AND n.source_session != ?
           AND n.created_at > ?
           ${upperClause}
           AND EXISTS (
             SELECT 1 FROM session_registry sr
             WHERE sr.session_id = n.source_session
               AND sr.last_active_at > ?
           )
           AND n.id NOT IN (
             SELECT note_id FROM session_log WHERE session_id = ?
           )
         ORDER BY n.created_at DESC
         LIMIT 8`
      )
      .all(...newNotesParams) as Array<{
      id: string;
      type: string;
      content: string;
      tags: string | null;
      created_at: string;
      source_session: string;
    }>;

    // Hot notes: union of two signals over the last 2 hours:
    //   (read-side) 2+ OTHER active sessions surfaced the note via session_log
    //   (creation-side) another active session CREATED the note
    // Creation-side matters because a fresh decision/insight that hasn't yet
    // been re-surfaced should still be "hot" on sibling sessions' screens.
    const twoHoursAgo = new Date(
      Date.now() - 2 * 60 * 60 * 1000
    ).toISOString();

    const readHotRows = this.db
      .query(
        `SELECT n.id, n.type, n.content, n.tags,
                COUNT(DISTINCT sl.session_id) as distinct_sessions,
                COUNT(*) as surfacings
         FROM session_log sl
         JOIN notes n ON n.id = sl.note_id
         WHERE sl.surfaced_at > ?
           AND sl.session_id != ?
         GROUP BY n.id
         HAVING distinct_sessions >= 2
         ORDER BY distinct_sessions DESC, surfacings DESC
         LIMIT 8`
      )
      .all(twoHoursAgo, sessionId) as Array<{
      id: string;
      type: string;
      content: string;
      tags: string | null;
      distinct_sessions: number;
      surfacings: number;
    }>;

    const createHotRows = this.db
      .query(
        `SELECT n.id, n.type, n.content, n.tags, n.source_session
         FROM notes n
         WHERE n.source_session IS NOT NULL
           AND n.source_session != ?
           AND n.created_at > ?
           AND EXISTS (
             SELECT 1 FROM session_registry sr
             WHERE sr.session_id = n.source_session
               AND sr.last_active_at > ?
           )
           AND n.id NOT IN (
             SELECT note_id FROM session_log WHERE session_id = ?
           )
         ORDER BY n.created_at DESC
         LIMIT 8`
      )
      .all(sessionId, twoHoursAgo, twentyFourHoursAgo, sessionId) as Array<{
      id: string;
      type: string;
      content: string;
      tags: string | null;
      source_session: string;
    }>;

    // Union and dedupe by id. Read-side wins on collision because it carries
    // the distinct_sessions/surfacings metadata that creation-side lacks.
    const seen = new Set<string>();
    const hotNotesRows: CrossSessionHotNote[] = [];
    for (const r of readHotRows) {
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      hotNotesRows.push(r);
    }
    for (const r of createHotRows) {
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      // Creation-side placeholder metadata: 1 distinct session (the author),
      // 1 "surfacing" (the creation event itself).
      hotNotesRows.push({
        id: r.id,
        type: r.type,
        content: r.content,
        tags: r.tags,
        distinct_sessions: 1,
        surfacings: 1,
      });
    }
    // Cap at 8 total across both signals.
    const cappedHot = hotNotesRows.slice(0, 8);

    return {
      new_notes: newNotesRows,
      hot_notes: cappedHot,
      active_session_count: activeCount,
      since,
    };
  }

  /** Set the concierge agent ID for a session. */
  setConciergeAgentId(sessionId: string, agentId: string): void {
    this.db.run(
      `UPDATE session_registry SET concierge_agent_id = ? WHERE session_id = ?`,
      [agentId, sessionId]
    );
  }

  /** Get the concierge agent ID for a session, or null if not set. */
  getConciergeAgentId(sessionId: string): string | null {
    const row = this.db
      .query(
        `SELECT concierge_agent_id FROM session_registry WHERE session_id = ?`
      )
      .get(sessionId) as { concierge_agent_id: string | null } | null;

    return row?.concierge_agent_id ?? null;
  }

  /**
   * Time-based cleanup:
   * 1. DELETE FROM session_log WHERE surfaced_at < 7 days ago
   * 2. DELETE FROM session_registry WHERE last_active_at < 7 days ago
   */
  cleanup(): void {
    const sevenDaysAgo = new Date(
      Date.now() - 7 * 24 * 60 * 60 * 1000
    ).toISOString();

    this.db.run(`DELETE FROM session_log WHERE surfaced_at < ?`, [
      sevenDaysAgo,
    ]);
    this.db.run(`DELETE FROM session_registry WHERE last_active_at < ?`, [
      sevenDaysAgo,
    ]);
  }
}
