import type { Database } from "bun:sqlite";
import { extractKeywords, now } from "../utils";

/**
 * Minimum absolute count of shared keywords required in addition to the
 * Jaccard ratio threshold for a near-duplicate match.
 *
 * Rationale (R3.5a): when both notes have few keywords, even 1-2 shared
 * tokens can cross a Jaccard ratio of 0.6 and trigger a false-positive
 * dedup or link. Requiring at least this many shared tokens guards against
 * tiny-keyword-set coincidences. Exact content matches bypass this gate.
 */
export const MIN_SHARED_KEYWORDS = 3;

interface DuplicateMatch {
  id: string;
  content: string;
  similarity: number;
}

/**
 * Check if content is a duplicate of an existing note of the same type.
 */
export function isDuplicate(
  db: Database,
  type: string,
  content: string,
  threshold = 0.6
): boolean {
  return findDuplicates(db, type, content, threshold).length > 0;
}

/**
 * Find duplicate or near-duplicate notes of the same type.
 * Uses exact match first, then Jaccard similarity on keywords.
 */
export function findDuplicates(
  db: Database,
  type: string,
  content: string,
  threshold = 0.6
): DuplicateMatch[] {
  const normalizedContent = content.trim().toLowerCase();
  const inputKeywords = new Set(extractKeywords(content));
  const matches: DuplicateMatch[] = [];

  // Get all notes of the same type
  const candidates = db
    .query(`SELECT id, content, keywords FROM notes WHERE type = ?`)
    .all(type) as Array<{ id: string; content: string; keywords: string }>;

  for (const candidate of candidates) {
    // Check exact match (case-insensitive, trimmed)
    if (candidate.content.trim().toLowerCase() === normalizedContent) {
      matches.push({ id: candidate.id, content: candidate.content, similarity: 1.0 });
      continue;
    }

    // Check keyword overlap via Jaccard similarity
    const candidateKeywords = new Set(
      candidate.keywords
        ? candidate.keywords
            .split(",")
            .map((k) => k.trim().toLowerCase())
            .filter((k) => k.length > 0)
        : extractKeywords(candidate.content)
    );

    if (inputKeywords.size === 0 && candidateKeywords.size === 0) continue;

    const intersection = new Set(
      [...inputKeywords].filter((k) => candidateKeywords.has(k))
    );
    const union = new Set([...inputKeywords, ...candidateKeywords]);
    const similarity = union.size > 0 ? intersection.size / union.size : 0;

    if (intersection.size >= MIN_SHARED_KEYWORDS && similarity >= threshold) {
      matches.push({ id: candidate.id, content: candidate.content, similarity });
    }
  }

  // Sort by similarity descending
  matches.sort((a, b) => b.similarity - a.similarity);
  return matches;
}

/**
 * Merge duplicate notes: keep the newest, delete older duplicates,
 * and re-link any links from deleted notes to the survivor.
 * Returns the number of notes merged (deleted).
 */
export function mergeDuplicates(db: Database): number {
  // Find all note types that have potential duplicates
  const types = db
    .query(`SELECT DISTINCT type FROM notes`)
    .all() as Array<{ type: string }>;

  let totalMerged = 0;

  for (const { type } of types) {
    const notes = db
      .query(
        `SELECT id, content, keywords, created_at FROM notes WHERE type = ? ORDER BY created_at DESC`
      )
      .all(type) as Array<{
      id: string;
      content: string;
      keywords: string;
      created_at: string;
    }>;

    const merged = new Set<string>();

    for (let i = 0; i < notes.length; i++) {
      if (merged.has(notes[i].id)) continue;

      const iKeywords = new Set(
        notes[i].keywords
          ? notes[i].keywords
              .split(",")
              .map((k) => k.trim().toLowerCase())
              .filter((k) => k.length > 0)
          : extractKeywords(notes[i].content)
      );

      for (let j = i + 1; j < notes.length; j++) {
        if (merged.has(notes[j].id)) continue;

        // Check exact match
        const exactMatch =
          notes[i].content.trim().toLowerCase() ===
          notes[j].content.trim().toLowerCase();

        if (!exactMatch) {
          // Check Jaccard similarity
          const jKeywords = new Set(
            notes[j].keywords
              ? notes[j].keywords
                  .split(",")
                  .map((k) => k.trim().toLowerCase())
                  .filter((k) => k.length > 0)
              : extractKeywords(notes[j].content)
          );

          if (iKeywords.size === 0 && jKeywords.size === 0) continue;

          const intersection = new Set(
            [...iKeywords].filter((k) => jKeywords.has(k))
          );
          const union = new Set([...iKeywords, ...jKeywords]);
          const similarity =
            union.size > 0 ? intersection.size / union.size : 0;

          if (similarity < 0.6 || intersection.size < MIN_SHARED_KEYWORDS) continue;
        }

        // notes[i] is the survivor (newer), notes[j] gets merged into it
        const survivorId = notes[i].id;
        const victimId = notes[j].id;

        // Re-link: point any links from/to the victim at the survivor.
        //
        // 0.30.92 BUGFIX - this threw SQLITE_CONSTRAINT_UNIQUE and took the
        // ENTIRE weekly maintenance pass down with it.
        //
        // `links` carries UNIQUE(from_note_id, to_note_id, relationship). A
        // plain UPDATE re-points the victim's edges onto the survivor, so any
        // neighbour BOTH already link to produces a duplicate edge and the
        // statement throws. The de-dup cleanup below was written to handle
        // exactly that collision, but it runs AFTER the update that dies - the
        // ordering makes it unreachable.
        //
        // At the observed scale a collision is not an edge case, it is a
        // certainty: 959,125 links across 6,827 notes (~140 each, top node
        // 1,119), so two merge candidates virtually always share neighbours.
        //
        // BLAST RADIUS, which is why this is the highest-value fix of the
        // session: handleReflect wraps decayAllSignals + mergeDuplicates in ONE
        // transaction, and handleOrient inline-invokes handleReflect on the
        // weekly auto-retro gate. So the throw rolled back the decay too, and
        // NO maintenance has been completing on this database - no signal
        // decay, no duplicate merging. That is a large part of how the graph
        // reached 959K links and the file reached 490MB unchecked. The failure
        // was silent because the caller catches and logs.
        //
        // OR IGNORE skips the colliding rows; the victim's now-redundant edges
        // are removed wholesale below, which is correct because the survivor
        // already holds an equivalent edge.
        db.run(
          `UPDATE OR IGNORE links SET from_note_id = ? WHERE from_note_id = ?`,
          [survivorId, victimId]
        );
        db.run(
          `UPDATE OR IGNORE links SET to_note_id = ? WHERE to_note_id = ?`,
          [survivorId, victimId]
        );

        // Anything still pointing at the victim is a collision OR IGNORE
        // skipped - the survivor already has that edge, so drop it.
        db.run(
          `DELETE FROM links WHERE from_note_id = ? OR to_note_id = ?`,
          [victimId, victimId]
        );

        // Remove self-links that may have formed
        db.run(
          `DELETE FROM links WHERE from_note_id = to_note_id`
        );

        // Remove duplicate links. Grouped by the FULL unique key including
        // relationship - grouping by (from,to) alone deleted distinct
        // relationship edges between the same pair, which the unique index
        // explicitly permits.
        db.run(
          `DELETE FROM links WHERE rowid NOT IN (
             SELECT MIN(rowid) FROM links GROUP BY from_note_id, to_note_id, relationship
           )`
        );

        // Delete the victim
        db.run(`DELETE FROM notes WHERE id = ?`, [victimId]);

        merged.add(victimId);
        totalMerged++;
      }
    }
  }

  return totalMerged;
}
