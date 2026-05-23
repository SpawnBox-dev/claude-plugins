---
name: install-launchers
description: Use when setting up the orchestrator plugin in a new project (or refreshing after a plugin update). Installs the canonical pa-start / sa-start / discord-start launchers into the current project root so the user can spawn PA/SA/Discord-ops Claude Code sessions from their terminal.
---

# Install orchestrator launchers into this project

## Overview

The orchestrator plugin ships canonical Python launchers (with thin
platform wrappers) for spawning Claude Code sessions wired into the
agent-channel. These launchers must live in the user's project root
(not the plugin's `bin/`) because the user invokes them from their OS
terminal to spawn NEW Claude sessions - and Claude Code's plugin `bin/`
PATH only applies inside an already-running Claude session.

Three launcher kinds ship today:

| Launcher | Role / Kind | Channels attached | Tab color | Files installed |
|---|---|---|---|---|
| `pa-start` | role=prime, kind=prime | orchestrator | gold (#F59E0B) | `pa_start.py` + `pa-start.sh` + `pa-start.ps1` + `pa-start.bat` |
| `sa-start` | role=subordinate, kind=subordinate | orchestrator | default | `sa_start.py` + `sa-start.sh` + `sa-start.ps1` + `sa-start.bat` |
| `discord-start` | role=subordinate, kind=discord-bot | orchestrator + Discord | red (#DC2626) | `discord_start.py` + `discord-start.sh` + `discord-start.ps1` + `discord-start.bat` |

All three launchers share a single canonical Python implementation
(`_launcher_common.py`), which is the 13th file installed.

This skill copies THIRTEEN files into the user's CWD (one shared
Python module + three Python entry-point modules + three POSIX
wrappers + three Windows PowerShell wrappers + three Windows batch
trampolines) and substitutes the marketplace slug into the shared
Python module so it references the right
`plugin:orchestrator@<marketplace>` for
`--dangerously-load-development-channels`.

## Prerequisites

- **Python 3.10 or newer** must be installed and on PATH.
  - Linux/WSL: `sudo apt install python3` (Ubuntu 22.04+ ships 3.10+).
  - macOS: `brew install python@3.12`.
  - Windows: `winget install Python.Python.3.12`, the python.org
    installer, OR the real Microsoft Store "Python 3.x" app (NOT the
    App Execution Alias stub that just prints "Python was not found").
- The wrappers also honor `$ORCH_PYTHON` / `$env:ORCH_PYTHON` if you
  want to point at a specific interpreter.

Python is already a baseline dependency of the orchestrator plugin
via `sidecar/embed_server.py` and `sidecar/requirements.txt`. This
skill does not add a new dependency.

## When to use

- After running `/plugin install orchestrator` in a new project
- After `/plugin update orchestrator` if the launcher source files have changed
- When a teammate forks the project and needs their own launchers

## Steps

### 1. Confirm target directory

Resolve the install target (the user's project root):

```bash
echo "Will install into: $PWD"
```

If `$PWD` isn't the project root the user wants, ask them to `cd` first.

### 2. Locate the source scripts directory

This skill lives at `<plugin-cache>/skills/install-launchers/SKILL.md`,
and the canonical launchers live in the `scripts/` directory next to it.
The system message that loaded this skill displayed a `Base directory for
this skill:` header with the absolute path - use that path's `scripts/`
subdirectory as the source.

If for some reason the base directory isn't surfaced, locate the plugin
cache by searching:

```bash
SCRIPTS_DIR=$(find ~/.claude/plugins/cache -path "*/orchestrator/*/skills/install-launchers/scripts" -type d 2>/dev/null | sort | tail -1)
echo "$SCRIPTS_DIR"
```

The `sort | tail -1` picks the lexicographically last version directory,
which is typically the newest semver. If there are multiple installs,
pick the one matching the current `/plugin` version visible to the user.

### 3. Derive the marketplace slug

The launchers' `--dangerously-load-development-channels` flag needs
`plugin:orchestrator@<marketplace-slug>`. Extract the slug from the
plugin cache path: it's the segment immediately after `cache/` and
immediately before `orchestrator/`:

```bash
# Example path: ~/.claude/plugins/cache/spawnbox-dev-claude-plugins/orchestrator/0.30.3/skills/install-launchers/scripts
# Marketplace slug: spawnbox-dev-claude-plugins
MARKETPLACE=$(echo "$SCRIPTS_DIR" | sed -nE 's|.*/cache/([^/]+)/orchestrator/.*|\1|p')
echo "Marketplace: $MARKETPLACE"
```

If `MARKETPLACE` is empty, ask the user for the correct marketplace slug
(visible via `/plugin marketplace list`) before proceeding.

### 4. Copy files into the project root

```bash
INSTALL_DIR="$PWD"
for f in _launcher_common.py \
         pa_start.py sa_start.py discord_start.py \
         pa-start.sh sa-start.sh discord-start.sh \
         pa-start.ps1 sa-start.ps1 discord-start.ps1 \
         pa-start.bat sa-start.bat discord-start.bat; do
  cp "$SCRIPTS_DIR/$f" "$INSTALL_DIR/$f"
done
chmod 755 "$INSTALL_DIR/pa-start.sh" \
          "$INSTALL_DIR/sa-start.sh" \
          "$INSTALL_DIR/discord-start.sh"
```

On Windows the `chmod` step is a no-op; `.sh` files are not executable
there, and `.ps1` / `.bat` files don't need an executable bit.

If any target file already exists at `$INSTALL_DIR/$f`, **ask the user
before overwriting** - they may have a local customization worth
preserving.

### 5. Substitute the marketplace slug

The placeholder `__ORCH_MARKETPLACE__` lives in `_launcher_common.py`
as a module-level constant; substitute it in that single file at copy
time:

```bash
# Linux/macOS/WSL
sed -i.bak "s|__ORCH_MARKETPLACE__|$MARKETPLACE|g" \
    "$INSTALL_DIR/_launcher_common.py"
rm "$INSTALL_DIR/_launcher_common.py.bak"
```

```powershell
# Windows
(Get-Content "$InstallDir\_launcher_common.py") `
  -replace '__ORCH_MARKETPLACE__', $Marketplace `
  | Set-Content "$InstallDir\_launcher_common.py"
```

Verify the substitution by running the marketplace guard:

```bash
python3 -c "import sys; sys.path.insert(0, '$INSTALL_DIR'); \
  import _launcher_common; _launcher_common.check_marketplace_substituted()"
```

If the placeholder wasn't substituted, the script exits 1 with an
actionable error pointing back at this install skill.

### 6. Verify the install

```bash
ls -la "$INSTALL_DIR"/_launcher_common.py \
       "$INSTALL_DIR"/{pa,sa,discord}_start.py \
       "$INSTALL_DIR"/{pa,sa,discord}-start.{sh,ps1,bat}
grep -l "__ORCH_MARKETPLACE__" "$INSTALL_DIR/_launcher_common.py" \
  || echo "Substitution complete."
grep -h "MARKETPLACE_PLACEHOLDER" "$INSTALL_DIR/_launcher_common.py" | head -1
```

The first listing should show 13 files. The first grep should produce
no output (the literal token is gone). The third should print the
substituted slug.

### 7. Output usage instructions

Print to terminal:

```
Installed orchestrator launchers into <PROJECT_ROOT>. Usage:

POSIX (Linux/macOS/WSL):
  ./pa-start.sh                          Start a new PA (gold tab on Win)
  ./pa-start.sh --resume <uuid-or-name>  Resume an existing session as PA
  ./sa-start.sh                          Start a new SA
  ./sa-start.sh --name "SA-frontend"     Start SA with an explicit name
  ./sa-start.sh --effort max             Start SA at max reasoning effort
  ./sa-start.sh --resume <uuid-or-name>  Resume an existing session as SA
  ./discord-start.sh                     Start a Discord-ops session

Windows:
  .\pa-start.bat                         Start a new PA (gold tab)
  .\pa-start.bat -Resume <uuid-or-name>  (replace -Resume with --resume
                                          when calling the .ps1 directly)
  .\sa-start.bat                         Start a new SA
  .\discord-start.bat                    Start a Discord-ops session

Override the Python interpreter with $ORCH_PYTHON / $env:ORCH_PYTHON
if the default `python3` / `python.exe` resolves to the wrong one.

Use --dry-run on any launcher to print the resolved argv + env without
actually spawning Claude — useful for debugging.
```

## Quick reference

| Step | What | Where |
|---|---|---|
| 1 | Confirm `$PWD` is project root | Terminal |
| 2 | Locate scripts dir | `<base-dir>/scripts/` |
| 3 | Extract marketplace slug | `<cache-path>` after `cache/` |
| 4 | Copy 13 files + chmod the 3 .sh | `$PWD/*.{py,sh,ps1,bat}` |
| 5 | Substitute `__ORCH_MARKETPLACE__` in `_launcher_common.py` only | One sed/replace |
| 6 | Verify no unsubstituted tokens remain | grep + guard call |
| 7 | Print usage | Terminal |

## How discord-start differs

`discord-start` is unique because it attaches BOTH channel plugins to
the same Claude Code session:

- `--channels plugin:discord@claude-plugins-official` (allowlisted)
- `--dangerously-load-development-channels plugin:orchestrator@<marketplace>` (third-party)

The session receives events from both sources, distinguishable by the
`source` attribute on the `<channel>` tag:

- `<channel source="plugin:discord:discord" ...>` - incoming Discord chat
- `<channel source="plugin:orchestrator:core" ...>` - cross-session events

This is a powerful combination: PA can observe and coordinate the
Discord-ops session, and the Discord-ops session can `@PA` when it
needs help with a tricky Discord situation. The two flags coexist
per the [channels reference](https://code.claude.com/docs/en/channels-reference),
though the `--dangerously-load-development-channels` bypass does NOT
extend to `--channels` entries (which is why Discord still needs its
own `--channels` arg).

## Common mistakes

- **Forgetting the substitution step**: copying the raw `_launcher_common.py`
  with the literal `__ORCH_MARKETPLACE__` placeholder will produce
  launchers that fail with the guard's "marketplace slug not
  substituted" error on first run. Always run the substitution.
- **Forgetting `chmod 755` on the .sh wrappers**: POSIX shells refuse
  to exec non-executable scripts. Without the chmod, users see
  "Permission denied".
- **Picking the wrong cache version**: if the user has multiple
  installed versions, `sort | tail -1` may not be what they want. If
  uncertain, look at `/plugin` for the active version and use that
  path.
- **Overwriting customized launchers silently**: if installed files
  already exist, ask before clobbering. The user may have local edits.
- **Running outside the project root**: the skill anchors install to
  `$PWD`. If the user runs it from a parent or sibling directory, the
  launchers land in the wrong place. Always confirm `$PWD` in step 1.
- **Python interpreter mismatch on Windows**: if `python.exe` resolves
  to the Microsoft Store App Execution Alias stub instead of a real
  Python install, the wrapper's stub-detection (`Python was not
  found` output match) catches it and exits 127. Install a real Python
  (winget / python.org / the real MS Store Python 3.x app).

## Notes

- Re-running this skill after a `/plugin update orchestrator` is the
  right way to pick up launcher improvements. The installed copies are
  static; they don't auto-update with the plugin.
- The launchers themselves are project-agnostic: they use `$PWD` (or
  an explicit `--project-dir` flag) as the project root, set
  `ORCHESTRATOR_PROJECT_ROOT` env for the spawned MCP, and work in
  any project where the orchestrator plugin is installed.
- The `__ORCH_MARKETPLACE__` placeholder makes the source scripts
  portable across marketplace slugs; only the COPIED `_launcher_common.py`
  in each project root is slug-specific. Entry-point and wrapper files
  are identical across all installs.
- For testing the launcher logic without spawning Claude, use the
  `--dry-run` flag on any entry point. It prints the JSON envelope
  describing the resolved argv + env_overrides + tab_color + use_wt.
