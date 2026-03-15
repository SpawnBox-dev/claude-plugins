---
name: consult-concierge
description: Invoke the memory concierge for complex knowledge retrieval. Use instead of raw lookup when you need curated, context-aware results.
---

Use the Agent tool to spawn or resume the memory concierge:

1. Check if you have a concierge agent ID from a prior turn in this conversation (it will be in your context from when you last invoked this skill)
2. If found, resume it with your query using the `resume` parameter
3. If not found, spawn a new agent using `subagent_type: "orchestrator:memory-concierge"` with `model: "sonnet"`
4. After the concierge responds, note its agent ID in your context for future resumption - no need to persist externally since the concierge only lives within one session

**Default model: Sonnet.** Only use Opus when the concierge itself says to escalate (genuine contradictions, complex cross-domain synthesis).

**When to use this skill:**
- Starting work on an unfamiliar area ("what should I know about combat?")
- Suspecting you may be contradicting a past decision
- After context compaction (you feel like you're missing context)
- When raw lookup returns too many results to triage

**When NOT to use this skill:**
- Simple, specific lookups ("lookup the broker convention")
- Just checking if a note exists
- Quick keyword searches

**Example invocation:**

```
Agent tool:
  subagent_type: "orchestrator:memory-concierge"
  model: "sonnet"
  prompt: "I'm about to work on [topic]. What decisions, conventions, and anti-patterns should I know about?"
  resume: <agent_id from prior invocation, if available>
```

After the concierge responds, save its agent ID for future `resume` calls this session.
