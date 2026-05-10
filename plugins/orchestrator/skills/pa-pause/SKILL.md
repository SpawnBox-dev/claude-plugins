---
name: pa-pause
description: Override - tell PA to back off. In an SA terminal, pauses PA's posture toward THIS SA only. In PA's terminal, pauses PA globally across all SAs.
---

# Pause PrimeAgent

This command takes one of two scopes depending on where you run it:

- **In an SA terminal**: PA pauses ONLY for this SA. PA continues observing
  this SA's events (so it stays current) but does not address this SA or
  respond to its `pa_addressed` events. Other SAs continue normally.

- **In PA's terminal**: PA pauses GLOBALLY across all SAs. PA observes
  everything but writes nothing to any SA, ignores all `pa_addressed`
  events, takes no orchestration action.

Natural-language equivalents recognized by the agent-channel filewatcher:
"PA, back off", "PA, stand down", "PA, take five", "PA, pause".

## Steps

### 1. Read your role

```bash
cat "$CLAUDE_PROJECT_DIR/.orchestrator-state/agent-channel/sessions.json"
```

Find your own session entry (matches `$CLAUDE_SESSION_ID`). Note your `role`.

### 2. Read current state

```bash
cat "$CLAUDE_PROJECT_DIR/.orchestrator-state/agent-channel/state.json"
```

### 3. Apply the pause

If your `role` is `subordinate`:

- Atomic-update `state.json`: set
  `state.sa_pauses[<your_session_id>] = { since: "<now-iso8601>", set_by_session: "<your_session_id>" }`.
- Output to terminal:
  `Pause set: PA stand down for SA-<id8>. Resume with /pa-resume.`

If your `role` is `prime`:

- Atomic-update `state.json`: set
  `state.pa_global_pause = { active: true, since: "<now-iso8601>", set_by_session: "<your_session_id>" }`.
- Output to terminal:
  `Global pause set: PA standing down across all SAs. Resume with /pa-resume.`

Use a temp-file + rename pattern for the write to avoid torn writes:

```bash
TMP="$STATE_DIR/state.json.tmp.$$"
echo "<new_json>" > "$TMP"
mv "$TMP" "$STATE_DIR/state.json"
```

(On Windows, `Move-Item -Force` via PowerShell achieves the same atomicity.)

## Notes

- The agent-channel filewatcher will detect this skill invocation in your
  JSONL transcript (the literal `/pa-pause` line) and emit the
  `override_set` event independently. The state.json write here is the
  source-of-truth; the channel event is for visibility.
- **Idempotent**: re-running `/pa-pause` while already paused refreshes
  the `since` timestamp but is otherwise a no-op.
- The orchestrator MCP's filewatcher in PA's session also reads the
  natural-language variants ("PA, back off" etc) and would set the same
  flag - but explicitly invoking `/pa-pause` is more deterministic.
