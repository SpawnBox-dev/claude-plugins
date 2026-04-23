import type { Database } from "bun:sqlite";
import type { Note, NoteSummary, NoteType } from "../types";
import { findRelatedNotes, findRelatedNotesHybrid } from "../engine/linker";
import type { EmbeddingClient } from "../engine/embeddings";

export interface RecallInput {
  query?: string;
  id?: string;
  type?: NoteType;
  tag?: string;
  limit?: number;
  depth?: number;
}

export interface LinkedNote {
  relationship: string;
  note: NoteSummary;
  depth: number;
}

export interface RecallResult {
  results: NoteSummary[];
  detail: (Note & { links: LinkedNote[] }) | null;
  message: string;
}

function tryFetchNote(db: Database, id: string): Note | null {
  const row = db
    .query(
      `SELECT id, type, content, keywords, confidence, created_at, updated_at,
              source AS source_conversation, source_session, context, resolved,
              superseded_by, superseded_at, status, priority, due_date
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
    source_session: row.source_session ?? null,
    superseded_by: row.superseded_by ?? null,
    superseded_at: row.superseded_at ?? null,
    is_global: false,
    status: row.status ?? null,
    priority: row.priority ?? null,
    due_date: row.due_date ?? null,
  };
}

function fetchLinkedNotes(
  db: Database,
  noteId: string,
  maxDepth = 1
): LinkedNote[] {
  const results: LinkedNote[] = [];
  const visited = new Set<string>([noteId]);

  function traverse(currentId: string, currentDepth: number) {
    if (currentDepth > maxDepth) return;

    const rows = db
      .query(
        `SELECT l.relationship, l.from_note_id, l.to_note_id,
                n.id, n.type, n.content, n.confidence, n.created_at, n.updated_at,
                n.source_session, n.keywords, n.tags, n.status, n.priority, n.due_date
         FROM links l
         JOIN notes n ON (
           CASE WHEN l.from_note_id = ? THEN l.to_note_id ELSE l.from_note_id END = n.id
         )
         WHERE l.from_note_id = ? OR l.to_note_id = ?`
      )
      .all(currentId, currentId, currentId) as any[];

    for (const r of rows) {
      if (visited.has(r.id)) continue;
      visited.add(r.id);

      results.push({
        relationship: r.relationship,
        depth: currentDepth,
        note: {
          id: r.id,
          type: r.type,
          content: r.content.length > 200
            ? r.content.slice(0, 200) + `... [truncated - call lookup(id: "${r.id}") for full content]`
            : r.content,
          confidence: r.confidence,
          created_at: r.created_at,
          updated_at: r.updated_at,
          source_session: r.source_session ?? null,
          keywords: r.keywords
            ? r.keywords
                .split(",")
                .map((k: string) => k.trim())
                .filter((k: string) => k.length > 0)
            : [],
          tags: r.tags ?? null,
          status: r.status ?? null,
          priority: r.priority ?? null,
          due_date: r.due_date ?? null,
        },
      });

      // Recurse for deeper hops
      if (currentDepth < maxDepth) {
        traverse(r.id, currentDepth + 1);
      }
    }
  }

  traverse(noteId, 1);
  return results;
}

function getTotalHint(projectDb: Database, globalDb: Database, type?: NoteType): string {
  try {
    if (type) {
      const total = (projectDb.query("SELECT COUNT(*) as cnt FROM notes WHERE type = ?").get(type) as any).cnt;
      const globalTotal = (globalDb.query("SELECT COUNT(*) as cnt FROM notes WHERE type = ?").get(type) as any).cnt;
      return ` (~${total + globalTotal} ${type} notes in knowledge base)`;
    } else {
      const total = (projectDb.query("SELECT COUNT(*) as cnt FROM notes").get() as any).cnt;
      const globalTotal = (globalDb.query("SELECT COUNT(*) as cnt FROM notes").get() as any).cnt;
      return ` (~${total + globalTotal} total notes in knowledge base)`;
    }
  } catch {
    return "";
  }
}

export async function handleRecall(
  projectDb: Database,
  globalDb: Database,
  input: RecallInput,
  embeddingClient?: EmbeddingClient | null
): Promise<RecallResult> {
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
    const depth = input.depth ?? 1;
    const links = fetchLinkedNotes(db, input.id, depth);

    return {
      results: [],
      detail: { ...note, links },
      message: `Found note "${input.id}" with ${links.length} link(s).`,
    };
  }

  // Search mode: query both DBs via hybrid search (FTS5 + vector when
  // embeddings are available). If the sidecar is up, we generate ONE query
  // vector and pass it to both DB searches so they merge FTS5 BM25 with
  // cosine similarity via RRF+MMR. If the sidecar is down or embedding fails,
  // findRelatedNotesHybrid falls through to FTS5-only automatically.
  //
  // This is the v0.21 fix for the "lookup has zero resilience when FTS5
  // returns empty" problem. Before this change, a query like "storage
  // deduplication" would miss a note titled "compressed backup hashing"
  // because there's no keyword overlap - even though they're semantically
  // about the same thing. Vector search catches that.
  if (input.query) {
    let queryVector: Float32Array | undefined;
    if (embeddingClient) {
      try {
        const vecs = await embeddingClient.embed([input.query]);
        if (vecs && vecs.length > 0) {
          queryVector = vecs[0];
        }
      } catch (err) {
        // Sidecar failure is non-fatal - fall through to FTS5-only
        console.error(
          `[recall] Query embed failed, falling back to FTS5-only:`,
          err
        );
      }
    }

    const projectResults = await findRelatedNotesHybrid(
      projectDb,
      input.query,
      limit,
      queryVector
    );
    const globalResults = await findRelatedNotesHybrid(
      globalDb,
      input.query,
      limit,
      queryVector
    );

    // Interleave with reserved slots for global results.
    // Global DB has user_patterns, cross-project conventions, tool_capabilities -
    // these are few in number but high in value. Without reserved slots, the
    // larger project DB drowns them out in unfiltered queries.
    const GLOBAL_RESERVED = Math.min(3, globalResults.length);
    const seen = new Set<string>();
    const merged: NoteSummary[] = [];

    // Reserve top global results first
    for (let i = 0; i < GLOBAL_RESERVED; i++) {
      if (!seen.has(globalResults[i].id)) {
        seen.add(globalResults[i].id);
        merged.push({ ...globalResults[i], is_global: true } as any);
      }
    }

    // Interleave remaining: project results, then remaining global
    const remaining = [
      ...projectResults,
      ...globalResults.slice(GLOBAL_RESERVED),
    ];
    for (const r of remaining) {
      if (!seen.has(r.id)) {
        seen.add(r.id);
        merged.push(r);
      }
    }

    // Filter by type if specified
    let filtered = merged;
    if (input.type) {
      filtered = filtered.filter((r) => r.type === input.type);
    }

    // Filter by tag if specified (substring match on comma-separated tags field)
    if (input.tag) {
      const tagLower = input.tag.toLowerCase();
      filtered = filtered.filter((r) =>
        r.tags?.toLowerCase().includes(tagLower)
      );
    }

    // Limit results
    const results = filtered.slice(0, limit);

    const totalHint = getTotalHint(projectDb, globalDb, input.type);

    return {
      results,
      detail: null,
      message:
        results.length > 0
          ? `Found ${results.length} note(s) matching "${input.query}".${totalHint}`
          : `No notes found matching "${input.query}".${totalHint}`,
    };
  }

  return {
    results: [],
    detail: null,
    message: "Provide either a query or an id to recall notes.",
  };
}
