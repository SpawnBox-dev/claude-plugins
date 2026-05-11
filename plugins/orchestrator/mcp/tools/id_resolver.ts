import type { Database } from "bun:sqlite";

export interface ResolveIdResult {
  id: string | null;
  ambiguous?: string[];
}

/**
 * Resolve a note id that may be the full 36-char UUID OR the 8-char hex
 * id8 prefix surfaced in hook hints, agent-channel events, and stop nudges.
 *
 * Exact match wins. If the input is exactly 8 hex chars and doesn't match
 * exactly, fall back to `id LIKE 'prefix-%'`. A single match returns the
 * full UUID; multiple matches return `{ id: null, ambiguous: [...] }` so
 * callers can surface a helpful "ambiguous prefix" error instead of
 * silently picking the wrong note.
 *
 * Single-DB scope: callers that span project + global call this once per DB.
 */
export function resolveNoteId(
  db: Database,
  idOrPrefix: string
): ResolveIdResult {
  if (!idOrPrefix) return { id: null };

  const exact = db
    .query("SELECT id FROM notes WHERE id = ? LIMIT 1")
    .get(idOrPrefix) as { id: string } | null;
  if (exact) return { id: exact.id };

  if (!/^[0-9a-f]{8}$/i.test(idOrPrefix)) return { id: null };

  const matches = db
    .query("SELECT id FROM notes WHERE id LIKE ? LIMIT 5")
    .all(`${idOrPrefix.toLowerCase()}-%`) as { id: string }[];

  if (matches.length === 0) return { id: null };
  if (matches.length === 1) return { id: matches[0].id };

  return { id: null, ambiguous: matches.map((m) => m.id) };
}
