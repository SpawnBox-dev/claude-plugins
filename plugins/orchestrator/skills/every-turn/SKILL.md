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

**Framing - critical to internalize**: the orchestrator is **additive** to your normal Claude Code practice (decision `3b962e67`). It surfaces team-level history + cross-session awareness that you'd otherwise lack. It does NOT replace your own code reading, doc-checking, web research, or careful investigation. If a nudge below tempts you to skip a step you'd take anyway without this plugin, take the step - then layer the orchestrator's context on top.

## Direct MCP calls + agent-channel addressing

The orchestrator plugin (0.29.0+) gives you two operational surfaces:

1. **Direct MCP calls** (`lookup`, `note`, `check_similar`, etc.) - retrieval, capture, work triage, lifecycle.
2. **Agent-channel addressing** (typing `@PA` / `@SA-<id8>` / `@all` in your terminal output) - cross-session communication routed via real-time `notifications/claude/channel`.

The Sonnet memory-concierge subagent pattern is **gone in 0.29.0**. Persistent thinking is now the PrimeAgent (PA) - if a PA is running for the project, address it with `@PA, ...` in your terminal output for judgment-heavy work that benefits from a session-wide thinking partner. Otherwise, use direct MCP calls and lean on `lookup({code_ref: ...})` for file-scoped retrieval.

## Operation Routing Table

| Need | Route | Why |
|---|---|---|
| Find note by ID | `lookup({id: "abc123"})` | Exact-key retrieval |
| Find by keyword | `lookup({query: "..."})` | Semantic + FTS5 search |
| What do we know about a specific file? | `lookup({code_ref: "path/to/file"})` | Reverse-index breadcrumb match |
| Has anything similar been decided? | `check_similar({content: "..."})` | Embedding similarity |
| Complete inventory of work matching a tag | `list_work_items({tag: "..."})` | Returns everything; lookup might miss vocabulary mismatches |
| Open threads in an area | `list_open_threads({tag: "..."})` | Returns everything |
| Save 1 note about 1 thing | `note({type, content, tags, code_refs})` | Fast capture |
| Update a note's content | `update_note({id, append_content: "..."})` | Prefer append_content - no read-before-write, keywords auto-refresh, revision snapshotted |
| Replace outdated note with new canonical | `supersede_note({old_id, ...})` | Preserves history, graph-links old->new, hides old |
| Delete genuinely wrong/harmful note | `delete_note({id})` | Last resort - prefer supersede_note or close_thread |
| Create work item | `create_work_item({...})` | Pass `tags` for findability and `code_refs` if file-scoped |
| Bump status | `update_work_item({id, status})` | Trivial state change |
| Break down complex work | `breakdown({...})` | Decompose into parent + children |
| Validate "should I pick X over Y?" | `check_similar` first, then `lookup` | Surface conflicts + anti-patterns |
| Close a resolved thread | `close_thread({id, resolution})` | Cascades through the graph |
| Session checkpoint | `save_progress({summary, open_questions, next_steps})` | One call, end of session |
| User observation | `user_profile({...})` | You observe the user, not any subagent |
| Maintenance | Auto-fires from briefing 7-day cadence | Manual `retro` only when forcing |
| Capture knowledge about specific code | `note({..., code_refs: ["path"]})` | Breadcrumbs make it findable later via `lookup({code_ref})` |
| Starting a major task | `update_session_task("...")` | Broadcasts your `current_task` to peers via agent-channel |
| Discovered something a peer needs to know | Type `@SA-<id8> <message>` in your terminal output | Filewatcher routes to that session via `notifications/claude/channel` |
| Need PA's help (PA active) | Type `PA, <question>` in your terminal output | PA-addressed events tag `pa_addressed=true` in PA's channel feed |
| Cross-session events from peers | Arrive inline as `<channel source="agent-channel" ...>content</channel>` | Auto-injected at every model turn |

## BEFORE you act this turn

**Starting a session or lost context?**
- Invoke `orchestrator:getting-started` - it handles `briefing`, role detection, and task broadcasting.

**About to implement something?**
- Run `lookup({code_ref: "path/to/file"})` against any file you're about to edit. File-scoped breadcrumbs surface notes keyword search would miss.
- Run `check_similar({content: "<your approach>"})` to surface prior art and conflicts before committing.

**Building a list, audit, or inventory?**
- Use `list_work_items` / `list_open_threads` with appropriate filters. They return everything; `lookup` may miss items with different vocabulary.

## AFTER you act this turn

Scan what just happened. Did any of these occur?

| What happened | Action |
|--------------|--------|
| You completed a task or step | → `update_work_item({id, status: "done"})` |
| You started working on something trackable | → `lookup` for prior art / overlapping in-flight work; `create_work_item` if novel; `update_session_task` to broadcast |
| You discovered something a peer session needs to know | → Type `@SA-<id8> <message>` (or `@all` for broadcast) in your terminal output |
| Cross-session event arrived in your context | → Acknowledge and act on it. Sender invested in routing it to you; treat it as a directive (from PA) or a heads-up (from peer SA), not a notification you can ignore. |
| You're blocked on something | → `update_work_item({id, status: "blocked", blocked_by: "<other_id>"})` |
| You identified new work | → `check_similar` for dup-check; if novel, `create_work_item` |
| Complex task needs breakdown | → `breakdown({...})` with existing-item context |
| Knowledge evolved or needs correction | → `update_note({id, append_content: "..."})` for additive; `supersede_note` for substantive replacement |
| A note is wrong or harmful | → `supersede_note` (preserve history) or `close_thread` (was right-at-the-time, now settled). `delete_note` only as last resort |
| You made an architectural or design choice | → `note({type: "decision", content: "...", tags: "...", code_refs: ["..."]})` |
| You discovered a pattern, convention, or gotcha | → `note({type: "convention" | "anti_pattern" | "insight", ...})` |
| Something failed or you pivoted | → `note({type: "anti_pattern" | "insight", content: "what failed and what worked", ...})` |
| The user corrected you or stated a preference | → `user_profile({...})` + `note({type: "user_pattern", scope: "global", ...})` |
| Open thread resolved | → `close_thread({id, resolution: "..."})` |
| Hit a milestone or natural stopping point | → `save_progress({summary, open_questions, next_steps})` |
| Significant systems changed | → Use `docs-manager:docs` skill |

**Multiple can apply in one turn.** If you made a decision AND learned a pattern AND the user stated a preference, all three captures should fire. Don't batch them mentally and forget.

## Struggle Detection - STOP, LOOK UP, MAYBE ASK PA

<EXTREMELY_IMPORTANT>
If you notice ANY of these patterns, STOP and run `lookup` against the failure description + key error keywords. The knowledge base may have a documented gotcha. If a PA is active in the project, also address `PA, <description of struggle>` in your terminal output - PA's tailing will surface the address and PA can intervene with broader context.

**Signals you are struggling:**
- You've tried the same approach 2+ times with different variations and it keeps failing
- You're getting the same error/failure across multiple attempts
- You've been working on the same issue for 3+ turns without resolution
- You're guessing at solutions rather than working from known patterns
- You're editing code you just edited in the previous turn
- You keep hitting unexpected behavior that doesn't match your assumptions
- You're tempted to "try one more thing" without understanding why the last thing failed

**What to surface (in `lookup` or your `PA, ...` address):**
1. What you're trying to accomplish (the goal, not the approach)
2. What you've tried so far and what happened
3. What error/behavior you're seeing
4. What assumptions you're working from

The PostToolUseFailure hook will also nudge you here automatically after 2+ consecutive tool failures. Listen to it.

**You are NOT "almost there." You are stuck.** Agents that keep hammering away waste enormous time rediscovering gotchas that are already documented. STOP. LOOKUP. THEN proceed with the right approach.
</EXTREMELY_IMPORTANT>

## Red Flags

These thoughts mean STOP - you are rationalizing your way out of using the orchestrator:

| Thought | Reality |
|---------|---------|
| "This is just a quick fix" | Quick fixes create decisions. Lookup adds historical context to layer onto your own code reading. |
| "I already know this codebase" | You know THIS context window. The KB holds team history you may not. Use both. |
| "I'll note it later" | Later never comes. Capture NOW. |
| "Nothing noteworthy happened" | A turn with zero knowledge capture is rarely zero-signal. Re-evaluate. |
| "The user just wants speed" | Speed without context causes rework. 2 seconds of lookup saves 20 minutes - alongside your normal investigation, not in place of it. |
| "I don't need to lookup for this" | Cheap to verify. The lookup adds; it doesn't subtract from what you'd otherwise do. |
| "This turn is just a follow-up" | Follow-up turns produce decisions, discoveries, and completions. |
| "Let me try one more thing" | If you've tried 2+ things already, STOP and lookup. |
| "I'm almost there" | If you said this last turn too, you're not almost there. You're looping. |
| "The orchestrator told me what to do" | The orchestrator surfaced context. The current source/docs/upstream remain ground truth. If a note tempted you to skip reading the actual code, read the code. |
| "Lookup found the answer, I can skip reading the file" | Lookup tells you what was decided/learned in the past. The code may have moved on. Read the file. |

## Turn Bridge (now automatic)

The turn bridge is now maintained by hooks. The `post-tool-use` hook writes a bridge record each time you call an orchestrator MCP tool; the `user-prompt-submit` hook reads it and injects it as context at the start of your next turn. You do NOT need to write `[orch] next:` in your thinking block - that mechanism is deprecated because thinking compression often strips it.

Just use the tools. The bridge takes care of itself.

## Self-Audit

After responding, ask yourself: **Did I skip a capture or lookup that the table says I should have run?** If so, run it NOW. Don't wait for "a better time." The longer you defer, the more the context rots.

## Primitives (direct MCP, use for precision)

| Primitive | When to call directly |
|-----------|----------------------|
| `briefing` | Session start (getting-started handles it). Surfaces `curation_candidates` worth revisiting. On the first startup of a week, an `## Auto-Retro` section is prepended - automatic maintenance ran on a 7-day cadence |
| `note` | Single fast capture. Pass `code_refs: [paths]` when knowledge is about specific files |
| `lookup` | Exact-key retrieval. Params: `code_ref: 'path'` (reverse-index file query), `link_limit` (default 20, cap on linked notes; raise to 500 for full neighborhoods, 0 to skip), `include_superseded: true`, `include_history: true` |
| `check_similar` | Quick similarity check before implementing |
| `update_note` | Correction/enrichment. `append_content` mode preferred for additive updates |
| `supersede_note` | Replace outdated note with new canonical. Preserves history |
| `delete_note` | Last resort - genuinely wrong/harmful only |
| `create_work_item` | Pass `code_refs` for file-scoped work items so they surface via `lookup({code_ref})` |
| `update_work_item` | Status/priority change. Also covers `tags`, `context`, `confidence` |
| `breakdown` | Decompose complex work into parent + children |
| `close_thread` | Resolve specific thread; cascades through graph |
| `user_profile` | User observation (you do this) |
| `retro` | Manual maintenance (auto-fires on 7-day cadence from briefing) |
| `system_status` | Embedding sidecar + DB health |
| `list_work_items` | Exhaustive filtered enumeration |
| `list_open_threads` | Exhaustive filtered enumeration |
| `update_session_task` | Broadcast your `current_task` for peer visibility |
| `save_progress` | End-of-session checkpoint |

For cross-session communication, **type `@PA` / `@SA-<id8>` / `@all` in your terminal output** - the agent-channel filewatcher routes the addressing automatically.
