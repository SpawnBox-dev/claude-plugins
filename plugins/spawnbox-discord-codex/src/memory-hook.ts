// Reuses the native orchestrator lifecycle engine, with conversation-local global
// memory as well as project memory. No private room reads the shared fleet DB.
import { join } from "node:path";
export {};
const input = JSON.parse(await Bun.stdin.text());
process.env.ORCHESTRATOR_HOST = "codex";
process.env.ORCHESTRATOR_MODE = "standalone";
process.env.ORCHESTRATOR_PROJECT_ROOT = input.cwd;
process.env.ORCHESTRATOR_WORKTREE_ROOT = input.cwd;
process.env.ORCHESTRATOR_GLOBAL_DB = join(
  input.cwd,
  ".orchestrator",
  "global.db",
);
process.env.ORCHESTRATOR_EMBEDDINGS = "off";
try {
  const { getProjectDb, closeAll } = await import(
    "../../orchestrator/mcp/db/connection"
  );
  const { handleCodexHook } = await import(
    "../../orchestrator/mcp/runtime/codex-hooks"
  );
  try {
    console.log(JSON.stringify(handleCodexHook(getProjectDb(), input)));
  } finally {
    closeAll();
  }
} catch (error) {
  console.error(String(error));
  console.log("{}");
}
