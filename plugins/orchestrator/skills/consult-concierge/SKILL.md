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

**When to use this skill (completeness matters):**
- You need a COMPLETE picture of an area ("all work items", "everything about combat", "what's the full launch list")
- Starting work on an unfamiliar area ("what should I know about X?")
- After context compaction (you feel like you're missing context)
- You suspect you may be contradicting a past decision
- When raw lookup returns results but you're not confident they're comprehensive
- Building any kind of inventory, audit, or status report
- The user says "are we missing anything?" or "give me everything"

**When NOT to use this skill (precision is enough):**
- Looking up a specific note by ID
- Checking one known keyword or convention name ("the broker convention")
- Quick fact-check ("was X decided?")

**Key insight: if you're about to make a list or need "all of" something, use the concierge. Direct lookup returns keyword-matched results which WILL miss items that use different vocabulary. You won't know they're missing.**

**Example invocation:**

```
Agent tool:
  subagent_type: "orchestrator:memory-concierge"
  model: "sonnet"
  prompt: "I'm about to work on [topic]. What decisions, conventions, and anti-patterns should I know about?"
  resume: <agent_id from prior invocation, if available>
```

After the concierge responds, save its agent ID for future `resume` calls this session.
