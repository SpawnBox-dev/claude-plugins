import type { Database } from "bun:sqlite";
import type { Note, NoteSummary, NoteType, NoteRevision } from "../types";
import { findRelatedNotes, findRelatedNotesHybrid } from "../engine/linker";
import type { EmbeddingClient } from "../engine/embeddings";

export interface RecallInput {
  query?: string;
  id?: string;
  type?: NoteType;
  tag?: string;
  limit?: number;
  depth?: number;
  include_superseded?: boolean;
  include_history?: boolean;
  link_limit?: number;
}

export interface LinkedNote {
  relationship: string;
  note: NoteSummary;
  depth: number;
}

export interface SupersedeChain {
  supersedes: NoteSummary[];
  superseded_by: NoteSummary[];
}

export interface RecallResult {
  results: NoteSummary[];
  detail: (Note & {
    links: LinkedNote[];
    revisions?: NoteRevision[];
    supersede_chain?: SupersedeChain;
    total_link_count?: number;
  }) | null;
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

function fetchRevisions(db: Database, noteId: string): NoteRevision[] {
  const rows = db.query(
    `SELECT id, note_id, content, context, tags, keywords, confidence, revised_at, revised_by_session
     FROM note_revisions WHERE note_id = ? ORDER BY revised_at ASC`
  ).all(noteId) as any[];
  return rows.map((r) => ({
    id: r.id,
    note_id: r.note_id,
    content: r.content,
    context: r.context ?? null,
    tags: r.tags ?? null,
    keywords: r.keywords ?? null,
    confidence: r.confidence ?? null,
    revised_at: r.revised_at,
    revised_by_session: r.revised_by_session ?? null,
  }));
}

function fetchSupersedeChain(db: Database, noteId: string): SupersedeChain {
  // Outgoing supersedes edges: notes THIS note supersedes
  const supersedesRows = db.query(
    `SELECT n.id, n.type, n.content, n.confidence, n.created_at, n.updated_at,
            n.source_session, n.superseded_by, n.keywords, n.tags, n.status, n.priority, n.due_date
     FROM links l JOIN notes n ON l.to_note_id = n.id
     WHERE l.from_note_id = ? AND l.relationship = 'supersedes'
     ORDER BY l.created_at ASC`
  ).all(noteId) as any[];

  const supersededByRows = db.query(
    `SELECT n.id, n.type, n.content, n.confidence, n.created_at, n.updated_at,
            n.source_session, n.superseded_by, n.keywords, n.tags, n.status, n.priority, n.due_date
     FROM links l JOIN notes n ON l.from_note_id = n.id
     WHERE l.to_note_id = ? AND l.relationship = 'supersedes'
     ORDER BY l.created_at ASC`
  ).all(noteId) as any[];

  const rowToSummary = (r: any): NoteSummary => ({
    id: r.id,
    type: r.type,
    content: r.content.length > 200 ? r.content.slice(0, 200) + `... [truncated - call lookup(id: "${r.id}") for full]` : r.content,
    confidence: r.confidence,
    created_at: r.created_at,
    updated_at: r.updated_at,
    source_session: r.source_session ?? null,
    superseded_by: r.superseded_by ?? null,
    keywords: r.keywords ? r.keywords.split(",").map((k: string) => k.trim()).filter(Boolean) : [],
    tags: r.tags ?? null,
    status: r.status ?? null,
    priority: r.priority ?? null,
    due_date: r.due_date ?? null,
  });

  return {
    supersedes: supersedesRows.map(rowToSummary),
    superseded_by: supersededByRows.map(rowToSummary),
  };
}

function fetchLinkedNotes(
  db: Database,
  noteId: string,
  maxDepth = 1,
  linkLimit = 20
): { links: LinkedNote[]; totalCount: number } {
  const results: LinkedNote[] = [];
  const visited = new Set<string>([noteId]);

  // Count total distinct non-supersede linked notes at depth 1 first (for tail message)
  const totalCountRow = db.query(
    `SELECT COUNT(DISTINCT CASE WHEN l.from_note_id = ? THEN l.to_note_id ELSE l.from_note_id END) AS c
     FROM links l
     WHERE (l.from_note_id = ? OR l.to_note_id = ?)
       AND l.relationship != 'supersedes'`
  ).get(noteId, noteId, noteId) as { c: number };
  const totalCount = totalCountRow.c;

  if (linkLimit === 0) {
    return { links: [], totalCount };
  }

  function traverse(currentId: string, currentDepth: number, limit: number): void {
    if (currentDepth > maxDepth) return;
    if (limit <= 0) return;

    // Composite ORDER BY: link strength (strong=3, moderate=2, weak=1 DESC), then note signal DESC, then note updated_at DESC
    // supersedes relationship is excluded (rendered by fetchSupersedeChain instead)
    const rows = db.query(
      `SELECT l.relationship, l.from_note_id, l.to_note_id, l.strength AS link_strength,
              n.id, n.type, n.content, n.confidence, n.created_at, n.updated_at,
              n.source_session, n.superseded_by, n.keywords, n.tags, n.status, n.priority, n.due_date,
              COALESCE(n.signal, 0) AS note_signal
       FROM links l
       JOIN notes n ON (
         CASE WHEN l.from_note_id = ? THEN l.to_note_id ELSE l.from_note_id END = n.id
       )
       WHERE (l.from_note_id = ? OR l.to_note_id = ?)
         AND l.relationship != 'supersedes'
       ORDER BY
         CASE l.strength WHEN 'strong' THEN 3 WHEN 'moderate' THEN 2 WHEN 'weak' THEN 1 ELSE 0 END DESC,
         COALESCE(n.signal, 0) DESC,
         n.updated_at DESC
       LIMIT ?`
    ).all(currentId, currentId, currentId, limit) as any[];

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
          superseded_by: r.superseded_by ?? null,
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

      // Recurse for deeper hops - pass remaining limit budget
      const remaining = limit - results.length;
      if (currentDepth < maxDepth && remaining > 0) {
        traverse(r.id, currentDepth + 1, remaining);
      }
    }
  }

  traverse(noteId, 1, linkLimit);
  return { links: results, totalCount };
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
    const linkLimit = input.link_limit ?? 20;
    const { links, totalCount } = fetchLinkedNotes(db, input.id, depth, linkLimit);

    // R2: always surface supersede chain in detail (cheap single-hop graph query)
    const supersede_chain = fetchSupersedeChain(db, input.id);

    // R2: fetch revisions only when requested
    let revisions: NoteRevision[] | undefined = undefined;
    if (input.include_history) {
      revisions = fetchRevisions(db, input.id);
    }

    return {
      results: [],
      detail: { ...note, links, revisions, supersede_chain, total_link_count: totalCount },
      message: `Found note "${input.id}" with ${totalCount} link(s)${links.length < totalCount ? ` (showing top ${links.length} by relevance)` : ""}${revisions ? ` and ${revisions.length} revision(s)` : ""}.`,
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

    const includeSuperseded = input.include_superseded ?? false;

    const projectResults = await findRelatedNotesHybrid(
      projectDb,
      input.query,
      limit,
      queryVector,
      0.7,
      includeSuperseded
    );
    const globalResults = await findRelatedNotesHybrid(
      globalDb,
      input.query,
      limit,
      queryVector,
      0.7,
      includeSuperseded
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
