import type { Database } from "bun:sqlite";
import type { NoteType, Dimension } from "../types";
import { GLOBAL_TYPES, DIMENSIONS } from "../types";
import { generateId, now, extractKeywords } from "../utils";
import { findDuplicates } from "../engine/deduplicator";
import { createAutoLinks } from "../engine/linker";
import { promoteConfidence } from "../engine/scorer";
import { type EmbeddingClient, blobToVector } from "../engine/embeddings";
import { cosineSimilarity } from "../engine/hybrid_search";
import { handleCheckSimilar } from "./check_similar";
import { truncate } from "../utils";

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

const SIMILARITY_ALERT_TYPES: NoteType[] = ["decision", "convention", "anti_pattern"];
const SIMILARITY_ALERT_THRESHOLD = 0.75;

export async function handleRemember(
  projectDb: Database,
  globalDb: Database,
  input: RememberInput,
  embeddingClient?: EmbeddingClient | null
): Promise<RememberResult> {
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
    `INSERT INTO notes (id, type, content, context, keywords, tags, confidence, resolved, status, priority, due_date, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      noteId,
      input.type,
      input.content,
      input.context ?? null,
      keywords.join(","),
      tagsStr,
      "medium",
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

  // Embed and check for similar prior knowledge
  let similarityAlert = "";
  if (embeddingClient) {
    try {
      const vecs = await embeddingClient.embed([input.content]);
      if (vecs && vecs.length > 0) {
        const queryVector = vecs[0];

        // Store the embedding
        const blob = Buffer.from(queryVector.buffer);
        db.run(
          `INSERT OR REPLACE INTO embeddings (note_id, vector, model, embedded_at)
           VALUES (?, ?, ?, ?)`,
          [noteId, blob, "bge-m3", new Date().toISOString()]
        );

        // Check for similar existing notes (excluding the one we just inserted)
        const similar = handleCheckSimilar(db, queryVector, {
          proposed_action: input.content,
          types: SIMILARITY_ALERT_TYPES,
          threshold: SIMILARITY_ALERT_THRESHOLD,
        });

        // Filter out the note we just inserted
        const relatedNotes = similar.results.filter((r) => r.id !== noteId);

        if (relatedNotes.length > 0) {
          const top = relatedNotes[0];
          similarityAlert = `\n!! RELATED PRIOR KNOWLEDGE: A similar ${top.type} already exists (id: ${top.id}):\n  "${truncate(top.content, 120)}"\n  Review for consistency. Call lookup(id: "${top.id}") for full context.`;
        }
      }
    } catch (err) {
      console.error(`[embed] Failed to embed note ${noteId}:`, err);
    }
  }

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
    message: `Stored ${input.type} note${links.length > 0 ? ` with ${links.length} auto-link(s)` : ""}.${similarityAlert}`,
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
    const inputKeywords = new Set(extractKeywords(content));

    // Find best match in same dimension using Jaccard similarity
    const candidates = globalDb
      .query(
        `SELECT id, observation, evidence FROM user_model WHERE dimension = ?`
      )
      .all(dimension) as Array<{ id: string; observation: string; evidence: string }>;

    let bestMatch: { id: string; observation: string; evidence: string; similarity: number } | null = null;

    for (const candidate of candidates) {
      // Exact match
      if (candidate.observation.trim().toLowerCase() === content.trim().toLowerCase()) {
        bestMatch = { ...candidate, similarity: 1.0 };
        break;
      }

      // Jaccard similarity on keywords
      const candidateKeywords = new Set(extractKeywords(candidate.observation));
      if (inputKeywords.size === 0 && candidateKeywords.size === 0) continue;

      const intersection = new Set(
        [...inputKeywords].filter((k) => candidateKeywords.has(k))
      );
      const union = new Set([...inputKeywords, ...candidateKeywords]);
      const similarity = union.size > 0 ? intersection.size / union.size : 0;

      if (similarity >= 0.5 && (!bestMatch || similarity > bestMatch.similarity)) {
        bestMatch = { ...candidate, similarity };
      }
    }

    if (bestMatch) {
      // Update existing: append evidence, promote confidence, keep the longer/newer observation
      const evidenceList = bestMatch.evidence ? bestMatch.evidence.split("\n").filter(Boolean) : [];
      if (context) evidenceList.push(`[${timestamp}] ${context}`);
      // Keep whichever observation is longer (more detailed)
      const observation = content.length > bestMatch.observation.length ? content : bestMatch.observation;
      globalDb.run(
        `UPDATE user_model SET observation = ?, evidence = ?, confidence = 'high', updated_at = ? WHERE id = ?`,
        [observation, evidenceList.join("\n"), timestamp, bestMatch.id]
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
