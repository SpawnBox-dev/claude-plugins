---
name: what-was-decided
description: >
  Use when you encounter a design choice, naming convention, architectural pattern,
  or implementation approach and wonder why it was done that way. Use before proposing
  changes to check for prior decisions. Use when you're about to make an architectural
  choice and want to avoid contradicting past work.
---

# What Was Decided

You're wondering about a prior decision or convention. Do this:

1. Call `lookup` with keywords describing what you're curious about
2. **If the question is scoped to a specific file or module**, also call `lookup({code_ref: 'path/to/file'})` - this filters to notes that explicitly pointed at that file via their code_refs breadcrumb at capture time. It's complementary to keyword search: decisions about a file aren't always indexed by the vocabulary you'd guess.
3. If results reference related notes, follow the links (use `lookup` with the note ID and depth > 1). Note: default `link_limit` is 20; for umbrella notes with many connections, pass `link_limit: 500` to see the full graph neighborhood, or filter by relationship via `depth` and follow targeted paths.
4. If you find a relevant decision or convention:
   - Honor it unless there's a strong reason to override
   - If overriding, call `supersede_note(old_id, new_content, new_type='decision', reason='...')`. This atomically creates the new decision note and marks the old as superseded - agents reading the old one will see `[SUPERSEDED by X]` and `[go to current: lookup(id:X)]` hints instead of treating it as current. A plain `note` without supersede leaves the old at equal rank and will mislead future sessions.
5. If nothing is found, that's useful information too - proceed and record your decision with `note` (pass `code_refs: [paths]` if the decision is scoped to specific files, so the next file-level lookup surfaces it)

This prevents contradicting past decisions and re-learning solved problems.
