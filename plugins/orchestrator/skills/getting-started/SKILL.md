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
Do NOT respond to the user's first message until you have called `briefing` and
spawned the concierge. Both steps are fast and prevent you from contradicting
past decisions or wasting cold-start budget on the concierge later.
</HARD-GATE>

# Getting Started

You're entering a task and need context. Do this quickly and silently:

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

## Step 2 — Spawn the Concierge (do this NOW, not later)

Spawn the memory concierge subagent immediately, before you need it. This is the most important thing to understand about the concierge:

**Concierge cost is bimodal.** The first invocation pays the cold-start cost (~15-20k tokens) because the subagent has to boot and absorb the orchestrator instructions. Every subsequent invocation in the same session is cheap - you resume it with SendMessage and it already has state. If you call concierge once per session, you pay cold-start for a single query, which is the worst case. If you call it heavily, cost amortizes and it becomes your persistent thinking partner.

**Solution:** spawn it at session start with a session-context handoff. Pay the cold-start once, then use it freely.

Spawn via the Agent tool:

```
Agent(
  subagent_type: "orchestrator:memory-concierge",
  model: "sonnet",
  prompt: "Session handoff: the user's initial request is: <paste the user's first message verbatim>. The briefing I just pulled shows <one-sentence summary of the most relevant briefing items>. I plan to work on <your initial read of the task>. What should I know before I start? Surface any relevant decisions, conventions, anti-patterns, or in-flight work that could inform or contradict this task."
)
```

Save the returned agent_id. Every subsequent concierge call this session should use `SendMessage(to: "<agent_id>", ...)` to resume, NOT a new Agent call.

**Note:** name the deliverable explicitly in the prompt (the artifact shape, the report format, the question you're asking). The concierge distinguishes Shape A (structured artifact - return what was asked) vs Shape B (batch capture - synthesize and save). Ambiguous asks default to Shape B. See `skills/consult-concierge/SKILL.md` for full framing.

## Step 3 — Broadcast your task to siblings (R6)

If your briefing showed any active sibling sessions, OR if the user's request touches code that's likely to overlap with parallel work, call `update_session_task("<one-line task description>")` now. This writes your `current_task` into `session_registry` so:

- Sibling sessions see what you're working on in their hook-time activity injection
- Their next briefing's Cross-Session Activity surfaces your task

You can update it again later if your scope shifts. Skip this step on trivial / read-only sessions where overlap isn't a risk - it's not mandatory, just high-leverage when multiple agents are active.

You can also `send_message({body, to_session: "<sid>"})` if the briefing surfaced a sibling session whose work directly affects yours - leave them a message before you both blindly edit the same file.

## Step 4 — Route judgment-heavy work through the concierge

From this point on, default to the concierge for anything judgmental:
- Multi-note batch captures at end of task
- Work item triage before create/update
- Decision validation before picking an approach
- Deep exploration of linked knowledge
- Contradiction checks before implementation

Use direct MCP calls only for exact-key retrieval, trivial writes, and deterministic operations. See `orchestrator:every-turn` for the full operation routing table.

## Step 5 — Work the task

Proceed with the user's request. The concierge is now in context, resumable with SendMessage, and ready for the judgment-heavy calls you'll need throughout the session.

## Recovery Checkpoints

If the briefing shows a recovery checkpoint, honor it - that's where the last session left off. Fold any "next steps" it suggests into your current plan.

## What NOT to do

- Do NOT call `briefing` and then skip the concierge spawn. You'll pay cold-start later when you're mid-task and need it most.
- Do NOT dump the briefing to the user - including `curation_candidates`. Scan those internally and schedule maintenance actions as part of your work, don't narrate them.
- Do NOT spawn multiple concierges in one session. Always resume the one you already have.
- Do NOT skip briefing because the user's request "seems simple." Simple requests are where contradictions sneak in.
