---
name: learned-something
description: >
  Use proactively whenever you discover a pattern, convention, gotcha, workaround,
  or important fact about the codebase that would be valuable in future sessions.
  Also use when the user corrects you or explains how something works. If in doubt
  about whether to record it, record it.
---

# Learned Something

You just discovered something worth preserving. Record it immediately with `note`:

Choose the right type:
- `convention` - "This codebase always does X" / "The pattern for Y is Z"
- `anti_pattern` - "Never do X because Y" / "This approach causes Z"
- `insight` - General understanding: "System X works by Y"
- `architecture` - Structural knowledge: "Module X connects to Y via Z"
- `risk` - "X could break if Y happens"
- `quality_gate` - "All new code must pass X"
- `tool_capability` - "Tool X can do Y" / "MCP server X provides Y"

When the user corrects you, always record it as high-value knowledge. Their corrections reveal gaps in your understanding that will repeat across sessions.

Be specific and actionable. "The event bus uses broadcast channels" is better than "events work a certain way."
