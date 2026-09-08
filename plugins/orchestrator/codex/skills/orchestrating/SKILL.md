---
name: orchestrating
description: Use Orchestrator to retrieve and maintain persistent project knowledge and track work.
---

Use the loaded core MCP tools directly. `lookup` supports query, id, tag, code_ref, pagination, history and graph depth. `list_work_items` and `list_open_threads` provide inventories where keyword search would miss vocabulary variants.

Before implementation, check prior decisions with `check_similar({content:"approach"})` and look up the affected file with `lookup({code_ref:"relative/path"})`. Pair knowledge with current source and documentation.

Capture one durable idea per `note`, with type, content, tags and code_refs. If the tool identifies an existing note or pending capture, follow its returned schema and IDs. Use `update_note` for amendments, `supersede_note` for replacement, and `close_thread` for resolution. Work items use the same note store; use create/update/breakdown for task fields.

Use `save_progress` at milestones. Run `retro` when an explicit maintenance pass is useful; automatic retro is disabled in Codex while other hosts share the store.
