---
name: every-turn
description: >
  MANDATORY every turn. Evaluate which orchestrator tools and skills apply
  to what you're about to do, what just happened, and what you learned.
  This is your orchestrator intercept - run it before and after acting.
---

<HARD-GATE>
Do NOT skip this evaluation. If you catch yourself about to respond without scanning
the action table below, STOP and scan it. This is not optional. This is not negotiable.
Every turn means every turn - including "simple" ones, "quick" ones, and ones where
you think nothing noteworthy happened.
</HARD-GATE>

# Orchestrator Turn Evaluation

Run this evaluation every turn. It takes seconds and prevents you from missing context, losing knowledge, or contradicting past work.

## Concierge-first, direct-for-precision

You have two ways to talk to the orchestrator:

1. **The concierge** (persistent thinking partner, spawned once per session via `getting-started`, resumed with SendMessage). Handles judgment-heavy work: curated retrieval, batch captures, work triage, decision validation, deep exploration.
2. **Direct MCP calls** (`lookup`, `note`, `check_similar`, etc). Handles precision: exact-key retrieval, single fast captures, deterministic state changes.

**Default to the concierge for anything judgmental.** It already knows what you've done this session and won't repeat itself. Direct calls are the fast path for things that don't need judgment.

## Operation Routing Table

| Need | Route | Why |
|---|---|---|
| "What should I know about X?" | **Concierge** | Broad, judgment-heavy, wants curation |
| "What conventions apply in this area?" | **Concierge** | Multi-angle search + synthesis |
| "Complete inventory of Y" | **Concierge** | Direct lookup misses items with different vocabulary |
| "Find note with ID abc123" | **Direct `lookup`** | Exact-key retrieval, no judgment |
| "Find the broker convention" | **Direct `lookup`** | Specific known keyword |
| "Is there prior art for approach X?" | **Concierge** | Uses `check_similar` + synthesis |
| Quick fact-check ("was X decided?") | **Direct `lookup`** | Single-note answer |
| Save 1 note about 1 thing | **Direct `note`** | Fast, no batching needed |
| Save 3+ things at end of turn | **Concierge** | Type-picking, dedup, consolidation |
| Update a note's content | **Direct `update_note`** | Specific action. Prefer `append_content` mode for additive updates - no read-before-write, keywords auto-refresh |
| Replace outdated note with new version | **Direct `supersede_note`** | Preserves history, graph-links old->new, hides old from default lookup |
| Delete a note (genuinely wrong/harmful - last resort) | **Direct `delete_note`** | Destructive, main-agent judgment. Prefer `supersede_note` or `close_thread` when the note was right-at-the-time or now settled |
| Create a new work item | **Concierge** | Dup check + parent linkage + priority advice |
| Bump work item status to done | **Direct `update_work_item`** | Trivial state machine |
| Break down complex work | **Concierge** | Judgment-heavy decomposition |
| Validate "should I pick X over Y?" | **Concierge** | Conflict + anti-pattern scan |
| Close a resolved thread | **Direct `close_thread`** | Specific action |
| Session checkpoint | **Concierge (end-of-session) or direct `save_progress`** | Concierge can summarize state it already tracked |
| Set/update user profile observation | **Direct `user_profile`** | You observe the user, not concierge |
| Run maintenance | **Direct `retro`** | Deterministic. Also auto-fires from briefing on a 7-day cadence - no need to call manually unless forcing a refresh |
| Check health | **Direct `system_status`** | Deterministic |
| Capture knowledge about specific code | **Direct `note` with `code_refs: [paths]`** | Breadcrumbs at file/module granularity make the note findable later via `lookup({code_ref: 'path'})` |
| "What do we know about this file?" before editing | **Direct `lookup({code_ref: 'path/to/file'})`** | Reverse-index query - exact path match against the breadcrumb array |

## BEFORE you act this turn

**Starting a session or lost context?**
- Invoke `orchestrator:getting-started` - it calls `briefing` AND spawns the concierge in one shot

**About to implement something?**
- Send the concierge a pre-implementation query: "I'm about to touch X. Any conventions, anti-patterns, or prior decisions I should know?" Resume the existing concierge with SendMessage, don't spawn a new one.
- For exact-key precision lookups, use direct `lookup`.

**Building a list, audit, or inventory?**
- Always use the concierge. Direct lookup will miss items with different vocabulary - you won't know they're missing.

## AFTER you act this turn

Scan what just happened. Did any of these occur?

| What happened | Action |
|--------------|--------|
| You completed a task or step | → `update_work_item` status=done (direct, fast) |
| You started working on something trackable | → Ask concierge: "Should this be a new work item? Any overlaps with in-flight work?" |
| You're blocked on something | → `update_work_item` status=blocked, blocked_by=ID (direct) |
| You identified new work | → Concierge dup-check, then create (concierge does both) |
| Complex task needs breakdown | → Concierge `breakdown` with existing-item context |
| Knowledge evolved or needs correction | → `update_note` direct (use `append_content` mode for lightweight timestamped additions) OR `supersede_note` if the correction is substantial enough that the new content should be the canonical one going forward |
| A note is wrong or harmful | → Prefer `supersede_note` (replace with corrected version, preserves history) or `close_thread` (question was right-at-the-time, now settled). `delete_note` only as last resort |
| You made an architectural or design choice | → Concierge: "I just decided X. Check for contradictions and save it with the right type." |
| You discovered a pattern, convention, or gotcha | → Single item: direct `note`. Multiple: concierge batch capture. |
| Something failed or you pivoted | → Concierge: "Here's what failed and what worked. Save the lessons." |
| The user corrected you or stated a preference | → Direct `user_profile` + direct `note` (user_pattern scope=global) |
| Open thread resolved | → Direct `close_thread` |
| Hit a milestone or natural stopping point | → Concierge: "Checkpoint time. Summarize what we've done and what's open." |
| Significant systems changed | → `docs-manager:docs` |

**Multiple can apply in one turn.** If you made a decision AND learned a pattern AND the user stated a preference, route all three - decision and pattern go to concierge as a batch, user preference direct.

## Struggle Detection - STOP AND ASK THE CONCIERGE

<EXTREMELY_IMPORTANT>
If you notice ANY of these patterns, SendMessage the concierge IMMEDIATELY with a detailed description of what you're trying to do, what keeps failing, and what approaches you've tried:

**Signals you are struggling:**
- You've tried the same approach 2+ times with different variations and it keeps failing
- You're getting the same error/failure across multiple attempts
- You've been working on the same issue for 3+ turns without resolution
- You're guessing at solutions rather than working from known patterns
- You're editing code you just edited in the previous turn
- You keep hitting unexpected behavior that doesn't match your assumptions
- You're tempted to "try one more thing" without understanding why the last thing failed

**What to tell the concierge:**
1. What you're trying to accomplish (the goal, not the approach)
2. What you've tried so far and what happened
3. What error/behavior you're seeing
4. What assumptions you're working from

The PostToolUseFailure hook will also nudge you here automatically after 2+ consecutive tool failures. Listen to it.

**You are NOT "almost there." You are stuck.** Agents that keep hammering away without consulting the concierge waste enormous time rediscovering gotchas that are already documented. STOP. ASK. THEN proceed with the right approach.
</EXTREMELY_IMPORTANT>

## Red Flags

These thoughts mean STOP - you are rationalizing your way out of using the orchestrator:

| Thought | Reality |
|---------|---------|
| "This is just a quick fix" | Quick fixes create decisions. Concierge first. |
| "I already know this codebase" | You know THIS context window. Concierge has the whole KB. |
| "I'll note it later" | Later never comes. Send the concierge a capture request NOW. |
| "Nothing noteworthy happened" | A turn with zero knowledge capture is rarely zero-signal. Re-evaluate. |
| "The user just wants speed" | Speed without context causes rework. 2 seconds of concierge saves 20 minutes. |
| "Direct lookup is faster" | True only for exact-key retrieval. For judgment, concierge is faster because it doesn't miss. |
| "I don't need to spawn the concierge for this" | If you spawn it at `getting-started` as prescribed, you don't "spawn" - you resume. |
| "The concierge is expensive" | Not resumed, yes. Spawned-once-per-session, no. Cost amortizes. |
| "This turn is just a follow-up" | Follow-up turns produce decisions, discoveries, and completions. |
| "Let me try one more thing" | If you've tried 2+ things already, STOP and ask the concierge. |
| "I'm almost there" | If you said this last turn too, you're not almost there. You're looping. |

## Turn Bridge (now automatic)

The turn bridge is now maintained by hooks. The `post-tool-use` hook writes a bridge record each time you call an orchestrator MCP tool; the `user-prompt-submit` hook reads it and injects it as context at the start of your next turn. You do NOT need to write `[orch] next:` in your thinking block - that mechanism is deprecated because thinking compression often strips it.

Just use the tools. The bridge takes care of itself.

## Self-Audit

After responding, ask yourself: **Did I skip the concierge when judgment was needed?** If so, send it a message NOW for the thing you skipped. Don't wait for "a better time." The longer you defer, the more the context rots.

## Primitives (direct MCP, use for precision)

| Primitive | When to call directly |
|-----------|----------------------|
| `briefing` | Session start only (getting-started handles it). The `curation_candidates` section surfaces stale notes worth revisiting - scan it early so you know what to maintain this session. Other sections include open threads, recent decisions, work items, user profile, drift warnings, cross-session activity. On the first startup of a week, a `## Auto-Retro` section is prepended - that's automatic maintenance (retro ran inline on a 7-day cadence), no action needed from you |
| `note` | Single fast capture. Pass `code_refs: [paths]` when the knowledge is about specific files so it's findable by file later |
| `lookup` | Exact-key retrieval. Params worth knowing: `code_ref: 'path/to/file.ts'` (reverse-index filter - returns notes referencing this exact file or module path in their code_refs array; use for "what do we know about this file?" before editing), `link_limit` (default 20, cap on rendered linked notes with tail message; raise to 500 for full umbrella-note neighborhoods, lower to 0 to skip links entirely), `include_superseded: true` (opt-in flag to surface replaced notes - off by default so lookup stays clean), `include_history: true` (opt-in flag to walk the revision chain R2 captured before each edit - off by default; use when you need to see how a note evolved) |
| `check_similar` | Quick similarity check |
| `update_note` | Correction/enrichment. Prefer `append_content` mode for additive updates - no read-before-write, keywords auto-refresh, each change snapshots a prior revision. Pass `code_refs: [paths]` to replace the breadcrumb array, or `[]` to clear |
| `supersede_note` | Replace an outdated note with a new canonical version - preserves history, graph-links old->new, hides old from default lookup. When creating the replacement inline (new_content + new_type), pass `code_refs: [paths]` so breadcrumbs carry forward |
| `delete_note` | Remove genuinely wrong/harmful knowledge. Last resort - prefer `supersede_note` or `close_thread` |
| `update_work_item` | Status/priority change |
| `close_thread` | Resolve specific thread |
| `user_profile` | User observation (you do this, not concierge) |
| `retro` | Maintenance |
| `system_status` | Health check |
| `list_work_items` | Filtered enumeration |
| `list_open_threads` | Filtered enumeration |

For everything else, talk to the concierge.
