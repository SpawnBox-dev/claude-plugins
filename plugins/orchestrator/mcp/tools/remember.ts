import type { Database } from "bun:sqlite";
import type { NoteType, Dimension } from "../types";
import { GLOBAL_TYPES, DIMENSIONS, NOTE_TYPES } from "../types";
import { generateId, now, extractKeywords, stringifyCodeRefs, parseTagList } from "../utils";
import { findDuplicates, MIN_SHARED_KEYWORDS } from "../engine/deduplicator";
import { createAutoLinksWithStats } from "../engine/linker";
import { promoteConfidence } from "../engine/scorer";
import { type EmbeddingClient } from "../engine/embeddings";
import { handleCheckSimilar } from "./check_similar";
import { truncate } from "../utils";
import { appendToNoteContent } from "./update_note_helpers";
import { cascadeResolution } from "./cascade";
import { stashPendingNote, takePendingNote, PENDING_NOTE_TTL_MS, findConcurrentCaptures } from "./pending_note";

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
  /** 0.30.72+: token returned by a blocked gate. Supplying it rehydrates the
   *  stashed body so `resolution` alone commits the write - no re-transmission
   *  of content/tags/code_refs. Any field ALSO passed explicitly wins over the
   *  stashed one, so the same call can amend while committing. */
  pending_id?: string;
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
  /** 0.30.72+: token identifying the stashed body when the gate blocks. Quote
   *  it back as `pending_id` with a `resolution` to commit without re-sending
   *  the content. */
  pending_id?: string;
}

const SIMILARITY_ALERT_TYPES: NoteType[] = ["decision", "convention", "anti_pattern"];

/** Types where keyword dedup does not apply, because identity is not phrasing.
 *  See the findDuplicates call site for the measured data-loss case. */
const DEDUP_EXEMPT_TYPES: NoteType[] = ["reference"];

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
 * 0.30.72+: the vocabulary two notes share, so the gate can show EVIDENCE for
 * why it fired instead of only how hard.
 *
 * HONESTY BOUND (corrected 0.30.73): the gate BLOCKS on cosine similarity over
 * embeddings (check_similar.ts), NOT on these keywords. So this list explains
 * the match, it does not compute it. It is still the right thing to show: for
 * jargon-dense text the two correlate strongly, and "heavy shared jargon +
 * different claims" is precisely the signature of a false positive. But do not
 * read it as the cause, and do not expect changing these terms to change the
 * block.
 *
 * Reported independently by PA, SA-b14fafa3 and SA-5a433456 on 2026-07-27:
 * the gate blocks on shared VOCABULARY, not on the claim. Concrete cases -
 * "code-signing dates as historical evidence" gated against "code signing as a
 * shipping feature"; a knowledge-placement convention gated at 87% against
 * three notes about PA behaviour. In an orchestrator KB nearly every note says
 * PA / SA / session / compaction, so jargon alone can carry a pair over the
 * bar. Showing the overlap lets the author see "this matched on shared jargon"
 * in one glance and answer accept_new with confidence - instead of learning to
 * reflexively accept_new, which is what destroys the gate's value.
 */
export function sharedMatchTerms(
  content: string,
  candidateContent: string,
  max = 8
): string[] {
  const a = new Set(extractKeywords(content));
  const b = extractKeywords(candidateContent);
  const shared: string[] = [];
  for (const term of b) {
    if (a.has(term) && !shared.includes(term)) shared.push(term);
    if (shared.length >= max) break;
  }
  return shared;
}


/**
 * 0.30.73: tell the author at write time when their note became a HUB.
 *
 * SA-5a433456 asked for exactly this: "surface the count back to the author at
 * write time so I can tell I've created a hub rather than a note." Before the
 * cap, a work item silently drew 295 edges and a note 494 - and the author had
 * no way to know. Now that ranking discards the tail, saying how many were
 * considered is the honest signal: a high considered-count means this note's
 * vocabulary is broadly shared, which is worth knowing while you can still
 * make the wording more specific.
 */
function formatLinkSummary(created: number, considered: number, capped: boolean): string {
  if (created === 0) return "";
  const base = ` with ${created} auto-link(s)`;
  if (!capped) return base;
  return (
    `${base} (kept the ${created} most distinctive of ${considered} keyword matches - ` +
    `this note shares vocabulary with a large slice of the KB, so more specific wording ` +
    `would make it easier to find)`
  );
}


/**
 * 0.30.78: surface a PEER's near-simultaneous capture of the same knowledge.
 *
 * SA-df343a05's correction is why this is keyword-based and not behavioural:
 * they avoided the duplicate "by being slow, not by method" - checking ~3
 * minutes after the broadcast, once the peer note was indexed. Sixty seconds
 * earlier and they would have filed a third. SA-90bf73bd ran check_similar - a
 * STRONGER check - and got nothing, because the note existed but had no vector
 * yet. So "look before you write" is not a defence here: the window where it
 * fails is exactly the window a broadcast creates, and everyone did look.
 */
function formatConcurrentAdvisory(
  peers: Array<{ id: string; type: string; content: string; session: string | null }>
): string {
  if (peers.length === 0) return "";
  const lines = peers
    .map((p) => {
      const who = p.session ? ` by SA-${p.session.slice(0, 8)}` : "";
      return `  - ${p.id.slice(0, 8)} [${p.type}]${who}: "${truncate(p.content, 100)}"`;
    })
    .join("\n");
  return (
    `\n\n[CONCURRENT CAPTURE - a peer wrote something very similar in the last 15 min]\n` +
    lines +
    `\nThe near-duplicate gate CANNOT catch this: it matches on embeddings, and a note ` +
    `written seconds ago has no vector yet - so check_similar returns nothing even though ` +
    `the note exists. This is a keyword check against recent writes instead.\n` +
    `If you and the peer captured the SAME knowledge, one of you should supersede into the ` +
    `other NOW - pick by better content, not by who was first - and say so in-channel. An ` +
    `unreconciled fork is a silently divided truth that nobody notices until someone reads both.`
  );
}


// ── 0.32.0: PUSH PRIOR KNOWLEDGE AT THE MOMENT OF ASSERTION ─────────────────
//
// Jarid's root-cause escalation (2026-07-28): "as an agent's scope grows and
// crosses into new domains, nothing proactively steers it to prior knowledge.
// It posits instead of discovering, and a human has to say 'there's more
// there'." Three amplified-and-retracted claims in two days.
//
// WHY THE FOUR RETRIEVAL TRIGGERS SHIPPED YESTERDAY DO NOT COVER IT: three of
// them key on the USER'S PROMPT (hedging, topic-shift phrasing, new vocabulary)
// and one keys on FILE PATHS. The failure Jarid describes happens while the
// agent is working - no prompt to inspect, and for a non-code domain (a
// marketplace's conventions, a pricing model, a vendor's terms) no file either.
//
// THE STRUCTURAL GAP, found by reading the write path rather than adding a
// fifth trigger: there are FIFTEEN note types. Only THREE - decision,
// convention, anti_pattern - got anything surfaced at write time, and even
// those were checked for DUPLICATION, not for relevance. An agent writing an
// `insight` or `architecture` note ("here is what I concluded") saw NOTHING.
// So the one moment the plugin can actually observe the agent's own claim was
// silent for 12 of 15 types.
//
// Writing a note IS the assertion. That makes it the natural push point:
// lookup is pull and requires knowing there is something to ask about, which
// is precisely what the failing agent does not know. This turns capture into a
// retrieval moment for every type.
//
// Deliberately: NON-BLOCKING (the note is already stored - this informs, it
// does not gate), silent when there is nothing relevant, capped at 3, and it
// never repeats a note the duplicate gate already showed. Checkpoints are
// excluded on both sides per 0.31.4 - session snapshots are not knowledge.
// FLOOR SET BY PRIOR ART, NOT BY TASTE. My first attempt used 0.60 and the
// existing suite immediately failed: the fc7fcb0d test uses a 0.60 neighbour as
// its definition of "no near-match, no advisory noise". That is a domain
// judgement someone already made about this KB, and overriding it silently to
// make my own feature fire would be exactly the "fix the test into agreement"
// anti-pattern. 0.68 sits above that established noise line and below the 0.75
// duplicate floor, so this band is "related but demonstrably not a duplicate".
//
// STILL A JUDGEMENT, NOT A MEASUREMENT: the honest way to tune it is observed
// fire-rate on real writes. SA-5a433456 and PA both warned that a check firing
// on every note write trains dismissal as reliably as an always-on alert - so
// if this proves noisy in practice, RAISE it rather than defending it.
const RELEVANCE_FLOOR = 0.68;
const RELEVANCE_MAX = 3;

function formatPriorKnowledge(
  hits: Array<{ id: string; type: string; content: string; similarity: number }>
): string {
  if (hits.length === 0) return "";
  const lines = hits
    .map(
      (h) =>
        // id8, and it IS resolvable - do not "fix" this to a full UUID.
        // resolveNoteId (mcp/tools/id_resolver.ts) is shared by supersede,
        // update_note and lookup: exact match first, then `id LIKE 'prefix-%'`
        // for 8 hex chars, with an ambiguous prefix returning the candidate
        // list rather than guessing. So the action this block asks for is
        // takeable with what it renders, and 8 chars keeps a nudge that exists
        // to avoid noise from spending 36 characters a line on identifiers.
        // (Checked the hard way: an earlier pass "fixed" this to a full id on
        // the strength of an empty grep against two filenames that do not
        // exist. See the round-trip test - it pins the PROPERTY, so a future
        // change to either the render width or the resolver fails loudly.)
        `  - ${h.id.slice(0, 8)} [${h.type}] ${Math.round(h.similarity * 100)}%: "${truncate(h.content, 110)}"`
    )
    .join("\n");
  return (
    `\n\n[PRIOR KNOWLEDGE on what you just asserted - pushed, you did not ask]\n` +
    lines +
    `\nThese are NOT duplicates; they are existing notes about the same ground. ` +
    `If any CONTRADICTS what you just wrote, resolve it now - a fork between an old ` +
    `note and a new one is invisible until someone reads both. If one makes your note ` +
    `redundant, supersede rather than leave two. If they simply add context, read them ` +
    `before you act on your own conclusion.`
  );
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
): Promise<{ noteId: string; linksCreated: number; linksConsidered: number; linksCapped: boolean; concurrent: string }> {
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

  const linkStats = createAutoLinksWithStats(db, noteId, keywords);
  const links = linkStats.links;

  // Embed the new note. 0.47.2: route through embedIfAvailable instead of
  // writing the embeddings row by hand.
  //
  // This was a SECOND, INDEPENDENT writer of the same table, and it drifted
  // from the first the moment either changed. By 0.47.1 it had two defects
  // that compounded: it never wrote note_chunks (so a newly created note was
  // absent from passage retrieval), and it hardcoded the model literal
  // "bge-m3" - which 0.47.0's `WHERE model = ACTIVE_EMBED_MODEL` filter then
  // excluded. Net effect: every note created after the model switch was
  // INVISIBLE to vector search, findable only by keyword, with no error
  // anywhere.
  //
  // One writer, one code path. embedIfAvailable owns chunking, the model tag
  // and the note-level row together, so they cannot disagree again.
  // Shape-check before calling: callers pass duck-typed `{ embed }` partials in
  // several places, and this is the THIRD time today that assumption has bitten
  // (see anti_pattern 798f741b). A best-effort embed must never break the note
  // write that triggered it, and `typeof` is cheaper than discovering it in
  // production.
  if (embeddingClient && typeof embeddingClient.embedIfAvailable === "function") {
    try {
      await embeddingClient.embedIfAvailable(db, noteId, input.content);
    } catch (err) {
      console.error(`[embed] Failed to embed note ${noteId}:`, err);
    }
  }

  // Write to user_model if this is a user_pattern note
  if (input.type === "user_pattern") {
    writeUserModel(globalDb, input.content, input.context, input.dimension);
  }

  return {
    noteId,
    linksCreated: links.length,
    linksConsidered: linkStats.considered,
    linksCapped: linkStats.capped,
    concurrent: formatConcurrentAdvisory(
      findConcurrentCaptures(db, {
        noteId,
        keywords,
        sessionId: input.session_id,
      })
    ),
  };
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
  // ── 0.30.72+: rehydrate a gate-blocked body from its pending token ───────
  // Runs FIRST, before every other check, because everything downstream reads
  // content/type. The stash always lives in projectDb (plugin_state is project-
  // scoped runtime state) even when the note itself will land in globalDb.
  if (input.pending_id) {
    const stashed = takePendingNote(projectDb, input.pending_id);
    if (!stashed) {
      return {
        stored: false,
        note_id: null,
        duplicate: false,
        promoted: false,
        links_created: 0,
        message:
          `pending_id "${input.pending_id}" is unknown, expired, or already committed - nothing was written. ` +
          `Pending bodies are one-shot and expire after ${Math.round(PENDING_NOTE_TTL_MS / 60000)} minutes. ` +
          `Re-send the note with its full content plus your resolution.`,
      };
    }
    // Explicitly-passed fields WIN over the stash, so the commit call can also
    // amend (e.g. add a tag or a code_ref the gate made you notice) without
    // re-sending the body.
    input = {
      ...stashed,
      ...Object.fromEntries(
        Object.entries(input).filter(([, v]) => v !== undefined)
      ),
    } as RememberInput;
  }

  if (typeof input.content !== "string" || input.content.length === 0) {
    return {
      stored: false,
      note_id: null,
      duplicate: false,
      promoted: false,
      links_created: 0,
      message:
        "note() requires `content` (and `type`), unless you pass a `pending_id` from a blocked near-duplicate gate.",
    };
  }

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
  // `reference` is EXEMPT. Jaccard dedup asks "is this the same claim, said
  // again?" - correct for a decision or a pattern, wrong for a POINTER, which
  // is identified by what it points AT, not by how it is worded. Pointers are
  // formulaic ("the X dashboard lives at Y"), so two references to genuinely
  // different resources share nearly all their keywords.
  //
  // Measured while adding the type: "Billing dashboard for the PAYMENT
  // provider..." and "Billing dashboard for the EMAIL provider..." collapsed
  // into ONE note - the second write was silently discarded and the first
  // note's confidence PROMOTED, so the loss looked like a success. Shipping
  // the type without this exemption would have shipped a type whose primary
  // use case destroys data.
  const duplicates = DEDUP_EXEMPT_TYPES.includes(input.type)
    ? []
    : findDuplicates(db, input.type, input.content);
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

  // 0.32.0: relevance push for EVERY type (see formatPriorKnowledge). Computed
  // here so it shares the single embed call below rather than adding one.
  let priorKnowledge: Candidate[] = [];

  const isAlertScopeType = SIMILARITY_ALERT_TYPES.includes(input.type);
  const blockThreshold = similarityAlertThreshold(input.type);
  // Relevance push runs for ALL types, including the 12 that never had any
  // write-time surfacing. Separate embed only when the gate below will not
  // already do one.
  if (!isAlertScopeType && embeddingClient) {
    try {
      const vecs = await embeddingClient.embed([input.content]);
      if (vecs && vecs.length > 0) {
        priorKnowledge = handleCheckSimilar(db, vecs[0], {
          proposed_action: input.content,
          types: NOTE_TYPES.filter((t) => t !== "checkpoint") as NoteType[],
          threshold: RELEVANCE_FLOOR,
        }).results.slice(0, RELEVANCE_MAX);
      }
    } catch (err) {
      console.error(`[embed] relevance push failed:`, err);
    }
  }

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
        // Relevance band sits BELOW the duplicate floor: related prior work
        // that is explicitly NOT a duplicate, which is the material the
        // duplicate-shaped check could never surface. Reuses this vector.
        const shown = new Set([
          ...preInsertCandidates.map((c) => c.id),
          ...advisoryCandidates.map((c) => c.id),
        ]);
        priorKnowledge = handleCheckSimilar(db, queryVector, {
          proposed_action: input.content,
          types: NOTE_TYPES.filter((t) => t !== "checkpoint") as NoteType[],
          threshold: RELEVANCE_FLOOR,
        })
          .results.filter(
            (c) => !shown.has(c.id) && c.similarity < SIMILARITY_ADVISORY_FLOOR
          )
          .slice(0, RELEVANCE_MAX);
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
        const shared = sharedMatchTerms(input.content, c.content);
        // Label is deliberately "indicative", not "matched on". The block is
        // decided by embedding cosine; these terms are a correlated artefact.
        // A misleading explanation shown at the moment of confusion teaches a
        // false model of the gate - the same failure shape as docs that tell
        // agents to make a call the tool rejects.
        const why =
          shared.length > 0
            ? `\n      overlapping terms (indicative, not the match basis): ${shared.join(", ")}`
            : "";
        return `  [${bucket} ${pct}%] **${c.id}** [${c.type}] "${truncate(c.content, 120)}"${why}`;
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
    // 0.30.72+: stash the body so the resolution round-trip costs a token, not
    // a full re-transmission of the note. See pending_note.ts for why.
    const pendingId = stashPendingNote(projectDb, input);

    const message =
      "Near-duplicate detected. Review before choosing resolution:\n\n" +
      `(Gate: ${input.type} blocks at >=${gatePct}% similarity.${typeBarNote})\n\n` +
      candidateLines +
      "\n\n" +
      guidanceBlock +
      "\n\nHOW TO READ `overlapping terms` - the block is decided by SEMANTIC (embedding) " +
      "similarity; those terms are shared vocabulary shown as evidence, not the thing that " +
      "matched. They can diverge in both directions: two notes can be embedding-close with " +
      "almost no shared words (paraphrases of one claim), or share heavy jargon and still be " +
      "far apart. Use them as a hint, not a verdict. The reliable signature of a FALSE " +
      "positive is heavy shared jargon PLUS genuinely different claims - judge the claims.\n" +
      "\nYour note body is SAVED - do NOT re-send it. Commit with the token alone:\n" +
      `  note({ pending_id: "${pendingId}", resolution: { action: "accept_new" } })\n\n` +
      "Choose one:\n" +
      `  - resolution: { action: "accept_new" }  -- both notes stand, adjacent-but-different\n` +
      `  - resolution: { action: "update_existing", target_id: "ID" }  -- APPENDS your content to the target as a timestamped segment; no new note is created. Pass ONLY the delta - do NOT pre-merge the target's existing body into your content, or the shared text lands twice.\n` +
      `  - resolution: { action: "supersede_existing", target_id: "ID", reason?: "..." }  -- new note supersedes target (preserves history)\n` +
      `  - resolution: { action: "close_existing", target_id: "ID", reason?: "..." }  -- new note and close target as resolved\n` +
      `\n(Any field you pass alongside pending_id overrides the stashed one, so you can amend while committing. ` +
      `The token is one-shot and expires in ${Math.round(PENDING_NOTE_TTL_MS / 60000)} minutes; after that, re-send the content.)`;

    return {
      stored: false,
      note_id: null,
      duplicate: false,
      promoted: false,
      links_created: 0,
      blocked_on_resolution: true,
      candidates: sortedCandidates,
      pending_id: pendingId,
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
      const { noteId, linksCreated, linksConsidered, linksCapped, concurrent } = await insertNote(db, globalDb, input, embeddingClient);
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
        message: `Stored ${input.type} note "${noteId}"${formatLinkSummary(linksCreated, linksConsidered, linksCapped)}. (resolution: accept_new)${advisory}${formatPriorKnowledge(priorKnowledge)}${concurrent}`,
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
      //
      // 0.44.0: pass the embedding client. This branch is the odd one out -
      // its three siblings (accept_new, supersede_existing, close_existing)
      // all route through insertNote and embed there, while this one called
      // the append helper directly and inherited nothing. That made it the
      // most perverse instance of the staleness family: the gate fires
      // BECAUSE embedding similarity crossed a bar, then merges knowledge in
      // and left the target's vector describing only its pre-merge content -
      // degrading the very index that triggered it. See insight 1ad2c09d.
      appendToNoteContent(db, targetId, input.content, embeddingClient);
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
      const { noteId, linksCreated, linksConsidered, linksCapped, concurrent } = await insertNote(db, globalDb, input, embeddingClient);
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
      const { noteId, linksCreated, linksConsidered, linksCapped, concurrent } = await insertNote(db, globalDb, input, embeddingClient);
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
  const { noteId, linksCreated, linksConsidered, linksCapped, concurrent } = await insertNote(db, globalDb, input, embeddingClient);
  const advisory = formatConsolidationAdvisory(advisoryCandidates);
  return {
    stored: true,
    note_id: noteId,
    duplicate: false,
    promoted: false,
    links_created: linksCreated,
    message: `Stored ${input.type} note "${noteId}"${formatLinkSummary(linksCreated, linksConsidered, linksCapped)}.${advisory}${formatPriorKnowledge(priorKnowledge)}${concurrent}`,
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
