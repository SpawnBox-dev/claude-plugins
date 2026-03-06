import type { Database } from "bun:sqlite";
import type { NoteType } from "../types";
import { GLOBAL_TYPES } from "../types";
import { generateId, now, extractKeywords } from "../utils";
import { isDuplicate } from "../engine/deduplicator";
import { createAutoLinks } from "../engine/linker";

export interface RememberInput {
  content: string;
  type: NoteType;
  context?: string;
  tags?: string;
  scope?: "global" | "project";
}

export interface RememberResult {
  stored: boolean;
  note_id: string | null;
  duplicate: boolean;
  links_created: number;
  message: string;
}

export function handleRemember(
  projectDb: Database,
  globalDb: Database,
  input: RememberInput
): RememberResult {
  // Determine which DB to use
  const useGlobal =
    input.scope === "global" || GLOBAL_TYPES.includes(input.type);
  const db = useGlobal ? globalDb : projectDb;

  // Check for duplicates
  if (isDuplicate(db, input.type, input.content)) {
    return {
      stored: false,
      note_id: null,
      duplicate: true,
      links_created: 0,
      message: `Duplicate ${input.type} detected - skipped storage.`,
    };
  }

  // Extract keywords from content + context
  const textForKeywords = [input.content, input.context]
    .filter(Boolean)
    .join(" ");
  const keywords = extractKeywords(textForKeywords);

  // Build tags: always include the type, plus any user-provided tags
  const tagParts: string[] = [input.type];
  if (input.tags) {
    for (const t of input.tags.split(",").map((s) => s.trim())) {
      if (t && !tagParts.includes(t)) tagParts.push(t);
    }
  }
  const tagsStr = tagParts.join(",");

  // Insert the note
  const noteId = generateId();
  const timestamp = now();

  db.run(
    `INSERT INTO notes (id, type, content, context, keywords, tags, confidence, last_validated, resolved, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      noteId,
      input.type,
      input.content,
      input.context ?? null,
      keywords.join(","),
      tagsStr,
      "medium",
      timestamp,
      0,
      timestamp,
      timestamp,
    ]
  );

  // Create auto-links
  const links = createAutoLinks(db, noteId, keywords);

  return {
    stored: true,
    note_id: noteId,
    duplicate: false,
    links_created: links.length,
    message: `Stored ${input.type} note${links.length > 0 ? ` with ${links.length} auto-link(s)` : ""}.`,
  };
}
