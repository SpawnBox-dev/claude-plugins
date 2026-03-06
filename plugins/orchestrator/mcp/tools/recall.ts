import type { Database } from "bun:sqlite";
import type { Note, NoteSummary, NoteType } from "../types";
import { findRelatedNotes } from "../engine/linker";

export interface RecallInput {
  query?: string;
  id?: string;
  type?: NoteType;
  limit?: number;
}

export interface RecallResult {
  results: NoteSummary[];
  detail:
    | (Note & { links: Array<{ relationship: string; note: NoteSummary }> })
    | null;
  message: string;
}

function tryFetchNote(db: Database, id: string): Note | null {
  const row = db
    .query(
      `SELECT id, type, content, keywords, confidence, created_at, updated_at,
              source AS source_conversation, context, resolved
       FROM notes WHERE id = ?`
    )
    .get(id) as any | null;

  if (!row) return null;

  return {
    id: row.id,
    type: row.type,
    content: row.content,
    keywords: row.keywords
      ? row.keywords
          .split(",")
          .map((k: string) => k.trim())
          .filter((k: string) => k.length > 0)
      : [],
    confidence: row.confidence,
    created_at: row.created_at,
    updated_at: row.updated_at,
    source_conversation: row.source_conversation ?? null,
    superseded_by: null,
    is_global: false,
  };
}

function fetchLinkedNotes(
  db: Database,
  noteId: string
): Array<{ relationship: string; note: NoteSummary }> {
  const rows = db
    .query(
      `SELECT l.relationship, l.from_note_id, l.to_note_id,
              n.id, n.type, n.content, n.confidence, n.created_at, n.keywords
       FROM links l
       JOIN notes n ON (
         CASE WHEN l.from_note_id = ? THEN l.to_note_id ELSE l.from_note_id END = n.id
       )
       WHERE l.from_note_id = ? OR l.to_note_id = ?`
    )
    .all(noteId, noteId, noteId) as any[];

  return rows.map((r: any) => ({
    relationship: r.relationship,
    note: {
      id: r.id,
      type: r.type,
      content: r.content,
      confidence: r.confidence,
      created_at: r.created_at,
      keywords: r.keywords
        ? r.keywords
            .split(",")
            .map((k: string) => k.trim())
            .filter((k: string) => k.length > 0)
        : [],
    },
  }));
}

export function handleRecall(
  projectDb: Database,
  globalDb: Database,
  input: RecallInput
): RecallResult {
  const limit = input.limit ?? 10;

  // Detail mode: fetch a specific note by ID
  if (input.id) {
    let note = tryFetchNote(projectDb, input.id);
    let db = projectDb;
    let isGlobal = false;

    if (!note) {
      note = tryFetchNote(globalDb, input.id);
      db = globalDb;
      isGlobal = true;
    }

    if (!note) {
      return {
        results: [],
        detail: null,
        message: `No note found with id "${input.id}".`,
      };
    }

    note.is_global = isGlobal;
    const links = fetchLinkedNotes(db, input.id);

    return {
      results: [],
      detail: { ...note, links },
      message: `Found note "${input.id}" with ${links.length} link(s).`,
    };
  }

  // Search mode: query both DBs
  if (input.query) {
    const projectResults = findRelatedNotes(projectDb, input.query, limit);
    const globalResults = findRelatedNotes(globalDb, input.query, limit);

    // Merge and deduplicate by id
    const seen = new Set<string>();
    const merged: NoteSummary[] = [];

    for (const r of [...projectResults, ...globalResults]) {
      if (!seen.has(r.id)) {
        seen.add(r.id);
        merged.push(r);
      }
    }

    // Filter by type if specified
    let filtered = merged;
    if (input.type) {
      filtered = merged.filter((r) => r.type === input.type);
    }

    // Limit results
    const results = filtered.slice(0, limit);

    return {
      results,
      detail: null,
      message:
        results.length > 0
          ? `Found ${results.length} note(s) matching "${input.query}".`
          : `No notes found matching "${input.query}".`,
    };
  }

  return {
    results: [],
    detail: null,
    message: "Provide either a query or an id to recall notes.",
  };
}
