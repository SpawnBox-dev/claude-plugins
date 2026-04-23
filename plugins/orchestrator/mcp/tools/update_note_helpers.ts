import type { Database } from "bun:sqlite";
import { now, extractKeywords } from "../utils";

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
