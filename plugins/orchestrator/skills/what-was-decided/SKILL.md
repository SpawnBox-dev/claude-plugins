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
2. If results reference related notes, follow the links (use `lookup` with the note ID and depth > 1)
3. If you find a relevant decision or convention:
   - Honor it unless there's a strong reason to override
   - If overriding, call `note` with type=decision to record WHY you're changing course
4. If nothing is found, that's useful information too - proceed and record your decision with `note`

This prevents contradicting past decisions and re-learning solved problems.
