---
name: closing-a-thread
description: Resolve a tracked question or completed work item in Orchestrator.
---

Read the record and confirm its acceptance evidence. Use `close_thread({id:"...",resolution:"..."})` for a settled open thread, or `update_work_item({id:"...",status:"done"})` for completed work. Explain remaining limits when work is only partially done. Check dependent items after resolution.
