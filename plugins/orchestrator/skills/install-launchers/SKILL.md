---
name: install-launchers
description: Use when setting up the orchestrator plugin in a new project (or refreshing after a plugin update). Installs the canonical pa-start / sa-start launchers into the current project root so the user can spawn PA/SA Claude Code sessions from their terminal.
---

# Install orchestrator launchers into this project

## Overview

The orchestrator plugin ships canonical PowerShell launchers for spawning
PrimeAgent (PA) and Subordinate Agent (SA) Claude Code sessions. These
launchers must live in the user's project root (not the plugin's `bin/`)
because the user invokes them from their OS terminal to spawn NEW Claude
sessions - and Claude Code's plugin `bin/` PATH only applies inside an
already-running Claude session.

This skill copies four files into the user's CWD and substitutes the
marketplace slug into the copies so they reference the right
`plugin:orchestrator@<marketplace>` for development-channels.

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

### 4. Copy + substitute the four files

The source files contain the literal token `__ORCH_MARKETPLACE__` where
the slug needs to be. Copy each file and replace the token in-place:

```bash
for f in pa-start.ps1 pa-start.bat sa-start.ps1 sa-start.bat; do
  sed "s|__ORCH_MARKETPLACE__|$MARKETPLACE|g" "$SCRIPTS_DIR/$f" > "$PWD/$f"
  echo "Installed $f"
done
```

If any target file already exists at `$PWD/$f`, **ask the user before
overwriting** - they may have a local customization worth preserving.

### 5. Verify the install

```bash
ls -la "$PWD"/{pa,sa}-start.{ps1,bat}
grep -l "__ORCH_MARKETPLACE__" "$PWD"/{pa,sa}-start.{ps1,bat} || echo "Substitution complete."
grep -h "plugin:orchestrator@" "$PWD"/pa-start.ps1
```

The first grep should produce no output (the literal token is gone).
The second should print the substituted plugin reference matching the
marketplace slug.

### 6. Output usage instructions

Print to terminal:

```
Installed orchestrator launchers into <PROJECT_ROOT>. Usage:
  .\pa-start.bat                          Start a new PA (gold tab)
  .\pa-start.bat -Resume <uuid-or-name>   Resume an existing session as PA
  .\sa-start.bat                          Start a new SA
  .\sa-start.bat -Name "SA-frontend"      Start SA with an explicit name
  .\sa-start.bat -Resume <uuid-or-name>   Resume an existing session as SA
```

## Quick reference

| Step | What | Where |
|---|---|---|
| 1 | Confirm `$PWD` is project root | Terminal |
| 2 | Locate scripts dir | `<base-dir>/scripts/` |
| 3 | Extract marketplace slug | `<cache-path>` after `cache/` |
| 4 | Copy + substitute `__ORCH_MARKETPLACE__` | `$PWD/*.{ps1,bat}` |
| 5 | Verify no unsubstituted tokens remain | grep check |
| 6 | Print usage | Terminal |

## Common mistakes

- **Forgetting the substitution step**: copying the raw `.ps1` files
  with the literal `__ORCH_MARKETPLACE__` placeholder will produce
  launchers that fail with "plugin not found in marketplace
  '__ORCH_MARKETPLACE__'". Always run the `sed` step.
- **Picking the wrong cache version**: if the user has multiple
  installed versions, `sort | tail -1` may not be what they want. If
  uncertain, look at `/plugin` for the active version and use that
  path.
- **Overwriting customized launchers silently**: if `$PWD/pa-start.ps1`
  already exists, ask before clobbering. The user may have local edits.
- **Running outside the project root**: the skill anchors install to
  `$PWD`. If the user runs it from a parent or sibling directory, the
  launchers land in the wrong place. Always confirm `$PWD` in step 1.

## Notes

- Re-running this skill after a `/plugin update orchestrator` is the
  right way to pick up launcher improvements. The installed copies are
  static; they don't auto-update with the plugin.
- The launchers themselves are project-agnostic: they use `$PWD` (or
  an explicit `-ProjectDir` parameter) as the project root, set
  `ORCHESTRATOR_PROJECT_ROOT` env for the spawned MCP, and work in
  any project where the orchestrator plugin is installed.
- The `__ORCH_MARKETPLACE__` placeholder makes the source scripts
  portable across marketplace slugs; only the COPIED versions in each
  project root are slug-specific.
