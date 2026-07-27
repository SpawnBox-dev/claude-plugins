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

## Scope it to what it GOVERNS, not to the occasion that produced it

This is the single most common reason a correct decision fails to fire for the person who needed it.

You will naturally write the note about the thing you were doing when you decided. But a future reader arrives from somewhere else entirely, in different vocabulary, and the one-line summary is all they see. **If your summary names your occasion, it will not match their situation - and cheap one-line recall makes that invisible, because it feels like they already checked.**

Worked case (2026-07-27): a decision that an install beacon must stay structurally unlinkable was indexed as *"install beacon deliberately unlinkable."* Months later an agent reasoning about joining `account_id` to analytics data never saw it fire - same governing principle, no shared vocabulary. The decision was right, captured, searchable, and still missed.

So, when you write the summary line:

- **Name the CLASS the decision governs, not the instance that prompted it.** "Never re-identify a severed link by recomputing the hash" outranks "install beacon deliberately unlinkable."
- **Name the TECHNIQUE, not only the domain.** Future readers hit techniques from domains you never anticipated.
- **Ask: what OTHER situations does this rule me out of?** Put at least one of them in the note, in that situation's vocabulary. That sentence is what makes it findable from outside your context.
- If the decision forbids a technique, say so explicitly - a prohibition phrased only as a property of one system reads as a fact about that system, not as a rule.

**If the decision is about specific code** (a pattern for a module, a convention for a file, an architectural choice tied to a subsystem), pass `code_refs: [paths]` on the `note` call - file or module paths only, not line numbers or symbols. Future agents touching those files will find the decision via `lookup({code_ref: 'path'})`. Without breadcrumbs, the decision is still searchable by keyword but invisible when someone is simply editing the file.

If the decision overrides a previous one, use `supersede_note(old_id, new_id | new_content+new_type='decision')` to formally mark the replacement. Mentioning in prose alone leaves both at equal rank in lookup; supersede writes the graph edge, hides the old from default search while preserving it for provenance, and surfaces `[SUPERSEDED by X]` hints to future readers of the old note.
