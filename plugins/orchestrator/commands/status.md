---
description: "Show current orchestrator state: open threads, checkpoint, neglected areas, autonomy scores"
---

Show the user a comprehensive view of orchestrator state:

1. Call `briefing` with event "startup" to get the current briefing (includes checkpoint, open threads, decisions, drift warnings, user patterns, cross-project patterns, AND `curation_candidates` surfacing stale-but-hot and low-confidence-but-hot notes with maintenance handles). Note: on the first startup of a week, briefing may be prepended with an `## Auto-Retro` section - that's the R4.4 auto-retro gate firing (weekly maintenance). Show it to the user if present; it's informational, not an error.
2. Call `retro` to get autonomy scores and knowledge health metrics (if auto-retro already ran in step 1, the summaries will be recent - mention that to the user so they understand why the output isn't dramatically new)
3. Present both results clearly, organized by section

Additionally, use these tools for complete inventories:
- Call `list_work_items` for a full inventory of tracked work (filterable by status/priority)
- Call `list_open_threads` for a complete list of open threads (no keyword search needed)
- Call `system_status` to show embedding sidecar health and coverage stats

Highlight any areas needing attention:
- Open threads that have been open for a long time
- Domains with "sparse" autonomy (need more knowledge)
- Drift warnings (too much focus in one area)
- Notes queued for revalidation
- Low embedding coverage (if sidecar is down or behind)
