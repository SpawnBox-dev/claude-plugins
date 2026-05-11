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
session_id you can see in your environment). Verify `role` is `prime`.

**If role is `subordinate` despite env being correct**, you're likely
fighting an impostor MCP — another orphaned bun process from a prior
session that's heartbeating your entry with the wrong role. Diagnose:

```powershell
Get-CimInstance Win32_Process -Filter "Name = 'bun.exe'" |
  Where-Object { $_.CommandLine -like '*orchestrator*server.js*' } |
  Select-Object ProcessId, ParentProcessId, CreationDate, CommandLine
```

For each `bun`, walk the parent chain to find the host `claude.exe`. If a
bun's `started_at` in sessions.json matches your session_id but its
ancestor `claude.exe` is launching a DIFFERENT session (e.g., the wrong
`--resume <uuid>`), kill that bun — it's an impostor. Your legitimate
MCP's next heartbeat (~30s) restores the correct entry.

Reference: anti-pattern note `120b8e59-fbef-4847-8c04-6bc7aa3ad378`
(orchestrator KB) documents the race in detail.

If no impostor exists and role is still wrong, abort and surface the
env-propagation failure (something between `pa-start.ps1` setting
`SPAWNBOX_AGENT_ROLE=prime` and the bun process actually reading it is
broken).

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

The path is `<orchestrator-plugin-source>/agents/prime-agent.md`. From a
typical install this resolves to either
`~/.claude/plugins/cache/<marketplace>/orchestrator/<version>/agents/prime-agent.md`
(installed cache, version-pinned) or the source repo
`<repo>/plugins/orchestrator/agents/prime-agent.md` if you have it
checked out locally.

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
