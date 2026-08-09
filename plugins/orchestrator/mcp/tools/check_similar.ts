import type { Database } from "bun:sqlite";
import { blobToVector, ACTIVE_EMBED_MODEL } from "../engine/embeddings";
import { cosineSimilarity } from "../engine/hybrid_search";
import type { NoteType } from "../types";

export interface CheckSimilarInput {
  proposed_action: string;
  types?: NoteType[];
  threshold?: number;
}

export interface SimilarNote {
  id: string;
  type: string;
  content: string;
  similarity: number;
}

const DEFAULT_TYPES: NoteType[] = ["decision", "convention", "anti_pattern"];
const DEFAULT_THRESHOLD = 0.5;
const MAX_RESULTS = 10;

export function handleCheckSimilar(
  db: Database,
  queryVector: Float32Array | null,
  input: CheckSimilarInput
): { results: SimilarNote[]; message: string } {
  if (queryVector === null) {
    return {
      results: [],
      message: "Embedding sidecar unavailable",
    };
  }

  const types = input.types ?? DEFAULT_TYPES;
  const threshold = input.threshold ?? DEFAULT_THRESHOLD;

  // Build type filter placeholders
  const placeholders = types.map(() => "?").join(",");

  const rows = db
    .query(
      // 0.47.2: restrict to the ACTIVE model. Vectors written by a previous
      // model share no coordinate system with the query and are not even the
      // same length. Without this the near-duplicate gate compares a 384-dim
      // query against 1024-dim rows; cosineSimilarity's dimension guard makes
      // that score 0 rather than garbage, so the failure is silent - the gate
      // simply stops noticing duplicates and every write sails through.
      // Filtering makes the degradation explicit and self-healing: notes
      // rejoin the comparison as they are re-embedded.
      `SELECT n.id, n.type, n.content, e.vector
       FROM notes n
       JOIN embeddings e ON n.id = e.note_id
       WHERE n.type IN (${placeholders})
         AND n.resolved = 0
         AND e.model = ?`
    )
    .all(...types, ACTIVE_EMBED_MODEL) as Array<{
    id: string;
    type: string;
    content: string;
    vector: Buffer;
  }>;

  const scored: SimilarNote[] = [];

  for (const row of rows) {
    const noteVector = blobToVector(row.vector);
    const similarity = cosineSimilarity(queryVector, noteVector);

    if (similarity >= threshold) {
      scored.push({
        id: row.id,
        type: row.type,
        content: row.content,
        similarity,
      });
    }
  }

  // Sort descending by similarity
  scored.sort((a, b) => b.similarity - a.similarity);

  // Limit to MAX_RESULTS
  const results = scored.slice(0, MAX_RESULTS);

  const message =
    results.length > 0
      ? `Found ${results.length} similar note(s).`
      : "No similar notes found.";

  return { results, message };
}
