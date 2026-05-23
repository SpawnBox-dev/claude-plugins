# Launcher Python-Canonical Rewrite — Design

**Status:** Design, awaiting plan + implementation.
**Date:** 2026-05-13
**Supersedes:** PR#3 (bash port, closed 2026-05-12) per upstream operator decision.

## Background

The orchestrator plugin today ships three PowerShell launcher scripts
(`pa-start.ps1`, `sa-start.ps1`, `discord-start.ps1`) totaling ~496 LOC,
each with a thin `.bat` double-click trampoline. They spawn Claude Code
sessions wired into the orchestrator agent-channel with role-appropriate
env vars, sessions.json singleton semantics for PA, and (on Windows)
Windows Terminal tab colors per role.

An earlier upstream PR (#3) ported the PowerShell logic to bash for
WSL/Linux/macOS. That PR was closed 2026-05-12 in favor of this
Python-canonical approach, motivated by:

- **Cross-platform drift** is the actual maintenance cost. Keeping
  bash and PowerShell in sync as the plugin evolves duplicates every
  change.
- Python is **already a baseline dependency** of the plugin via
  `sidecar/embed_server.py` and `sidecar/requirements.txt`. The
  Python-canonical path adds no new runtime dependency.
- A single Python module is **testable** as a unit, where the bash
  and PowerShell implementations had no unit-test surface.

## Goals

1. Single canonical implementation of launcher logic in Python.
2. Platform-native wrappers (`.sh` / `.ps1` / `.bat`) that do nothing
   but locate a Python interpreter and exec the canonical entry point.
3. User-observable behavior parity with the current upstream `.ps1`
   launchers (same CLI flags, same env vars set on the spawned
   `claude` process, same sessions.json mutations, same wt.exe tab
   colors), plus the `discord-start` surface (which the bash port
   omitted).
4. A pytest suite for the shared logic so future changes have
   regression coverage.
5. No new third-party Python dependencies; stdlib only for launcher
   code.

## Non-goals

- Cross-platform terminal-spawn abstraction beyond `wt.exe` on
  Windows. POSIX path uses `os.execvp("claude", argv)` in the current
  console — same as the closed bash port. macOS-native terminal
  spawning (`osascript` to Terminal.app / iTerm2) is out of scope.
- Refactoring `install-launchers/SKILL.md` into a Python-driven
  installer. The existing Bash recipe in the skill body continues to
  work; this PR only updates the file inventory and substitution
  step.
- Folding the sidecar's Python-interpreter discovery (uvx fallback
  chain) into the launcher wrappers. The two surfaces remain
  independent.

## File Layout

All paths relative to `plugins/orchestrator/skills/install-launchers/scripts/`.

| File | Role | Approx LOC |
| --- | --- | --- |
| `_launcher_common.py` | Shared module: project-dir resolution, project-hash transform, JSONL display-name → UUID lookup, sessions.json read/write + singleton-supersede, session-name generator, env-var assembly, claude argv builder, `launch()` (wt.exe on Windows, execvp on POSIX), marketplace-slug guard. | ~250 |
| `pa_start.py` | PA entry point: singleton-supersede + hardcoded `--effort max` + gold tab `#F59E0B`. | ~60 |
| `sa_start.py` | SA entry point: optional `--effort` (low/medium/high/xhigh/max) + default tab. | ~60 |
| `discord_start.py` | Discord-ops entry point: dual `--channels` (Discord allowlisted + orchestrator dev-channels) + red tab `#DC2626` + fixed `DISCORD-LIVE-` name prefix. | ~50 |
| `pa-start.sh` / `sa-start.sh` / `discord-start.sh` | POSIX wrapper: locate `python3` (honoring `$ORCH_PYTHON` override), exec the entry `.py` with passthrough args. Mode 755. | ~8 each |
| `pa-start.ps1` / `sa-start.ps1` / `discord-start.ps1` | Windows PS wrapper: locate `python.exe` → `py.exe` fallback with MS Store stub detection (per anti-pattern `adf2b104`), exec entry `.py`. | ~15 each |
| `pa-start.bat` / `sa-start.bat` / `discord-start.bat` | Windows double-click trampoline (unchanged shape from today: `@powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0<name>.ps1" %*`). | 4 each |

**Totals:** 13 files (up from 6 today). ~420 LOC Python + ~80 LOC platform glue, replacing 496 LOC PowerShell + 12 LOC batch.

**Naming:** `.py` files use underscores (PEP 8 importable module names so
the entry points can `from _launcher_common import ...`). Wrappers and
shell-invocable surface use hyphens (shell tradition). Users invoke only
the wrappers, so the naming mismatch is invisible at the user surface.

**Python version floor: 3.10.** Justified by `X | None` type-union syntax
(PEP 604), broad ecosystem availability (Ubuntu 22.04 default, Windows
winget `Python.Python.3.12`, macOS `brew install python@3.12`). Enforced
via a single `sys.version_info` check at `_launcher_common.py` import
time with an actionable error message.

## Components

### `_launcher_common.py` public interface

```python
MARKETPLACE_PLACEHOLDER: str  # "__ORCH_MARKETPLACE__"; install-launchers substitutes

def resolve_project_dir(arg: str | None) -> Path
def project_hash_for(project_dir: Path) -> str         # CC dir-hash transform
def resolve_resume_target(resume: str, project_dir: Path) -> str  # uuid-or-name → uuid
def supersede_existing_pa(project_dir: Path) -> None   # pa-only
def make_session_name(prefix: str) -> str              # "{PREFIX}-YYYY-MM-DD-HH-MM-SS"

def setup_env(*, role: str, session_kind: str,
              project_dir: Path, session_name: str | None) -> None
def build_claude_args(*, marketplace: str, session_name: str | None,
                      resume: str | None, effort: str | None,
                      extra_channels: list[str] | None = None) -> list[str]

def launch(claude_args: list[str], *, project_dir: Path,
           tab_color: str | None, no_wt: bool) -> int
```

### Per-entry-point data flow (pa_start.py example)

```
argv → argparse → resolve_project_dir
                  ↓
              resolve_resume_target  (if --resume)
                  ↓
              supersede_existing_pa  ← pa-only
                  ↓
              make_session_name("PA")  ← skipped if --resume
                  ↓
              setup_env(role="prime", session_kind="prime", …)
                  ↓
              build_claude_args(marketplace=…, effort="max", …)
                  ↓
              launch(argv, tab_color="#F59E0B", no_wt=…)
                  ↓
              POSIX: os.execvp("claude", argv)
              Win:   subprocess.run(["wt.exe", …, "claude", *argv])  or direct
```

### Distinctness across entry points

| Aspect | `pa_start.py` | `sa_start.py` | `discord_start.py` |
| --- | --- | --- | --- |
| Role env | `prime` | `subordinate` | `subordinate` |
| Session kind env | `prime` | `subordinate` | `discord-bot` |
| Singleton-supersede | yes | no | no |
| Session-name prefix | `PA-` | `SA-` (or `--name`) | `DISCORD-LIVE-` (fixed) |
| `--effort` flag | none (hardcoded `max`) | optional | none |
| Extra `--channels` | none | none | `plugin:discord@claude-plugins-official` |
| Tab color | `#F59E0B` (gold) | none | `#DC2626` (red) |
| `--resume` flag | yes | yes | no |
| `--name` flag | no | yes | no |

### `--dry-run` mode

Each entry point accepts `--dry-run`, which performs all state mutations
EXCEPT the `sessions.json` write and the `launch()` call. It prints a
JSON envelope to stdout:

```json
{
  "argv": ["--dangerously-load-development-channels", "plugin:orchestrator@<marketplace>", ...],
  "env_overrides": {"MCP_TIMEOUT": "30000", "ORCHESTRATOR_PROJECT_ROOT": "...", ...},
  "tab_color": "#F59E0B",
  "use_wt": true
}
```

Returns 0. Serves as both a debugging tool (`pa-start.sh --dry-run`) and
the smoke-test interface for `tests/launchers/test_entry_points.py`.

### Wrapper templates

**POSIX (`pa-start.sh`, identical shape for sa/discord):**

```bash
#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PYTHON="${ORCH_PYTHON:-python3}"
command -v "$PYTHON" >/dev/null 2>&1 || {
  echo "ERROR: '$PYTHON' not found. Install Python 3.10+ (apt install python3, brew install python@3.12, or set \$ORCH_PYTHON to a working interpreter)." >&2
  exit 127
}
exec "$PYTHON" "$SCRIPT_DIR/pa_start.py" "$@"
```

**Windows (`pa-start.ps1`, identical shape for sa/discord):**

```powershell
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$candidates = @($env:ORCH_PYTHON, 'python.exe', 'py.exe') | Where-Object { $_ }
$python = $null
foreach ($c in $candidates) {
  $cmd = Get-Command $c -ErrorAction SilentlyContinue
  if ($cmd) {
    $vout = & $cmd.Source --version 2>&1
    if ($LASTEXITCODE -eq 0 -and $vout -notmatch 'Python was not found') {
      $python = $cmd.Source
      break
    }
  }
}
if (-not $python) {
  Write-Host "ERROR: Python 3.10+ not found. Install via 'winget install Python.Python.3.12', python.org, or the Microsoft Store (real Python 3.x, not the App Execution Alias stub). Or set `$env:ORCH_PYTHON to a working interpreter." -ForegroundColor Red
  exit 127
}
& $python "$here\pa_start.py" @args
exit $LASTEXITCODE
```

**`.bat` trampoline** retains its current 4-line shape; only the
filename it dispatches to is updated when the corresponding `.ps1`
changes.

## Error Handling

| Failure point | Exit | Message + recovery |
| --- | --- | --- |
| Wrapper: Python not found | 127 | "Python 3.10+ not found" + install hint (winget / python.org / `$ORCH_PYTHON`). |
| Wrapper: MS Store stub (Windows) | 127 | Caught by `Python was not found` output match. Same install hint. |
| `.py`: Python < 3.10 | 1 | Checked at `_launcher_common.py` import; clear message naming the detected version. |
| `.py`: `--project-dir` doesn't exist | 1 | `"ERROR: project-dir not found: <path>"`. |
| `.py`: `--resume <name>` projects dir missing | 1 | Mirrors current `.ps1`: `"ERROR: Projects dir not found: <dir>"`. |
| `.py`: `--resume <name>` no match in JSONLs | 1 | Mirrors current `.ps1`: `"ERROR: No session in <dir> renamed to: <name>"`. |
| `.py`: `sessions.json` parse error during supersede | warn, continue | `"WARNING: Could not parse <file> (treating as no-PA): <err>"`. Matches current `.ps1`. |
| `.py`: `sessions.json` write fails during supersede | **1 (fatal)** | New, tighter than `.ps1`. Silent write failure would leave two `role=prime` entries; we exit hard with `"ERROR: Could not write <file>: <err>"`. |
| `.py`: `claude` not on PATH | 127 | Caught via `shutil.which("claude")` before `execvp`; tells user to install Claude Code CLI. |
| `.py`: `wt.exe` missing on Windows (no `--no-windows-terminal`) | falls through to direct exec | INFO log when `--verbose`. |
| `.py`: any unexpected exception | 1 | Default Python traceback to stderr — no swallowing. |

**Design rationale:**

- No catch-all `try/except` in entry points. Python's default traceback is more useful than a swallowed message. The `.ps1` today uses `$ErrorActionPreference = 'Stop'` with a narrow `try`/`catch` only around the supersede block; this design mirrors that scope.
- The supersede-block catch splits into two: parse errors stay warn-only (corrupt state file → treat as no-PA, self-heals on next register), but write errors become fatal (silent write failure leaves the sessions.json in a broken state where the singleton invariant is violated).
- No retries. These are session-spawn operations; if launch fails, the user reruns.

## Marketplace Slug Substitution

The `__ORCH_MARKETPLACE__` placeholder lives only in
`_launcher_common.py` as a module-level constant. Entry points read it
via import; wrappers never touch it.

`install-launchers/SKILL.md` step 4 changes from "substitute in three
`.ps1` files" to "substitute in one `.py` file". Net simpler.

**Guard at module import:** `_launcher_common.py` checks that
`MARKETPLACE_PLACEHOLDER` is not still the literal placeholder
(using a split-string trick to avoid self-detection: comparing against
`"__ORCH_" + "MARKETPLACE__"`). If it is, prints an actionable error
pointing at `/orchestrator:install-launchers`. This catches the case
where a user copies the `.py` files directly without going through the
install skill.

## Testing

### Location and runner

`plugins/orchestrator/tests/launchers/` — pytest. Pytest is the only
new dev dependency; declared via:

- `plugins/orchestrator/pyproject.toml` (new): minimal
  `[tool.pytest.ini_options]` block + `[project.optional-dependencies] dev = ["pytest>=8"]`.
- `plugins/orchestrator/package.json`: new script `"test:py": "uvx --from pytest pytest tests/launchers/"`. Using `uvx` matches the sidecar's existing uvx-fallback pattern so contributors don't need a separate `pip install`.

### Test files

```
tests/launchers/
├── conftest.py            # fixtures: tmp project dir, fake sessions.json, env-var snapshot/restore
├── test_project_hash.py   # POSIX + Windows path → CC project-hash transform
├── test_resume_resolve.py # display-name → UUID via JSONL grep (creates 3 fake JSONLs)
├── test_supersede.py      # parse OK / parse fail (warn) / write fail (fatal) / no-prime / fresh-prime / stale-prime
├── test_session_name.py   # regex match on PA-/SA-/DISCORD-LIVE- + timestamp
├── test_setup_env.py      # role/kind/name combinations + SPAWNBOX_ aliases + relay flag
├── test_build_args.py     # marketplace substitution path, --effort presence/absence, --resume, --channels
└── test_entry_points.py   # smoke: each entry .py with --dry-run prints expected JSON
```

### What's NOT tested in pytest

The actual `os.execvp("claude", ...)` and
`subprocess.run(["wt.exe", ...])` calls. Smoke tests assert on
`--dry-run` output; they do not drive a real Claude Code instance.
Real end-to-end remains operator-driven per the bash-port verification
protocol.

### Reviewer-runnable verification

```bash
cd plugins/orchestrator
bun install
bun run typecheck         # unchanged: no .py change crosses the bun boundary
uvx --from pytest pytest tests/launchers/
```

All three must pass clean. Operator separately runs end-to-end on the
fresh Windows + WSL systems available for this work.

## Install Skill Changes

`plugins/orchestrator/skills/install-launchers/SKILL.md` requires
targeted updates:

1. Overview paragraph: "copies SIX files" → "copies THIRTEEN files."
2. File inventory table: rewrite to reflect the new 1 shared module + 3 entry points + 3 platforms × 3 wrappers = 13 files. Distinguish between role-specific entry points and shared module.
3. Step 4 (marketplace substitution): substitute in `_launcher_common.py` only, not in `.ps1` files.
4. New step: `chmod 755` on the three `.sh` wrappers after copy.
5. Update the "When to use" section to note that Python 3.10+ is now a prerequisite (with the same install hints as the wrappers).

No other skill changes required.

## Migration for Existing Users

### Operator's local quayline workspace (closed PR#3 bash launchers)

Currently `~/workspaces/quayline/pa-start.sh` and `sa-start.sh` are
canonical-bash files (~200 LOC each) installed from the closed PR#3
plus a local-copy step in the SKILL.md update for that PR.

When this PR merges and `/orchestrator:install-launchers` is re-run,
those two filenames will be **overwritten** with ~8-line wrapper
versions. The new `discord-start.sh` is added (not present today
locally). Observable behavior is unchanged: same args, same env, same
claude invocation — only the implementation moves from
bash-does-the-work to bash-execs-python-which-does-the-work.

If the operator wants a rollback safety net, they can keep a backup
copy of the current `pa-start.sh` / `sa-start.sh` before re-running
install-launchers. No git stash is appropriate because those files are
not tracked in the Quayline workspace.

### Other upstream consumers

No other migration concerns. Windows users on `.ps1` get
behavior-preserving wrappers; their `.bat` shims continue to work
because the trampoline is unchanged in shape (only the dispatched
`.ps1` body differs).

## Out of Scope (Deferred)

- **macOS-specific terminal-spawn.** POSIX path uses `os.execvp` in the current console, matching the closed bash port. macOS users get the same in-console behavior as Linux/WSL. A future PR may add `osascript` integration for Terminal.app / iTerm2 if there's demand.
- **Python-driven install-launchers skill.** The current Bash recipe in the skill body remains fine. A `scripts/install.py` that orchestrates copy + substitution is a larger refactor for a separate PR.
- **Sidecar / launcher Python-discovery convergence.** Each surface retains its own interpreter-discovery logic for now; sharing would couple the launcher to the sidecar's uvx fallback chain unnecessarily.

## PR Shape

- **Branch:** `feat/orchestrator-launcher-python-canonical`, cut from `upstream/main`.
- **Scope:** 13 launcher files (replacing 6 today), pyproject.toml (new), package.json (1 script added), `install-launchers/SKILL.md` (5 line-item edits), `tests/launchers/` directory (8 test files), this design doc.
- **Stack independence:** unrelated to PR#2 (sidecar boot timeout) and PR#4 (backup-plugin-db skill). Mergeable in any order; no shared files.
- **PR body sections:** Why (decision c4125ed4) → What's removed → What's added → Python-already-a-dep → Test plan → Stack note (independent).

## References

- Decision `c4125ed4` — withdraw PR#3, pivot to Python-canonical.
- Note `cee051ff` — bash-port verification protocol (used as the E2E template here).
- Anti-pattern `adf2b104` — MS Store Python stub detection rule (informs the `.ps1` wrapper).
- Note `952a88bb` — operator validation resources (fresh Windows + WSL hosts available post-merge).
- Anti-pattern `743f94a0` — generated-artifact drift after rebase (irrelevant here — no `dist/` files in this PR, but recorded as a general rule).
- Existing precedent: `plugins/orchestrator/docs/plans/2026-04-28-r6-cross-session-messaging.md` — same directory, same style.
