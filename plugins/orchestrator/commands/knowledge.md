---
description: "Browse the orchestrator's knowledge graph - search, filter by type/domain, inspect notes, resolve threads"
---

Ask the user what they want to explore:
1. **Search by topic** - use `lookup` with query and optionally depth > 1 for graph traversal
2. **Browse by type** - use `lookup` with type filter (decision, convention, architecture, open_thread, etc.)
3. **View autonomy scores** - use `retro` to see domain maturity
4. **View user model** - use `lookup` with type "user_pattern" to see learned patterns
5. **Resolve threads** - use `close_thread` to mark open_threads or commitments as done

Present results interactively - let the user drill into specific notes by ID.
When viewing a note by ID, use depth=2 or depth=3 to show its neighborhood in the knowledge graph.
