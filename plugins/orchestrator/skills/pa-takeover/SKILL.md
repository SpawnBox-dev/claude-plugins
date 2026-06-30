---
name: pa-takeover
description: Force-claim PA primacy when another PA already holds the role. Run from a NEW PA window after pa-start.bat refused launch.
---

# Force PrimeAgent Takeover

Use this when `pa-start.bat` refused to launch you because another PA was
detected as fresh in `sessions.json`. The previous PA's window may be
orphaned (terminal closed without clean shutdown, machine rebooted while
PA was running, MCP server zombied), and you need to forcibly claim the
role.

## Hard rule

This is destructive to the previous PA's authority. Run ONLY when you've
confirmed the existing PA is unreachable (window closed, machine rebooted
without clean shutdown, etc.). Do NOT run while the existing PA is
actively in use - that would silently demote a working PA mid-task.

If unsure, close the existing PA window first and let the heartbeat
expire (90s), then launch via `pa-start.bat` normally - it will succeed.

## Steps

### 1. Read sessions.json

```bash
cat "$CLAUDE_PROJECT_DIR/.orchestrator-state/agent-channel/sessions.json"
```

Identify any entry with `role=prime` whose `session_id` is NOT yours.

### 2. Confirm intent

Output to terminal:

```
Found existing PA(s):
  - <session_id> (<name>) last_heartbeat=<ts>

Forcing takeover. The existing PA(s) will revert to subordinate posture
on their next agent-channel filewatch tick (~1.5s).
```

If multiple exist (rare), list all.

### 3. Update sessions.json atomically

For each existing prime session entry that's not yours:

- Set its `role` to `subordinate`.

For your own session entry (you should already exist if `pa-start.bat`
ran far enough to spin up the MCP server, even though it then refused
the user-side launch):

- Set your `role` to `prime`.

Atomic-write the merged sessions.json.

### 4. Verify

Re-read sessions.json. Confirm exactly one `role=prime` entry exists,
and that it's yours.

### 5. Run /pa-bootstrap

The takeover only changes the role flag. You still need full priming:
latest-Opus-or-Fable model confirmation, `xhigh` effort, and contract-loading. Run
`/pa-bootstrap` now to complete.

## Notes

- The demoted PA's instance will see its own role flip to subordinate
  on its next filewatch tick. Its `agent-channel` will start filtering
  inbound events to "addressed-to-me only" (subordinate posture). It
  won't crash; it just stops observing everything.
- If the demoted PA is genuinely orphaned (terminal closed), its
  filewatch will eventually go stale (90s) and reaping will remove it
  from sessions.json entirely. No further action needed.
- Atomic write uses temp-file + rename so concurrent reads from other
  instances see either the old or new state, never a partial.
