---
name: made-a-decision
description: >
  Use proactively after making or recommending an architectural decision, choosing
  between implementation approaches, or establishing a new convention. Captures both
  the decision AND the reasoning so future sessions understand the 'why' and don't
  revisit settled questions.
---

# Made a Decision

You just made or recommended a decision. Record it now with `note`:

- **type**: `decision`
- **content**: State the decision clearly: "We chose X over Y because Z"
- **context**: Include what alternatives were considered and why they were rejected

Good decision notes answer these questions for a future session:
1. What was decided?
2. What were the alternatives?
3. Why was this choice made?
4. Under what conditions should this be revisited?

**If the decision is about specific code** (a pattern for a module, a convention for a file, an architectural choice tied to a subsystem), pass `code_refs: [paths]` on the `note` call - file or module paths only, not line numbers or symbols. Future agents touching those files will find the decision via `lookup({code_ref: 'path'})`. Without breadcrumbs, the decision is still searchable by keyword but invisible when someone is simply editing the file.

If the decision overrides a previous one, use `supersede_note(old_id, new_id | new_content+new_type='decision')` to formally mark the replacement. Mentioning in prose alone leaves both at equal rank in lookup; supersede writes the graph edge, hides the old from default search while preserving it for provenance, and surfaces `[SUPERSEDED by X]` hints to future readers of the old note.
