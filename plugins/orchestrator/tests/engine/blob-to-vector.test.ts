import { describe, test, expect } from "bun:test";
import { blobToVector } from "../../mcp/engine/embeddings";

// 0.48.1 - blobToVector copied unconditionally, and MEASURED on the live KB
// that copy was 92% of the cost of a vector search: 15,474 chunk vectors cost
// 164ms to copy against 15ms of actual cosine math, where a zero-copy view
// took 6ms. Every lookup paid it and it grows with the KB forever.
//
// The copy was NOT superstition - Float32Array over a buffer throws unless the
// byteOffset is 4-aligned, and SQLite blobs carry no alignment guarantee. So
// the correctness cases below matter more than the speed: the fast path must
// produce EXACTLY what the copy path produced, and the guard must catch every
// input the fast path cannot handle.

function f32(values: number[]): Float32Array {
  return new Float32Array(values);
}

/** A Buffer whose byteOffset is deliberately NOT 4-aligned. */
function misalignedBuffer(values: number[]): Buffer {
  const src = Buffer.from(f32(values).buffer);
  const padded = Buffer.alloc(src.length + 1);
  src.copy(padded, 1); // offset 1 => byteOffset % 4 === 1
  return padded.subarray(1);
}

describe("blobToVector", () => {
  test("round-trips values from an aligned buffer", () => {
    const original = f32([0.5, -0.25, 1, 0]);
    const blob = Buffer.from(original.buffer);
    const out = blobToVector(blob);
    expect(Array.from(out)).toEqual([0.5, -0.25, 1, 0]);
  });

  test("round-trips values from a MISALIGNED buffer (the fallback path)", () => {
    // This is the input that makes the fast path throw. If the guard is ever
    // removed, this test is what fails instead of production.
    const blob = misalignedBuffer([0.5, -0.25, 1, 0]);
    expect(blob.byteOffset % 4).not.toBe(0);
    const out = blobToVector(blob);
    expect(Array.from(out)).toEqual([0.5, -0.25, 1, 0]);
  });

  test("aligned and misaligned inputs produce IDENTICAL output", () => {
    // The optimisation is only valid if the two paths are indistinguishable.
    const values = [0.1, 0.2, -0.3, 0.4, 100.5, -0.000125, 0, 1];
    const a = blobToVector(Buffer.from(f32(values).buffer));
    const b = blobToVector(misalignedBuffer(values));
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  test("does not throw on a byteLength that is not a multiple of 4", () => {
    // A truncated/corrupt row must degrade, not crash a search.
    const odd = Buffer.alloc(7);
    expect(() => blobToVector(odd)).not.toThrow();
  });

  test("length reflects the element count, not the byte count", () => {
    const out = blobToVector(Buffer.from(f32([1, 2, 3, 4, 5]).buffer));
    expect(out.length).toBe(5);
  });

  test("an empty blob yields an empty vector", () => {
    expect(blobToVector(Buffer.alloc(0)).length).toBe(0);
  });

  test("reads a slice of a larger pooled buffer correctly", () => {
    // Node/Bun hand out Buffers backed by shared pools, so a nonzero
    // byteOffset is the NORMAL case, not an edge case - getting this wrong
    // reads a neighbouring row's bytes and silently returns a wrong vector.
    const pool = Buffer.alloc(64);
    const wanted = f32([9, 8, 7, 6]);
    Buffer.from(wanted.buffer).copy(pool, 16); // 16 is 4-aligned
    const view = pool.subarray(16, 32);
    expect(Array.from(blobToVector(view))).toEqual([9, 8, 7, 6]);
  });
});
