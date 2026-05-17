import type { Database } from "bun:sqlite";
import type { NoteType, Dimension } from "../types";
import { GLOBAL_TYPES, DIMENSIONS } from "../types";
import { generateId, now, extractKeywords, stringifyCodeRefs, parseTagList } from "../utils";
import { findDuplicates, MIN_SHARED_KEYWORDS } from "../engine/deduplicator";
import { createAutoLinks } from "../engine/linker";
import { promoteConfidence } from "../engine/scorer";
import { type EmbeddingClient } from "../engine/embeddings";
import { handleCheckSimilar } from "./check_similar";
import { truncate } from "../utils";
import { appendToNoteContent } from "./update_note_helpers";
import { cascadeResolution } from "./cascade";

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
  /** R5: file/module-level breadcrumbs. Array of path strings, e.g.
   *  ["mcp/server.ts", "src-tauri/src/core/backup/"]. Not line numbers or
   *  symbols - orchestrator points at the neighborhood and carries the WHY. */
  code_refs?: string[];
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

// fc7fcb0d: type-aware BLOCK threshold. A flat 0.75 over-blocked anti_pattern
// notes, which by design enumerate close-but-distinct failure modes that share
// vocabulary (dogfood: bot 4x/5h, dev 3x, +1 live 2026-05-17 - a design
// decision blocked at 88% against the routing anti_pattern). decision /
// convention SHOULD consolidate when similar, so they keep 0.75; anti_pattern
// requires a stronger 0.85 to BLOCK (genuine dupes >= 0.90 still caught). Only
// the 3 SIMILARITY_ALERT_TYPES reach this gate (see isAlertScopeType); the
// default is harmless for the rest.
const SIMILARITY_ALERT_THRESHOLDS: Partial<Record<NoteType, number>> = {
  decision: 0.75,
  convention: 0.75,
  anti_pattern: 0.85,
};
const DEFAULT_SIMILARITY_ALERT_THRESHOLD = 0.75;

// Floor for SURFACING near-matches. A candidate at >= this floor but below the
// type's BLOCK threshold does not block the write, but IS surfaced as a
// non-blocking consolidation advisory - so loosening the block bar never makes
// a near-duplicate vanish silently (preserves the gate's consolidation
// purpose at the looser bar). Only non-empty for types whose block threshold
// exceeds the floor (anti_pattern); decision/convention block at the floor.
const SIMILARITY_ADVISORY_FLOOR = 0.75;

export function similarityAlertThreshold(type: NoteType): number {
  return SIMILARITY_ALERT_THRESHOLDS[type] ?? DEFAULT_SIMILARITY_ALERT_THRESHOLD;
}

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
 * fc7fcb0d: format the non-blocking consolidation advisory appended to a
 * stored note's message when near-matches existed at >= the advisory floor
 * but below this type's BLOCK threshold. The note was NOT blocked (no forced
 * resolution round-trip), but the agent still sees the adjacent notes so the
 * gate's consolidation purpose survives the looser bar. Empty string when
 * there are no advisory candidates (no noise on clean stores).
 */
function formatConsolidationAdvisory(
  candidates: Array<{ id: string; type: string; content: string; similarity: number }>
): string {
  if (candidates.length === 0) return "";
  const lines = candidates
    .map(
      (c) =>
        `  - ${c.id} [${c.type}] ${Math.round(c.similarity * 100)}% "${truncate(c.content, 90)}"`
    )
    .join("\n");
  return (
    `\n\n[consolidation check - NOT blocking] ${candidates.length} adjacent note(s) ` +
    `below the block bar:\n${lines}\n` +
    `If this is the SAME knowledge/failure-mode, prefer update_note or supersede on the ` +
    `closest match to keep the catalog consolidated; if genuinely distinct, no action needed.`
  );
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
    // c658ce38: normalize at capture so a JSON-array-stringified tags value
    // never gets baked into the stored row.
    for (const t of parseTagList(input.tags)) {
      if (!tagParts.includes(t)) tagParts.push(t);
    }
  }
  const tagsStr = tagParts.join(",");

  const noteId = generateId();
  const timestamp = now();
  const codeRefsJson = stringifyCodeRefs(input.code_refs);

  db.run(
    `INSERT INTO notes (id, type, content, context, keywords, tags, confidence, resolved, status, priority, due_date, created_at, updated_at, source_session, code_refs)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      codeRefsJson,
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

/** 0.30.26+ per-note hard size limit. Primitives should stay primitive;
 *  notes that grow unboundedly become hidden pre-computed digests, which
 *  violates the orchestrator's design principle (decision 3b962e67). A
 *  hard ceiling forces agents to split into multiple linked notes (better
 *  graph shape) or capture bulk into a doc/file and reference it.
 *
 *  The limit is generous (50K chars ≈ ~12K tokens) - any single concept
 *  that won't fit in 50K is almost certainly multiple concepts that
 *  should be separate primitives. */
const NOTE_CONTENT_HARD_CHARS = 50_000;

export async function handleRemember(
  projectDb: Database,
  globalDb: Database,
  input: RememberInput,
  embeddingClient?: EmbeddingClient | null
): Promise<RememberResult> {
  // 0.30.26+ size check before any DB work
  if (input.content.length > NOTE_CONTENT_HARD_CHARS) {
    return {
      stored: false,
      note_id: null,
      duplicate: false,
      promoted: false,
      links_created: 0,
      message: `Note content is ${input.content.length} chars - exceeds hard limit of ${NOTE_CONTENT_HARD_CHARS}. Primitives should stay primitive (orchestrator design principle: decision 3b962e67). Split into multiple smaller notes linked via supersedes/related_to, or capture the bulk into a doc/file and reference it from a compact note with code_refs. If the content genuinely cannot be smaller, this is the kind of thing the PA should synthesize on demand from underlying notes - not a stored digest.`,
    };
  }

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
  type Candidate = { id: string; type: string; content: string; similarity: number };
  let preInsertCandidates: Candidate[] = [];
  // fc7fcb0d: near-matches at >= floor but below this type's BLOCK threshold.
  // These do NOT block; they ride along as a non-blocking consolidation
  // advisory on the stored note's message.
  let advisoryCandidates: Candidate[] = [];

  const isAlertScopeType = SIMILARITY_ALERT_TYPES.includes(input.type);
  const blockThreshold = similarityAlertThreshold(input.type);
  if (isAlertScopeType && embeddingClient) {
    try {
      const vecs = await embeddingClient.embed([input.content]);
      if (vecs && vecs.length > 0) {
        const queryVector = vecs[0];
        // Query at the advisory FLOOR to see the whole near-neighborhood,
        // then partition by this type's BLOCK threshold: >= blockThreshold
        // blocks (forced resolution); [floor, blockThreshold) is a
        // non-blocking consolidation advisory.
        const similar = handleCheckSimilar(db, queryVector, {
          proposed_action: input.content,
          types: SIMILARITY_ALERT_TYPES,
          threshold: SIMILARITY_ADVISORY_FLOOR,
        });
        preInsertCandidates = similar.results
          .filter((c) => c.similarity >= blockThreshold)
          .slice(0, 3);
        advisoryCandidates = similar.results
          .filter(
            (c) =>
              c.similarity >= SIMILARITY_ADVISORY_FLOOR &&
              c.similarity < blockThreshold
          )
          .slice(0, 3);
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

    const gatePct = Math.round(blockThreshold * 100);
    const typeBarNote =
      input.type === "anti_pattern"
        ? " anti_pattern uses a stricter bar because vocabulary-adjacent-but-distinct" +
          " failure modes are expected - if this is a DIFFERENT failure mode/angle," +
          " accept_new is correct; if the SAME mode, prefer update_existing/" +
          "supersede_existing to keep the catalog consolidated."
        : "";
    const message =
      "Near-duplicate detected. Review before choosing resolution:\n\n" +
      `(Gate: ${input.type} blocks at >=${gatePct}% similarity.${typeBarNote})\n\n` +
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
      // Parity with the normal store path: surface sub-block-threshold
      // near-matches as a non-blocking consolidation advisory. Without this,
      // accepting-new after a gate block would silently drop the
      // [floor, blockThreshold) neighbors - exactly the silent-fragmentation
      // hole the first-class-consolidation requirement forbids.
      const advisory = formatConsolidationAdvisory(advisoryCandidates);
      return {
        stored: true,
        note_id: noteId,
        duplicate: false,
        promoted: false,
        links_created: linksCreated,
        message: `Stored ${input.type} note "${noteId}"${linksCreated > 0 ? ` with ${linksCreated} auto-link(s)` : ""}. (resolution: accept_new)${advisory}`,
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
      cascadeResolution(db, targetId, timestamp);
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
  const advisory = formatConsolidationAdvisory(advisoryCandidates);
  return {
    stored: true,
    note_id: noteId,
    duplicate: false,
    promoted: false,
    links_created: linksCreated,
    message: `Stored ${input.type} note "${noteId}"${linksCreated > 0 ? ` with ${linksCreated} auto-link(s)` : ""}.${advisory}`,
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
