---
name: pa-resume
description: Clear a previously-set PA pause. In an SA terminal, clears that SA's pause. In PA's terminal, clears the global pause.
---

# Resume PrimeAgent

Inverse of `/pa-pause`. Clears the pause flag for the appropriate scope.

Natural-language equivalents recognized: "PA, come back in", "PA, resume",
"PA, you can come back in".

## Steps

### 1. Read your role

```bash
cat "$CLAUDE_PROJECT_DIR/.orchestrator-state/agent-channel/sessions.json"
```

Find your own session entry. Note `role`.

### 2. Read current state

```bash
cat "$CLAUDE_PROJECT_DIR/.orchestrator-state/agent-channel/state.json"
```

### 3. Clear the pause

If your `role` is `subordinate`:

- Atomic-update `state.json`: delete `state.sa_pauses[<your_session_id>]`.
- Output: `Pause cleared: PA may now address SA-<id8> again.`

If your `role` is `prime`:

- Atomic-update `state.json`: set
  `state.pa_global_pause = { active: false, since: null, set_by_session: null }`.
- Output: `Global pause cleared: PA back to full orchestration.`

## Notes

- Idempotent: re-running `/pa-resume` when no pause was set is a no-op
  (output: `No pause was active.`).
- Atomic write: same temp-file + rename pattern as `/pa-pause`.
