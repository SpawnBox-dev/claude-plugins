---
name: planning-approach
description: >
  Use when facing a complex task that would benefit from checking past decisions,
  known constraints, or previous failed approaches before diving into implementation.
  Gathers domain-specific context to avoid contradicting established patterns.
---

# Planning Approach

You're about to tackle something complex. Gather context first:

1. Call `plan` with the task description - this returns domain-specific conventions, anti-patterns, quality gates, and recent decisions
2. Call `lookup` with keywords related to the specific area you'll be working in. Tune the return shape with `link_limit` (default 20; raise to 500 for a full graph neighborhood when an umbrella note is central to the plan, lower to 0 to skip linked notes entirely when you only need the top-level hit) and `include_history: true` when revision evolution matters to the planning context (e.g., the current note is a successor and you want to see how the decision shifted).
3. Review the autonomy level:
   - **MATURE**: Proceed confidently using established patterns
   - **DEVELOPING**: Follow existing conventions, propose for gaps
   - **SPARSE**: Be cautious, ask before architectural decisions, record everything

4. If spawning subagents, pass the context package to them so they work with full knowledge

This prevents re-learning solved problems and contradicting established patterns.
