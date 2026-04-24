---
name: wrapping-up
description: >
  Use when finishing a task, completing a significant milestone, or when the
  conversation is ending. Saves progress so the next session picks up seamlessly.
---

<HARD-GATE>
Do NOT end a session or declare a task complete without calling `save_progress`.
If the session ends without a checkpoint, the next session starts blind - no context,
no continuity, no memory of what happened here. This is not optional.
</HARD-GATE>

# Wrapping Up

You're finishing a piece of work. The end-of-session playbook is two passes: first MAINTENANCE of what you used, then CAPTURE of what you did.

## Maintenance pass (do this BEFORE save_progress)

For every lookup result you relied on this session, ask: **is it still accurate?** If not, act now:

- **Still accurate, just needs an addition** - `update_note` with `append_content` mode (lightweight, no read-before-write, keywords auto-refresh)
- **No longer the canonical answer** - `supersede_note(old_id, new_id_or_new_content)` (preserves history, graph-links old->new, hides old from default lookup)
- **The question it tracked is now settled** - `close_thread`
- **Genuinely wrong or harmful** - `delete_note` (last resort)

The knowledge base gets more accurate over time only if sessions that READ stale notes also MAINTAIN them. Capture alone is not enough.

If you touched >=3 notes this session, the Stop hook will surface a "notes surfaced this session" list (R3.4 nudge) - walk it before moving on.

For any notes you WROTE this session that are about specific code (a gotcha in a file, a pattern for a module, a decision scoped to a subsystem), verify the note carries `code_refs: [paths]`. If you forgot, call `update_note({id, code_refs: [paths]})` now. Without breadcrumbs the note is still keyword-searchable, but invisible when a future agent is editing those files and runs `lookup({code_ref: 'path'})`.

## Capture pass: save_progress

Call `save_progress` with:

- **summary**: What was accomplished. Be specific - "Renamed MCP tools from orient/remember/recall to briefing/note/lookup" not "Made changes to the plugin"
- **open_questions**: Anything unresolved that the next session should know about
- **next_steps**: Concrete actions for follow-up work
- **in_flight**: If anything is partially done, describe its state

Also consider:
- Were any decisions made this session? If not already recorded, `note` them now (with code_refs if the decision is scoped to specific files)
- Were any open threads resolved? Call `close_thread` on them
- Did you learn any conventions or anti-patterns? `note` them (with code_refs when tied to specific files)

**Retro is automatic now.** The orchestrator inline-invokes `retro` from briefing on a 7-day cadence, so you don't need to manually call it at session end unless you want to force an immediate maintenance pass (e.g., after a heavy debugging session where a lot changed). The old "call retro when wrapping up" reflex is stale - `save_progress` remains the required checkpoint step.

The goal: a fresh session reading your checkpoint should feel like they have full continuity, AND the notes they pull up should still be correct.
