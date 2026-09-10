// Installed ONLY in the dedicated HELP Codex home. No effect on ordinary Codex
// or Claude tasks. Tool names are provided by the host, never Discord content.
import { memoryTools, projectKnowledgeTools } from "./memory-policy";
const allowed = new Set([
  "mcp__spawnbox_discord__context",
  "mcp__spawnbox_discord__schedule_review",
  "mcp__spawnbox_discord__list_reviews",
  "mcp__spawnbox_discord__cancel_review",
  "mcp__spawnbox_discord__review_report",
  "mcp__spawnbox_discord__reply",
  "mcp__spawnbox_discord__react",
  "mcp__spawnbox_discord__edit_message",
  "mcp__spawnbox_discord__fetch_messages",
  "mcp__spawnbox_discord__download_attachment",
  "mcp__spawnbox_discord__read_resource",
  "mcp__spawnbox_discord__record_note",
  "mcp__spawnbox_discord__no_reply",
  "mcp__spawnbox_discord__needs_operator",
  "mcp__spawnbox_discord__forum_action",
  "mcp__spawnbox_discord__member_info",
  "mcp__spawnbox_discord__moderate",
  "mcp__spawnbox_discord__create_support",
  "mcp__spawnbox_discord__list_channels",
  "mcp__spawnbox_discord__create_forum_post",
  "mcp__spawnbox_discord__send_file",
  "mcp__spawnbox_discord__diagnostic",
  "mcp__orchestrator__system_status",
  "mcp__orchestrator__briefing",
  "mcp__orchestrator__lookup",
  "mcp__orchestrator__note",
  "mcp__orchestrator__save_progress",
  "mcp__orchestrator__check_similar",
  "mcp__orchestrator__create_work_item",
  "mcp__orchestrator__update_work_item",
  "mcp__orchestrator__list_work_items",
  ...memoryTools.map(name => `mcp__orchestrator__${name}`),
  ...projectKnowledgeTools.map(name => `mcp__project_knowledge__${name}`),
]);
export function guard(input: any) {
  const name = input?.tool_name;
  // Codex 0.153.3 supports deny here, but reports explicit allow as an invalid
  // hook result. Empty output preserves the host's normal approval policy.
  if (typeof name === "string" && allowed.has(name)) return {};
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason:
        "HELP conversations use only the scoped Discord and memory tools. Host commands, code edits and other integrations require the local operator.",
    },
  };
}
if (import.meta.main) {
  try {
    console.log(JSON.stringify(guard(JSON.parse(await Bun.stdin.text()))));
  } catch {
    console.log(JSON.stringify(guard(null)));
  }
}
