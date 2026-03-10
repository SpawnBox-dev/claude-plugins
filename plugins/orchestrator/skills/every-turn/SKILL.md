---
name: every-turn
description: >
  MANDATORY every turn. Evaluate which orchestrator tools and skills apply
  to what you're about to do, what just happened, and what you learned.
  This is your orchestrator intercept - run it before and after acting.
---

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

## The bar is LOW

If there's even a small chance one of these applies, invoke it. A skill that turns out to be irrelevant costs nothing. A missed capture is knowledge lost forever.
