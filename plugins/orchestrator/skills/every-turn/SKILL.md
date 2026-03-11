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

## BEFORE you act this turn

**Starting a session or lost context?**
- Call `briefing` MCP tool → then invoke `orchestrator:getting-started`
- To save context, use `briefing({ sections: ["work_items"] })` for just work items

**About to implement something?**
- Call `lookup` with relevant keywords → invoke `orchestrator:what-was-decided` if you find prior decisions
- Call `plan` if the task is complex → invoke `orchestrator:planning-approach`

**About to touch unfamiliar code?**
- Call `lookup` for conventions, anti-patterns, architecture notes about that area

## AFTER you act this turn

Scan what just happened. Did any of these occur?

| What happened | Action |
|--------------|--------|
| You completed a task or step | → `update_work_item` status=done (cascades automatically) |
| You started working on something trackable | → `update_work_item` status=active, or `create_work_item` if it doesn't exist |
| You're blocked on something | → `update_work_item` status=blocked, blocked_by=ID |
| You identified new work that needs doing | → `create_work_item` with priority and optional due_date |
| A complex task needs breakdown | → `breakdown` to create parent + children |
| Knowledge evolved or needs correction | → `update_note` to modify content/tags in place |
| A note is wrong or harmful | → `delete_note` to permanently remove it |
| You made an architectural or design choice | → invoke `orchestrator:made-a-decision` |
| You discovered a pattern, convention, or gotcha | → invoke `orchestrator:learned-something` |
| You found a bug, footgun, or limitation | → invoke `orchestrator:found-a-problem` |
| Something failed or you had to pivot | → invoke `orchestrator:something-went-wrong` |
| The user corrected you or stated a preference | → invoke `orchestrator:user-preference` + `user_profile` set |
| An open thread or commitment was resolved | → invoke `orchestrator:closing-a-thread` |
| You finished a task or hit a milestone | → invoke `orchestrator:wrapping-up` |
| Significant systems were changed | → invoke `docs-manager:docs` |

**Multiple can apply in one turn.** If you made a decision AND learned a pattern AND the user stated a preference, invoke all three. Don't pick one.

## Red Flags

These thoughts mean STOP - you are rationalizing your way out of using the orchestrator:

| Thought | Reality |
|---------|---------|
| "This is just a quick fix" | Quick fixes create decisions. Lookup first. |
| "I already know this codebase" | You know THIS context window. Previous sessions knew more. Lookup. |
| "I'll note it later" | Later never comes. Context compaction erases your memory. Note NOW. |
| "Nothing noteworthy happened" | A turn with no knowledge capture is rarely zero-signal. Re-evaluate. |
| "The user just wants speed" | Speed without context causes rework. 2 seconds of lookup saves 20 minutes. |
| "This doesn't affect future sessions" | If you touched code, made a choice, or learned something - it does. |
| "I'll check the knowledge base after I'm done" | Checking AFTER means you've already contradicted past decisions. Check BEFORE. |
| "The briefing didn't mention this area" | Absence of knowledge is the strongest signal TO capture knowledge. |
| "I don't need to look up decisions for this" | That's what every session thinks before contradicting a past decision. |
| "This turn is just a follow-up" | Follow-up turns produce decisions, discoveries, and completions. Scan the table. |

## Self-Audit

After responding, ask yourself: **Did I skip any tool that should have fired?** If so, fire it NOW in your next action. Don't wait for "a better time." If you catch yourself skipping tools repeatedly, record it with `note` type=`anti_pattern` so the retro system can track enforcement drift.

## Primitives (compose these freely)

These are your building blocks. Combine them however the situation demands:

| Primitive | What it does |
|-----------|-------------|
| `briefing` | Orient - full or filtered by sections |
| `note` | Capture any typed knowledge |
| `lookup` | Search existing knowledge |
| `plan` | Gather domain context for complex tasks |
| `save_progress` | Checkpoint for next session |
| `close_thread` | Resolve + cascade |
| `update_note` | Modify content/tags/confidence in place |
| `delete_note` | Remove wrong/outdated knowledge |
| `user_profile` | View/set/remove structured user observations |
| `create_work_item` | Track a concrete task with priority/due date |
| `update_work_item` | Change status/priority/content/due date |
| `breakdown` | Split complex work into children |
| `retro` | Maintenance: decay, dedup, trajectories |
