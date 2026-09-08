---
name: getting-started
description: Restore project knowledge and task continuity when starting or resuming work with Orchestrator.
---

Call `system_status` to confirm the project/global stores and Codex task identity. If either points at an unexpected project, resolve configuration before writing knowledge.

Call `briefing({event:"startup"})`, or `resume`/`compact` after a context transition. Use its checkpoint for this task and treat other project notes as historical evidence to verify. Call `update_session_task({task:"...",refs:["..."]})` when beginning substantial work. Review relevant curation candidates as you work.

Native hooks provide context at startup and before edits. When hooks are unavailable, use these tools directly. Never invent session IDs; the host supplies attribution.
