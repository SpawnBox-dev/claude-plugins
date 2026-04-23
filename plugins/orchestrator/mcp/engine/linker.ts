import type { Database } from "bun:sqlite";
import type { NoteSummary, Link, RelationshipType, NoteType } from "../types";
import { generateId, now } from "../utils";
import {
  cosineSimilarity,
  reciprocalRankFusion,
  maximalMarginalRelevance,
} from "../engine/hybrid_search";
import { blobToVector } from "../engine/embeddings";

/**
 * Infer relationship type based on note types.
 * Falls back to "related_to" when no specific inference applies.
 */
export function inferRelationship(
  fromType: NoteType,
  toType: NoteType
): RelationshipType {
  // Decision supersedes open_thread (the thread was resolved by a decision)
  if (fromType === "decision" && toType === "open_thread") return "supersedes";
  if (fromType === "open_thread" && toType === "decision") return "supersedes";

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
  includeSuperseded = false
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

  try {
    const rows = db
      .query(
        `SELECT n.id, n.type, n.content, n.confidence, n.created_at, n.updated_at, n.source_session, n.superseded_by, n.keywords, n.tags,
                bm25(notes_fts, 1.0, 0.5, 2.0) AS rank
         FROM notes_fts
         JOIN notes n ON notes_fts.rowid = n.rowid
         WHERE notes_fts MATCH ?
           ${includeSuperseded ? "" : "AND n.superseded_by IS NULL"}
         ORDER BY rank ASC
         LIMIT ?`
      )
      .all(ftsQuery, limit) as Array<{
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
      rank: number;
    }>;

    return rows.map((r) => ({
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
  includeSuperseded = false
): Promise<NoteSummary[]> {
  // Fallback: no vector, just use existing FTS5 search
  if (!queryVector) {
    return findRelatedNotes(db, query, limit, includeSuperseded);
  }

  // 1. FTS5 ranked list
  const ftsResults = findRelatedNotes(db, query, limit * 3, includeSuperseded);
  const ftsRanks = new Map<string, number>();
  ftsResults.forEach((r, i) => ftsRanks.set(r.id, i + 1));

  // Build a lookup of FTS results by id for later
  const noteById = new Map<string, NoteSummary>();
  for (const r of ftsResults) {
    noteById.set(r.id, r);
  }

  // 2. Vector search: fetch all embeddings, compute cosine similarity, rank
  const embRows = db
    .query(`SELECT e.note_id, e.vector FROM embeddings e`)
    .all() as Array<{ note_id: string; vector: Buffer }>;

  const vecScores: Array<{ id: string; similarity: number }> = [];
  for (const row of embRows) {
    const vec = blobToVector(row.vector as Buffer);
    const sim = cosineSimilarity(queryVector, vec);
    vecScores.push({ id: row.note_id, similarity: sim });
  }

  // Sort descending by similarity and assign ranks
  vecScores.sort((a, b) => b.similarity - a.similarity);
  const vecRanks = new Map<string, number>();
  vecScores.forEach((v, i) => vecRanks.set(v.id, i + 1));

  // 3. Reciprocal Rank Fusion
  const rrfResults = reciprocalRankFusion(ftsRanks, vecRanks);

  // Expand candidate pool: load note data for any ids not already in noteById
  const candidateTopK = rrfResults.slice(0, limit * 2);
  for (const rrf of candidateTopK) {
    if (!noteById.has(rrf.id)) {
      const row = db
        .query(
          `SELECT id, type, content, confidence, created_at, updated_at, source_session, keywords, tags, status, priority, due_date, superseded_by
           FROM notes WHERE id = ?${includeSuperseded ? "" : " AND superseded_by IS NULL"}`
        )
        .get(rrf.id) as {
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
        });
      }
    }
  }

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
 */
export function createAutoLinks(
  db: Database,
  noteId: string,
  keywords: string[],
  minOverlap = 2
): Link[] {
  if (keywords.length === 0) return [];

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

  const links: Link[] = [];
  const timestamp = now();

  for (const candidate of candidates) {
    const candidateKeywords = candidate.keywords
      .split(",")
      .map((k) => k.trim().toLowerCase())
      .filter((k) => k.length > 0);

    // Calculate overlap
    const overlap = candidateKeywords.filter((k) => noteKeywords.has(k));

    if (overlap.length >= minOverlap) {
      const strength =
        overlap.length >= 5
          ? "strong"
          : overlap.length >= 3
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

      db.run(
        `INSERT INTO links (id, from_note_id, to_note_id, relationship, strength, created_at)
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
  }

  return links;
}
