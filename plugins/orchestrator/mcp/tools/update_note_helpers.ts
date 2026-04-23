import type { Database } from "bun:sqlite";
import { now, extractKeywords, generateId } from "../utils";

export interface AppendResult {
  appended: boolean;
  message: string;
}

export function appendToNoteContent(
  db: Database,
  id: string,
  appendContent: string
): AppendResult {
  const row = db.query("SELECT content FROM notes WHERE id = ?").get(id) as { content: string } | null;
  if (!row) {
    return { appended: false, message: `No note found with id "${id}".` };
  }
  const timestamp = now();
  const newContent = `${row.content}\n\n--- ${timestamp} ---\n${appendContent}`;
  const newKeywords = extractKeywords(newContent).join(",");
  db.run(
    `UPDATE notes SET content = ?, keywords = ?, updated_at = ? WHERE id = ?`,
    [newContent, newKeywords, timestamp, id]
  );
  return { appended: true, message: `Appended to note "${id}".` };
}

export function snapshotRevision(
  db: Database,
  noteId: string,
  sessionId?: string | null
): string | null {
  const row = db.query(
    `SELECT content, context, tags, keywords, confidence FROM notes WHERE id = ?`
  ).get(noteId) as { content: string; context: string | null; tags: string | null; keywords: string | null; confidence: string | null } | null;
  if (!row) return null;

  const revisionId = generateId();
  const timestamp = now();
  db.run(
    `INSERT INTO note_revisions (id, note_id, content, context, tags, keywords, confidence, revised_at, revised_by_session)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [revisionId, noteId, row.content, row.context, row.tags, row.keywords, row.confidence, timestamp, sessionId ?? null]
  );
  return revisionId;
}
