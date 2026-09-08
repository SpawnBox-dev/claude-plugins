// Set the explicit host profile before importing any shared runtime module.
export {};
const input = JSON.parse(await Bun.stdin.text());
process.env.ORCHESTRATOR_HOST = "codex";
process.env.ORCHESTRATOR_MODE = "standalone";
if (input.cwd) process.env.ORCHESTRATOR_WORKTREE_ROOT = input.cwd;
try {
  const { getProjectDb, closeAll } = await import("../mcp/db/connection");
  const { handleCodexHook } = await import("../mcp/runtime/codex-hooks");
  try { console.log(JSON.stringify(handleCodexHook(getProjectDb(), input))); }
  finally { closeAll(); }
} catch (error) {
  // A broken advisory must not block the user's work or trigger a retry loop.
  console.error(`[orchestrator] Codex hook failed: ${error instanceof Error ? error.message : error}`);
  console.log("{}");
}
