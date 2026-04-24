---
name: something-went-wrong
description: >
  Use after a debugging session reveals root causes, when an approach failed and
  you pivoted, or when an unexpected issue occurred. Captures what happened and
  what to do differently so the same mistake isn't repeated across sessions.
---

# Something Went Wrong

An approach failed or you found a root cause. Capture the lesson:

1. Call `note` with type=`anti_pattern` describing what went wrong and why
   - Be specific about the failure mode
   - Include what the fix or correct approach is
   - Example: "Using rm -rf with Windows backslash paths in Git Bash can delete wrong directory. Use forward slashes or PowerShell Remove-Item instead."
   - Pass `code_refs: [paths]` with the files involved in the failure. Root causes almost always tie back to specific code - a breadcrumb on the relevant file means the next agent editing it will see your anti_pattern surfaced before they repeat it.

2. If this was a significant debugging session, also call `retro` to run knowledge maintenance (note: retro also auto-fires weekly from briefing, so you only need to call it manually when you want an immediate maintenance pass)

3. If the root cause reveals a broader pattern, record it as a separate `convention` or `risk` note
4. If the root cause reveals an existing convention / risk / decision that was WRONG, also call `supersede_note` on the old note with the correction as the replacement. Leaving the wrong note in the graph will mislead future sessions - they'll find the stale note first and repeat the failure.

The goal: no future session should hit this same problem and have to rediscover the solution.
