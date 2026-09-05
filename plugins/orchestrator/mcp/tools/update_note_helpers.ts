import type { Database } from "bun:sqlite";
import { now, extractKeywords, generateId } from "../utils";
import type { EmbeddingClient } from "../engine/embeddings";

export interface AppendResult {
  appended: boolean;
  message: string;
  /**
   * The in-flight embedding refresh, when a client was supplied. Exposed so
   * callers (and tests) can await it; production call sites deliberately do
   * not, matching the fire-and-forget shape used elsewhere.
   */
  embedding?: Promise<boolean>;
}

/**
 * Re-embed a note after its content changed. THE single choke point for that
 * guarantee - route every content mutation through here.
 *
 * 0.44.0: four separate write paths used to mutate content and leave the
 * vector alone, so the text was FTS-findable and invisible to semantic search
 * (insights 44d445bb, 1ad2c09d). The bias was directional and flattering: the
 * most-maintained notes read emptiest to concept search, because maintenance
 * means appends. 715 of 7083 notes were measurably affected.
 *
 * On failure the stale vector is REMOVED rather than retained. A vector that
 * no longer matches its text is worse than no vector at all, because backfill
 * can repair a missing one - and, since 0.44.0, a stale one too.
 */
export function refreshNoteEmbedding(
  db: Database,
  id: string,
  content: string,
  embeddingClient?: EmbeddingClient | null
): Promise<boolean> | undefined {
  if (!embeddingClient) return undefined;
  // Best-effort by contract: a refresh must NEVER break the content write that
  // triggered it. Callers are duck-typed in places (tests and older call sites
  // pass a partial `{ embed }` object), so a missing method would otherwise
  // throw SYNCHRONOUSLY - before any promise exists, which means .catch()
  // cannot see it and the whole note write fails. Guard the shape, and wrap
  // the call so a sync throw degrades to "no embedding" like every other
  // failure mode in EmbeddingClient.
  if (typeof (embeddingClient as Partial<EmbeddingClient>).embedIfAvailable !== "function") {
    return undefined;
  }
  try {
    return embeddingClient.embedIfAvailable(db, id, content).catch(() => {
      try {
        embeddingClient.removeEmbedding(db, id);
      } catch {
        /* removal is itself best-effort */
      }
      return false;
    });
  } catch {
    return undefined;
  }
}

/**
 * `sessionId` stamps WHO appended, in a guaranteed format, alongside WHEN.
 *
 * WHY NOT snapshotRevision HERE, WHICH IS THE OBVIOUS MOVE AND WAS PROPOSED:
 * `note_revisions` stores the FULL prior body per row, and appends are the
 * dominant write. Measured 2026-09-05 on this KB: 7,802 append events across
 * 1,792 notes, against 1,115 revision rows total - appends outnumber snapshotted
 * rewrites 7 to 1. Snapshotting each one costs an upper bound of 349 MB on a
 * 776 MB database, and the cost is QUADRATIC in appends per note: `b2bdd253`
 * alone (279 appends, 328 KB body) would hold ~87 MB of near-identical copies.
 * A full-body snapshot also cannot say WHICH text was appended - you would have
 * to diff consecutive rows to recover the delta the caller already had in hand.
 *
 * So the author goes in the marker: no schema change, no storage growth, and
 * "who said this, when" becomes machine-readable rather than prose. A
 * delta-shaped events table is the better long-term home (it stores the
 * appendContent itself, not a copy of everything before it) and is scoped on
 * work item fe3ec978 pending a schema ruling - this is the cheap half that
 * needs no migration.
 *
 * The marker keeps the timestamp FIRST so the existing assertion
 * (/\n\n--- \d{4}-\d{2}-\d{2}T/) still holds, and omits the author segment
 * entirely when no session is known rather than emitting a placeholder.
 */
export function appendToNoteContent(
  db: Database,
  id: string,
  appendContent: string,
  embeddingClient?: EmbeddingClient | null,
  sessionId?: string | null
): AppendResult {
  const row = db.query("SELECT content FROM notes WHERE id = ?").get(id) as { content: string } | null;
  if (!row) {
    return { appended: false, message: `No note found with id "${id}".` };
  }
  const timestamp = now();
  const who = sessionId ? ` · session ${sessionId.slice(0, 8)}` : "";
  const newContent = `${row.content}\n\n--- ${timestamp}${who} ---\n${appendContent}`;
  const newKeywords = extractKeywords(newContent).join(",");
  db.run(
    `UPDATE notes SET content = ?, keywords = ?, updated_at = ? WHERE id = ?`,
    [newContent, newKeywords, timestamp, id]
  );
  // Embed the FULL post-append body, not the delta: the vector has to cover
  // what the note now says, or the appended text stays invisible.
  const embedding = refreshNoteEmbedding(db, id, newContent, embeddingClient);
  return { appended: true, message: `Appended to note "${id}".`, embedding };
}

export function snapshotRevision(
  db: Database,
  noteId: string,
  sessionId?: string | null
): string | null {
  // R5.2 Important-1: capture code_refs along with the rest of the pre-change
  // state. Previously code_refs-only updates silently lost their prior value
  // from revision history.
  const row = db.query(
    `SELECT content, context, tags, keywords, confidence, code_refs FROM notes WHERE id = ?`
  ).get(noteId) as { content: string; context: string | null; tags: string | null; keywords: string | null; confidence: string | null; code_refs: string | null } | null;
  if (!row) return null;

  const revisionId = generateId();
  const timestamp = now();
  db.run(
    `INSERT INTO note_revisions (id, note_id, content, context, tags, keywords, confidence, code_refs, revised_at, revised_by_session)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [revisionId, noteId, row.content, row.context, row.tags, row.keywords, row.confidence, row.code_refs, timestamp, sessionId ?? null]
  );
  return revisionId;
}
