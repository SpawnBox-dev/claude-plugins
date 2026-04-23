import type { Database } from "bun:sqlite";
import { now } from "../utils";

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
  db.run(
    `UPDATE notes SET content = ?, updated_at = ? WHERE id = ?`,
    [newContent, timestamp, id]
  );
  return { appended: true, message: `Appended to note "${id}".` };
}
