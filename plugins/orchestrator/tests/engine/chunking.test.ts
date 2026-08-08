import { describe, test, expect } from "bun:test";
import { chunkText, CHUNK_TARGET_CHARS, CHUNK_OVERLAP_CHARS } from "../../mcp/engine/chunking";

// Why chunking exists (measured 2026-08-08 on the live 7148-note KB):
//
// The sidecar truncates at 512 tokens (~2000 chars) and 3402 notes exceed
// that, so ~48% of the corpus was partially unembedded - the largest note had
// 97% of its text discarded. Worse, even text INSIDE the window retrieved
// badly, because one 1024-dim vector cannot represent a 5000-word note
// covering twenty separate claims; every specific idea averages into mush.
//
// Evidence: five paraphrase probes ranked the correct note #205, #967, #1206,
// #1688, #3247 out of 7148, while the same notes ranked #1 by keyword. Mean
// centering was tried and REFUTED (made ranks worse), ruling out anisotropy.
//
// Chunking fixes both at once: each chunk fits the window, and each chunk is
// about one thing, so a query matches a PASSAGE instead of a document average.

describe("chunkText", () => {
  test("short text yields exactly one chunk, unmodified", () => {
    const chunks = chunkText("a short note about docker");
    expect(chunks).toEqual(["a short note about docker"]);
  });

  test("empty or whitespace yields no chunks", () => {
    expect(chunkText("")).toEqual([]);
    expect(chunkText("   \n  ")).toEqual([]);
  });

  test("long text is split into multiple chunks", () => {
    const text = "x".repeat(CHUNK_TARGET_CHARS * 3);
    const chunks = chunkText(text);
    expect(chunks.length).toBeGreaterThan(2);
  });

  test("every chunk fits the embedding window", () => {
    // The whole point: a chunk longer than the 512-token window would be
    // silently truncated again, reintroducing the bug.
    const text = ("paragraph about the daemon and wsl. ".repeat(400));
    for (const c of chunkText(text)) {
      expect(c.length).toBeLessThanOrEqual(CHUNK_TARGET_CHARS + CHUNK_OVERLAP_CHARS);
    }
  });

  test("chunks overlap, so an idea spanning a boundary is not lost", () => {
    const a = "AAAA ".repeat(CHUNK_TARGET_CHARS / 5);
    const b = "BBBB ".repeat(CHUNK_TARGET_CHARS / 5);
    const chunks = chunkText(a + b);
    expect(chunks.length).toBeGreaterThan(1);
    // Consecutive chunks must share text, or a sentence split across the seam
    // belongs to neither chunk's meaning.
    const tail = chunks[0].slice(-50);
    expect(chunks[1].includes(tail.trim().slice(0, 20))).toBe(true);
  });

  test("prefers paragraph boundaries when one is available near the target", () => {
    const p1 = "First paragraph. ".repeat(60);   // ~1000 chars
    const p2 = "Second paragraph. ".repeat(60);
    const chunks = chunkText(p1 + "\n\n" + p2);
    // The first chunk should end at the blank line rather than mid-sentence.
    expect(chunks[0].trimEnd().endsWith("First paragraph.")).toBe(true);
  });

  test("the full text is recoverable across chunks (nothing silently dropped)", () => {
    const text = Array.from({ length: 40 }, (_, i) => `Sentence number ${i} about a distinct topic.`).join(" ");
    const joined = chunkText(text).join(" ");
    for (let i = 0; i < 40; i++) {
      expect(joined).toContain(`Sentence number ${i}`);
    }
  });

  test("a realistic long KB note produces a sane number of chunks", () => {
    const note = "This is a dense architectural note about the orchestrator. ".repeat(200); // ~11800 chars
    const chunks = chunkText(note);
    expect(chunks.length).toBeGreaterThanOrEqual(5);
    expect(chunks.length).toBeLessThanOrEqual(20); // not pathological
  });
});
