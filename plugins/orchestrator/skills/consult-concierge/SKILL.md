---
name: consult-concierge
description: Talk to the memory concierge - your persistent session thinking partner. Default for curated retrieval, batch captures, work triage, decision validation, deep exploration, and struggle intervention. Not an "advanced tool" - it's the first-line option for anything judgment-heavy.
---

# Consult the Memory Concierge

The concierge is your persistent thinking partner for this session. It was (or should have been) spawned at `orchestrator:getting-started`. Every subsequent call is a SendMessage, not a new spawn.

## The Spawn vs Resume Rule

1. **If you spawned the concierge at `getting-started`** - resume it with `SendMessage(to: "<agent_id>", ...)`. Fast, cheap, state-aware.
2. **If you didn't** - spawn it now with the Agent tool, save the agent_id, use SendMessage from here on.
3. **Never spawn a second concierge in the same session.** If you forgot the first one's agent_id, that's a bug - the skills are supposed to prompt you to save it. Search your context for "agent_id" or recent Agent tool results.

## Spawn template

```
Agent(
  subagent_type: "orchestrator:memory-concierge",
  model: "sonnet",
  prompt: "<your query or request>"
)
```

## Resume template

```
SendMessage(
  to: "<concierge_agent_id>",
  content: "<your new query>"
)
```

**Default model: Sonnet.** Only use Opus when the concierge explicitly says to escalate (genuine contradictions, complex cross-domain synthesis).

## When to use the concierge

Use it freely once spawned - it's cheap per call when resumed. These are the high-value cases:

### Retrieval
- "What should I know about [area]?"
- "What conventions apply when working on X?"
- "Are there anti-patterns around Y?"
- "Give me everything on Z" (completeness queries)
- "Trace how decision A connects to conventions B and C" (deep linked exploration)
- Starting unfamiliar work - "I'm about to touch [file/system]. Surface relevant prior art."
- After context compaction - "Refresh me on what matters for the current task."

### Capture
- End-of-turn batch: "I just did 4 things worth saving. Help me pick types and tags, dedup against existing, save them."
- Decision made: "I decided X over Y because Z. Check for contradictions and save it."
- Pattern discovered: "I noticed [convention/anti-pattern]. Is this already documented? If not, save it."
- User preference observed: Actually, save user preferences with direct `user_profile` + direct `note` - the concierge doesn't observe the user, you do.

### Work triage
- "I'm about to track work on X. Dup check, find related in-flight items, suggest parent/breakdown."
- "Break down [complex task] with awareness of existing work items."
- "What's blocked and why?"

### Decision validation
- "Should I pick approach X over Y? Any conflicts with prior decisions?"
- "I'm about to do [thing]. Surface anti-patterns in this area."
- "Is there prior art for this approach?"

### Struggle intervention
- "I've been stuck on X for 2+ turns. What's going wrong?"
- "This error keeps happening despite [attempted fixes]. Is there a documented gotcha?"
- Triggered automatically by the PostToolUseFailure hook after 2+ consecutive tool failures - listen to it.

### Session lifecycle
- End of major task: "Checkpoint time. Summarize what we've done and save it."
- End of session: "Final wrap-up. Save progress, close any resolved threads, capture what was learned."

## When NOT to use the concierge

Direct MCP calls are faster and simpler for:

- **Exact-key retrieval** - `lookup(id: "abc123")` or `lookup("the broker convention")` when you already know the keyword
- **Single fast captures** - one decision, one `note()` call, done
- **Trivial state changes** - `update_work_item(status: "done")`, `close_thread(id: ...)`
- **Deterministic operations** - `retro`, `system_status`, `save_progress`, `briefing`
- **User observations** - `user_profile` (the concierge doesn't see the user, you do)
- **Destructive ops** - `delete_note` requires main-agent judgment

## Key insight

**Spawned once per session, the concierge is cheap.** Not resumed, every call pays cold-start. The concierge isn't expensive - the spawn pattern is. If you're tempted to skip it because "one call feels wasteful," that means you should have spawned it earlier and are about to pay cold-start on a single query. Spawn now and use it heavily for the rest of the session.

**Your concierge is stateful.** It tracks what it's already told you and won't repeat verbatim. It detects compaction (if you re-ask something it already answered, it flags the likely compaction). It progressively discloses (top 3 first, next 3 on follow-up, deeper cuts on third). The more you use it, the better it knows the session.

**Your concierge acts, not just advises.** It has write tools. When the right move is clear, it will save, update, or triage on your behalf. It will tell you what it did. You're still in the loop, but the grunt work happens in one subagent turn instead of N main-agent turns.
