---
name: sa-launch
description: Use when PA needs to spawn a new Subordinate Agent (SA) session participating in agent-channel. Wraps the project-root sa-start.bat launcher with the correct PowerShell parameter syntax so PA doesn't have to remember `-Name` / `-Effort` PowerShell conventions vs Unix-style flags. Skill returns immediately after launch - PA observes `session_joined` via agent-channel hook in its normal context, then proceeds with the briefing-package handoff.
---

# Launch a Subordinate Agent (SA) session

## Overview

Spawns a fresh Subordinate Agent Claude Code session that participates
in the orchestrator's agent-channel. The new session appears in PA's
agent-channel context as a `session_joined` event when it boots
(~5-10 seconds after launch).

This skill exists because PA invoking the launcher directly via Bash
hit friction: PowerShell-style `-Name` / `-Effort` vs Unix-style
`--name` / `--effort` flag confusion produced silent failures (an
empty cmd.exe window with no SA inside). Encapsulating the launch
as a skill removes that friction. See WI `c16439f5` for context.

## When to use

- PA is about to delegate a non-trivial task to a fresh SA.
- An existing SA stood down and the new task warrants a fresh context
  rather than resuming theirs.
- Spinning up a domain-specific SA (frontend, backend, docs, infra).

Do NOT use to spawn a PA - PA cannot spawn itself; `pa-start.bat` is
user-initiated only.

## Inputs (skill args)

| Position / Flag | Meaning | Required | Default |
|---|---|---|---|
| positional `name` | Friendly name for the session | No | `SA-YYYY-MM-DD-HH-MM-SS` |
| `--effort low\|medium\|high\|xhigh\|max` | Reasoning effort override | No | session default |
| `--resume <uuid-or-display-name>` | Resume an existing session | No | new session |
| `--project-dir <path>` | Project root | No | `$CLAUDE_PROJECT_DIR` or cwd |

Example invocations:
- `/sa-launch` - fresh SA at session default effort
- `/sa-launch SA-fe-data-contract --effort max` - named fresh SA, max effort
- `/sa-launch --resume SA-frontend-old` - resume by display name
- `/sa-launch SA-docs --effort high --project-dir D:\some\other\repo` - cross-project

## Steps

### 1. Parse the skill args

Skill args arrive as a single string (e.g. `"SA-fe-data-contract --effort max"`).
Parse into the four logical inputs above:

- First non-flag token is the positional `name`.
- `--effort` / `--resume` / `--project-dir` flags each consume the next token.
- Anything else is a malformed arg - surface a clear error and stop.

If `name` is not supplied and no `--resume` is given, the underlying
launcher script auto-generates `SA-YYYY-MM-DD-HH-MM-SS`. Don't synthesize
it in this skill - let the launcher own that default.

### 2. Resolve the launcher path

The canonical `sa-start.ps1` lives at the project root (installed there
by the `/orchestrator:install-launchers` skill). Locate it:

```bash
LAUNCHER_PS1="${CLAUDE_PROJECT_DIR:-$PWD}/sa-start.ps1"
if [ ! -f "$LAUNCHER_PS1" ]; then
  echo "ERROR: sa-start.ps1 not found at $LAUNCHER_PS1"
  echo "Run /orchestrator:install-launchers to install launchers into this project first."
  exit 1
fi
```

If `--project-dir` was passed in args, use it instead of
`$CLAUDE_PROJECT_DIR`.

### 3. Invoke the launcher with PowerShell-style parameters

The launcher script takes PowerShell-style parameters (`-Name`,
`-Effort`, `-Resume`, `-ProjectDir`) - NOT Unix-style flags. Build
the parameter list and invoke directly via `powershell`:

```bash
powershell -NoProfile -ExecutionPolicy Bypass -File "$LAUNCHER_PS1" \
  ${NAME:+-Name "$NAME"} \
  ${EFFORT:+-Effort "$EFFORT"} \
  ${RESUME:+-Resume "$RESUME"} \
  ${PROJECT_DIR:+-ProjectDir "$PROJECT_DIR"}
```

The `${VAR:+...}` shell expansion only emits the flag when the var is
non-empty - so omitted args don't produce empty `-Name ""` clauses
that confuse the launcher.

The launcher uses `wt.exe -w new new-tab -d <project> claude <args>` to
spawn a new Windows Terminal tab. If `wt.exe` is missing, the launcher
falls back to running claude in the current console - which is rarely
what PA wants. If you see no new terminal window appear, confirm
`wt.exe` is installed:

```bash
command -v wt.exe || echo "wt.exe not found - launcher will fall back to current console"
```

### 4. Report and yield

Output a short confirmation that includes the chosen name + effort:

```
Launched SA: name=<name>, effort=<effort>. Waiting for session_joined event.
```

Do NOT wait for the `session_joined` event in this skill. PA observes
it via agent-channel hooks in its normal turn-by-turn context. Trying
to wait here couples the skill to agent-channel state and adds 5-10s
of latency for no benefit. PA's reflex after invoking this skill is:
proceed with whatever turn-level work is queued; when the
`session_joined` event arrives in a future hook context, begin the
briefing-package handoff (see WI `e7fde4ea`).

## Hard rules

- Do NOT pass Unix-style flags (`--name`, `--effort`) to the .ps1 -
  PowerShell does not recognize them as parameters and the launcher
  fails silently in ways that produce empty cmd.exe windows.
- Do NOT use `start "" cmd /c "sa-start.bat ..."` - that spawns an
  empty cmd window if the inner command errors. Invoke `powershell`
  directly with `-File <path>` so you get explicit launcher output.
- Do NOT `cd` into the project dir from bash before invoking - the
  .ps1 uses `$PWD` or its `-ProjectDir` param. `cd` in a subshell
  doesn't propagate to the spawned process anyway on Windows.
- Do NOT spawn a PA (prime) via this skill - it's SA-only. PA
  bootstrapping is user-initiated via `pa-start.bat`.

## Failure modes

- **No new window appears**: launcher script likely errored. Check
  `sa-start.ps1` exists and is syntactically valid. If `wt.exe` is
  missing, the launcher falls back to running claude in the calling
  terminal - it would appear in PA's own console, which is wrong.
- **SA joins agent-channel but role=prime**: another orchestrator bun
  process is heartbeating the session entry with the wrong role. See
  the impostor-diagnosis section in the `pa-bootstrap` skill.
- **`/sa-launch` returns but no `session_joined` event arrives within
  ~30s**: SA bootstrap is hung. Diagnose by checking
  `.orchestrator-state/agent-channel/sessions.json` directly - does
  the SA's UUID appear? If no, the launcher didn't actually start
  claude. If yes but no event in PA's context, the MCP bridge isn't
  wired correctly.

## Related

- `/orchestrator:install-launchers` - installs the underlying
  `sa-start.bat` / `sa-start.ps1` / `pa-start.bat` / `pa-start.ps1` /
  `discord-start.bat` / `discord-start.ps1` into the project root.
  Required before this skill can succeed.
- WI `c16439f5` - the work item that motivated this skill (PA hit
  PowerShell-flag-syntax friction during the FE-data-contract SA
  spawn, 2026-05-12).
- WI `e7fde4ea` - the broader PA briefing-package reflex.
  `/sa-launch` is the prerequisite "launch" step before the
  briefing-package handoff that pre-cites relevant anti-patterns,
  conventions, decisions, and code refs to the new SA.
