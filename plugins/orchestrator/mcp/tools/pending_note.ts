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
 * 0.30.78: CONCURRENT-CAPTURE detection - the duplication class the
 * near-duplicate gate is structurally blind to.
 *
 * Observed 2026-07-27: PA broadcast one behavioural rule to @all. Three
 * sessions reacted within ~2 minutes. One captured it; one checked, found the
 * existing note, and correctly declined; the third ran check_similar, FOUND
 * NOTHING, and filed a duplicate. The gate cleared it.
 *
 * WHY THE GATE CANNOT SEE THIS: it compares against EMBEDDED notes, and
 * embedding happens after the row is written. When the third session queried,
 * the earlier note either was not embedded yet or was not indexed. So the gate
 * protects against RE-DERIVING OLD knowledge and is blind to PARALLEL CAPTURE
 * OF NEW knowledge - which is precisely what a fleet-wide broadcast produces.
 * PA's read is that this is the more damaging of the two classes: a false
 * positive costs a round trip, whereas this costs a silently forked truth.
 *
 * This check deliberately uses KEYWORDS, not embeddings, because the notes row
 * is inserted synchronously - so a peer's capture from 90 seconds ago is
 * visible immediately, exactly when the embedding is not.
 *
 * Non-blocking by design: the note is already stored. Losing a capture is
 * worse than carrying a duplicate for a few minutes, and the author is the
 * right party to reconcile - so this surfaces the peer's note and id8 and asks
 * them to merge, rather than rejecting the write.
 */
export const CONCURRENT_WINDOW_MS = 15 * 60 * 1000;

export function findConcurrentCaptures(
  db: Database,
  opts: {
    noteId: string;
    keywords: string[];
    sessionId?: string;
    minShared?: number;
    windowMs?: number;
  }
): Array<{ id: string; type: string; content: string; session: string | null }> {
  const minShared = opts.minShared ?? 3;
  if (opts.keywords.length < minShared) return [];
  const cutoff = new Date(
    Date.now() - (opts.windowMs ?? CONCURRENT_WINDOW_MS)
  ).toISOString();

  // 0.31.4: ARTIFACT CLASS is a free discriminator. Reported by SA-c5b207e0
  // from two live firings: one TRUE positive (PA had folded their correction
  // into a note seconds earlier - they retired theirs to a redirect stub rather
  // than fork the truth), and one FALSE positive that matched PA's CHECKPOINT
  // against their anti_pattern note. Same subject matter, different KIND of
  // artifact.
  //
  // A checkpoint is a session-state snapshot; a note is reusable knowledge.
  // They are never duplicates of each other no matter how much vocabulary they
  // share - and checkpoints are vocabulary-dense by nature (they summarise
  // everything the session touched), so they are the single most likely false
  // match in the window. Excluding the class costs nothing and cannot suppress
  // a real fork.
  const rows = db
    .query(
      `SELECT id, type, content, keywords, source_session
       FROM notes
       WHERE created_at >= ? AND id != ? AND superseded_by IS NULL
         AND type != 'checkpoint'
       ORDER BY created_at DESC
       LIMIT 50`
    )
    .all(cutoff, opts.noteId) as Array<{
    id: string;
    type: string;
    content: string;
    keywords: string | null;
    source_session: string | null;
  }>;

  const mine = new Set(opts.keywords.map((k) => k.toLowerCase()));
  const out: Array<{ id: string; type: string; content: string; session: string | null }> = [];

  for (const r of rows) {
    // A session duplicating ITSELF is a different problem (and usually
    // intentional - a split note). Only peers count here.
    if (opts.sessionId && r.source_session === opts.sessionId) continue;
    const theirs = (r.keywords ?? "")
      .split(",")
      .map((k) => k.trim().toLowerCase())
      .filter(Boolean);
    if (theirs.length === 0) continue;
    let shared = 0;
    const seen = new Set<string>();
    for (const k of theirs) {
      if (mine.has(k) && !seen.has(k)) {
        seen.add(k);
        shared++;
      }
    }
    if (shared >= minShared) {
      out.push({ id: r.id, type: r.type, content: r.content, session: r.source_session });
    }
    if (out.length >= 3) break;
  }
  return out;
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
