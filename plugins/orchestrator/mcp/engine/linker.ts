import type { Database } from "bun:sqlite";
import type { NoteSummary, Link, RelationshipType, NoteType } from "../types";
import { generateId, now, parseCodeRefs } from "../utils";
import {
  cosineSimilarity,
  reciprocalRankFusion,
  maximalMarginalRelevance,
} from "../engine/hybrid_search";
import { blobToVector } from "../engine/embeddings";
import { signalBoost, confidenceMultiplier } from "./signal";
import { MIN_SHARED_KEYWORDS } from "./deduplicator";

/**
 * Infer relationship type based on note types.
 * Falls back to "related_to" when no specific inference applies.
 */
export function inferRelationship(
  fromType: NoteType,
  toType: NoteType
): RelationshipType {
  // Decision and open_thread are often topically adjacent but supersede is too strong
  // a claim without explicit user intent. handleSupersede is the ONLY valid path for
  // supersedes edges; auto-linker defaults to related_to.
  if (fromType === "decision" && toType === "open_thread") return "related_to";
  if (fromType === "open_thread" && toType === "decision") return "related_to";

  // Quality gates block: they must be passed before proceeding
  if (fromType === "quality_gate" || toType === "quality_gate") return "blocks";

  // Dependencies create depends_on relationships
  if (fromType === "dependency" || toType === "dependency") return "depends_on";

  // Anti-patterns conflict with conventions and autonomy recipes
  if (fromType === "anti_pattern" && (toType === "convention" || toType === "autonomy_recipe"))
    return "conflicts_with";
  if (toType === "anti_pattern" && (fromType === "convention" || fromType === "autonomy_recipe"))
    return "conflicts_with";

  // Architecture enables implementation patterns
  if (fromType === "architecture" && (toType === "convention" || toType === "autonomy_recipe"))
    return "enables";
  if (toType === "architecture" && (fromType === "convention" || fromType === "autonomy_recipe"))
    return "enables";

  // Risk blocks commitments and work items
  if (fromType === "risk" && (toType === "commitment" || toType === "work_item")) return "blocks";
  if ((fromType === "commitment" || fromType === "work_item") && toType === "risk") return "blocks";

  // Work items relate to decisions and architecture
  if (fromType === "work_item" && toType === "decision") return "depends_on";
  if (fromType === "decision" && toType === "work_item") return "enables";

  return "related_to";
}

/**
 * Find notes related to the given query using FTS5 full-text search.
 * Uses BM25 ranking with weights: content=1.0, context=0.5, keywords=2.0.
 *
 * Tokenization matches FTS5's internal unicode61 tokenizer: any non-alphanumeric
 * character is a word separator. This is critical - the old implementation
 * preserved hyphens and underscores, which caused FTS5 to interpret `-` as its
 * NOT operator and throw a syntax error on queries like "x-ray" or
 * "mining-anomaly". The try/catch below would swallow the error and return 0
 * results, which looked like "no matches" but was actually a query-construction
 * bug. We now strip non-alphanumerics here so the query tokens exactly match
 * what's in the FTS5 index, e.g. "x-ray detection" -> ["ray", "detection"]
 * (the single-char "x" is filtered by the length>2 check).
 */
export function findRelatedNotes(
  db: Database,
  query: string,
  limit = 10,
  includeSuperseded = false,
  codeRefFilter?: string
): NoteSummary[] {
  // Convert natural language to FTS5 syntax: split on any non-alphanumeric
  // run (same as FTS5 unicode61 tokenizer), filter short words, join with OR.
  const terms = query
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2);

  if (terms.length === 0) return [];

  const ftsQuery = terms.join(" OR ");

  // R5.2 Important-3: when code_ref is supplied, pre-filter at SQL level so the
  // 2x-limit slice is already narrowed to matching notes. Otherwise, needle-in-
  // haystack queries can return zero results even when matches exist, because
  // the post-limit TS filter never gets to see notes that ranked past the cut.
  // The LIKE is a coarse pre-filter (matches JSON-serialized code_refs array);
  // the exact-equality TS post-filter in handleRecall is kept as a belt.
  // Build the LIKE needle by JSON-escaping the path (so quotes/backslashes in
  // the path can't break the LIKE pattern) and wrapping in quotes + %s.
  const codeRefClause = codeRefFilter ? `AND n.code_refs LIKE ?` : ``;
  const escapedForLike = codeRefFilter
    ? JSON.stringify(codeRefFilter).slice(1, -1)
    : null;
  const codeRefLikeParam = escapedForLike !== null ? `%"${escapedForLike}"%` : null;

  try {
    // R3.2: fetch 2x limit so the post-SQL signal/confidence re-rank has
    // headroom to promote high-signal items that BM25 alone would have
    // dropped just below the cut line.
    const sql = `SELECT n.id, n.type, n.content, n.confidence, n.created_at, n.updated_at, n.source_session, n.superseded_by, n.keywords, n.tags, n.code_refs,
                COALESCE(n.signal, 0) AS note_signal,
                bm25(notes_fts, 1.0, 0.5, 2.0) AS rank
         FROM notes_fts
         JOIN notes n ON notes_fts.rowid = n.rowid
         WHERE notes_fts MATCH ?
           ${includeSuperseded ? "" : "AND n.superseded_by IS NULL"}
           ${codeRefClause}
         ORDER BY rank ASC
         LIMIT ?`;
    const params: any[] =
      codeRefLikeParam !== null
        ? [ftsQuery, codeRefLikeParam, limit * 2]
        : [ftsQuery, limit * 2];
    const rows = db.query(sql).all(...params) as Array<{
      id: string;
      type: string;
      content: string;
      confidence: string;
      created_at: string;
      updated_at: string;
      source_session: string | null;
      superseded_by: string | null;
      keywords: string;
      tags: string | null;
      code_refs: string | null;
      note_signal: number;
      rank: number;
    }>;

    // R3.2: re-rank applying signalBoost + confidenceMultiplier.
    // SQLite's bm25() returns NEGATIVE scores where more-negative = better match
    // (ORDER BY rank ASC puts the best match first). To boost a note, we want
    // its final score to be MORE negative, so we MULTIPLY rank by the boost
    // (negative * >1 = more-negative). High-signal and high-confidence notes
    // therefore float toward the top of the list.
    const rescored = rows.map((r) => ({
      row: r,
      finalScore:
        r.rank * signalBoost(r.note_signal) * confidenceMultiplier(r.confidence),
    }));
    rescored.sort((a, b) => a.finalScore - b.finalScore);
    const top = rescored.slice(0, limit).map((x) => x.row);

    return top.map((r) => ({
      id: r.id,
      type: r.type as NoteSummary["type"],
      content: r.content,
      confidence: r.confidence as NoteSummary["confidence"],
      created_at: r.created_at,
      updated_at: r.updated_at,
      source_session: r.source_session,
      superseded_by: r.superseded_by ?? null,
      keywords: r.keywords ? r.keywords.split(",").map((k) => k.trim()) : [],
      tags: r.tags ?? null,
      status: (r as any).status ?? null,
      priority: (r as any).priority ?? null,
      due_date: (r as any).due_date ?? null,
      code_refs: parseCodeRefs(r.code_refs ?? null),
    }));
  } catch (err) {
    // FTS query can still fail on truly pathological input. Log the actual
    // query and error so regressions in query construction are debuggable
    // instead of silently returning zero results.
    console.error(
      `[linker] findRelatedNotes FTS5 error - query="${ftsQuery}" original="${query}":`,
      err
    );
    return [];
  }
}

/**
 * Hybrid FTS5+vector search. When a queryVector is provided, merges FTS5
 * and cosine-similarity rankings via Reciprocal Rank Fusion, then applies
 * Maximal Marginal Relevance for diversity. Falls back to plain FTS5 when
 * no queryVector is given.
 */
export async function findRelatedNotesHybrid(
  db: Database,
  query: string,
  limit = 10,
  queryVector?: Float32Array,
  mmrLambda: number = 0.7,
  includeSuperseded = false,
  codeRefFilter?: string
): Promise<NoteSummary[]> {
  // Fallback: no vector, just use existing FTS5 search
  if (!queryVector) {
    return findRelatedNotes(db, query, limit, includeSuperseded, codeRefFilter);
  }

  // 1. FTS5 ranked list
  const ftsResults = findRelatedNotes(db, query, limit * 3, includeSuperseded, codeRefFilter);
  const ftsRanks = new Map<string, number>();
  ftsResults.forEach((r, i) => ftsRanks.set(r.id, i + 1));

  // Build a lookup of FTS results by id for later
  const noteById = new Map<string, NoteSummary>();
  for (const r of ftsResults) {
    noteById.set(r.id, r);
  }

  // R3.2: signalById tracks raw signal per note so the boost can be applied
  // to RRF scores before MMR (preserving the diversity guarantee) and to the
  // final ordering.
  const signalById = new Map<string, number>();
  if (ftsResults.length > 0) {
    const ids = ftsResults.map((r) => r.id);
    const placeholders = ids.map(() => "?").join(",");
    const rows = db
      .query(
        `SELECT id, COALESCE(signal, 0) AS note_signal FROM notes WHERE id IN (${placeholders})`
      )
      .all(...ids) as Array<{ id: string; note_signal: number }>;
    for (const r of rows) signalById.set(r.id, r.note_signal);
  }

  // 2. Vector search. 0.46.0: score each note by its BEST-MATCHING PASSAGE
  // (max-pool over note_chunks) instead of by a single whole-note vector.
  //
  // A document average cannot answer "which note contains this idea?" - every
  // specific claim inside a long note is washed out. Measured 2026-08-08:
  // paraphrase probes ranked the correct note #205-#3247 of 7148 under the old
  // scheme while keyword ranked the same notes #1; chunked max-pool won 5/5
  // probes in a controlled A/B. Max-pool (not mean) is the point: one strongly
  // matching passage should surface the note, and averaging would re-introduce
  // exactly the dilution being fixed.
  //
  // Falls back to the note-level `embeddings` row for any note with no chunks
  // yet, so search keeps working during a partial backfill rather than
  // silently dropping un-chunked notes out of the vector leg.
  const chunkRows = db
    .query(`SELECT note_id, vector FROM note_chunks`)
    .all() as Array<{ note_id: string; vector: Buffer }>;

  const best = new Map<string, number>();
  for (const row of chunkRows) {
    const sim = cosineSimilarity(queryVector, blobToVector(row.vector as Buffer));
    const prev = best.get(row.note_id);
    if (prev === undefined || sim > prev) best.set(row.note_id, sim);
  }

  const embRows = db
    .query(`SELECT e.note_id, e.vector FROM embeddings e`)
    .all() as Array<{ note_id: string; vector: Buffer }>;

  const vecScores: Array<{ id: string; similarity: number }> = [];
  const seen = new Set<string>();
  for (const row of embRows) {
    seen.add(row.note_id);
    const chunked = best.get(row.note_id);
    if (chunked !== undefined) {
      vecScores.push({ id: row.note_id, similarity: chunked });
      continue;
    }
    const vec = blobToVector(row.vector as Buffer);
    vecScores.push({ id: row.note_id, similarity: cosineSimilarity(queryVector, vec) });
  }
  // Notes that have chunks but no note-level row would otherwise be invisible.
  // Set membership, not a scan - this runs per query over the whole corpus.
  for (const [id, sim] of best) {
    if (!seen.has(id)) vecScores.push({ id, similarity: sim });
  }

  // Sort descending by similarity and assign ranks
  vecScores.sort((a, b) => b.similarity - a.similarity);
  const vecRanks = new Map<string, number>();
  vecScores.forEach((v, i) => vecRanks.set(v.id, i + 1));

  // 3. Reciprocal Rank Fusion
  const rrfResults = reciprocalRankFusion(ftsRanks, vecRanks);

  // Expand candidate pool: load note data for any ids not already in noteById.
  // We inspect a wider pre-boost slice so that high-signal items that BM25+vector
  // alone would have dropped just below the cutoff can still be promoted in.
  // R5.2 Important-3: when codeRefFilter is set, apply the same LIKE pre-filter
  // here too, so notes pulled in via vector rank but lacking the requested
  // code_ref don't leak into the candidate pool.
  const preBoostSlice = rrfResults.slice(0, limit * 4);
  const hybridCodeRefClause = codeRefFilter ? `AND code_refs LIKE ?` : ``;
  const hybridLikeParam = codeRefFilter
    ? `%"${JSON.stringify(codeRefFilter).slice(1, -1)}"%`
    : null;
  for (const rrf of preBoostSlice) {
    if (!noteById.has(rrf.id)) {
      const sql = `SELECT id, type, content, confidence, created_at, updated_at, source_session, keywords, tags, status, priority, due_date, superseded_by, code_refs,
                  COALESCE(signal, 0) AS note_signal
           FROM notes WHERE id = ?${includeSuperseded ? "" : " AND superseded_by IS NULL"} ${hybridCodeRefClause}`;
      const params: any[] =
        hybridLikeParam !== null ? [rrf.id, hybridLikeParam] : [rrf.id];
      const row = db.query(sql).get(...params) as {
        id: string;
        type: string;
        content: string;
        confidence: string;
        created_at: string;
        updated_at: string;
        source_session: string | null;
        keywords: string;
        tags: string | null;
        status: string | null;
        priority: string | null;
        due_date: string | null;
        superseded_by: string | null;
        code_refs: string | null;
        note_signal: number;
      } | null;

      if (row) {
        noteById.set(row.id, {
          id: row.id,
          type: row.type as NoteSummary["type"],
          content: row.content,
          confidence: row.confidence as NoteSummary["confidence"],
          created_at: row.created_at,
          updated_at: row.updated_at,
          source_session: row.source_session,
          superseded_by: row.superseded_by ?? null,
          keywords: row.keywords ? row.keywords.split(",").map((k) => k.trim()) : [],
          tags: row.tags ?? null,
          status: row.status as NoteSummary["status"] ?? null,
          priority: row.priority as NoteSummary["priority"] ?? null,
          due_date: row.due_date ?? null,
          code_refs: parseCodeRefs(row.code_refs ?? null),
        });
        signalById.set(row.id, row.note_signal);
      }
    }
  }

  // R3.2: apply signal + confidence boost to RRF scores BEFORE MMR so the
  // diversity guarantee still holds. MMR picks by relevance-minus-similarity;
  // biasing relevance upward for hot/high-confidence notes is the intended
  // spend of the pheromone signal. We re-sort rrfResults after boosting so the
  // candidateTopK slice below reflects boosted ordering.
  for (const r of rrfResults) {
    const note = noteById.get(r.id);
    if (!note) continue;
    const signal = signalById.get(r.id) ?? 0;
    const boost = signalBoost(signal) * confidenceMultiplier(note.confidence);
    r.score = r.score * boost;
  }
  rrfResults.sort((a, b) => b.score - a.score);

  const candidateTopK = rrfResults.slice(0, limit * 2);

  // 4. MMR: load vectors for top-K candidates that have embeddings
  const embMap = new Map<string, Float32Array>();
  for (const row of embRows) {
    embMap.set(row.note_id, blobToVector(row.vector as Buffer));
  }

  const mmrItems = candidateTopK
    .filter((rrf) => embMap.has(rrf.id) && noteById.has(rrf.id))
    .map((rrf) => ({
      id: rrf.id,
      score: rrf.score,
      vector: embMap.get(rrf.id)!,
    }));

  // Also include FTS-only candidates (no embedding) so they're not lost
  const ftsOnlyCandidates = candidateTopK.filter(
    (rrf) => !embMap.has(rrf.id) && noteById.has(rrf.id)
  );

  let finalIds: string[];

  if (mmrItems.length > 0) {
    const mmrResults = maximalMarginalRelevance(mmrItems, limit, mmrLambda);
    finalIds = mmrResults.map((r) => r.id);
    // Append FTS-only candidates after MMR results if room
    for (const c of ftsOnlyCandidates) {
      if (finalIds.length >= limit) break;
      if (!finalIds.includes(c.id)) finalIds.push(c.id);
    }
  } else {
    // No embeddings at all: just use RRF order
    finalIds = candidateTopK.map((r) => r.id).slice(0, limit);
  }

  // 5. Build final NoteSummary list preserving order
  const results: NoteSummary[] = [];
  for (const id of finalIds) {
    const note = noteById.get(id);
    if (note) results.push(note);
    if (results.length >= limit) break;
  }

  return results;
}

/**
 * Auto-link a note to other notes based on keyword overlap.
 * Creates links in the DB and returns the created Link objects.
 *
 * R4.3: default `minOverlap` now uses `MIN_SHARED_KEYWORDS` (3) from the
 * deduplicator, aligning the auto-linker with the R3.5a discipline that
 * already guards `findDuplicates`, `mergeDuplicates`, and
 * `remember.writeUserModel`. Prior to R4.3 this defaulted to 2, producing
 * false-positive graph links from incidental short-keyword overlaps.
 */
export function createAutoLinks(
  db: Database,
  noteId: string,
  keywords: string[],
  minOverlap = MIN_SHARED_KEYWORDS
): Link[] {
  return createAutoLinksWithStats(db, noteId, keywords, minOverlap).links;
}

/**
 * 0.30.72+: cap + relevance floor on auto-linking.
 *
 * THE PROBLEM (fleet-reported 2026-07-27 with hard numbers by SA-90bf73bd,
 * SA-df343a05 and SA-5a433456): this function linked a new note to EVERY note
 * in the KB sharing >= minOverlap keywords, with no bound. At ~7,300 notes and
 * a shared house vocabulary, single notes drew 494, 295, 293, 285 and 254
 * edges. SA-90bf73bd's 494-edge note was not a densely-connected concept - its
 * terms (deploy, push, worker, dashboard, version, ship) simply collide with
 * most of the KB.
 *
 * WHY IT MATTERS: "signal at that count is indistinguishable from none."
 * Nobody traverses 494 edges, so a note that links to everything is
 * discoverable via nothing - the hub actively degrades the neighbourhood
 * retrieval path it was supposed to serve. df343a05 reported never once using
 * the graph to navigate, and keeping detail-view readable only via
 * `link_limit: 0`. Their smallest-degree notes were the useful ones.
 *
 * THE FIX, per SA-90bf73bd's recommendation ("bias toward a cap plus a
 * relevance floor rather than a pure similarity threshold"):
 *   1. RANK by Jaccard (overlap / union), not by raw overlap count. Raw count
 *      rewards verbose notes; Jaccard normalizes, so a generic note sharing 4
 *      terms out of 40 ranks below a precise one sharing 4 out of 8. Jaccard
 *      also matches what deduplicator.ts already uses - one similarity notion
 *      across the engine, not two.
 *   2. FLOOR at AUTO_LINK_MIN_RELEVANCE - drops the long tail of incidental
 *      vocabulary collisions that cleared minOverlap on size alone.
 *   3. CAP at AUTO_LINK_MAX_PER_NOTE, keeping the highest-ranked. This is the
 *      guarantee: degree is bounded regardless of how large the KB grows, so
 *      this cannot silently regress as the corpus scales.
 *
 * minOverlap is still enforced first, so R4.3 semantics are untouched.
 */
export const AUTO_LINK_MAX_PER_NOTE = 25;
/** Jaccard floor. Deliberately permissive - the CAP is the primary bound, and
 *  an over-tight floor would silently sever legitimate sparse links. This only
 *  clips the tail where overlap cleared minOverlap purely because one side had
 *  a large keyword set. */
export const AUTO_LINK_MIN_RELEVANCE = 0.08;

/**
 * 0.30.95: BACKFILL PRUNE for the pre-0.30.73 link graph.
 *
 * The cap added in 0.30.73 bounds NEW notes only. Measured on the live DB:
 * 959,125 links across 6,827 notes (~140 each; top node 1,119; 768 notes
 * carry >300 edges totalling 325,754). At that density the graph has stopped
 * discriminating - if everything connects to everything, traversal is
 * indistinguishable from enumeration, and the notes with the highest degree are
 * the LEAST specific rather than the most connected.
 *
 * WHY THIS IS SAFE TO RUN, established by reading the producer rather than
 * assuming: inferRelationship() can emit blocks / depends_on / conflicts_with /
 * enables, so relationship type alone does NOT separate auto-generated edges
 * from hand-made ones. But it can never emit `supersedes` - linker.ts states
 * that handleSupersede is the only valid path - and it never emits `part_of`.
 *
 * So this prunes ONLY `related_to`, the auto-linker's default and 908,154 of
 * the 959,125 edges (94.7%). Every semantically-typed edge is left untouched,
 * which means a manually-created `blocks` (from blocked_by) or a `supersedes`
 * chain cannot be damaged even in principle. The 5% we decline to touch is also
 * the 5% that carries actual meaning.
 *
 * WHAT IT KEEPS: the highest-ranked N per source note, ordered EXACTLY as the
 * read path already orders them (recall.ts fetchLinkedNotes: link strength,
 * then target signal, then recency).
 *
 * PRECISE CLAIM, because the loose version is wrong and was caught in review:
 * "changes what is STORED without changing what is SHOWN" holds AT DEFAULT
 * SETTINGS ONLY. lookup's default link_limit is 20, comfortably under the cap,
 * so a default detail-view is bit-identical before and after. But link_limit
 * accepts up to 500, and a caller who explicitly asks for a wide neighbourhood
 * WILL see fewer edges afterwards.
 *
 * That is an accepted consequence, not an oversight: such a caller now gets the
 * 25 highest-ranked neighbours instead of 500 mostly-noise ones, which is the
 * entire point at ~140 edges per note. Stated explicitly so nobody later reads
 * the invariant as universal - cascade.ts also walks links, but only over
 * part_of / blocks, which this never touches.
 *
 * CAVEAT ON THE ORDERING: `signal` is a weak term right now, because decay
 * never persisted until 0.30.92 (see reflect.ts) - so signals are undecayed and
 * flatter than they should be. Link strength is doing most of the work. After
 * decay has run for a while the ranking gets strictly better; it is not wrong
 * today, just less discriminating than it will be.
 *
 * Deliberately NOT wired into briefing. It belongs in an explicit maintenance
 * pass; the startup path is a hard-gated call and has no business doing a mass
 * delete (0.30.92 removed the last such operation from it).
 */
export function pruneSaturatedLinks(
  db: Database,
  maxPerNote = AUTO_LINK_MAX_PER_NOTE
): { removed: number; before: number; after: number } {
  const count = () =>
    (db.query(`SELECT COUNT(*) AS c FROM links`).get() as { c: number }).c;
  const before = count();

  // Rank each note's related_to edges the way the reader will see them, and
  // drop everything past the cap. Window function over the join so the target
  // note's signal participates in the ordering.
  db.run(
    `DELETE FROM links WHERE rowid IN (
       SELECT rowid FROM (
         SELECT l.rowid AS rowid,
                ROW_NUMBER() OVER (
                  PARTITION BY l.from_note_id
                  ORDER BY
                    CASE l.strength WHEN 'strong' THEN 3 WHEN 'moderate' THEN 2 WHEN 'weak' THEN 1 ELSE 0 END DESC,
                    COALESCE(n.signal, 0) DESC,
                    n.updated_at DESC
                ) AS rn
         FROM links l
         JOIN notes n ON n.id = l.to_note_id
         WHERE l.relationship = 'related_to'
       )
       WHERE rn > ?
     )`,
    [maxPerNote]
  );

  const after = count();
  return { removed: before - after, before, after };
}

/**
 * 0.30.97: REGENERATE the auto-link graph from scratch.
 *
 * This is the primitive the graph has never had, and its absence is what made
 * the 0.30.95 prune unsafe. PA's framing, which is the right one: check whether
 * an operation is RECOVERABLE before checking whether it is CORRECT. A graph
 * you cannot regenerate is a graph you can never safely repair - every future
 * fix to link quality inherits the same one-way risk.
 *
 * With this, pruning stops being a 750,000-row irreversible deletion and
 * becomes "a slow afternoon". It is also independently useful: the entire live
 * graph was built by the PRE-0.30.73 linker, with no cap and no IDF weighting,
 * so a rebuild re-derives every edge under the current ranking rather than
 * merely trimming what the old one produced.
 *
 * ONLY `related_to` is regenerated - the same boundary the prune uses, and for
 * the same reason: inferRelationship can emit blocks/depends_on/conflicts_with/
 * enables, but `supersedes` and `part_of` come only from explicit tools, so
 * hand-made edges must never be deleted here. Note this means a rebuild does
 * NOT reproduce auto-generated blocks/enables/etc. edges from the old graph;
 * those are left exactly as they are, untouched, rather than being destroyed
 * and re-derived.
 *
 * Deliberately NOT wired into retro or briefing. It is an explicit repair
 * operation, invoked knowingly, and it is slow by nature - every note re-scans
 * the corpus.
 */
export function rebuildAutoLinks(
  db: Database,
  opts: { onProgress?: (done: number, total: number) => void } = {}
): { notes: number; linksBefore: number; linksAfter: number } {
  const countRelated = () =>
    (
      db
        .query(`SELECT COUNT(*) AS c FROM links WHERE relationship = 'related_to'`)
        .get() as { c: number }
    ).c;

  const linksBefore = countRelated();

  const notes = db
    .query(
      `SELECT id, keywords FROM notes WHERE keywords IS NOT NULL AND keywords != ''`
    )
    .all() as Array<{ id: string; keywords: string }>;

  // Clear ONLY the auto-generated default relationship, then re-derive. Done in
  // one statement rather than per-note so the graph is never half-old-half-new
  // if this is wrapped in a transaction by the caller.
  db.run(`DELETE FROM links WHERE relationship = 'related_to'`);

  let done = 0;
  for (const note of notes) {
    const keywords = note.keywords
      .split(",")
      .map((k) => k.trim())
      .filter(Boolean);
    if (keywords.length > 0) {
      createAutoLinksWithStats(db, note.id, keywords);
    }
    done++;
    if (opts.onProgress && done % 250 === 0) opts.onProgress(done, notes.length);
  }

  return { notes: notes.length, linksBefore, linksAfter: countRelated() };
}

export interface AutoLinkStats {
  links: Link[];
  /** How many candidates cleared minOverlap before ranking/floor/cap. Lets the
   *  caller tell the author "you created a hub, not a note" at write time -
   *  which SA-5a433456 asked for explicitly, having no way to know a work item
   *  had drawn 295 edges. */
  considered: number;
  /** True when ranking discarded candidates that cleared minOverlap. */
  capped: boolean;
}

export function createAutoLinksWithStats(
  db: Database,
  noteId: string,
  keywords: string[],
  minOverlap = MIN_SHARED_KEYWORDS
): AutoLinkStats {
  if (keywords.length === 0) return { links: [], considered: 0, capped: false };

  const noteKeywords = new Set(keywords.map((k) => k.toLowerCase()));

  // Get the type of the source note for relationship inference
  const sourceRow = db
    .query(`SELECT type FROM notes WHERE id = ?`)
    .get(noteId) as { type: string } | null;
  const sourceType = (sourceRow?.type ?? "insight") as NoteType;

  // Get all other notes that have keywords
  const candidates = db
    .query(
      `SELECT id, type, keywords FROM notes WHERE id != ? AND keywords IS NOT NULL AND keywords != ''`
    )
    .all(noteId) as Array<{ id: string; type: string; keywords: string }>;

  // ── Pass 1: document frequency for THIS note's terms ────────────────────
  // SA-df343a05 sharpened the diagnosis on 2026-07-27 and it changed the fix.
  // PA's hypothesis was "the highest-linking notes are the least specific".
  // The counter-example: a decision note with an extremely NARROW claim (one
  // session must not run one command) drew 421 edges, because its VOCABULARY
  // was dense with house jargon - session, plugin, update, transport, bot, PA.
  // So the driver is COMMON-VOCABULARY DENSITY, not claim generality: two
  // equally narrow notes can link 40x differently based purely on how much
  // shared jargon they carry.
  //
  // A flat cap cannot fix that - it keeps 25 arbitrary edges instead of 421.
  // Term RARITY can. In a KB where ~7,300 notes all say "session" and "note",
  // those terms carry no information; "portproxy" or "vhdx" carry a lot. So
  // weight each shared term by inverse document frequency and score a
  // candidate by how much of this note's DISTINCTIVE vocabulary it shares.
  //
  // Cost is free: we already scan every candidate row, so DF is computed in
  // the same pass rather than with an extra query.
  const parsedCandidates: Array<{ id: string; type: string; keywords: string[] }> = [];
  const df = new Map<string, number>();
  for (const candidate of candidates) {
    const candidateKeywords = candidate.keywords
      .split(",")
      .map((k) => k.trim().toLowerCase())
      .filter((k) => k.length > 0);
    parsedCandidates.push({
      id: candidate.id,
      type: candidate.type,
      keywords: candidateKeywords,
    });
    // Only the source note's terms matter for scoring; counting just those
    // keeps the map small regardless of KB size.
    const seen = new Set<string>();
    for (const k of candidateKeywords) {
      if (noteKeywords.has(k) && !seen.has(k)) {
        seen.add(k);
        df.set(k, (df.get(k) ?? 0) + 1);
      }
    }
  }

  const corpusSize = parsedCandidates.length + 1;
  const idf = (term: string): number =>
    Math.log(1 + corpusSize / (1 + (df.get(term) ?? 0)));

  // Total distinctive weight of this note. A candidate's relevance is the
  // FRACTION of that weight it shares, so the score is normalized to 0..1 and
  // comparable across notes of very different keyword-set sizes.
  let totalIdf = 0;
  for (const k of noteKeywords) totalIdf += idf(k);

  // ── Pass 2: score every candidate that clears minOverlap ─────────────────
  type Scored = {
    id: string;
    type: string;
    overlap: number;
    relevance: number;
  };
  const scored: Scored[] = [];

  for (const candidate of parsedCandidates) {
    const overlap = candidate.keywords.filter((k) => noteKeywords.has(k));
    if (overlap.length < minOverlap) continue;

    // Dedupe: a candidate repeating a term must not be scored twice for it.
    const sharedTerms = new Set(overlap);
    let sharedIdf = 0;
    for (const t of sharedTerms) sharedIdf += idf(t);

    const relevance = totalIdf > 0 ? sharedIdf / totalIdf : 0;

    scored.push({
      id: candidate.id,
      type: candidate.type,
      overlap: sharedTerms.size,
      relevance,
    });
  }

  const considered = scored.length;

  const ranked = scored
    .filter((s) => s.relevance >= AUTO_LINK_MIN_RELEVANCE)
    // Strongest relevance first; raw overlap breaks ties so a genuinely
    // richer match wins between equal-ratio candidates. id is the final
    // tiebreak purely so the selection is deterministic.
    .sort(
      (a, b) =>
        b.relevance - a.relevance ||
        b.overlap - a.overlap ||
        a.id.localeCompare(b.id)
    )
    .slice(0, AUTO_LINK_MAX_PER_NOTE);

  const links: Link[] = [];
  const timestamp = now();

  for (const candidate of ranked) {
    const strength =
      candidate.overlap >= 5
        ? "strong"
        : candidate.overlap >= 3
          ? "moderate"
          : "weak";

    const relationship = inferRelationship(
      sourceType,
      candidate.type as NoteType
    );

    const link: Link = {
      id: generateId(),
      from_note_id: noteId,
      to_note_id: candidate.id,
      relationship,
      strength,
      created_at: timestamp,
    };

    // 0.30.97: OR IGNORE. On a fresh note this can never collide (it has no
    // edges yet), which is why it never fired in normal operation - but
    // rebuildAutoLinks re-derives links for EXISTING notes, and
    // inferRelationship can return a non-`related_to` type for a pair whose
    // old auto-generated edge of that same type was deliberately preserved.
    // The unique key is (from, to, relationship), so that is a straight
    // collision. Keeping the existing row is the correct resolution: it is the
    // same edge. Found by running the rebuild against a copy of the live DB -
    // the same UNIQUE-collision class as the merge bug in deduplicator.ts, one
    // level further in.
    db.run(
      `INSERT OR IGNORE INTO links (id, from_note_id, to_note_id, relationship, strength, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        link.id,
        link.from_note_id,
        link.to_note_id,
        link.relationship,
        link.strength,
        link.created_at,
      ]
    );

    links.push(link);
  }

  return { links, considered, capped: considered > links.length };
}
