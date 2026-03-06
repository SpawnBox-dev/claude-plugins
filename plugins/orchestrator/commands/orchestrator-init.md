---
description: "First-run onboarding - bootstrap the orchestrator's knowledge from your project"
---

This is the orchestrator's first-run onboarding. Follow these phases:

**Phase 1: Self-Discovery**
1. Read CLAUDE.md if it exists - extract project overview, tech stack, conventions, critical rules
2. Read README.md if it exists - extract purpose, architecture overview
3. Scan docs/ directory for architecture documents - extract key decisions and system descriptions
4. Review git log (last 50 commits) for recent work themes
5. Scan directory structure to identify major systems/modules
6. Read any existing memory files (MEMORY.md, auto-memory files)
7. Detect available MCP servers and tools - record as tool_capability notes
8. Use `remember` to store each extracted piece of knowledge with appropriate type

**Phase 2: User Calibration (ask one at a time)**
1. "What's your role with this project?"
2. "What's currently in flight or blocked?"
3. "What's the most important thing to get right?"
4. "What do you wish agents did better?"
5. "Anything agents should never do in this project?"

Store answers using `remember` with appropriate types (user_pattern, open_thread, quality_gate, anti_pattern, convention).

**Phase 3: Baseline Summary**
Present what was learned: "I found N systems, M open items, K conventions."
Let the user correct anything. Store corrections as high-confidence notes.

**Goal:** After this, the orchestrator should feel like it's been on the project for a week.
