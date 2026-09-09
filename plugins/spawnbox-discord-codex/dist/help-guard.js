// @bun
// src/memory-policy.ts
var memoryTools = [
  "system_status",
  "briefing",
  "lookup",
  "note",
  "save_progress",
  "check_similar",
  "create_work_item",
  "update_work_item",
  "list_work_items",
  "update_note",
  "supersede_note",
  "close_thread",
  "list_open_threads",
  "update_session_task",
  "user_profile",
  "plan",
  "breakdown",
  "retro",
  "delete_note"
];
var projectKnowledgeTools = [...memoryTools];

// src/guard.ts
var allowed = new Set([
  "mcp__spawnbox_discord__context",
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
  ...memoryTools.map((name) => `mcp__orchestrator__${name}`),
  ...projectKnowledgeTools.map((name) => `mcp__project_knowledge__${name}`)
]);
function guard(input) {
  const name = input?.tool_name;
  if (typeof name === "string" && allowed.has(name))
    return {};
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: "HELP conversations use only the scoped Discord and memory tools. Host commands, code edits and other integrations require the local operator."
    }
  };
}
if (import.meta.main) {
  try {
    console.log(JSON.stringify(guard(JSON.parse(await Bun.stdin.text()))));
  } catch {
    console.log(JSON.stringify(guard(null)));
  }
}
export {
  guard
};
