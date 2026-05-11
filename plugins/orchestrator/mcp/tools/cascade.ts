import type { Database } from "bun:sqlite";

/**
 * Cascade-resolution helper. When a note is closed/superseded/marked-done,
 * propagate the consequences through the graph:
 *
 *   1. Unblock work_items that this note was blocking (only when no OTHER
 *      blockers remain).
 *   2. Auto-complete parent items when all part_of children are done.
 *   3. Auto-resolve notes superseded BY this note.
 *
 * Returns a list of human-readable action strings describing what cascaded,
 * suitable for embedding in the calling tool's response message. Callers
 * that don't need the action list (e.g. the resolution: close_existing path
 * in remember.ts) can simply discard the return value.
 *
 * Lives in its own file to keep both `close_thread` / `update_work_item`
 * (called from server.ts) and `handleRemember`'s close_existing path
 * (called from remember.ts) using the SAME implementation without a
 * module-level circular dependency.
 */
export function cascadeResolution(
  db: Database,
  noteId: string,
  timestamp: string
): string[] {
  const results: string[] = [];

  // 1. Unblock items that this note was blocking
  const blockedItems = db
    .query(
      `SELECT DISTINCT n.id, n.type, n.status FROM links l
       JOIN notes n ON (
         (l.from_note_id = ? AND l.to_note_id = n.id) OR
         (l.to_note_id = ? AND l.from_note_id = n.id)
       )
       WHERE l.relationship = 'blocks' AND n.id != ? AND n.resolved = 0`
    )
    .all(noteId, noteId, noteId) as Array<{
      id: string;
      type: string;
      status: string | null;
    }>;

  for (const blocked of blockedItems) {
    const otherBlockers = db
      .query(
        `SELECT COUNT(*) as cnt FROM links l
         JOIN notes n ON (
           (l.from_note_id = n.id AND l.to_note_id = ?) OR
           (l.to_note_id = n.id AND l.from_note_id = ?)
         )
         WHERE l.relationship = 'blocks' AND n.id != ? AND n.resolved = 0`
      )
      .get(blocked.id, blocked.id, noteId) as { cnt: number };

    if (
      otherBlockers.cnt === 0 &&
      blocked.type === "work_item" &&
      blocked.status === "blocked"
    ) {
      db.run(
        `UPDATE notes SET status = 'planned', updated_at = ? WHERE id = ?`,
        [timestamp, blocked.id]
      );
      results.push(`Unblocked "${blocked.id}"`);
    }
  }

  // 2. Auto-complete parent if all children done
  const parentLinks = db
    .query(
      `SELECT l.to_note_id FROM links l WHERE l.from_note_id = ? AND l.relationship = 'part_of'`
    )
    .all(noteId) as Array<{ to_note_id: string }>;

  for (const parentLink of parentLinks) {
    const unresolvedSiblings = db
      .query(
        `SELECT COUNT(*) as cnt FROM links l
         JOIN notes n ON l.from_note_id = n.id
         WHERE l.to_note_id = ? AND l.relationship = 'part_of'
         AND n.id != ? AND (n.resolved = 0 OR (n.type = 'work_item' AND n.status != 'done'))`
      )
      .get(parentLink.to_note_id, noteId) as { cnt: number };

    if (unresolvedSiblings.cnt === 0) {
      const parent = db
        .query(`SELECT id, type, status FROM notes WHERE id = ?`)
        .get(parentLink.to_note_id) as {
          id: string;
          type: string;
          status: string | null;
        } | null;

      if (parent && parent.status !== "done") {
        if (parent.type === "work_item") {
          db.run(
            `UPDATE notes SET resolved = 1, status = 'done', updated_at = ? WHERE id = ?`,
            [timestamp, parent.id]
          );
        } else {
          db.run(
            `UPDATE notes SET resolved = 1, updated_at = ? WHERE id = ?`,
            [timestamp, parent.id]
          );
        }
        results.push(
          `Auto-completed parent "${parent.id}" (all children done)`
        );
      }
    }
  }

  // 3. Auto-resolve superseded notes
  const superseded = db
    .query(
      `SELECT n.id FROM links l
       JOIN notes n ON l.to_note_id = n.id
       WHERE l.from_note_id = ? AND l.relationship = 'supersedes' AND n.resolved = 0`
    )
    .all(noteId) as Array<{ id: string }>;

  for (const sup of superseded) {
    db.run(`UPDATE notes SET resolved = 1, updated_at = ? WHERE id = ?`, [
      timestamp,
      sup.id,
    ]);
    results.push(`Auto-resolved superseded "${sup.id}"`);
  }

  return results;
}
