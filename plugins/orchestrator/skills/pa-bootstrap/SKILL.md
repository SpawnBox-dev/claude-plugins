---
name: pa-bootstrap
description: Bootstrap the PrimeAgent (PA) session. Run as the first command after pa-start.bat launches PA. Sets model/effort, confirms role=prime, reads active sessions from sessions.json, verifies agent-channel is wired, and outputs a readiness status line. Idempotent.
---

# Bootstrap the PrimeAgent

This skill primes a fresh PA session for orchestration. Run it ONCE per
PA window, immediately after `pa-start.bat` launches. Idempotent - safe
to re-run.

## Steps

### 1. Set runtime config (the .bat cannot)

Run these two commands in this PA session:
- `/model claude-opus-4-7` - ensure Opus 4.7, the most capable model family for orchestration judgment.
- `/effort max` - deepest reasoning per turn.

These are per-session slash commands; the launcher .bat cannot pre-set them.

### 2. Confirm role and identity

Read `$CLAUDE_PROJECT_DIR/.orchestrator-state/agent-channel/sessions.json`:

```bash
cat "$CLAUDE_PROJECT_DIR/.orchestrator-state/agent-channel/sessions.json"
```

Find your own session entry (matches `$CLAUDE_SESSION_ID` env var, or the
session_id you can see in your environment). Verify `role` is `prime`. If
not, error and abort - means the env was wrong (the .bat sets
`SPAWNBOX_AGENT_ROLE=prime`; if your entry has `role=subordinate`, the env
didn't propagate).

### 3. Read active subordinates

From sessions.json, list every session with `role=subordinate` whose
`last_heartbeat_at` is within the last 90 seconds.

Output a status block to terminal:

```
Currently orchestrating:
  - SA-<id8> (<name>) [task: <current_task or '(none)'>]
  - SA-<id8> (<name>) [task: ...]
```

If zero SAs active, output `No SAs currently active. Run sa-start.bat to spin one up.`

### 4. Verify agent-channel is wired

The MCP server should have logged `agent-channel: started as prime ...`
to its stderr when this session started. Check by tailing the orchestrator
plugin's recent log output OR by confirming sessions.json contains your
own entry with role=prime + a fresh heartbeat (< 60s old).

If you can't confirm agent-channel is running, surface the failure
verbatim and abort - PA without agent-channel is useless.

### 5. Load PA's operating contract

Read `agents/prime-agent.md` from the orchestrator plugin (your role doc).
Internalize:

- When to act (PA-addressed events, situational coordination, conflict
  prevention).
- When to observe (during pauses, unaddressed dialogue, peer-to-peer
  exchanges).
- Override etiquette (per-SA vs global, slash vs natural language).
- How to use `note()` and `create_work_item()` for self-improvement
  (tags: `agent-channel-improvement, area:orchestrator-plugin`).

The path is `<orchestrator-plugin-source>/agents/prime-agent.md`. From the
spawnbox project this typically resolves to
`C:/Users/Jarid/.claude/plugins/cache/spawnbox-dev-claude-plugins/orchestrator/0.29.0/agents/prime-agent.md`
(installed cache) or `C:/Users/Jarid/OneDrive/AppDev/claude-plugins/plugins/orchestrator/agents/prime-agent.md`
(source repo).

### 6. Check for any existing global pause

Read `state.json` (same dir as sessions.json):

```bash
cat "$CLAUDE_PROJECT_DIR/.orchestrator-state/agent-channel/state.json"
```

If `pa_global_pause.active` is true, mention it explicitly in the
readiness output and ask Jarid if you should clear it. Typically yes (he
just spawned a fresh PA), but his call.

### 7. Output readiness

Print:

```
PA ready (Opus 4.7, max effort). <N> SAs in orchestration.
Override state: <none|paused-on-X|global-pause>.
```

## Hard rules

- Do NOT spawn any subagents during bootstrap. PA is itself a Claude Code
  session; it doesn't need a concierge subagent (that whole pattern is
  gone in 0.29.0).
- Do NOT call any messaging tool. `send_message`, `read_messages`,
  `peek_inbox` were deleted in 0.29.0. Cross-session communication is via
  terminal output + agent-channel notifications.
- Do NOT silently recover from a missing/malformed sessions.json. If the
  state isn't sane at startup, surface the problem to Jarid and ask. PA's
  job depends on accurate visibility into the project's session graph.

## On idempotency

Re-running `/pa-bootstrap` mid-session is safe:
- `/model` and `/effort` calls are no-ops if already at the target.
- sessions.json read is read-only at this stage.
- state.json is only modified if you choose to clear an existing global
  pause (Jarid's call).
