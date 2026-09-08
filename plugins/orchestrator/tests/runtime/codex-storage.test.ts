import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { codexSidecarCompatible } from "../../mcp/runtime/codex-sidecar";
import { currentCodexSession, withCodexRequest } from "../../mcp/runtime/profile";

test("an invalid host identity cannot fall back to an inherited parent task", () => {
  const previous = process.env.CODEX_THREAD_ID;
  try {
    process.env.CODEX_THREAD_ID = "unrelated-parent-task";
    expect(withCodexRequest({ threadId: "?invalid" }, currentCodexSession)).toBeUndefined();
    expect(withCodexRequest({ threadId: "valid-child-task" }, currentCodexSession)).toBe("codex-valid-child-task");
  } finally {
    if (previous === undefined) delete process.env.CODEX_THREAD_ID;
    else process.env.CODEX_THREAD_ID = previous;
  }
});

test("sidecar adoption checks model and actual vector width, not health alone", async () => {
  const client = (model: string, dim: number, actual = dim) => ({ health: async () => ({ status: "ready", model, dim }), embed: async () => [new Float32Array(actual)] });
  expect(await codexSidecarCompatible(client("BAAI/bge-base-en-v1.5", 768))).toBe(true);
  expect(await codexSidecarCompatible(client("other-model", 768))).toBe(false);
  expect(await codexSidecarCompatible(client("BAAI/bge-base-en-v1.5", 768, 384))).toBe(false);
  expect(await codexSidecarCompatible({ health: async () => null, embed: async () => null })).toBe(false);
});

test("Claude and Codex initialize and write a fresh shared store concurrently", async () => {
  const root = mkdtempSync(join(tmpdir(), "orchestrator-concurrent-init-"));
  const module = pathToFileURL(resolve(import.meta.dir, "../../mcp/db/connection.ts")).href;
  const workers = Array.from({ length: 4 }, (_, n) => Bun.spawn([process.execPath, "-e", `const {getProjectDb, closeAll} = await import(${JSON.stringify(module)}); getProjectDb().run('INSERT INTO plugin_state(key,value,updated_at) VALUES(?,?,?)', ['worker-${n}', 'ok', new Date().toISOString()]); closeAll();`], { env: { ...process.env, ORCHESTRATOR_HOST: n % 2 ? "claude" : "codex", ORCHESTRATOR_MODE: n % 2 ? "fleet" : "standalone", ORCHESTRATOR_PROJECT_ROOT: root }, stdout: "pipe", stderr: "pipe" }));
  for (const worker of workers) {
    const error = new Response(worker.stderr).text();
    expect(await worker.exited, await error).toBe(0);
  }
  const db = new Database(join(root, ".orchestrator/project.db"), { readonly: true });
  try {
    expect((db.query("SELECT count(*) AS n FROM plugin_state WHERE key LIKE 'worker-%'").get() as { n: number }).n).toBe(4);
    expect(db.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
  } finally { db.close(); }
}, 15000);
