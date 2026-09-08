import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";

export function runtimeProfile(env: NodeJS.ProcessEnv = process.env) {
  const host = env.ORCHESTRATOR_HOST || "claude";
  const mode = env.ORCHESTRATOR_MODE || (host === "codex" ? "standalone" : "fleet");
  if (!((host === "claude" && mode === "fleet") || (host === "codex" && mode === "standalone"))) {
    throw new Error(`Unsupported orchestrator runtime: ${host}/${mode}`);
  }
  return { host, mode, standalone: host === "codex" } as const;
}

// Evaluated before server startup, including ancestry checks and timers.
export const RUNTIME = runtimeProfile();
const requests = new AsyncLocalStorage<{ sessionId?: string }>();

export function codexSessionId(value: unknown): string | undefined {
  if (typeof value !== "string" || !/^(?:codex-)?[a-zA-Z0-9_-]{8,160}$/.test(value)) return undefined;
  return value.startsWith("codex-") ? value : `codex-${value}`;
}

export function currentCodexSession(): string | undefined {
  const request = requests.getStore();
  return request ? request.sessionId : codexSessionId(process.env.CODEX_THREAD_ID);
}

export function withCodexRequest<T>(meta: Record<string, unknown> | undefined, run: () => T): T {
  // Metadata comes from the MCP host, never from an ordinary tool argument.
  // Codex 0.153.3 injects threadId on native MCP calls (verified by the native smoke).
  // An invalid supplied identity must not fall back to an inherited parent task.
  const sessionId = meta && "threadId" in meta ? codexSessionId(meta.threadId) : codexSessionId(process.env.CODEX_THREAD_ID);
  return requests.run({ sessionId }, run);
}

export function resolveCodexAttribution(explicit?: string): string | undefined {
  const bound = currentCodexSession();
  if (explicit && bound && codexSessionId(explicit) !== bound) {
    throw new Error("session_id does not match the Codex task bound to this request");
  }
  return bound;
}

export function workingRoot(): string {
  return resolve(process.env.ORCHESTRATOR_WORKTREE_ROOT || process.cwd());
}

export function knowledgeRoot(): string {
  if (!RUNTIME.standalone) return resolve(process.env.ORCHESTRATOR_PROJECT_ROOT || process.env.CLAUDE_PROJECT_DIR || process.cwd());
  let root = process.env.ORCHESTRATOR_PROJECT_ROOT;
  const configPath = join(workingRoot(), ".orchestrator", "codex.json");
  if (!root && existsSync(configPath)) {
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    if (typeof config.knowledgeRoot === "string") root = resolve(workingRoot(), config.knowledgeRoot);
  }
  const result = resolve(root || workingRoot());
  if (/\.(?:claude|codex)[\\/]plugins[\\/]cache(?:[\\/]|$)/i.test(result)) {
    throw new Error("Refusing to store knowledge in a plugin cache. Configure ORCHESTRATOR_PROJECT_ROOT or .orchestrator/codex.json.");
  }
  return result;
}

export const STANDALONE_INSTRUCTIONS = [
  "Orchestrator provides persistent project knowledge, work tracking and user preferences for this independent Codex task.",
  "Call briefing on startup or lost context; use lookup and check_similar alongside current source and documentation before substantive changes.",
  "Capture useful findings with note and code_refs. Amend or supersede existing knowledge when evidence changes. Use work-item tools to track delivery.",
  "Call save_progress at milestones and before finishing. Checkpoints and transient state are scoped to the current Codex task.",
  "Task identity is supplied by the host. Do not invent a session_id. system_status reports missing identity and hook delivery.",
  "Use retro explicitly for a maintenance pass; automatic retro is disabled in this host to avoid racing maintenance by other processes.",
].join("\n");

export const STANDALONE_DESCRIPTIONS: Record<string, string> = {
  note: "Capture a new finding, decision, convention, gotcha or question. First check existing knowledge; update or supersede an existing record when appropriate. Add repository-relative code_refs for code-specific knowledge. If the near-duplicate gate blocks a write, use its pending_id and resolution (accept_new, update_existing, supersede_existing or close_existing), without resending content. Judge the underlying claims against the returned evidence.",
  lookup: "Retrieve project and global knowledge alongside current source and documentation. Search by query, exact code_ref, type or tag, or read a full ID/unambiguous ID prefix. Use include_history for revisions, depth/link_limit for graph context, output_mode=summary for compact results, and limit/offset to page large sets.",
  create_work_item: "Create persistent, trackable work with priority, status, due date and optional parent. Add repository-relative code_refs when scoped to code. Use open_thread notes for unresolved questions.",
  briefing: "Read current project knowledge, work, preferences, curation candidates and this Codex task's checkpoint. Use at startup, resume or after compaction. Optional sections and summary output reduce context cost.",
  update_session_task: "Record this Codex task's current work and referenced notes/work items. Task text is limited to 2000 characters; save longer context in save_progress.",
  _hook_event: "Internal lifecycle adapter. Invoked by trusted Codex hooks; ordinary agent calls are unnecessary.",
  save_progress: "Save this Codex task's progress, in-flight work, questions and next steps for resume and compaction recovery.",
};
