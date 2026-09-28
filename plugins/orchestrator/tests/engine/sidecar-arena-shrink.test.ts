/**
 * THE SIDECAR RETURNS ITS ONNX ARENA AFTER EVERY RUN.
 *
 * Measured 2026-09-28 (the numbers are beside _RUN_OPTIONS in embed_server.py):
 * without shrinkage a sidecar kept ~2.4 GB working set / ~3.3 GB private
 * after one backfill-sized call, for as long as it lived; with it, ~0.5 GB /
 * ~1.0 GB, same vectors. That measurement needs onnxruntime and a model
 * download, so it is not repeated here - this pins the WIRING that the
 * measurement depends on, which is exactly what a refactor would silently
 * drop (the option object built but never passed to run()).
 */
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const PY = readFileSync(join(import.meta.dir, "..", "..", "sidecar", "embed_server.py"), "utf8");

describe("sidecar arena shrinkage", () => {
  test("the run options enable CPU arena shrinkage", () => {
    expect(PY).toContain(
      '_RUN_OPTIONS.add_run_config_entry("memory.enable_memory_arena_shrinkage", "cpu:0")',
    );
  });

  test("the embed path passes them to run()", () => {
    // _embed_batch is the call that runs the big batches; without the options
    // there, it keeps its arena forever. (The one-off "hello" probe at load
    // time is too small to matter and is left alone.)
    const body = PY.slice(PY.indexOf("def _embed_batch("), PY.indexOf("def _rss_mb("));
    expect(body).toContain("_session.run([_output_name], feed, _RUN_OPTIONS)");
  });

  test("the arena is not disabled - shrinkage requires it ON", () => {
    expect(PY).not.toMatch(/enable_cpu_mem_arena\s*=\s*False/);
  });

  test("/health says so, so a reader can tell the fixed code is running", () => {
    expect(PY).toContain('"arena_shrink": True');
  });
});
