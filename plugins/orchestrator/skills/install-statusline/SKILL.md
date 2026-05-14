---
name: install-statusline
description: Use when the user wants a role-aware Claude Code statusline that shows whether the current session is PA, SA, or Discord-ops (matching the launcher's wt.exe tab-color scheme on Windows). Installs the orchestrator statusline script into the project root and configures Claude Code's `statusLine` setting to point at it. Idempotent — refuses to clobber an existing custom statusLine without explicit override.
---

# Install orchestrator role-aware statusline

## Overview

The orchestrator launchers (`pa-start` / `sa-start` / `discord-start`)
set role-specific env vars on the spawned Claude Code session:

| Launcher | `ORCHESTRATOR_SESSION_KIND` | `ORCHESTRATOR_AGENT_NAME` |
|---|---|---|
| `pa-start` | `prime` | `PA-<timestamp>` |
| `sa-start` | `subordinate` | `SA-<timestamp-or-name>` |
| `discord-start` | `discord-bot` | `DISCORD-LIVE-<timestamp>` |

This skill installs a small Python script + thin wrapper that reads
those env vars and emits a one-line, ANSI-colored statusline like:

```
🟡 PA  PA-2026-05-13-12-00-00  quayline
⚪ SA  SA-frontend              quayline
🔴 DISCORD  DISCORD-LIVE-...    quayline
```

This is the in-Claude complement to the Windows-only `wt.exe --tabColor`
flag used by the launchers: on POSIX you get the colored statusline
without needing a terminal-emulator tab-color API; on Windows you get
both (tab color from `wt.exe`, statusline indicator from this skill).

This skill is **separate from `install-launchers`**: installing the
launchers does NOT auto-install the statusline (the user may have a
custom statusline they don't want to clobber).

## Prerequisites

- The orchestrator plugin is installed.
- Python 3.10+ is on PATH (same prerequisite as the launchers — see
  `install-launchers` SKILL.md).
- The user has run `/orchestrator:install-launchers` so the env-var
  contract is in place. Without that, the statusline degrades gracefully
  to a generic `orchestrator` label, but won't show role info.

## When to use

- After installing the launchers, when the user asks for a visual
  role indicator inside the Claude UI.
- When the user surfaces frustration about "which session am I in?"
  during multi-session orchestration work.
- After a `/plugin update orchestrator` that bumps the statusline
  source (re-run picks up improvements).

## Steps

### 1. Confirm target directory

```bash
echo "Will install into: $PWD"
```

Same anchor convention as `install-launchers`: the user's project root.

### 2. Locate the source scripts directory

```bash
SCRIPTS_DIR=$(find ~/.claude/plugins/cache -path "*/orchestrator/*/skills/install-statusline/scripts" -type d 2>/dev/null | sort | tail -1)
echo "$SCRIPTS_DIR"
```

If the base directory was surfaced via the skill-load header, use that
path's `scripts/` subdirectory directly.

### 3. Detect existing `statusLine` setting (global AND project)

Claude Code resolves `statusLine` from a precedence chain — the
project-level `.claude/settings.json` shadows the global
`~/.claude/settings.json`. If we write an unconditional statusLine into
the project settings, we silently clobber a global statusline the user
relies on (the global one stops rendering in this project). Check BOTH
levels:

```bash
PROJECT_SETTINGS="$PWD/.claude/settings.json"
GLOBAL_SETTINGS="$HOME/.claude/settings.json"

EXISTING_LEVEL=""   # "project" | "global" | ""
EXISTING_VALUE=""

if [ -f "$PROJECT_SETTINGS" ]; then
  v=$(jq -r '.statusLine // empty | tojson' "$PROJECT_SETTINGS" 2>/dev/null)
  if [ -n "$v" ] && [ "$v" != "null" ]; then
    EXISTING_LEVEL="project"
    EXISTING_VALUE="$v"
  fi
fi

if [ -z "$EXISTING_LEVEL" ] && [ -f "$GLOBAL_SETTINGS" ]; then
  v=$(jq -r '.statusLine // empty | tojson' "$GLOBAL_SETTINGS" 2>/dev/null)
  if [ -n "$v" ] && [ "$v" != "null" ]; then
    EXISTING_LEVEL="global"
    EXISTING_VALUE="$v"
  fi
fi
```

If `EXISTING_LEVEL` is non-empty, surface the existing config and the
four options:

```
⚠ Existing statusLine detected at <project|global> level:
  <show $EXISTING_VALUE>

  (1) AUTO-COMPOSE (recommended) — install a composed-wrapper script
      that runs your existing statusline AND the orchestrator role
      indicator together. Your existing statusline keeps rendering;
      the orchestrator role indicator appears as the first line.
      Non-destructive of your existing setup.

  (2) SKIP — keep your existing statusLine, do not install the
      orchestrator statusline.

  (3) REPLACE — set the project-level statusLine to the orchestrator
      one only. If your existing config was at the GLOBAL level, this
      shadows it for this project only — your global statusline stays
      intact and renders in other projects. If your existing was at
      the PROJECT level, it's lost; back it up first.

  (4) COMPOSE MANUALLY — install the orchestrator scripts but do not
      touch settings.json. You merge the fragment into your existing
      statusline by hand. Use this when AUTO-COMPOSE's defaults
      (running ~/.claude/statusline.sh as the user-side script) don't
      match your setup.

Which option?
```

Wait for the user's answer before proceeding. Default to (1)
AUTO-COMPOSE if unclear — it's non-destructive.

**Stdin fan-out caveat (informs option 1):** Claude Code pipes session
JSON to the statusLine command via stdin on every refresh. A naive
"run cmd1; run cmd2" composition would have both commands fight over
stdin (cmd1 consumes it, cmd2 sees EOF). The shipped
`orchestrator-statusline-composed.sh` template handles this correctly:
it captures stdin once, runs the orchestrator script (which ignores
stdin), then re-pipes the captured JSON to the user's existing
statusline. Do NOT hand-roll a composition that skips the stdin
capture — the user's statusline will silently render blank.

If `EXISTING_LEVEL` is empty: proceed to step 4 without prompting.

### 4. Copy script files into the project root

The script set installed depends on the option chosen in step 3:

- For options (1) AUTO-COMPOSE, (3) REPLACE, (4) COMPOSE MANUALLY:
  install all four files.
- For option (2) SKIP: install nothing, exit.

```bash
INSTALL_DIR="$PWD"
for f in orchestrator_statusline.py \
         orchestrator-statusline.sh \
         orchestrator-statusline.ps1 \
         orchestrator-statusline-composed.sh; do
  cp "$SCRIPTS_DIR/$f" "$INSTALL_DIR/$f"
done
chmod 755 "$INSTALL_DIR/orchestrator-statusline.sh" \
          "$INSTALL_DIR/orchestrator-statusline-composed.sh"
```

On Windows the `chmod` step is a no-op.

The fourth file (`orchestrator-statusline-composed.sh`) is the
composed-wrapper template. It runs the orchestrator role indicator
THEN the user's `~/.claude/statusline.sh` (re-piping captured stdin).
For setups where the user's statusline is at a different path, the
template's `USER_STATUSLINE` variable can be edited in-place — it's a
single assignment at the top of the file.

### 5. Configure `.claude/settings.json`

For option (4) COMPOSE MANUALLY: skip this step. The scripts are in
place; the user merges into their existing settings.json on their own.

For options (1) AUTO-COMPOSE and (3) REPLACE: write the statusLine
command into the **project-level** `.claude/settings.json`. Project-
level always takes precedence over global, so this is the right
surface either way.

```bash
mkdir -p "$PWD/.claude"
SETTINGS="$PWD/.claude/settings.json"

# Build the OS-appropriate command — pointing at the composed wrapper
# for option (1), or the orchestrator-only wrapper for option (3).
case "$(uname -s 2>/dev/null || echo Windows)" in
  MINGW*|MSYS*|CYGWIN*|*NT*|Windows*)
    WRAPPER_BASE="orchestrator-statusline.ps1"     # option (3)
    COMPOSED_BASE="orchestrator-statusline-composed.sh"  # option (1) — bash via WSL
    if [ "$CHOICE" = "auto-compose" ]; then
      CMD="bash $INSTALL_DIR/$COMPOSED_BASE"
    else
      CMD="powershell -NoProfile -ExecutionPolicy Bypass -File $INSTALL_DIR\\$WRAPPER_BASE"
    fi
    ;;
  *)
    if [ "$CHOICE" = "auto-compose" ]; then
      CMD="$INSTALL_DIR/orchestrator-statusline-composed.sh"
    else
      CMD="$INSTALL_DIR/orchestrator-statusline.sh"
    fi
    ;;
esac

# Merge into existing settings.json (or create new). Preserves
# everything else in the file; only replaces `.statusLine`.
if [ -f "$SETTINGS" ]; then
  jq --arg cmd "$CMD" '.statusLine = {"type": "command", "command": $cmd}' "$SETTINGS" > "$SETTINGS.new"
  mv "$SETTINGS.new" "$SETTINGS"
else
  cat > "$SETTINGS" <<EOF
{
  "statusLine": {
    "type": "command",
    "command": "$CMD"
  }
}
EOF
fi
```

### 6. Verify install

```bash
# Run the statusline script directly to confirm output.
"$INSTALL_DIR/orchestrator-statusline.sh"
```

Expected output (when run outside a launcher session, env unset):

```
orchestrator  <project-basename>
```

When run inside a session spawned by `pa-start` / `sa-start` /
`discord-start`, the output includes the role glyph + session name.

### 7. Restart the Claude session

The statusline takes effect on session restart. Print:

```
Statusline installed. Close this Claude session and re-launch via
./pa-start.sh / sa-start.sh / discord-start.sh to see the role
indicator. Resumed sessions also pick it up.
```

## Composition guide for users with custom statuslines

If the user picked option (3) MANUAL COMPOSE in step 3, document the
fragment they can merge into their existing statusline:

The orchestrator statusline emits a single line of ANSI-colored
text on stdout. To include it inside an existing statusline script,
add this to your existing script's output:

```bash
ORCH_FRAGMENT=$(/abs/path/to/orchestrator-statusline.sh)
echo "$ORCH_FRAGMENT  |  <your existing content>"
```

The fragment is purely role/name/project — it doesn't read other state,
make network calls, or modify the environment. Safe to compose with
git-status / model-cost / battery-level / etc. statuslines.

## Uninstall

```bash
# Remove the orchestrator statusline configuration.
jq 'del(.statusLine)' "$PWD/.claude/settings.json" > "$PWD/.claude/settings.json.new"
mv "$PWD/.claude/settings.json.new" "$PWD/.claude/settings.json"

# Remove the script files.
rm "$PWD/orchestrator_statusline.py" \
   "$PWD/orchestrator-statusline.sh" \
   "$PWD/orchestrator-statusline.ps1"
```

If the user had a previous statusLine and we replaced it in option (2),
they'll need to restore from their backup — we don't track the
displaced value.

## Common mistakes

- **Replacing without backup**: option (2) replace is destructive. If
  the user has a custom statusline they care about, show them the
  current value before replacing so they can copy it elsewhere.
- **Auto-composing arbitrary commands**: do NOT attempt to wrap an
  existing statusLine command into our script. Shell command
  composition is fragile — quoting, $IFS, exit codes, side effects.
  Option (3) puts the composition burden on the user, which is the
  right place for it.
- **Setting the statusLine command to a relative path**: Claude Code
  invokes the statusline from its own CWD, which may not be the
  project root. Always use absolute paths in the `command` field.
- **Forgetting `chmod 755`**: on POSIX the `.sh` wrapper must be
  executable, or Claude Code will fail to invoke it (errors are
  swallowed silently and the statusline just goes blank).

## Notes

- The statusline depends on `$ORCHESTRATOR_SESSION_KIND` being set
  by the launchers. If the user launches Claude Code directly (e.g.,
  `claude` from the CLI with no launcher), the statusline degrades
  to a neutral `orchestrator <project-basename>` line.
- Re-running this skill after a `/plugin update orchestrator` is the
  right way to pick up statusline-script improvements. The installed
  copies are static.
- The script is stdlib-only Python — no third-party deps. Cross-platform
  by virtue of `os.environ` access being identical on POSIX and Windows.
- Performance: the script runs on every Claude UI refresh. Keep it
  fast (single env-var lookup + string format ≈ <1ms). Do not add
  subprocess calls, file I/O, or network access.
