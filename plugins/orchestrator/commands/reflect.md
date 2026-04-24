---
description: "Trigger orchestrator knowledge maintenance: consolidation, confidence decay, gap analysis"
---

Call the orchestrator MCP `retro` tool.
Present the results to the user and offer to address any revalidation items.
If there are orphan notes, offer to review and link them.
If confidence was decayed on notes, offer to revalidate the most important ones.

Note on cadence: `retro` now auto-fires from `briefing` on a 7-day cadence (R4.4 auto-retro gate). So manual `/reflect` is a force-refresh - useful after a heavy debugging session or when the user wants an immediate maintenance pass without waiting for the weekly gate. If auto-retro already ran recently, the manual run will produce similar output; mention that to the user to avoid confusion about "nothing changed."

R5 verification: when `CLAUDE_PROJECT_DIR` (or fallback `ORCHESTRATOR_PROJECT_ROOT`) is set, retro also checks file-existence for every path in every note's `code_refs` breadcrumb array and reports `code_refs verified: N checked, M broken`. If M > 0, surface the count and offer to investigate - broken refs may need `supersede_note` (the code moved), `update_note` with corrected code_refs (the code was renamed), or `delete_note` (the knowledge is no longer applicable).
