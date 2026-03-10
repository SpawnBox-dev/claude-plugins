import type { Database } from "bun:sqlite";
import type { NoteType, Dimension } from "../types";
import { GLOBAL_TYPES, DIMENSIONS } from "../types";
import { generateId, now, extractKeywords } from "../utils";
import { findDuplicates } from "../engine/deduplicator";
import { createAutoLinks } from "../engine/linker";
import { promoteConfidence } from "../engine/scorer";

export interface RememberInput {
  content: string;
  type: NoteType;
  context?: string;
  tags?: string;
  scope?: "global" | "project";
  dimension?: Dimension;
}

export interface RememberResult {
  stored: boolean;
  note_id: string | null;
  duplicate: boolean;
  promoted: boolean;
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

  // Check for duplicates - promote confidence if near-duplicate found
  const duplicates = findDuplicates(db, input.type, input.content);
  if (duplicates.length > 0) {
    const bestMatch = duplicates[0];
    const newConfidence = promoteConfidence(db, bestMatch.id);
    return {
      stored: false,
      note_id: bestMatch.id,
      duplicate: true,
      promoted: true,
      links_created: 0,
      message: `Near-duplicate ${input.type} found - promoted existing note confidence to ${newConfidence}.`,
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
    `INSERT INTO notes (id, type, content, context, keywords, tags, confidence, last_validated, resolved, status, priority, due_date, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      null,
      null,
      null,
      timestamp,
      timestamp,
    ]
  );

  // Create auto-links
  const links = createAutoLinks(db, noteId, keywords);

  // Write to user_model if this is a user_pattern note
  if (input.type === "user_pattern") {
    writeUserModel(globalDb, input.content, input.context, input.dimension);
  }

  return {
    stored: true,
    note_id: noteId,
    duplicate: false,
    promoted: false,
    links_created: links.length,
    message: `Stored ${input.type} note${links.length > 0 ? ` with ${links.length} auto-link(s)` : ""}.`,
  };
}

/**
 * Infer dimension from user_pattern content.
 * Used as fallback when no explicit dimension is provided.
 */
function inferDimension(content: string): Dimension {
  const lower = content.toLowerCase();
  if (/prefer|like|want|style|format|approach|always|never/i.test(lower)) return "preference";
  if (/decide|decision|chose|choose|pick|select|weigh|trade-?off/i.test(lower)) return "decision_pattern";
  if (/communicat|respond|explain|ask|tell|say|verbose|concise|brief/i.test(lower)) return "communication_style";
  if (/strength|good at|excels?|strong|skilled|expert/i.test(lower)) return "strength";
  if (/blind spot|miss|overlook|forget|ignore|weak|struggle/i.test(lower)) return "blind_spot";
  if (/intent|goal|aim|want to|trying to|plan to|vision|aspir/i.test(lower)) return "intent_pattern";
  return "preference";
}

function writeUserModel(
  globalDb: Database,
  content: string,
  context?: string,
  explicitDimension?: Dimension
): void {
  try {
    const dimension = explicitDimension ?? inferDimension(content);
    const timestamp = now();

    // Check if a similar observation exists for this dimension
    // Use fuzzy match: same dimension and content starts the same way
    const existing = globalDb
      .query(
        `SELECT id, evidence, observation FROM user_model WHERE dimension = ? AND observation = ?`
      )
      .get(dimension, content) as { id: string; evidence: string; observation: string } | null;

    if (existing) {
      // Increment evidence and update
      const evidenceList = existing.evidence ? existing.evidence.split("\n").filter(Boolean) : [];
      if (context) evidenceList.push(`[${timestamp}] ${context}`);
      globalDb.run(
        `UPDATE user_model SET evidence = ?, confidence = 'high', updated_at = ? WHERE id = ?`,
        [evidenceList.join("\n"), timestamp, existing.id]
      );
    } else {
      const evidence = context ? `[${timestamp}] ${context}` : "";
      globalDb.run(
        `INSERT INTO user_model (id, dimension, observation, evidence, confidence, trajectory, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          generateId(),
          dimension,
          content,
          evidence,
          "medium",
          "stable",
          timestamp,
          timestamp,
        ]
      );
    }
  } catch {
    // user_model table might not exist
  }
}
