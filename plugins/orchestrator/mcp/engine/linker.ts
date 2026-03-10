import type { Database } from "bun:sqlite";
import type { NoteSummary, Link, RelationshipType, NoteType } from "../types";
import { generateId, now } from "../utils";

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
 */
export function findRelatedNotes(
  db: Database,
  query: string,
  limit = 10
): NoteSummary[] {
  // Convert natural language to FTS5 syntax: filter short words, join with OR
  const terms = query
    .toLowerCase()
    .replace(/[^a-z0-9\s_-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2);

  if (terms.length === 0) return [];

  const ftsQuery = terms.join(" OR ");

  try {
    const rows = db
      .query(
        `SELECT n.id, n.type, n.content, n.confidence, n.created_at, n.keywords,
                bm25(notes_fts, 1.0, 0.5, 2.0) AS rank
         FROM notes_fts
         JOIN notes n ON notes_fts.rowid = n.rowid
         WHERE notes_fts MATCH ?
         ORDER BY rank ASC
         LIMIT ?`
      )
      .all(ftsQuery, limit) as Array<{
      id: string;
      type: string;
      content: string;
      confidence: string;
      created_at: string;
      keywords: string;
      rank: number;
    }>;

    return rows.map((r) => ({
      id: r.id,
      type: r.type as NoteSummary["type"],
      content: r.content,
      confidence: r.confidence as NoteSummary["confidence"],
      created_at: r.created_at,
      keywords: r.keywords ? r.keywords.split(",").map((k) => k.trim()) : [],
      status: (r as any).status ?? null,
      priority: (r as any).priority ?? null,
      due_date: (r as any).due_date ?? null,
    }));
  } catch {
    // FTS query can fail with unusual input - return empty
    return [];
  }
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
