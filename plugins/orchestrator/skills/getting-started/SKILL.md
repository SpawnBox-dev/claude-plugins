---
name: getting-started
description: >
  Use when beginning any task, switching to an unfamiliar area of the codebase,
  or when context from previous sessions would help. Also use when resuming after
  context compaction.
---

<SUBAGENT-STOP>
If you were dispatched as a subagent to execute a specific task, skip this skill.
Subagents work from the context given to them, not from the full knowledge base.
</SUBAGENT-STOP>

<HARD-GATE>
Do NOT respond to the user's first message until you have called `briefing`.
This prevents you from contradicting past decisions or missing relevant
in-flight work.
</HARD-GATE>

# Getting Started

You're entering a task and need context. The orchestrator's job here is **additive**: it primes you with historical/cross-session context that you'd otherwise lack. It does NOT substitute for the careful reading, doc-checking, web research, and source investigation you'd do anyway when entering an unfamiliar area. Treat what you learn from the briefing as starting hypotheses to verify against current code, not as final truth.

Do this quickly and silently:

## Step 0 — Capture your session_id

The SessionStart hook injects your current `session_id` into context as part of the startup directive. **Find it and remember it.** Every subsequent orchestrator tool call should pass this same `session_id` so sibling sessions can see what you create and you can see what they're working on.

- Briefings without `session_id` miss the Cross-Session Activity section.
- Notes without `session_id` are invisible to other sessions' cross-session discovery.
- Work items without `session_id` cannot be attributed in the discovery feed.

If for any reason you cannot find your session_id in the startup context, ask the user to share it or proceed without it - but the cross-session features will be degraded.

## Step 1 — Briefing

Call `briefing({ event: "startup", session_id: "<your_session_id>" })` to get the session orientation (open threads, recent decisions, work items, user profile, last checkpoint, cross-session activity from sibling sessions, AND a `curation_candidates` section surfacing stale notes worth maintaining). Default output covers all sections; pass `sections: [...]` to narrow. Scan it internally - including `curation_candidates` - and schedule maintenance opportunities alongside your task. Do NOT dump the full briefing to the user - only mention items directly relevant to their task.

On the first startup of a week (seven days since the last maintenance pass), the briefing may be prepended with a `## Auto-Retro` section. That's automatic maintenance: the orchestrator inline-invokes `retro` on a 7-day cadence so stale signal decays, orphans get flagged, and the knowledge base stays coherent without requiring the agent to remember. This is expected, not a surprise - scan the summary for anything actionable (broken code_refs, revalidation queue) and fold it into your maintenance plan.

If the Cross-Session Activity section is non-empty, note anything that affects your task. Sibling sessions may have just decided something you're about to revisit, or flagged an anti-pattern in the area you're about to touch.

## Step 2 — Identify your role (PA or SA)

Check `process.env.ORCHESTRATOR_AGENT_ROLE` (or the legacy `SPAWNBOX_AGENT_ROLE`):

- `prime` → You are the **PrimeAgent** for this project. Run `/pa-bootstrap` next (it sets `/model claude-opus-4-7`, `/effort max`, reads sessions.json, loads `agents/prime-agent.md`). Do not proceed past the bootstrap until that's done.
- `subordinate` (or unset) → You are a **Subordinate Agent (SA)**. The project's CLAUDE.md and the orchestrator plugin's CLAUDE.md describe your operating contract: PA's directives addressed to you (`@SA-<your-id8>` or unaddressed PA dialogue) are treated as the user's voice unless you're under `/pa-pause`. Address peers via `@PA` / `@SA-<id8>` / `@all` in your terminal output - the agent-channel filewatcher routes via `notifications/claude/channel`. **No `send_message` tool exists in 0.29.0+** - communication is purely terminal-output + filewatcher routing.

## Step 3 — Broadcast your task to peers

If your briefing showed any active sibling sessions, OR if the user's request touches code that's likely to overlap with parallel work, call `update_session_task("<one-line task description>")` now. This writes your `current_task` into `session_registry` (and into the SQLite agent-channel registry `agent_channel.db` that the filewatcher reads - the legacy `sessions.json` was retired in 0.30.35) so:

- Peer sessions see what you're working on as the `from_task` field on every channel notification you generate.
- Their next briefing's Cross-Session Activity surfaces your task.
- PA (if active) has fresh context on what you're doing.

You can update it again later if your scope shifts. Skip this step on trivial / read-only sessions where overlap isn't a risk - it's not mandatory, just high-leverage when multiple agents are active.

If the briefing surfaced a peer session whose work directly affects yours, address them in your terminal output: `@SA-<peer-id8> heads up - I'm about to touch <X>. anything I should know?` Their response will arrive inline as `<channel from="..." ...>`.

## Step 4 — Use direct MCP calls for retrieval and capture

Default to direct MCP tool calls for everything orchestrator-related:

- **Retrieval**: `lookup({query: "..."})`, `lookup({code_ref: "path/to/file"})`, `check_similar({content: "..."})`, `list_work_items({...})`, `list_open_threads({...})`.
- **Capture**: `note({type, content, tags, code_refs})`, `update_note({id, ...})`, `supersede_note({old_id, ...})`, `close_thread({id, resolution})`.
- **Work triage**: `create_work_item({...})`, `update_work_item({id, ...})`, `breakdown({...})`.
- **Lifecycle**: `save_progress({summary, open_questions, next_steps})`.

The `Agent` tool with `orchestrator:memory-concierge` subagent type is **gone in 0.29.0**. The persistent-thinking-partner pattern is now PA itself - no per-session subagent needed.

## Step 5 — Work the task

Proceed with the user's request. As you work, treat what the briefing told you as priming context, not as ground truth - your reading of current source files, current docs, and current upstream behavior (web research for upstream tooling, libraries, and APIs the project depends on) remains primary. The orchestrator adds team-level history and cross-session awareness on top of that, never in place of it.

## Recovery Checkpoints

If the briefing shows a recovery checkpoint, honor it - that's where the last session left off. Fold any "next steps" it suggests into your current plan.

## What NOT to do

- Do NOT call `briefing` then forget to use it. The whole point is to internalize prior context before acting.
- Do NOT dump the briefing to the user - including `curation_candidates`. Scan those internally and schedule maintenance actions as part of your work, don't narrate them.
- Do NOT call `send_message`, `read_messages`, or `peek_inbox` - those tools were deleted in 0.29.0.
- Do NOT spawn `orchestrator:memory-concierge` - that subagent type is gone.
- Do NOT skip briefing because the user's request "seems simple." Simple requests are where contradictions sneak in.
