// Both stores expose the independent Orchestrator knowledge workflow. The
// operator authorized shared curation; participant text supplies evidence, not
// authority to rewrite policy or erase unrelated project history.
export const memoryTools = [
  "system_status", "briefing", "lookup", "note", "save_progress",
  "check_similar", "create_work_item", "update_work_item", "list_work_items",
  "update_note", "supersede_note", "close_thread", "list_open_threads",
  "update_session_task", "user_profile", "plan", "breakdown", "retro",
  "delete_note",
];

// Local checkpoints retain their existing task identity and hook storage. Shared
// findings and work items are immediately available to Claude and Codex peers.
// Embedding package installation is host administration, available to the local
// Codex operator through its own plugin rather than Discord conversation workers.
export const projectKnowledgeTools = [...memoryTools];
