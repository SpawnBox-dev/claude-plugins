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

2. If this was a significant debugging session, also call `retro` to run knowledge maintenance

3. If the root cause reveals a broader pattern, record it as a separate `convention` or `risk` note

The goal: no future session should hit this same problem and have to rediscover the solution.
