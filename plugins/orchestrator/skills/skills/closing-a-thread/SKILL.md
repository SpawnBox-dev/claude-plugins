---
name: closing-a-thread
description: >
  Use when an open question, investigation, or tracked issue has been fully resolved.
  Prevents future sessions from revisiting solved problems and keeps the briefing
  focused on what's actually still open.
---

# Closing a Thread

An open thread or commitment has been addressed. Close it:

1. Call `close_thread` with the note ID (visible in briefing output or lookup results)
2. Include a `resolution` describing how it was resolved

If you don't remember the note ID, call `lookup` with type=open_thread to find it.

This is important for knowledge hygiene - unresolved threads show up in every future session's briefing. Closing them keeps the signal-to-noise ratio high.
