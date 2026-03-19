---
description: "Show current orchestrator state: open threads, checkpoint, neglected areas, autonomy scores"
---

Show the user a comprehensive view of orchestrator state:

1. Call `briefing` with event "startup" to get the current briefing (includes checkpoint, open threads, decisions, drift warnings, user patterns, cross-project patterns)
2. Call `retro` to get autonomy scores and knowledge health metrics
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
