---
description: "Browse the orchestrator's knowledge graph - search, filter by type/domain, inspect notes, resolve threads"
---

Ask the user what they want to explore:
1. **Search by topic** - use `lookup` with query and optionally depth > 1 for graph traversal
2. **Browse by type** - use `lookup` with type filter (decision, convention, architecture, open_thread, etc.). By default, superseded notes are hidden - pass `include_superseded: true` on lookup to see archived notes (useful when auditing what direction was rejected / evolved away from). When drilling into a specific note, use `lookup({id: X, include_history: true})` to see the revision chain R2 captured before each edit (shows how the note evolved, not just its current state), and `lookup({id: X, link_limit: 500})` if the default top-20 linked notes is too narrow for the investigation.
3. **Find notes about a specific file** - use `lookup({code_ref: 'mcp/server.ts'})` for the R5 reverse-index. Returns notes whose code_refs breadcrumb array contains that exact path - answers "what do we know about this file?" queries as a complement to keyword search. Exact path match, no wildcards.
4. **View autonomy scores** - use `retro` to see domain maturity (note: retro also auto-fires weekly from briefing per R4.4, so running /reflect may show recent maintenance already happened)
5. **View user model** - use `lookup` with type "user_pattern" to see learned patterns
6. **Resolve threads** - use `close_thread` to mark open_threads or commitments as done. For threads where the resolution is a new-note-replaces-old pattern, prefer `supersede_note(old_id, new_id)` over `close_thread` - preserves history and graph-links the replacement.

Present results interactively - let the user drill into specific notes by ID.
When viewing a note by ID, use depth=2 or depth=3 to show its neighborhood in the knowledge graph.
