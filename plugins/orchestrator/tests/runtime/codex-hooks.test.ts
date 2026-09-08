import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { applyMigrations } from "../../mcp/db/schema";
import { affectedFiles, failedTool, handleCodexHook } from "../../mcp/runtime/codex-hooks";
import { runtimeProfile, withCodexRequest, currentCodexSession, resolveCodexAttribution } from "../../mcp/runtime/profile";
import { resolve } from "node:path";

test("runtime selection preserves Claude and rejects incompatible modes", () => {
  expect(runtimeProfile({}).standalone).toBe(false);
  expect(runtimeProfile({ ORCHESTRATOR_HOST: "codex" }).standalone).toBe(true);
  expect(() => runtimeProfile({ ORCHESTRATOR_HOST: "codex", ORCHESTRATOR_MODE: "fleet" })).toThrow();
});

test("request identity stays isolated under concurrent async calls and rejects mismatched attribution", async () => {
  const ids = await Promise.all(["task-one-123", "task-two-456"].map(id => withCodexRequest({ threadId: id }, async () => {
    await Bun.sleep(2);
    expect(() => resolveCodexAttribution("other-task-789")).toThrow();
    return currentCodexSession();
  })));
  expect(ids).toEqual(["codex-task-one-123", "codex-task-two-456"]);
});

test("multi-file patches track add, remove and both rename paths without escaping the checkout", () => {
  const cwd = resolve("fixture");
  const patch = "*** Begin Patch\n*** Add File: src/new.ts\n+x\n*** Update File: src/old.ts\n*** Move to: src/renamed.ts\n@@\n-x\n+y\n*** Delete File: src/gone.ts\n*** Add File: ../outside.ts\n+x\n*** End Patch";
  expect(affectedFiles({ input: patch }, cwd)).toEqual(["src/new.ts", "src/old.ts", "src/renamed.ts", "src/gone.ts"]);
  expect(affectedFiles({ command: patch }, cwd)).toEqual(["src/new.ts", "src/old.ts", "src/renamed.ts", "src/gone.ts"]);
});

test("nonzero shell results are failures even when the tool itself returned normally", () => {
  expect(failedTool({ exit_code: 1, output: "failed" })).toBe(true);
  expect(failedTool('Process exited with code 2')).toBe(true);
  expect(failedTool('Exit code: 1\nOutput: Failed')).toBe(true);
  expect(failedTool({ exit_code: 0, output: "done" })).toBe(false);
});

test("file context, bounded stop, compaction and task isolation work without fleet state", () => {
  const db = new Database(":memory:");
  applyMigrations(db, "project");
  try {
    db.run("INSERT INTO notes(id,type,content,keywords,confidence,created_at,updated_at,code_refs) VALUES(?,?,?,?,?,?,?,?)", ["known-note", "convention", "Keep the retry id stable", "retry", "high", "2026-09-08", "2026-09-08", '["src/retry.ts"]']);
    const base = { session_id: "task-one-123", cwd: resolve("fixture") };
    handleCodexHook(db, { ...base, hook_event_name: "SessionStart" });
    const edit = { ...base, tool_name: "functions.apply_patch", tool_input: { input: "*** Update File: src/retry.ts\n@@\n-a\n+b" } };
    expect(JSON.stringify(handleCodexHook(db, { ...edit, hook_event_name: "PreToolUse" }))).toContain("Keep the retry id stable");
    handleCodexHook(db, { ...edit, hook_event_name: "PostToolUse", tool_response: { exit_code: 0 } });
    expect(handleCodexHook(db, { ...base, hook_event_name: "Stop", turn_id: "turn-1" }).decision).toBe("block");
    expect(handleCodexHook(db, { ...base, hook_event_name: "Stop", turn_id: "turn-1" })).toEqual({});
    handleCodexHook(db, { ...base, hook_event_name: "PreCompact" });
    expect(JSON.stringify(handleCodexHook(db, { ...base, hook_event_name: "SessionStart", source: "compact" }))).toContain("src/retry.ts");
    expect(JSON.stringify(handleCodexHook(db, { ...base, session_id: "task-two-456", hook_event_name: "SessionStart", source: "compact" }))).not.toContain("src/retry.ts");
    const failedEdit = { ...edit, session_id: "task-three-789" };
    handleCodexHook(db, { ...failedEdit, hook_event_name: "PostToolUse", tool_response: { exit_code: 1 } });
    expect(handleCodexHook(db, { ...failedEdit, hook_event_name: "Stop" })).toEqual({});
  } finally { db.close(); }
});
