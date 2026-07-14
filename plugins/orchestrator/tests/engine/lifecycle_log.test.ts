import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { appendLifecycleLine } from "../../mcp/engine/lifecycle_log";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lifecycle-log-test-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const CAP = 1024;
const NOW = "2026-07-13T00:00:00.000Z";

describe("appendLifecycleLine", () => {
  test("creates the parent directory and writes the line", () => {
    const p = join(dir, "nested", "deep", "mcp-lifecycle.log");
    appendLifecycleLine(p, "[orchestrator] started pid=1\n", CAP, NOW);
    expect(existsSync(p)).toBe(true);
    expect(readFileSync(p, "utf8")).toBe("[orchestrator] started pid=1\n");
  });

  test("appends across calls, preserving order", () => {
    const p = join(dir, "mcp-lifecycle.log");
    appendLifecycleLine(p, "line-1\n", CAP, NOW);
    appendLifecycleLine(p, "line-2\n", CAP, NOW);
    expect(readFileSync(p, "utf8")).toBe("line-1\nline-2\n");
  });

  test("truncate-rotates when the file exceeds capBytes, keeping the triggering line", () => {
    const p = join(dir, "mcp-lifecycle.log");
    writeFileSync(p, "X".repeat(CAP + 10)); // already over cap
    appendLifecycleLine(p, "fresh-line\n", CAP, NOW);
    const out = readFileSync(p, "utf8");
    expect(out).not.toContain("XXXX"); // old bulk gone
    expect(out).toContain("log rotated"); // rotation marker present
    expect(out).toContain(NOW); // marker carries the timestamp
    expect(out.endsWith("fresh-line\n")).toBe(true); // triggering line retained
    expect(out.length).toBeLessThan(CAP); // back under cap
  });

  test("does not rotate while under cap", () => {
    const p = join(dir, "mcp-lifecycle.log");
    appendLifecycleLine(p, "small\n", CAP, NOW);
    appendLifecycleLine(p, "also-small\n", CAP, NOW);
    const out = readFileSync(p, "utf8");
    expect(out).not.toContain("log rotated");
    expect(out).toBe("small\nalso-small\n");
  });

  test("NEVER throws when the path cannot be created (crash-safety invariant)", () => {
    // Make the parent a FILE so mkdir of a subdir under it fails (ENOTDIR).
    // This is the load-bearing property: the helper runs inside the MCP's
    // uncaughtException/unhandledRejection handlers, so it must swallow every
    // error rather than compound a crash.
    const blocker = join(dir, "blocker");
    writeFileSync(blocker, "i am a file, not a dir");
    const p = join(blocker, "sub", "mcp-lifecycle.log");
    expect(() =>
      appendLifecycleLine(p, "should-be-swallowed\n", CAP, NOW),
    ).not.toThrow();
    expect(existsSync(p)).toBe(false); // nothing written under the blocker
  });
});
