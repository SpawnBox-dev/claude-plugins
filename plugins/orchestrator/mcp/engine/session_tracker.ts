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
}

export interface SessionAnnotation {
  already_sent: boolean;
  sent_turns_ago: number | null;
  sent_to_other_sessions: Array<{ session_id: string; turn: number }>;
  activation_score: number;
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
       (session_id, started_at, last_active_at, agent_model, notes_surfaced, compaction_count)
       VALUES (?, ?, ?, ?, 0, 0)`,
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
   * - activation_score: from notes.access_count
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

    // Get activation_score from notes.access_count
    const noteRow = this.db
      .query(`SELECT access_count FROM notes WHERE id = ?`)
      .get(noteId) as { access_count: number } | null;

    const activation_score = noteRow?.access_count ?? 0;

    return {
      already_sent,
      sent_turns_ago,
      sent_to_other_sessions,
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
