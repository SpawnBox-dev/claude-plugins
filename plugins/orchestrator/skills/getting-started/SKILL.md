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
reviewed the result. Do NOT skip this because the user's request seems simple or
urgent. A 3-second briefing prevents 30 minutes of contradicting past decisions.
</HARD-GATE>

# Getting Started

You're entering a task and need context. Do this quickly and silently:

1. Call `briefing` to get the session briefing (open threads, recent decisions, last checkpoint)
2. If the task involves a specific domain or topic, invoke `orchestrator:consult-concierge` with a query like "What should I know about [topic]?" - the concierge searches conventions, decisions, anti-patterns, and architecture notes, then returns a curated summary. For simple lookups, call `lookup` directly instead.
3. Scan the briefing for anything relevant to your current task
4. If the briefing shows a recovery checkpoint, honor it - that's where the last session left off

Do NOT dump the full briefing to the user. Internalize it and proceed with the task. Only mention relevant items (e.g., "I see there's an open thread about X that relates to this").
