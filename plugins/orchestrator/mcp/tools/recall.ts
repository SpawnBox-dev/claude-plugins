import type { Database } from "bun:sqlite";
import type { Note, NoteSummary, NoteType, NoteRevision } from "../types";
import { findRelatedNotes, findRelatedNotesHybrid } from "../engine/linker";
import type { EmbeddingClient } from "../engine/embeddings";
import { parseCodeRefs } from "../utils";
import { resolveNoteId } from "./id_resolver";

export interface RecallInput {
  query?: string;
  id?: string;
  type?: NoteType;
  tag?: string;
  limit?: number;
  /** 0.30.26+ pagination cursor for list-mode + search-mode results.
   *  Pass `offset: <N>` with the same `limit` to fetch the next page. */
  offset?: number;
  depth?: number;
  include_superseded?: boolean;
  include_history?: boolean;
  link_limit?: number;
  /** R5 reverse-index: filter search results to notes whose code_refs array
   *  includes this exact path string. No wildcards; exact match. */
  code_ref?: string;
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
              superseded_by, superseded_at, status, priority, due_date, code_refs
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
    code_refs: parseCodeRefs(row.code_refs ?? null),
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
  // R3.7: filter by the notes.superseded_by column in both directions so that
  // historical auto-linker supersedes edges (which only exist in the links
  // table, with no matching column update) don't pollute the chain render.
  // handleSupersede is the only path that writes BOTH the link AND the column
  // atomically; any edge where those don't agree is a stale false positive.

  // Outgoing supersedes edges: notes THIS note supersedes. The target note's
  // superseded_by column must point back at us for the edge to be valid.
  const supersedesRows = db.query(
    `SELECT n.id, n.type, n.content, n.confidence, n.created_at, n.updated_at,
            n.source_session, n.superseded_by, n.keywords, n.tags, n.status, n.priority, n.due_date, n.code_refs
     FROM links l JOIN notes n ON l.to_note_id = n.id
     WHERE l.from_note_id = ? AND l.relationship = 'supersedes'
       AND n.superseded_by = ?
     ORDER BY l.created_at ASC`
  ).all(noteId, noteId) as any[];

  // Incoming supersedes edges: notes that supersede THIS. The current note's
  // superseded_by column must point at the from-node of each edge.
  const supersededByRows = db.query(
    `SELECT n.id, n.type, n.content, n.confidence, n.created_at, n.updated_at,
            n.source_session, n.superseded_by, n.keywords, n.tags, n.status, n.priority, n.due_date, n.code_refs
     FROM links l JOIN notes n ON l.from_note_id = n.id
     WHERE l.to_note_id = ? AND l.relationship = 'supersedes'
       AND EXISTS (SELECT 1 FROM notes curr WHERE curr.id = ? AND curr.superseded_by = n.id)
     ORDER BY l.created_at ASC`
  ).all(noteId, noteId) as any[];

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
    code_refs: parseCodeRefs(r.code_refs ?? null),
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
              n.source_session, n.superseded_by, n.keywords, n.tags, n.status, n.priority, n.due_date, n.code_refs,
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
          code_refs: parseCodeRefs(r.code_refs ?? null),
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

  // Detail mode: fetch a specific note by ID. Accepts the full 36-char UUID
  // or the 8-char id8 prefix that the orchestrator surfaces in hook hints,
  // agent-channel events, and stop nudges.
  if (input.id) {
    let resolved = resolveNoteId(projectDb, input.id);
    let db = projectDb;
    let isGlobal = false;

    if (!resolved.id && !resolved.ambiguous) {
      resolved = resolveNoteId(globalDb, input.id);
      db = globalDb;
      isGlobal = true;
    }

    if (resolved.ambiguous) {
      return {
        results: [],
        detail: null,
        message: `ID prefix "${input.id}" is ambiguous in ${isGlobal ? "global" : "project"} DB - matches ${resolved.ambiguous.length} notes: ${resolved.ambiguous.join(", ")}. Use the full UUID.`,
      };
    }

    if (!resolved.id) {
      return {
        results: [],
        detail: null,
        message: `No note found with id "${input.id}".`,
      };
    }

    const fullId = resolved.id;
    const note = tryFetchNote(db, fullId);
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
    const { links, totalCount } = fetchLinkedNotes(db, fullId, depth, linkLimit);

    // R2: always surface supersede chain in detail (cheap single-hop graph query)
    const supersede_chain = fetchSupersedeChain(db, fullId);

    // R2: fetch revisions only when requested
    let revisions: NoteRevision[] | undefined = undefined;
    if (input.include_history) {
      revisions = fetchRevisions(db, fullId);
    }

    return {
      results: [],
      detail: { ...note, links, revisions, supersede_chain, total_link_count: totalCount },
      message: `Found note "${fullId}" with ${totalCount} link(s)${links.length < totalCount ? ` (showing top ${links.length} by relevance)` : ""}${revisions ? ` and ${revisions.length} revision(s)` : ""}.`,
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
  // 0.30.26+ pagination offset. Default 0. Used by both search-mode (page
  // through a stable ranking) and list-mode (page through a typed/tagged
  // enumeration). Search-mode fetches `offset + limit` raw rows then slices
  // the post-filter result.
  const offset = Math.max(0, input.offset ?? 0);

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

    // 0.30.26+ pagination: fetch (offset + limit + 1) from each DB so we
    // can detect whether more results exist after the current page. Hybrid
    // search's ranking is stable-enough across calls that paging through
    // this way is safe for sequential reads.
    const fetchSize = offset + limit + 1;

    // R5.2 Important-3: propagate code_ref as a SQL-level pre-filter into the
    // FTS + hybrid search so the 2x-limit slice is already narrowed to notes
    // referencing the requested path. The TS post-filter below is kept as a
    // correctness belt (LIKE is a coarse substring check; exact-match happens
    // after).
    const projectResults = await findRelatedNotesHybrid(
      projectDb,
      input.query,
      fetchSize,
      queryVector,
      0.7,
      includeSuperseded,
      input.code_ref
    );
    const globalResults = await findRelatedNotesHybrid(
      globalDb,
      input.query,
      fetchSize,
      queryVector,
      0.7,
      includeSuperseded,
      input.code_ref
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

    // R5 reverse-index: filter by exact code_ref membership. No index on
    // code_refs, so a TS post-filter is simpler and safer than an escaped
    // SQL LIKE. The NoteSummary already carries parsed code_refs from the
    // per-DB SELECTs above, so this is a plain Array.includes check.
    if (input.code_ref) {
      const needle = input.code_ref;
      filtered = filtered.filter(
        (r) => Array.isArray(r.code_refs) && r.code_refs.includes(needle)
      );
    }

    // Page slice: offset...offset+limit
    const results = filtered.slice(offset, offset + limit);

    const totalHint = getTotalHint(projectDb, globalDb, input.type);
    const moreHint =
      filtered.length > offset + limit
        ? ` (paginated: ${results.length} of ${filtered.length} known; pass \`offset: ${offset + limit}\` for next page)`
        : "";
    const offsetLabel = offset > 0 ? ` from offset ${offset}` : "";

    return {
      results,
      detail: null,
      message:
        results.length > 0
          ? `Found ${results.length} note(s) matching "${input.query}"${offsetLabel}.${totalHint}${moreHint}`
          : offset > 0
            ? `No more results after offset ${offset} for "${input.query}".${totalHint}`
            : `No notes found matching "${input.query}".${totalHint}`,
    };
  }

  // 0.30.20+: type-only / tag-only enumeration mode. When neither id nor
  // query is provided but type or tag is, return the N most-recent notes
  // matching the filters. Lets callers like /pa-bootstrap do
  // `lookup({type: "user_pattern", limit: 25})` to surface recent
  // user-knowledge without inventing a meaningful query string.
  if (input.type || input.tag) {
    const conditions: string[] = [];
    const params: (string | number)[] = [];
    if (input.type) {
      conditions.push("type = ?");
      params.push(input.type);
    }
    if (input.tag) {
      // Tags column is a comma-delimited list; substring match with
      // word-boundary protection via SQL LIKE on the surrounding commas.
      conditions.push("(',' || COALESCE(tags, '') || ',') LIKE ?");
      params.push(`%,${input.tag},%`);
    }
    if (!(input.include_superseded ?? false)) {
      conditions.push("superseded_by IS NULL");
    }
    if (input.code_ref) {
      conditions.push("code_refs LIKE ?");
      params.push(`%${input.code_ref}%`);
    }
    const whereClause = conditions.join(" AND ");

    // 0.30.26+ pagination: per-DB query fetches enough rows to cover the
    // post-merge slice (offset + limit) PLUS ONE row to detect whether
    // there's another page available. We don't push OFFSET into the SQL
    // directly because each DB independently ranks by updated_at; we want
    // the GLOBAL ordering after merge, so we slice the merged result.
    const fetchSize = offset + limit + 1;
    const sql = `
      SELECT id, type, content, keywords, confidence, created_at, updated_at,
             source_session, code_refs, tags, superseded_by, status, priority, due_date
      FROM notes
      WHERE ${whereClause}
      ORDER BY updated_at DESC
      LIMIT ?
    `;
    params.push(fetchSize);

    const projectRows = projectDb.query(sql).all(...params) as any[];
    const globalRows = globalDb.query(sql).all(...params) as any[];
    const allMerged = [...projectRows, ...globalRows]
      .sort((a, b) => (b.updated_at ?? "").localeCompare(a.updated_at ?? ""));
    const merged = allMerged.slice(offset, offset + limit);
    const hasMore = allMerged.length > offset + limit;

    const results: NoteSummary[] = merged.map((row) => ({
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
      tags: row.tags ?? null,
      code_refs: parseCodeRefs(row.code_refs ?? null),
      source_session: row.source_session ?? null,
      superseded_by: row.superseded_by ?? null,
      status: row.status ?? null,
      priority: row.priority ?? null,
      due_date: row.due_date ?? null,
    }));

    const filterLabel = [
      input.type ? `type="${input.type}"` : null,
      input.tag ? `tag="${input.tag}"` : null,
      input.code_ref ? `code_ref="${input.code_ref}"` : null,
    ]
      .filter(Boolean)
      .join(", ");

    const offsetLabel = offset > 0 ? ` from offset ${offset}` : "";
    const moreHint = hasMore
      ? ` (pass \`offset: ${offset + limit}\` for next page)`
      : "";

    return {
      results,
      detail: null,
      message:
        results.length > 0
          ? `Listed ${results.length} most-recent note(s) matching {${filterLabel}}${offsetLabel}.${moreHint}`
          : offset > 0
            ? `No more results after offset ${offset} for {${filterLabel}}.`
            : `No notes match {${filterLabel}}. (Pass a query or id for semantic search.)`,
    };
  }

  return {
    results: [],
    detail: null,
    message: "Provide either a query, an id, or a type/tag filter to recall notes.",
  };
}
