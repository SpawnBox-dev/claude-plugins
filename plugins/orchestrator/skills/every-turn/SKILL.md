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

**About to implement something?**
- Call `lookup` with relevant keywords → invoke `orchestrator:what-was-decided` if you find prior decisions
- Call `plan` if the task is complex → invoke `orchestrator:planning-approach`

**About to touch unfamiliar code?**
- Call `lookup` for conventions, anti-patterns, architecture notes about that area

## AFTER you act this turn

Scan what just happened. Did any of these occur?

| What happened | Action |
|--------------|--------|
| You made an architectural or design choice | → invoke `orchestrator:made-a-decision` |
| You discovered a pattern, convention, or gotcha | → invoke `orchestrator:learned-something` |
| You found a bug, footgun, or limitation | → invoke `orchestrator:found-a-problem` |
| Something failed or you had to pivot | → invoke `orchestrator:something-went-wrong` |
| The user corrected you or stated a preference | → invoke `orchestrator:user-preference` |
| An open thread or commitment was resolved | → invoke `orchestrator:closing-a-thread` |
| You finished a task or hit a milestone | → invoke `orchestrator:wrapping-up` |
| Significant systems were changed | → invoke `docs-manager:docs` |

**Multiple can apply in one turn.** If you made a decision AND learned a pattern AND the user stated a preference, invoke all three. Don't pick one.

## The bar is LOW

If there's even a small chance one of these applies, invoke it. A skill that turns out to be irrelevant costs nothing. A missed capture is knowledge lost forever.
