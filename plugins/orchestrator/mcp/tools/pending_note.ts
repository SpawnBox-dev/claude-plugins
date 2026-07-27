import type { Database } from "bun:sqlite";
import { generateId, now } from "../utils";
import type { RememberInput } from "./remember";

/**
 * Pending-note stash for the R4 forced-resolution gate.
 *
 * WHY THIS EXISTS (fleet-solicited 2026-07-27, reported independently by
 * FOUR of five active sessions - PA + SA-5a433456 + SA-df343a05 + SA-b14fafa3):
 *
 * When the near-duplicate gate blocks a write, the caller had to re-transmit
 * the ENTIRE note body verbatim just to append `resolution: {...}`. For a
 * 2,400-char convention that is a full round-trip of pure repetition, and the
 * reporters converged on the same second-order harm: **the cost of a false
 * positive biases agents away from writing the note at all, or - worse -
 * toward the cheapest resolution (`update_existing`), which buries a distinct
 * lesson inside an unrelated note where nobody will find it.** The gate exists
 * to improve the catalog; paying for it in re-transmission made it corrode the
 * catalog instead.
 *
 * The fix keeps the review step (that part works - the candidate list is
 * genuinely useful) and removes the cost: the blocked body is stashed server-
 * side under a short token, and the caller commits with
 * `note({ pending_id, resolution })` alone.
 *
 * Storage is the existing `plugin_state` key/value table - no migration. Keys
 * are prefixed and GC'd on every stash, so this can never become another
 * unbounded state store (the exact trap `.orchestrator-state/` fell into with
 * 269 orphaned marker files).
 */

const PENDING_PREFIX = "pending_note_";

/**
 * How long a blocked body stays claimable. The round-trip this serves is
 * immediate - the agent re-calls within the same turn - so this only has to
 * survive a slow turn, not a session. Deliberately short: an expired stash
 * degrades to today's behavior (re-send the content), which is a correct
 * fallback, whereas a long TTL would accumulate note bodies in plugin_state.
 */
export const PENDING_NOTE_TTL_MS = 60 * 60 * 1000; // 1 hour

/** Fields carried across the gate round-trip. `resolution` is deliberately
 *  NOT stashed - it is what the caller supplies on the second call. */
export type StashedNote = Omit<RememberInput, "resolution" | "pending_id">;

function pendingKey(token: string): string {
  return `${PENDING_PREFIX}${token}`;
}

/**
 * Delete expired stashes. Called on every stash so the table self-bounds
 * without a cron. Cheap: the prefix scan only ever sees pending rows, and
 * there are at most a handful live at once.
 */
export function gcPendingNotes(db: Database, ttlMs = PENDING_NOTE_TTL_MS): number {
  const cutoff = new Date(Date.now() - ttlMs).toISOString();
  const rows = db
    .query(`SELECT key, updated_at FROM plugin_state WHERE key LIKE ?`)
    .all(`${PENDING_PREFIX}%`) as Array<{ key: string; updated_at: string }>;
  let removed = 0;
  for (const r of rows) {
    if (r.updated_at < cutoff) {
      db.run(`DELETE FROM plugin_state WHERE key = ?`, [r.key]);
      removed++;
    }
  }
  return removed;
}

/**
 * Stash a blocked note body and return the short token the caller quotes back.
 * Token is 8 hex chars to match the id8 convention agents already read
 * everywhere else (hook hints, channel events, lookup output).
 */
export function stashPendingNote(db: Database, input: RememberInput): string {
  gcPendingNotes(db);
  const token = generateId().replace(/-/g, "").slice(0, 8);
  const payload: StashedNote = {
    content: input.content,
    type: input.type,
    context: input.context,
    tags: input.tags,
    scope: input.scope,
    dimension: input.dimension,
    session_id: input.session_id,
    code_refs: input.code_refs,
  };
  db.run(
    `INSERT OR REPLACE INTO plugin_state (key, value, updated_at) VALUES (?, ?, ?)`,
    [pendingKey(token), JSON.stringify(payload), now()]
  );
  return token;
}

/**
 * Claim a stashed body. ONE-SHOT: the row is deleted on read, so a token
 * cannot commit twice (a retried tool call after a successful commit gets a
 * clean "not found" and a re-send instruction rather than a duplicate note).
 *
 * Returns null when the token is unknown, expired, or already claimed - the
 * caller turns that into an actionable error, never a silent empty write.
 */
export function takePendingNote(
  db: Database,
  token: string,
  ttlMs = PENDING_NOTE_TTL_MS
): StashedNote | null {
  const key = pendingKey(token.trim());
  const row = db
    .query(`SELECT value, updated_at FROM plugin_state WHERE key = ?`)
    .get(key) as { value: string; updated_at: string } | undefined;
  if (!row) return null;

  db.run(`DELETE FROM plugin_state WHERE key = ?`, [key]);

  const age = Date.now() - new Date(row.updated_at).getTime();
  if (!Number.isFinite(age) || age > ttlMs) return null;

  try {
    const parsed = JSON.parse(row.value) as StashedNote;
    // A stash with no content is corrupt, not usable - treat as a miss so the
    // caller is told to re-send rather than writing an empty note.
    if (!parsed || typeof parsed.content !== "string" || !parsed.content) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}
