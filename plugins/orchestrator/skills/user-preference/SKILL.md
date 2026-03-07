---
name: user-preference
description: >
  Use when the user expresses a preference about workflow, coding style,
  communication, tooling, or process. Examples: 'always use bun', 'don't auto-commit',
  'I prefer X over Y', 'never do X without asking'. These preferences persist across
  sessions and projects.
---

# User Preference

The user just expressed a preference. Record it with `note`:

- **type**: `user_pattern`
- **scope**: `global` (preferences usually apply across all projects)
- **content**: State the preference clearly and specifically
- **context**: Include the situation that prompted it

Examples of things to capture:
- Tool preferences: "User prefers bun over npm"
- Workflow preferences: "User wants to review before committing"
- Communication style: "User prefers concise answers, not lengthy explanations"
- Safety rules: "Never delete files without confirmation"
- Quality expectations: "User expects thorough testing after changes"

These build the user model over time, helping future sessions adapt automatically.
