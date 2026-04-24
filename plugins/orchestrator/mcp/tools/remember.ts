import type { Database } from "bun:sqlite";
import type { NoteType, Dimension } from "../types";
import { GLOBAL_TYPES, DIMENSIONS } from "../types";
import { generateId, now, extractKeywords } from "../utils";
import { findDuplicates, MIN_SHARED_KEYWORDS } from "../engine/deduplicator";
import { createAutoLinks } from "../engine/linker";
import { promoteConfidence } from "../engine/scorer";
import { type EmbeddingClient } from "../engine/embeddings";
import { handleCheckSimilar } from "./check_similar";
import { truncate } from "../utils";
import { appendToNoteContent } from "./update_note_helpers";

export interface RememberInput {
  content: string;
  type: NoteType;
  context?: string;
  tags?: string;
  scope?: "global" | "project";
  dimension?: Dimension;
  /** Session ID that authored this note. Enables cross-session discovery
   *  injection so sibling sessions can see what this session has created. */
  session_id?: string;
  /** R4: forced-resolution gate. When note() detects near-duplicate candidates
   *  (embedding similarity >= 0.75 for types: decision, convention, anti_pattern),
   *  the write is REJECTED unless the caller supplies an explicit resolution.
   *  Omit when there are no candidates, and the write proceeds normally. */
  resolution?: {
    action: "accept_new" | "update_existing" | "supersede_existing" | "close_existing";
    target_id?: string;
    reason?: string;
  };
}

export interface RememberResult {
  stored: boolean;
  note_id: string | null;
  duplicate: boolean;
  promoted: boolean;
  links_created: number;
  message: string;
  /** R4: true when note() is blocked waiting for the caller to supply a
   *  resolution for the near-duplicate candidates returned. */
  blocked_on_resolution?: boolean;
  /** R4: top candidates returned to the caller when the gate fires. */
  candidates?: Array<{ id: string; type: string; content: string; similarity: number }>;
}

const SIMILARITY_ALERT_TYPES: NoteType[] = ["decision", "convention", "anti_pattern"];
const SIMILARITY_ALERT_THRESHOLD = 0.75;

/**
 * R4.1: Map a cosine similarity score to a rank bucket label. The rank
 * bucket is the PROMINENT visual marker in the gate message so agents
 * can distinguish a 97% match (clearly same knowledge) from a 76% match
 * (adjacent but different) at a glance.
 *
 * - HIGH MATCH     (>= 0.95) - likely the same knowledge
 * - LIKELY RELATED (0.85 - 0.94) - same topic, different angle
 * - ADJACENT       (0.75 - 0.84) - overlapping vocabulary, likely different
 *
 * Below 0.75 the candidate does not surface at all (handleCheckSimilar's
 * threshold filter), so this helper does not define a below-ADJACENT label.
 */
export function bucketLabel(similarity: number): string {
  if (similarity >= 0.95) return "HIGH MATCH";
  if (similarity >= 0.85) return "LIKELY RELATED";
  return "ADJACENT";
}

/**
 * Insert a new note into the given DB and return the new id. Extracted so
 * both the normal path and the R4 resolution paths (supersede_existing,
 * close_existing, accept_new) share identical insert semantics.
 */
async function insertNote(
  db: Database,
  globalDb: Database,
  input: RememberInput,
  embeddingClient?: EmbeddingClient | null
): Promise<{ noteId: string; linksCreated: number }> {
  const textForKeywords = [input.content, input.context]
    .filter(Boolean)
    .join(" ");
  const keywords = extractKeywords(textForKeywords);

  const tagParts: string[] = [input.type];
  if (input.tags) {
    for (const t of input.tags.split(",").map((s) => s.trim())) {
      if (t && !tagParts.includes(t)) tagParts.push(t);
    }
  }
  const tagsStr = tagParts.join(",");

  const noteId = generateId();
  const timestamp = now();

  db.run(
    `INSERT INTO notes (id, type, content, context, keywords, tags, confidence, resolved, status, priority, due_date, created_at, updated_at, source_session)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      input.session_id ?? null,
    ]
  );

  const links = createAutoLinks(db, noteId, keywords);

  // Embed the new note (still needed for future similarity queries).
  if (embeddingClient) {
    try {
      const vecs = await embeddingClient.embed([input.content]);
      if (vecs && vecs.length > 0) {
        const blob = Buffer.from(vecs[0].buffer);
        db.run(
          `INSERT OR REPLACE INTO embeddings (note_id, vector, model, embedded_at)
           VALUES (?, ?, ?, ?)`,
          [noteId, blob, "bge-m3", new Date().toISOString()]
        );
      }
    } catch (err) {
      console.error(`[embed] Failed to embed note ${noteId}:`, err);
    }
  }

  // Write to user_model if this is a user_pattern note
  if (input.type === "user_pattern") {
    writeUserModel(globalDb, input.content, input.context, input.dimension);
  }

  return { noteId, linksCreated: links.length };
}

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

  // ── Jaccard dedup (unchanged) ──────────────────────────────────────────
  // Runs FIRST. If it short-circuits to "Near-duplicate found - promoted
  // existing", return early as today. The R4 gate does NOT fire on this
  // path; keyword-based near-dupes are already handled by auto-promotion.
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

  // ── R4: forced-resolution gate ─────────────────────────────────────────
  // Only for alert-scope types, only when embeddings are available. Compute
  // candidates BEFORE inserting; if any exist and the caller didn't supply a
  // resolution, REJECT the write and return the candidates so the agent can
  // choose an action.
  let preInsertCandidates: Array<{
    id: string;
    type: string;
    content: string;
    similarity: number;
  }> = [];

  const isAlertScopeType = SIMILARITY_ALERT_TYPES.includes(input.type);
  if (isAlertScopeType && embeddingClient) {
    try {
      const vecs = await embeddingClient.embed([input.content]);
      if (vecs && vecs.length > 0) {
        const queryVector = vecs[0];
        const similar = handleCheckSimilar(db, queryVector, {
          proposed_action: input.content,
          types: SIMILARITY_ALERT_TYPES,
          threshold: SIMILARITY_ALERT_THRESHOLD,
        });
        preInsertCandidates = similar.results.slice(0, 3);
      }
    } catch (err) {
      console.error(`[embed] Failed to compute similarity for gate:`, err);
    }
  }

  // Gate fires: candidates exist AND caller did not supply a resolution.
  if (preInsertCandidates.length > 0 && input.resolution === undefined) {
    // R4.1: Sort descending by similarity so the strongest match is listed
    // first. handleCheckSimilar already sorts descending, but this is a
    // defensive sort in case that contract ever changes. Clone the array so
    // we don't mutate the candidates returned on the result object.
    const sortedCandidates = preInsertCandidates
      .slice()
      .sort((a, b) => b.similarity - a.similarity);

    const candidateLines = sortedCandidates
      .map((c) => {
        const pct = Math.round(c.similarity * 100);
        const bucket = bucketLabel(c.similarity);
        return `  [${bucket} ${pct}%] **${c.id}** [${c.type}] "${truncate(c.content, 120)}"`;
      })
      .join("\n");

    const guidanceBlock =
      "Guidance by match strength:\n" +
      "- HIGH MATCH (95%+): likely the same knowledge. Default to update_existing (if additive) or supersede_existing (if replacing).\n" +
      "- LIKELY RELATED (85-94%): probably the same topic, different angle. Consider update_existing if additive, or accept_new if the angle is distinct enough to warrant a separate note.\n" +
      "- ADJACENT (75-84%): overlapping vocabulary but likely different concepts. accept_new is usually correct; update/supersede only if you are certain of duplication.";

    const message =
      "Near-duplicate detected. Review before choosing resolution:\n\n" +
      candidateLines +
      "\n\n" +
      guidanceBlock +
      "\n\nChoose one:\n" +
      `  - resolution: { action: "accept_new" }  -- both notes stand, adjacent-but-different\n` +
      `  - resolution: { action: "update_existing", target_id: "ID" }  -- update the target instead of creating new\n` +
      `  - resolution: { action: "supersede_existing", target_id: "ID", reason?: "..." }  -- new note supersedes target (preserves history)\n` +
      `  - resolution: { action: "close_existing", target_id: "ID", reason?: "..." }  -- new note and close target as resolved`;

    return {
      stored: false,
      note_id: null,
      duplicate: false,
      promoted: false,
      links_created: 0,
      blocked_on_resolution: true,
      candidates: sortedCandidates,
      message,
    };
  }

  // ── Resolution-driven paths ────────────────────────────────────────────
  if (input.resolution !== undefined) {
    const action = input.resolution.action;
    const targetId = input.resolution.target_id;

    // accept_new: proceed with the normal insert. Resolution is a no-op
    // beyond acknowledging the candidates.
    if (action === "accept_new") {
      const { noteId, linksCreated } = await insertNote(db, globalDb, input, embeddingClient);
      return {
        stored: true,
        note_id: noteId,
        duplicate: false,
        promoted: false,
        links_created: linksCreated,
        message: `Stored ${input.type} note${linksCreated > 0 ? ` with ${linksCreated} auto-link(s)` : ""}. (resolution: accept_new)`,
      };
    }

    // The remaining three actions all require a target_id.
    if (!targetId) {
      return {
        stored: false,
        note_id: null,
        duplicate: false,
        promoted: false,
        links_created: 0,
        message: `resolution action "${action}" requires target_id. Supply the id of the near-duplicate candidate being acted on.`,
      };
    }

    // Locate the target in either DB, preferring the scope-appropriate DB.
    const targetInDb = db.query("SELECT id, type FROM notes WHERE id = ?").get(targetId) as
      | { id: string; type: string }
      | null;
    if (!targetInDb) {
      // Fall back to the other DB to produce a clear cross-scope error.
      const otherDb = db === projectDb ? globalDb : projectDb;
      const crossRow = otherDb.query("SELECT id FROM notes WHERE id = ?").get(targetId) as
        | { id: string }
        | null;
      if (crossRow) {
        return {
          stored: false,
          note_id: null,
          duplicate: false,
          promoted: false,
          links_created: 0,
          message: `resolution target_id "${targetId}" lives in a different scope than the new note. Cross-scope resolutions are not supported - choose a target in the same scope.`,
        };
      }
      return {
        stored: false,
        note_id: null,
        duplicate: false,
        promoted: false,
        links_created: 0,
        message: `resolution target_id "${targetId}" not found. Verify the id from the blocked gate's candidates list.`,
      };
    }

    if (action === "update_existing") {
      // Caller's content is additive - append to target instead of creating
      // a new note. This matches R1.6 append_content semantics.
      appendToNoteContent(db, targetId, input.content);
      return {
        stored: false,
        note_id: targetId,
        duplicate: false,
        promoted: false,
        links_created: 0,
        message: `Appended new content to target "${targetId}" (resolution: update_existing). No new note created.`,
      };
    }

    if (action === "supersede_existing") {
      // Create new note, then mark target as superseded by it.
      const { noteId, linksCreated } = await insertNote(db, globalDb, input, embeddingClient);
      const timestamp = now();
      db.transaction(() => {
        db.run(
          `UPDATE notes SET superseded_by = ?, superseded_at = ?, updated_at = ? WHERE id = ?`,
          [noteId, timestamp, timestamp, targetId]
        );
        db.run(
          `INSERT OR IGNORE INTO links (id, from_note_id, to_note_id, relationship, strength, created_at)
           VALUES (?, ?, ?, 'supersedes', 'strong', ?)`,
          [generateId(), noteId, targetId, timestamp]
        );
      })();
      const reasonSuffix = input.resolution.reason ? ` Reason: ${input.resolution.reason}.` : "";
      return {
        stored: true,
        note_id: noteId,
        duplicate: false,
        promoted: false,
        links_created: linksCreated,
        message: `Stored ${input.type} note "${noteId}" and superseded target "${targetId}".${reasonSuffix}`,
      };
    }

    if (action === "close_existing") {
      // Create new note, then mark target as resolved (work_item also flipped to done).
      const { noteId, linksCreated } = await insertNote(db, globalDb, input, embeddingClient);
      const timestamp = now();
      if (targetInDb.type === "work_item") {
        db.run(
          `UPDATE notes SET resolved = 1, status = 'done', updated_at = ? WHERE id = ?`,
          [timestamp, targetId]
        );
      } else {
        db.run(
          `UPDATE notes SET resolved = 1, updated_at = ? WHERE id = ?`,
          [timestamp, targetId]
        );
      }
      // Cascade (unblocks, parent auto-complete, superseded auto-resolve).
      cascadeResolutionInline(db, targetId, timestamp);
      const reasonSuffix = input.resolution.reason ? ` Reason: ${input.resolution.reason}.` : "";
      return {
        stored: true,
        note_id: noteId,
        duplicate: false,
        promoted: false,
        links_created: linksCreated,
        message: `Stored ${input.type} note "${noteId}" and closed target "${targetId}" as resolved.${reasonSuffix}`,
      };
    }

    // Exhaustive - TS should have caught unknown action strings.
    return {
      stored: false,
      note_id: null,
      duplicate: false,
      promoted: false,
      links_created: 0,
      message: `Unknown resolution action "${action}".`,
    };
  }

  // ── Normal path: no gate, no resolution ────────────────────────────────
  const { noteId, linksCreated } = await insertNote(db, globalDb, input, embeddingClient);
  return {
    stored: true,
    note_id: noteId,
    duplicate: false,
    promoted: false,
    links_created: linksCreated,
    message: `Stored ${input.type} note${linksCreated > 0 ? ` with ${linksCreated} auto-link(s)` : ""}.`,
  };
}

/**
 * Cascade-resolution helper used by resolution: close_existing. Mirrors the
 * behavior of the close_thread tool's cascadeResolution() in server.ts. Kept
 * inline here to avoid a module-level circular dependency between remember.ts
 * and server.ts.
 */
function cascadeResolutionInline(
  db: Database,
  noteId: string,
  timestamp: string
): void {
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
    .all(noteId, noteId, noteId) as Array<{ id: string; type: string; status: string | null }>;

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

    if (otherBlockers.cnt === 0 && blocked.type === "work_item" && blocked.status === "blocked") {
      db.run(`UPDATE notes SET status = 'planned', updated_at = ? WHERE id = ?`, [timestamp, blocked.id]);
    }
  }

  // 2. Auto-complete parent if all children done
  const parentLinks = db
    .query(`SELECT l.to_note_id FROM links l WHERE l.from_note_id = ? AND l.relationship = 'part_of'`)
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
      const parent = db.query(`SELECT id, type, status FROM notes WHERE id = ?`)
        .get(parentLink.to_note_id) as { id: string; type: string; status: string | null } | null;

      if (parent && parent.status !== "done") {
        if (parent.type === "work_item") {
          db.run(`UPDATE notes SET resolved = 1, status = 'done', updated_at = ? WHERE id = ?`, [timestamp, parent.id]);
        } else {
          db.run(`UPDATE notes SET resolved = 1, updated_at = ? WHERE id = ?`, [timestamp, parent.id]);
        }
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
    db.run(`UPDATE notes SET resolved = 1, updated_at = ? WHERE id = ?`, [timestamp, sup.id]);
  }
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

      if (
        intersection.size >= MIN_SHARED_KEYWORDS &&
        similarity >= 0.5 &&
        (!bestMatch || similarity > bestMatch.similarity)
      ) {
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
