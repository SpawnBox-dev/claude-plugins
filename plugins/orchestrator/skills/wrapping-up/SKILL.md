---
name: wrapping-up
description: >
  Use when finishing a task, completing a significant milestone, or when the
  conversation is ending. Saves progress so the next session picks up seamlessly
  without re-discovering context.
---

# Wrapping Up

You're finishing a piece of work. Before moving on, call `save_progress` with:

- **summary**: What was accomplished. Be specific - "Renamed MCP tools from orient/remember/recall to briefing/note/lookup" not "Made changes to the plugin"
- **open_questions**: Anything unresolved that the next session should know about
- **next_steps**: Concrete actions for follow-up work
- **in_flight**: If anything is partially done, describe its state

Also consider:
- Were any decisions made this session? If not already recorded, `note` them now
- Were any open threads resolved? Call `close_thread` on them
- Did you learn any conventions or anti-patterns? `note` them

The goal: a fresh session reading your checkpoint should feel like they have full continuity.
