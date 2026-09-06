import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  appendLifecycleLine,
  emitLifecycleLine,
  stampLifecycleLine,
} from "../../mcp/engine/lifecycle_log";

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

const T = "2026-09-06T16:30:00.000Z";

describe("emitLifecycleLine", () => {
  test("writes the durable file even when the stderr writer throws (transport-death safety)", () => {
    // The whole point: during transport death stderr is a dead pipe and its
    // write raises (EPIPE-class). That must NOT skip the durable file write -
    // otherwise the log is blind in exactly the scenario it exists to capture.
    const fileCalls: string[] = [];
    const stderr = () => {
      throw new Error("EPIPE: broken pipe");
    };
    expect(() =>
      emitLifecycleLine(stderr, (s) => fileCalls.push(s), "event\n", T),
    ).not.toThrow();
    expect(fileCalls).toEqual([`${T} event\n`]);
  });

  test("writes the file BEFORE stderr", () => {
    const order: string[] = [];
    emitLifecycleLine(
      () => order.push("stderr"),
      () => order.push("file"),
      "event\n",
      T,
    );
    expect(order).toEqual(["file", "stderr"]);
  });

  test("both sinks receive the exact SAME stamped line", () => {
    // Not just "both got a line": the two sinks must agree byte-for-byte, or
    // the durable file and the stderr trail disagree about when something
    // happened and correlating them becomes guesswork.
    let fileLine = "";
    let stderrLine = "";
    emitLifecycleLine(
      (s) => {
        stderrLine = s;
      },
      (s) => {
        fileLine = s;
      },
      "L\n",
      T,
    );
    expect(fileLine).toBe(`${T} L\n`);
    expect(stderrLine).toBe(fileLine);
  });
});

describe("stampLifecycleLine", () => {
  test("THE MOTIVATING CASE: an event line that carried no date now carries one", () => {
    // Verbatim shape of the line that was written 5 times on 2026-09-06 and
    // found by nobody, because every reader scoped its search by date and this
    // line had none. Asserting the real string, not a toy, so a format change
    // at the call site cannot quietly re-open the hole.
    const real =
      "[orchestrator] install-mismatch: this window is running the plugin from " +
      ".../orchestrator/0.69.10, but installed_plugins.json names .../0.69.11.\n";
    const out = stampLifecycleLine(real, T);
    expect(out.startsWith(`${T} [orchestrator] install-mismatch:`)).toBe(true);
    // A date-scoped read must now find it - that is the whole repair.
    expect(/^\d{4}-\d{2}-\d{2}T/.test(out)).toBe(true);
  });

  test("IDEMPOTENT: an already-stamped line is not stamped twice", () => {
    const once = stampLifecycleLine("[orchestrator] boot\n", T);
    expect(stampLifecycleLine(once, "2026-01-01T00:00:00.000Z")).toBe(once);
  });

  test("the trailing newline is preserved exactly", () => {
    // The durable sink appends verbatim; eating the newline runs records
    // together and every line-oriented reader downstream breaks at once.
    expect(stampLifecycleLine("x\n", T).endsWith("\n")).toBe(true);
    expect(stampLifecycleLine("x\n", T)).toBe(`${T} x\n`);
  });

  test("only the FIRST physical line of a multi-line record is stamped", () => {
    // A crash stack is ONE record. Stamping every frame corrupts the trace for
    // anything that parses it; the frames are already scoped by the stamped
    // line above them.
    const stack = "[orchestrator] crash\n  at foo()\n  at bar()\n";
    const out = stampLifecycleLine(stack, T);
    expect(out).toBe(`${T} ${stack}`);
    expect(out.split("\n")[1]).toBe("  at foo()");
  });

  test("a line already carrying at=<iso> INSIDE it still gets a leading stamp", () => {
    // The 7707 dated lines are dated mid-line via `at=`, which no line-leading
    // date filter matches. If the idempotence guard were written as "contains a
    // date" rather than "STARTS WITH one", those lines would stay unfindable
    // and the fix would silently cover only 183 of 7890 lines.
    const alive = `[orchestrator] alive at=${T} pid=24500\n`;
    expect(stampLifecycleLine(alive, T)).toBe(`${T} ${alive}`);
  });
});
