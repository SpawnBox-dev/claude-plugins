// Conversation-local knowledge supports the complete independent workflow.
// Package installation and permanent deletion remain operator responsibilities.
export const memoryTools = [
  "system_status", "briefing", "lookup", "note", "save_progress",
  "check_similar", "create_work_item", "update_work_item", "list_work_items",
  "update_note", "supersede_note", "close_thread", "list_open_threads",
  "update_session_task", "user_profile", "plan", "breakdown", "retro",
];

// Full internal project context is useful for diagnosis and role continuity.
// Discord participants cannot mutate the shared project KB through this server.
export const projectKnowledgeTools = [
  "system_status", "lookup", "check_similar", "list_work_items",
  "list_open_threads", "user_profile",
];
