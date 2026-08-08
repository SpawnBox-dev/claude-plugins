/**
 * Split note text into overlapping passages for embedding.
 *
 * WHY (measured 2026-08-08 against the live 7148-note KB):
 *
 * The sidecar tokenizer truncates at 512 tokens (~2000 chars) and 3402 notes
 * are longer than that, so roughly half the corpus was only partially
 * embedded - the largest note (61983 chars) had ~97% of its text discarded
 * before the vector was computed. bge-m3 supports 8192 tokens; we were using
 * 6% of it.
 *
 * But truncation was only half the problem. Even VERBATIM text from inside the
 * window failed to retrieve its own note (ranks #17-#1961), because a single
 * 1024-dim vector cannot represent a 5000-word note covering twenty separate
 * claims. Whatever specific idea you search for is averaged away. That also
 * explains why unrelated notes scored 0.73-0.79 cosine against each other:
 * every document-average looks like every other document-average.
 *
 * Evidence trail: five paraphrase probes ranked the correct note #205, #967,
 * #1206, #1688 and #3247 out of 7148, while the SAME notes ranked #1 by
 * keyword - so the data was findable and only meaning-matching was broken.
 * Mean-centering (the standard anisotropy fix) was tried and REFUTED: it fixed
 * the score collapse but made every rank worse, ruling that cause out.
 *
 * Chunking addresses both at once. Each chunk fits the window, so nothing is
 * truncated; and each chunk is about ONE thing, so a query matches a PASSAGE
 * rather than a document average. A note's score becomes its BEST chunk.
 *
 * Sizing: the target is deliberately well under the 512-token window
 * (~4 chars/token for English prose) so a chunk is never re-truncated. Keeping
 * chunks inside the existing window is also why this needed no change to the
 * Python sidecar.
 */

/** Target chunk size in characters. ~375 tokens of English prose, comfortably
 *  inside the sidecar's 512-token truncation window. */
export const CHUNK_TARGET_CHARS = 1500;

/** Overlap between consecutive chunks. An idea that straddles a boundary would
 *  otherwise belong to neither chunk's meaning. */
export const CHUNK_OVERLAP_CHARS = 200;

/** Below this, splitting costs more (extra vectors, diluted scores) than it
 *  buys - the note already fits in one window. */
const MIN_SPLIT_CHARS = CHUNK_TARGET_CHARS + CHUNK_OVERLAP_CHARS;

/**
 * Find a natural break at or before `limit`, preferring paragraph boundaries,
 * then sentence ends, then whitespace. Returns `limit` when the text has no
 * break at all (a pathological unbroken blob), so progress is guaranteed.
 */
function findBreak(text: string, from: number, limit: number): number {
  const window = text.slice(from, from + limit);
  // Only accept a break in the last third, or chunks become tiny.
  const floor = Math.floor(limit * 0.6);

  const para = window.lastIndexOf("\n\n");
  if (para >= floor) return from + para + 2;

  for (const re of [/\.\s/g, /\n/g, /\s/g]) {
    let best = -1;
    let m: RegExpExecArray | null;
    re.lastIndex = 0;
    while ((m = re.exec(window)) !== null) {
      if (m.index >= floor) best = m.index + m[0].length;
    }
    if (best >= floor) return from + best;
  }
  return from + limit;
}

/**
 * Split `text` into overlapping chunks. Returns [] for empty input and a
 * single unmodified chunk for anything that already fits.
 */
export function chunkText(text: string): string[] {
  const trimmed = text?.trim() ?? "";
  if (!trimmed) return [];
  if (trimmed.length <= MIN_SPLIT_CHARS) return [trimmed];

  const chunks: string[] = [];
  let pos = 0;
  while (pos < trimmed.length) {
    const remaining = trimmed.length - pos;
    if (remaining <= CHUNK_TARGET_CHARS + CHUNK_OVERLAP_CHARS) {
      chunks.push(trimmed.slice(pos).trim());
      break;
    }
    const end = findBreak(trimmed, pos, CHUNK_TARGET_CHARS);
    chunks.push(trimmed.slice(pos, end).trim());
    // Step back by the overlap so a boundary-straddling idea appears whole in
    // one of the two chunks. Guard forward progress against a tiny break.
    const next = Math.max(end - CHUNK_OVERLAP_CHARS, pos + 1);
    pos = next;
  }
  return chunks.filter((c) => c.length > 0);
}
