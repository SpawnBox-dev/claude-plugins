# Launcher Python-Canonical Rewrite — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the three PowerShell-canonical launcher scripts (`pa-start.ps1`, `sa-start.ps1`, `discord-start.ps1`) with one Python-canonical implementation (1 shared module + 3 entry points) and thin `.sh` / `.ps1` / `.bat` wrappers, per the design in `2026-05-13-launcher-python-canonical-design.md`.

**Architecture:** Three Python entry points (`pa_start.py`, `sa_start.py`, `discord_start.py`) share business logic via `_launcher_common.py`. POSIX wrappers locate `python3`; Windows wrappers locate `python.exe` / `py.exe` with Microsoft Store stub detection. Behavior parity with existing PowerShell launchers preserved.

**Tech Stack:** Python 3.10+ stdlib only (no third-party launcher deps), `pytest` as dev-only test runner via `uvx`, Bash for POSIX wrappers, PowerShell for Windows wrappers, batch for Windows double-click trampolines.

**Working tree:** `/tmp/cp-launcher`. Branch: `feat/orchestrator-launcher-python-canonical` (cut from `upstream/main`). All paths in this plan are relative to that worktree's root unless absolute.

---

## File Structure

Files created or modified by this plan, with responsibility:

**New files (Python sources):**
- `plugins/orchestrator/skills/install-launchers/scripts/_launcher_common.py` — Shared module: project-dir resolution, project-hash transform, JSONL display-name lookup, sessions.json mutation, env-var assembly, claude argv builder, `launch()` (terminal-spawn abstraction), marketplace-slug guard. Importable.
- `plugins/orchestrator/skills/install-launchers/scripts/pa_start.py` — PA entry point.
- `plugins/orchestrator/skills/install-launchers/scripts/sa_start.py` — SA entry point.
- `plugins/orchestrator/skills/install-launchers/scripts/discord_start.py` — Discord-ops entry point.

**New files (wrappers):**
- `plugins/orchestrator/skills/install-launchers/scripts/pa-start.sh` — POSIX wrapper for `pa_start.py`.
- `plugins/orchestrator/skills/install-launchers/scripts/sa-start.sh` — POSIX wrapper for `sa_start.py`.
- `plugins/orchestrator/skills/install-launchers/scripts/discord-start.sh` — POSIX wrapper for `discord_start.py`.

**Modified files (wrappers replaced in place):**
- `plugins/orchestrator/skills/install-launchers/scripts/pa-start.ps1` — Now a thin Windows wrapper for `pa_start.py` (was 208 LOC canonical PS).
- `plugins/orchestrator/skills/install-launchers/scripts/sa-start.ps1` — Thin wrapper for `sa_start.py` (was 175 LOC).
- `plugins/orchestrator/skills/install-launchers/scripts/discord-start.ps1` — Thin wrapper for `discord_start.py` (was 113 LOC).

**Unchanged files:**
- `plugins/orchestrator/skills/install-launchers/scripts/pa-start.bat`, `sa-start.bat`, `discord-start.bat` — Already 4-line trampolines; their dispatch target (`.ps1`) is unchanged in name, only in body.

**New files (testing infrastructure):**
- `plugins/orchestrator/pyproject.toml` — Pytest config + dev-extras.
- `plugins/orchestrator/tests/launchers/conftest.py` — Pytest fixtures (tmp project dir, fake sessions.json, env-var snapshot/restore, sys.path injection).
- `plugins/orchestrator/tests/launchers/test_project_hash.py` — Unit tests for project-hash transform.
- `plugins/orchestrator/tests/launchers/test_resume_resolve.py` — Unit tests for display-name → UUID resolution.
- `plugins/orchestrator/tests/launchers/test_supersede.py` — Unit tests for PA singleton-supersede behavior.
- `plugins/orchestrator/tests/launchers/test_session_name.py` — Unit tests for session-name generator.
- `plugins/orchestrator/tests/launchers/test_setup_env.py` — Unit tests for env-var assembly.
- `plugins/orchestrator/tests/launchers/test_build_args.py` — Unit tests for claude argv builder.
- `plugins/orchestrator/tests/launchers/test_entry_points.py` — Smoke tests for each entry point via `--dry-run`.

**Modified files (project metadata):**
- `plugins/orchestrator/package.json` — Add `"test:py"` script.
- `plugins/orchestrator/skills/install-launchers/SKILL.md` — Update file count, file inventory, substitution step, `chmod` step, Python prerequisite.

---

## Task 1: Test infrastructure scaffolding

**Files:**
- Create: `plugins/orchestrator/pyproject.toml`
- Create: `plugins/orchestrator/tests/launchers/conftest.py`
- Create: `plugins/orchestrator/tests/launchers/__init__.py` (empty)
- Modify: `plugins/orchestrator/package.json` (add `test:py` script)

- [ ] **Step 1: Create `plugins/orchestrator/pyproject.toml`**

```toml
[project]
name = "orchestrator-launchers"
version = "0.0.0"
description = "Python launcher implementation for the orchestrator plugin. Stdlib only — no runtime dependencies."
requires-python = ">=3.10"

[project.optional-dependencies]
dev = ["pytest>=8"]

[tool.pytest.ini_options]
minversion = "8.0"
testpaths = ["tests/launchers"]
addopts = ["-ra", "--strict-markers"]
```

- [ ] **Step 2: Create `plugins/orchestrator/tests/launchers/__init__.py`** (empty file, so `tests/launchers` is treated as a package)

```python
```

- [ ] **Step 3: Create `plugins/orchestrator/tests/launchers/conftest.py`**

```python
"""Shared pytest fixtures for launcher unit tests.

Injects the launcher scripts directory into sys.path so tests can
`import _launcher_common` directly without packaging the scripts.
"""

import json
import os
import sys
from pathlib import Path
from typing import Iterator

import pytest

# Add scripts dir to sys.path so `_launcher_common` is importable.
_SCRIPTS_DIR = (
    Path(__file__).resolve().parent.parent.parent
    / "skills"
    / "install-launchers"
    / "scripts"
)
sys.path.insert(0, str(_SCRIPTS_DIR))


@pytest.fixture
def project_dir(tmp_path: Path) -> Path:
    """A clean tmp directory standing in for a project root."""
    return tmp_path


@pytest.fixture
def sessions_file(project_dir: Path) -> Path:
    """Empty sessions.json under the agent-channel state dir."""
    state_dir = project_dir / ".orchestrator-state" / "agent-channel"
    state_dir.mkdir(parents=True, exist_ok=True)
    f = state_dir / "sessions.json"
    f.write_text(json.dumps({"sessions": []}))
    return f


@pytest.fixture
def env_snapshot() -> Iterator[None]:
    """Snapshot os.environ before the test, restore after.

    Required because setup_env() mutates os.environ in place.
    """
    saved = dict(os.environ)
    try:
        yield
    finally:
        os.environ.clear()
        os.environ.update(saved)


@pytest.fixture
def fake_projects_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """Fake ~/.claude/projects/<hash>/ directory for resume-name resolution.

    Tests populate this with .jsonl files containing 'Session renamed to: X'.
    """
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setenv("USERPROFILE", str(home))  # Windows
    projects = home / ".claude" / "projects"
    projects.mkdir(parents=True)
    return projects
```

- [ ] **Step 4: Modify `plugins/orchestrator/package.json` — add `test:py` script**

Find the `"scripts"` block (currently contains `"build"`, `"dev"`, `"test"`, `"typecheck"`). Add the new entry:

```json
{
  "scripts": {
    "build": "bun build mcp/server.ts --outdir dist --target bun",
    "dev": "bun run mcp/server.ts",
    "test": "bun test",
    "test:py": "uvx --from pytest pytest tests/launchers/",
    "typecheck": "tsc --noEmit"
  }
}
```

(The other fields in `package.json` are unchanged. Only the `scripts` block gains the `"test:py"` line.)

- [ ] **Step 5: Run pytest to confirm the harness works (expected: zero tests collected, exit 5)**

```
cd plugins/orchestrator
uvx --from pytest pytest tests/launchers/ -v
```

Expected: `no tests ran in 0.XXs` and exit code 5 (pytest's "no tests collected"). This is the green-baseline.

- [ ] **Step 6: Commit**

```bash
git add plugins/orchestrator/pyproject.toml \
        plugins/orchestrator/tests/launchers/__init__.py \
        plugins/orchestrator/tests/launchers/conftest.py \
        plugins/orchestrator/package.json
git commit -m "test(orchestrator): scaffold pytest harness for launcher unit tests

Adds pyproject.toml (Python 3.10+ floor, pytest dev-only), a minimal
conftest.py with project-dir / sessions-file / env-snapshot / fake-
projects-dir fixtures, and a 'test:py' package.json script that runs
pytest via uvx (matching the sidecar's existing uvx fallback pattern,
so contributors don't need a separate pip install).

No production code yet — empty harness baseline for the launcher
rewrite (see docs/plans/2026-05-13-launcher-python-canonical-design.md)."
```

---

## Task 2: `_launcher_common.py` — Python version guard + marketplace placeholder

**Files:**
- Create: `plugins/orchestrator/skills/install-launchers/scripts/_launcher_common.py`
- Test: `plugins/orchestrator/tests/launchers/test_marketplace_guard.py` (new this task)

- [ ] **Step 1: Write the failing test**

Create `plugins/orchestrator/tests/launchers/test_marketplace_guard.py`:

```python
"""Tests for the marketplace-placeholder guard in _launcher_common."""

import importlib
import sys

import pytest


def test_marketplace_placeholder_constant_exists():
    """_launcher_common exposes the MARKETPLACE_PLACEHOLDER constant."""
    if "_launcher_common" in sys.modules:
        del sys.modules["_launcher_common"]
    mod = importlib.import_module("_launcher_common")
    assert hasattr(mod, "MARKETPLACE_PLACEHOLDER")
    # The placeholder is the literal substitution target. Verify shape.
    assert mod.MARKETPLACE_PLACEHOLDER.startswith("__ORCH_")
    assert mod.MARKETPLACE_PLACEHOLDER.endswith("__")


def test_check_marketplace_substituted_raises_when_unsubstituted():
    """When the placeholder is still literal, the guard raises with a
    pointer to /orchestrator:install-launchers."""
    if "_launcher_common" in sys.modules:
        del sys.modules["_launcher_common"]
    mod = importlib.import_module("_launcher_common")
    with pytest.raises(SystemExit) as exc_info:
        mod.check_marketplace_substituted()
    # SystemExit with non-zero exit code.
    assert exc_info.value.code != 0


def test_check_marketplace_substituted_no_op_when_substituted(monkeypatch):
    """When the placeholder has been substituted with a real slug, the
    guard returns normally."""
    if "_launcher_common" in sys.modules:
        del sys.modules["_launcher_common"]
    mod = importlib.import_module("_launcher_common")
    monkeypatch.setattr(mod, "MARKETPLACE_PLACEHOLDER", "spawnbox-dev-claude-plugins")
    # Should not raise.
    mod.check_marketplace_substituted()
```

- [ ] **Step 2: Run the test (expected: fail with ModuleNotFoundError)**

```
cd plugins/orchestrator
uvx --from pytest pytest tests/launchers/test_marketplace_guard.py -v
```

Expected: `ModuleNotFoundError: No module named '_launcher_common'`. Exit 1.

- [ ] **Step 3: Create the minimal `_launcher_common.py`**

Create `plugins/orchestrator/skills/install-launchers/scripts/_launcher_common.py`:

```python
"""Shared logic for the orchestrator plugin's Python-canonical launchers.

Imported by sibling scripts in the same directory (`pa_start.py`,
`sa_start.py`, `discord_start.py`). Stdlib only — no third-party deps.

See docs/plans/2026-05-13-launcher-python-canonical-design.md for the
full design. This module's public interface is the names exported via
the `__all__` declaration at the bottom of the file.
"""

import sys

# Enforce the Python version floor at import time. Wrappers also catch
# missing-Python at the shell level, but this catches the case where the
# wrapper resolves an interpreter that's older than 3.10.
if sys.version_info < (3, 10):
    print(
        f"ERROR: orchestrator launchers require Python 3.10+; got "
        f"{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}.",
        file=sys.stderr,
    )
    print(
        "Install a newer Python (apt install python3.12, brew install python@3.12, "
        "winget install Python.Python.3.12, or python.org) and ensure the wrapper "
        "resolves it (or set $ORCH_PYTHON).",
        file=sys.stderr,
    )
    sys.exit(1)


# The marketplace-slug placeholder. The /orchestrator:install-launchers
# skill substitutes this constant with the actual marketplace slug
# (e.g. "spawnbox-dev-claude-plugins") at copy-into-project time.
#
# If this constant still holds the literal placeholder at runtime, the
# launcher's --dangerously-load-development-channels flag will be invalid
# and the spawned Claude Code session will fail to load the orchestrator
# plugin. The check_marketplace_substituted() guard below catches this.
MARKETPLACE_PLACEHOLDER: str = "__ORCH_MARKETPLACE__"


def check_marketplace_substituted() -> None:
    """Verify the marketplace slug has been substituted by install-launchers.

    Exits with code 1 if the placeholder is still literal. Uses a split-
    string comparison to avoid self-matching by the substitution tool.
    """
    literal_placeholder = "__ORCH_" + "MARKETPLACE__"
    if MARKETPLACE_PLACEHOLDER == literal_placeholder:
        print(
            "ERROR: marketplace slug not substituted in _launcher_common.py. "
            "Re-run /orchestrator:install-launchers from inside a Claude "
            "session to install the launchers with the slug filled in.",
            file=sys.stderr,
        )
        sys.exit(1)


__all__ = [
    "MARKETPLACE_PLACEHOLDER",
    "check_marketplace_substituted",
]
```

- [ ] **Step 4: Run the test (expected: pass)**

```
cd plugins/orchestrator
uvx --from pytest pytest tests/launchers/test_marketplace_guard.py -v
```

Expected: 3 passed.

- [ ] **Step 5: Commit**

```bash
git add plugins/orchestrator/skills/install-launchers/scripts/_launcher_common.py \
        plugins/orchestrator/tests/launchers/test_marketplace_guard.py
git commit -m "feat(orchestrator): _launcher_common.py — version guard + marketplace placeholder

Adds the shared launcher module skeleton with two foundational pieces:

1. sys.version_info check at import time. Floor is Python 3.10
   (justified by PEP 604 type-union syntax used elsewhere in the
   module and broad ecosystem availability). Wrappers also catch
   missing-Python at the shell level; this catches the case where
   the wrapper finds a too-old interpreter.

2. MARKETPLACE_PLACEHOLDER constant + check_marketplace_substituted()
   guard. The /orchestrator:install-launchers skill substitutes the
   placeholder at copy-into-project time. If the guard runs against
   an unsubstituted module, it exits with an actionable error
   pointing back at the install skill.

Split-string comparison in the guard avoids self-detection by the
substitution tool."
```

---

## Task 3: `_launcher_common.py` — project-hash transform

**Files:**
- Modify: `plugins/orchestrator/skills/install-launchers/scripts/_launcher_common.py` (add `project_hash_for`)
- Create: `plugins/orchestrator/tests/launchers/test_project_hash.py`

- [ ] **Step 1: Write the failing test**

Create `plugins/orchestrator/tests/launchers/test_project_hash.py`:

```python
"""Tests for project-hash transform (matches Claude Code's
project-dir → ~/.claude/projects/<hash>/ directory naming).
"""

import importlib
import sys
from pathlib import PurePosixPath, PureWindowsPath


def _reload():
    if "_launcher_common" in sys.modules:
        del sys.modules["_launcher_common"]
    return importlib.import_module("_launcher_common")


def test_project_hash_posix_simple():
    """POSIX path: '/a/b/c' → 'a-b-c' (slashes become dashes,
    leading dash stripped)."""
    mod = _reload()
    assert mod.project_hash_for(PurePosixPath("/a/b/c")) == "a-b-c"


def test_project_hash_posix_deep():
    """A realistic project path."""
    mod = _reload()
    result = mod.project_hash_for(PurePosixPath("/home/enadeau/workspaces/quayline"))
    assert result == "home-enadeau-workspaces-quayline"


def test_project_hash_windows_drive_letter():
    """Windows: 'C:\\Users\\evan\\repo' → 'C--Users-evan-repo'.
    Claude Code does NOT collapse consecutive dashes — the C:\\ prefix
    yields a literal C-- in the hash."""
    mod = _reload()
    result = mod.project_hash_for(PureWindowsPath("C:\\Users\\evan\\repo"))
    assert result == "C--Users-evan-repo"


def test_project_hash_strips_leading_dashes():
    """A POSIX absolute path starts with '/' which becomes a leading dash.
    The transform strips leading dashes only (not consecutive interior ones)."""
    mod = _reload()
    result = mod.project_hash_for(PurePosixPath("/x"))
    assert result == "x"


def test_project_hash_no_trailing_dashes():
    """Trailing dashes stripped if present (e.g. path that ends in /)."""
    mod = _reload()
    # Path normalization on Path objects strips trailing slashes, but
    # we test the raw transform on a string-y input.
    result = mod.project_hash_for(PurePosixPath("/a/b/"))
    assert not result.endswith("-")
```

- [ ] **Step 2: Run the test (expected: fail, `project_hash_for` not defined)**

```
cd plugins/orchestrator
uvx --from pytest pytest tests/launchers/test_project_hash.py -v
```

Expected: 5 errors, `AttributeError: module '_launcher_common' has no attribute 'project_hash_for'`.

- [ ] **Step 3: Implement `project_hash_for` in `_launcher_common.py`**

Append to the existing `_launcher_common.py` (before the `__all__` block):

```python
import re
from pathlib import PurePath


def project_hash_for(project_dir: PurePath) -> str:
    """Transform a project path to the Claude Code project-dir hash.

    Matches CC's literal character substitution: backslash, forward
    slash, and drive-colon all become single dashes. Consecutive dashes
    are NOT collapsed (so 'C:\\' yields 'C--'). Leading and trailing
    dashes are stripped.

    Args:
        project_dir: A pathlib path (PurePosixPath or PureWindowsPath).

    Returns:
        The hash string used as the directory name under
        ~/.claude/projects/.
    """
    raw = str(project_dir)
    substituted = re.sub(r"[\\/:]", "-", raw)
    stripped = re.sub(r"^-+|-+$", "", substituted)
    return stripped
```

Update the `__all__` block to include `"project_hash_for"`:

```python
__all__ = [
    "MARKETPLACE_PLACEHOLDER",
    "check_marketplace_substituted",
    "project_hash_for",
]
```

- [ ] **Step 4: Run the test (expected: pass)**

```
cd plugins/orchestrator
uvx --from pytest pytest tests/launchers/test_project_hash.py -v
```

Expected: 5 passed.

- [ ] **Step 5: Commit**

```bash
git add plugins/orchestrator/skills/install-launchers/scripts/_launcher_common.py \
        plugins/orchestrator/tests/launchers/test_project_hash.py
git commit -m "feat(orchestrator): _launcher_common — project-hash transform

Adds project_hash_for(project_dir: PurePath) -> str, mirroring the
literal character-substitution transform that Claude Code applies to
project paths when naming ~/.claude/projects/<hash>/ directories:

  - backslash, forward slash, colon → single dash
  - consecutive dashes NOT collapsed (C:\\ yields C--)
  - leading and trailing dashes stripped

Test coverage: POSIX simple + deep, Windows with drive letter
(verifies the C-- prefix is preserved), leading-dash strip, no
trailing dash. Five cases, all pass."
```

---

## Task 4: `_launcher_common.py` — `resolve_project_dir`

**Files:**
- Modify: `plugins/orchestrator/skills/install-launchers/scripts/_launcher_common.py` (add `resolve_project_dir`)
- Test: extend `test_project_hash.py` is wrong — make a new test file.
- Create: `plugins/orchestrator/tests/launchers/test_resolve_project_dir.py`

- [ ] **Step 1: Write the failing test**

Create `plugins/orchestrator/tests/launchers/test_resolve_project_dir.py`:

```python
"""Tests for resolve_project_dir: default-to-CWD, --project-dir override,
must-exist validation."""

import importlib
import os
import sys
from pathlib import Path

import pytest


def _reload():
    if "_launcher_common" in sys.modules:
        del sys.modules["_launcher_common"]
    return importlib.import_module("_launcher_common")


def test_default_resolves_to_cwd(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    """Calling with None / empty string returns the absolute CWD."""
    mod = _reload()
    monkeypatch.chdir(tmp_path)
    result = mod.resolve_project_dir(None)
    assert result == tmp_path.resolve()


def test_explicit_arg_resolved_to_absolute(tmp_path: Path):
    """Passing an explicit directory returns its absolute path."""
    mod = _reload()
    result = mod.resolve_project_dir(str(tmp_path))
    assert result == tmp_path.resolve()
    assert result.is_absolute()


def test_relative_arg_resolved_against_cwd(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    """A relative path is resolved against CWD."""
    mod = _reload()
    sub = tmp_path / "sub"
    sub.mkdir()
    monkeypatch.chdir(tmp_path)
    result = mod.resolve_project_dir("sub")
    assert result == sub.resolve()


def test_missing_dir_exits(tmp_path: Path):
    """A non-existent path exits with code 1 + stderr message."""
    mod = _reload()
    missing = tmp_path / "does-not-exist"
    with pytest.raises(SystemExit) as exc_info:
        mod.resolve_project_dir(str(missing))
    assert exc_info.value.code == 1
```

- [ ] **Step 2: Run the test (expected: fail with `AttributeError: ... resolve_project_dir`)**

```
cd plugins/orchestrator
uvx --from pytest pytest tests/launchers/test_resolve_project_dir.py -v
```

Expected: 4 errors.

- [ ] **Step 3: Implement `resolve_project_dir`**

Append to `_launcher_common.py` (after `project_hash_for`):

```python
from pathlib import Path


def resolve_project_dir(arg: str | None) -> Path:
    """Resolve the project-root path from a user-supplied CLI arg.

    None / empty → CWD. Relative paths are resolved against CWD.
    Absolute paths pass through. The result is always absolute. Exits
    with code 1 if the resolved path doesn't exist (matches the .ps1
    launchers' behavior).

    Args:
        arg: Value of --project-dir from argparse, or None when not given.

    Returns:
        The absolute Path to the project root.
    """
    if not arg:
        base = Path.cwd()
    else:
        base = Path(arg)
        if not base.is_absolute():
            base = Path.cwd() / base
    resolved = base.resolve()
    if not resolved.is_dir():
        print(f"ERROR: project-dir not found: {resolved}", file=sys.stderr)
        sys.exit(1)
    return resolved
```

Update `__all__` to add `"resolve_project_dir"`:

```python
__all__ = [
    "MARKETPLACE_PLACEHOLDER",
    "check_marketplace_substituted",
    "project_hash_for",
    "resolve_project_dir",
]
```

- [ ] **Step 4: Run the test (expected: pass)**

```
cd plugins/orchestrator
uvx --from pytest pytest tests/launchers/test_resolve_project_dir.py -v
```

Expected: 4 passed.

- [ ] **Step 5: Commit**

```bash
git add plugins/orchestrator/skills/install-launchers/scripts/_launcher_common.py \
        plugins/orchestrator/tests/launchers/test_resolve_project_dir.py
git commit -m "feat(orchestrator): _launcher_common — resolve_project_dir

Adds resolve_project_dir(arg: str | None) -> Path. Handles:
  - None / empty arg → CWD
  - Relative path → resolved against CWD
  - Absolute path → passes through
Always returns absolute. Exits 1 if the resolved path doesn't exist
(matches the .ps1 launchers' Resolve-Path + Test-Path behavior).

Test coverage: default-to-CWD, explicit absolute arg, relative arg
resolved against CWD, missing-dir exits 1."
```

---

## Task 5: `_launcher_common.py` — `resolve_resume_target`

**Files:**
- Modify: `plugins/orchestrator/skills/install-launchers/scripts/_launcher_common.py` (add `resolve_resume_target`)
- Create: `plugins/orchestrator/tests/launchers/test_resume_resolve.py`

- [ ] **Step 1: Write the failing test**

Create `plugins/orchestrator/tests/launchers/test_resume_resolve.py`:

```python
"""Tests for resolve_resume_target: UUID passthrough + display-name → UUID
resolution via JSONL grep."""

import importlib
import sys
import time
from pathlib import Path

import pytest


def _reload():
    if "_launcher_common" in sys.modules:
        del sys.modules["_launcher_common"]
    return importlib.import_module("_launcher_common")


def test_uuid_passes_through(fake_projects_dir: Path, project_dir: Path):
    """A canonical UUID is returned unchanged, no JSONL grep performed."""
    mod = _reload()
    uuid_str = "abcdef01-2345-6789-abcd-ef0123456789"
    result = mod.resolve_resume_target(uuid_str, project_dir)
    assert result == uuid_str


def test_display_name_resolved_to_uuid(fake_projects_dir: Path, project_dir: Path):
    """A display name is looked up across the project's JSONLs and resolved
    to the UUID of the JSONL whose content contains
    'Session renamed to: <name>'."""
    mod = _reload()
    project_hash = mod.project_hash_for(project_dir)
    jsonl_dir = fake_projects_dir / project_hash
    jsonl_dir.mkdir(parents=True)
    target_uuid = "deadbeef-1111-2222-3333-444455556666"
    (jsonl_dir / f"{target_uuid}.jsonl").write_text(
        '{"event": "Session renamed to: MyAgent"}\n'
    )
    # Decoy JSONL — no rename event.
    (jsonl_dir / "00000000-aaaa-bbbb-cccc-dddddddddddd.jsonl").write_text(
        '{"event": "unrelated"}\n'
    )
    result = mod.resolve_resume_target("MyAgent", project_dir)
    assert result == target_uuid


def test_display_name_picks_newest_when_multiple(
    fake_projects_dir: Path, project_dir: Path
):
    """If multiple JSONLs have been renamed to the same name, the newest
    by mtime wins."""
    mod = _reload()
    project_hash = mod.project_hash_for(project_dir)
    jsonl_dir = fake_projects_dir / project_hash
    jsonl_dir.mkdir(parents=True)

    older_uuid = "11111111-1111-1111-1111-111111111111"
    newer_uuid = "22222222-2222-2222-2222-222222222222"

    (jsonl_dir / f"{older_uuid}.jsonl").write_text(
        '{"event": "Session renamed to: Duplicate"}\n'
    )
    time.sleep(0.05)
    (jsonl_dir / f"{newer_uuid}.jsonl").write_text(
        '{"event": "Session renamed to: Duplicate"}\n'
    )

    result = mod.resolve_resume_target("Duplicate", project_dir)
    assert result == newer_uuid


def test_display_name_no_match_exits(fake_projects_dir: Path, project_dir: Path):
    """No matching JSONL → exit 1 with message naming the dir + name."""
    mod = _reload()
    project_hash = mod.project_hash_for(project_dir)
    jsonl_dir = fake_projects_dir / project_hash
    jsonl_dir.mkdir(parents=True)
    (jsonl_dir / "11111111-1111-1111-1111-111111111111.jsonl").write_text(
        '{"event": "Session renamed to: Other"}\n'
    )
    with pytest.raises(SystemExit) as exc_info:
        mod.resolve_resume_target("Missing", project_dir)
    assert exc_info.value.code == 1


def test_projects_dir_missing_exits(fake_projects_dir: Path, project_dir: Path):
    """No <hash> dir under ~/.claude/projects/ → exit 1."""
    mod = _reload()
    # Deliberately do NOT create the hash dir.
    with pytest.raises(SystemExit) as exc_info:
        mod.resolve_resume_target("MyAgent", project_dir)
    assert exc_info.value.code == 1
```

- [ ] **Step 2: Run the test (expected: fail with `AttributeError: ... resolve_resume_target`)**

```
cd plugins/orchestrator
uvx --from pytest pytest tests/launchers/test_resume_resolve.py -v
```

Expected: 5 errors.

- [ ] **Step 3: Implement `resolve_resume_target`**

Append to `_launcher_common.py` (after `resolve_project_dir`):

```python
import os


_UUID_RE = re.compile(
    r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-"
    r"[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
)


def _user_home() -> Path:
    """Return the user's home dir, preferring $HOME then $USERPROFILE."""
    home = os.environ.get("HOME") or os.environ.get("USERPROFILE")
    if not home:
        return Path.home()
    return Path(home)


def resolve_resume_target(resume: str, project_dir: Path) -> str:
    """Convert a --resume value to a session UUID.

    If `resume` already matches the canonical UUID shape, it's returned
    unchanged. Otherwise, search the project's JSONL directory
    (~/.claude/projects/<project-hash>/) for a file containing the
    literal text "Session renamed to: <resume>" and return that JSONL's
    basename (the session UUID).

    If the projects dir doesn't exist, or no matching JSONL is found,
    exit with code 1 and an actionable message.

    Args:
        resume: The --resume CLI value (UUID or display name).
        project_dir: The absolute project root (from resolve_project_dir).

    Returns:
        The session UUID string.
    """
    if _UUID_RE.match(resume):
        return resume

    project_hash = project_hash_for(project_dir)
    jsonl_dir = _user_home() / ".claude" / "projects" / project_hash

    if not jsonl_dir.is_dir():
        print(f"ERROR: Projects dir not found: {jsonl_dir}", file=sys.stderr)
        sys.exit(1)

    needle = f"Session renamed to: {resume}"
    matches: list[Path] = []
    for jsonl in jsonl_dir.glob("*.jsonl"):
        try:
            content = jsonl.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        if needle in content:
            matches.append(jsonl)

    if not matches:
        print(
            f"ERROR: No session in {jsonl_dir} has been renamed to: {resume}",
            file=sys.stderr,
        )
        sys.exit(1)

    newest = max(matches, key=lambda p: p.stat().st_mtime)
    print(f" Resolved display name to session: {newest.stem}", file=sys.stderr)
    return newest.stem
```

Update `__all__`:

```python
__all__ = [
    "MARKETPLACE_PLACEHOLDER",
    "check_marketplace_substituted",
    "project_hash_for",
    "resolve_project_dir",
    "resolve_resume_target",
]
```

- [ ] **Step 4: Run the test (expected: pass)**

```
cd plugins/orchestrator
uvx --from pytest pytest tests/launchers/test_resume_resolve.py -v
```

Expected: 5 passed.

- [ ] **Step 5: Commit**

```bash
git add plugins/orchestrator/skills/install-launchers/scripts/_launcher_common.py \
        plugins/orchestrator/tests/launchers/test_resume_resolve.py
git commit -m "feat(orchestrator): _launcher_common — resolve_resume_target

Adds resolve_resume_target(resume: str, project_dir: Path) -> str.
Mirrors the .ps1 launchers' display-name → UUID lookup:

  - canonical UUID shape passes through unchanged
  - otherwise, grep ~/.claude/projects/<hash>/*.jsonl for the literal
    'Session renamed to: <name>' marker
  - newest match wins (by mtime)
  - missing projects-dir or no-match exits 1

Tests cover: UUID passthrough, single match, newest-wins on duplicates,
no-match exit, missing-projects-dir exit. Five cases."
```

---

## Task 6: `_launcher_common.py` — `supersede_existing_pa`

**Files:**
- Modify: `plugins/orchestrator/skills/install-launchers/scripts/_launcher_common.py` (add `supersede_existing_pa`)
- Create: `plugins/orchestrator/tests/launchers/test_supersede.py`

- [ ] **Step 1: Write the failing test**

Create `plugins/orchestrator/tests/launchers/test_supersede.py`:

```python
"""Tests for supersede_existing_pa: pre-emptively demote any role=prime
entries with fresh heartbeats."""

import importlib
import json
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest


def _reload():
    if "_launcher_common" in sys.modules:
        del sys.modules["_launcher_common"]
    return importlib.import_module("_launcher_common")


def _iso(dt: datetime) -> str:
    return dt.isoformat()


def test_no_state_file_is_noop(project_dir: Path):
    """When sessions.json doesn't exist, supersede is a no-op (returns None,
    doesn't raise)."""
    mod = _reload()
    # Deliberately do not create sessions.json.
    mod.supersede_existing_pa(project_dir)
    # No assertion needed — just check it doesn't raise.


def test_no_prime_sessions_no_changes(project_dir: Path, sessions_file: Path):
    """A sessions.json with only subordinates is left unchanged."""
    mod = _reload()
    state = {
        "sessions": [
            {"role": "subordinate", "session_id": "abc", "last_heartbeat_at": _iso(datetime.now(timezone.utc))},
        ]
    }
    sessions_file.write_text(json.dumps(state))
    mod.supersede_existing_pa(project_dir)
    after = json.loads(sessions_file.read_text())
    assert after == state


def test_stale_prime_not_demoted(project_dir: Path, sessions_file: Path):
    """A role=prime entry with last_heartbeat older than 90 seconds is left
    alone (already dead, no need to demote)."""
    mod = _reload()
    stale_heartbeat = datetime.now(timezone.utc) - timedelta(seconds=120)
    state = {
        "sessions": [
            {"role": "prime", "session_id": "stale", "last_heartbeat_at": _iso(stale_heartbeat)},
        ]
    }
    sessions_file.write_text(json.dumps(state))
    mod.supersede_existing_pa(project_dir)
    after = json.loads(sessions_file.read_text())
    assert after["sessions"][0]["role"] == "prime"  # unchanged


def test_fresh_prime_demoted_to_subordinate(project_dir: Path, sessions_file: Path):
    """A role=prime entry with a fresh heartbeat (<90s) is demoted."""
    mod = _reload()
    fresh_heartbeat = datetime.now(timezone.utc) - timedelta(seconds=10)
    state = {
        "sessions": [
            {"role": "prime", "session_id": "fresh", "name": "PA-old",
             "last_heartbeat_at": _iso(fresh_heartbeat)},
        ]
    }
    sessions_file.write_text(json.dumps(state))
    mod.supersede_existing_pa(project_dir)
    after = json.loads(sessions_file.read_text())
    assert after["sessions"][0]["role"] == "subordinate"


def test_parse_failure_is_warning_not_fatal(project_dir: Path, sessions_file: Path, capsys):
    """Corrupt JSON → warning to stderr, function returns normally
    (treated as no-PA)."""
    mod = _reload()
    sessions_file.write_text("not valid json {{{")
    mod.supersede_existing_pa(project_dir)  # should not raise
    captured = capsys.readouterr()
    assert "WARNING" in captured.err
    assert str(sessions_file) in captured.err


def test_write_failure_is_fatal(project_dir: Path, sessions_file: Path, monkeypatch):
    """If the sessions.json write fails after a demotion was decided,
    the function exits 1 — silent write failure leaves two primes."""
    mod = _reload()
    fresh_heartbeat = datetime.now(timezone.utc) - timedelta(seconds=10)
    state = {
        "sessions": [
            {"role": "prime", "session_id": "fresh",
             "last_heartbeat_at": _iso(fresh_heartbeat)},
        ]
    }
    sessions_file.write_text(json.dumps(state))

    real_write_text = Path.write_text

    def fake_write_text(self: Path, *args, **kwargs):
        if self == sessions_file:
            raise PermissionError("simulated write failure")
        return real_write_text(self, *args, **kwargs)

    monkeypatch.setattr(Path, "write_text", fake_write_text)

    with pytest.raises(SystemExit) as exc_info:
        mod.supersede_existing_pa(project_dir)
    assert exc_info.value.code == 1
```

- [ ] **Step 2: Run the test (expected: fail)**

```
cd plugins/orchestrator
uvx --from pytest pytest tests/launchers/test_supersede.py -v
```

Expected: 6 errors, `AttributeError: ... supersede_existing_pa`.

- [ ] **Step 3: Implement `supersede_existing_pa`**

Append to `_launcher_common.py` (after `resolve_resume_target`):

```python
import json
from datetime import datetime, timedelta, timezone


def _sessions_file_for(project_dir: Path) -> Path:
    """Path to the agent-channel sessions.json under the project."""
    return project_dir / ".orchestrator-state" / "agent-channel" / "sessions.json"


def supersede_existing_pa(project_dir: Path) -> None:
    """Demote any role=prime entries with fresh heartbeats.

    Pre-emptively transitions existing role=prime sessions to role=
    subordinate so the about-to-launch PA registers cleanly. Stale
    primes (heartbeat older than 90 seconds) are presumed dead and left
    alone — their record self-cleans on next aging pass.

    Mirrors the .ps1 launchers' pre-launch supersede block. Differs in
    one place: write errors are FATAL here (vs warn-only in .ps1).
    Silent write failure leaves two role=prime entries, breaking the
    singleton invariant.

    Args:
        project_dir: Absolute project root.

    Returns:
        None. Exits 1 only on write failure during demotion.
    """
    state_file = _sessions_file_for(project_dir)
    if not state_file.is_file():
        return

    try:
        state = json.loads(state_file.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError) as err:
        # Parse error: treat as no-PA. Self-heals on next session register.
        print(
            f"WARNING: Could not parse {state_file} (treating as no-PA): {err}",
            file=sys.stderr,
        )
        return

    now = datetime.now(timezone.utc)
    fresh_threshold = now - timedelta(seconds=90)
    sessions = state.get("sessions", [])

    fresh_primes = []
    for s in sessions:
        if s.get("role") != "prime":
            continue
        heartbeat_str = s.get("last_heartbeat_at")
        if not heartbeat_str:
            continue
        try:
            heartbeat = datetime.fromisoformat(heartbeat_str)
        except (ValueError, TypeError):
            continue
        # Ensure timezone-aware comparison.
        if heartbeat.tzinfo is None:
            heartbeat = heartbeat.replace(tzinfo=timezone.utc)
        if heartbeat > fresh_threshold:
            fresh_primes.append(s)

    if not fresh_primes:
        return

    print("", file=sys.stderr)
    print(" Existing PrimeAgent detected - auto-superseding:", file=sys.stderr)
    for pa in fresh_primes:
        print(f"   * {pa.get('session_id', '?')} ({pa.get('name', '?')})", file=sys.stderr)

    for s in sessions:
        if s.get("role") == "prime":
            s["role"] = "subordinate"

    try:
        state_file.write_text(
            json.dumps(state, indent=2),
            encoding="utf-8",
        )
    except OSError as err:
        print(
            f"ERROR: Could not write {state_file}: {err}",
            file=sys.stderr,
        )
        sys.exit(1)

    print(" (Existing PA(s) demoted. New PA will register as prime.)", file=sys.stderr)
    print(" (Press Ctrl+C in the next ~2s to cancel.)", file=sys.stderr)
    print("", file=sys.stderr)
    import time
    time.sleep(2)
```

Update `__all__`:

```python
__all__ = [
    "MARKETPLACE_PLACEHOLDER",
    "check_marketplace_substituted",
    "project_hash_for",
    "resolve_project_dir",
    "resolve_resume_target",
    "supersede_existing_pa",
]
```

- [ ] **Step 4: Run the test (expected: pass)**

```
cd plugins/orchestrator
uvx --from pytest pytest tests/launchers/test_supersede.py -v
```

Expected: 6 passed.

- [ ] **Step 5: Commit**

```bash
git add plugins/orchestrator/skills/install-launchers/scripts/_launcher_common.py \
        plugins/orchestrator/tests/launchers/test_supersede.py
git commit -m "feat(orchestrator): _launcher_common — supersede_existing_pa

Adds the PA singleton-supersede helper. Mirrors the .ps1 launchers'
pre-launch demote block:

  - no sessions.json → no-op
  - corrupt JSON → WARNING (treated as no-PA, self-heals)
  - any role=prime entries with last_heartbeat_at > now-90s → demoted
    to role=subordinate, file rewritten
  - stale primes (heartbeat older than 90s) left alone
  - 2-second pause after demote (matches .ps1 'press Ctrl+C to cancel')

Tightens one .ps1 behavior: write errors are FATAL (exit 1) instead
of warn-only. Silent write failure would leave two role=prime entries,
breaking the singleton invariant.

Tests cover all 6 paths: no-state-file, no-primes, stale-prime,
fresh-prime, parse-failure (warning), write-failure (fatal)."
```

---

## Task 7: `_launcher_common.py` — `make_session_name`

**Files:**
- Modify: `plugins/orchestrator/skills/install-launchers/scripts/_launcher_common.py` (add `make_session_name`)
- Create: `plugins/orchestrator/tests/launchers/test_session_name.py`

- [ ] **Step 1: Write the failing test**

Create `plugins/orchestrator/tests/launchers/test_session_name.py`:

```python
"""Tests for make_session_name: prefix + 'YYYY-MM-DD-HH-MM-SS' timestamp."""

import importlib
import re
import sys


def _reload():
    if "_launcher_common" in sys.modules:
        del sys.modules["_launcher_common"]
    return importlib.import_module("_launcher_common")


def test_pa_prefix_shape():
    """PA- prefix + valid timestamp."""
    mod = _reload()
    name = mod.make_session_name("PA")
    assert re.fullmatch(r"PA-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}", name)


def test_sa_prefix_shape():
    """SA- prefix + valid timestamp."""
    mod = _reload()
    name = mod.make_session_name("SA")
    assert re.fullmatch(r"SA-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}", name)


def test_discord_live_prefix_shape():
    """DISCORD-LIVE prefix + valid timestamp."""
    mod = _reload()
    name = mod.make_session_name("DISCORD-LIVE")
    assert re.fullmatch(r"DISCORD-LIVE-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}", name)
```

- [ ] **Step 2: Run the test (expected: fail)**

```
cd plugins/orchestrator
uvx --from pytest pytest tests/launchers/test_session_name.py -v
```

Expected: 3 errors.

- [ ] **Step 3: Implement `make_session_name`**

Append to `_launcher_common.py` (after `supersede_existing_pa`):

```python
def make_session_name(prefix: str) -> str:
    """Build a timestamped session name: '<PREFIX>-YYYY-MM-DD-HH-MM-SS'.

    Uses local time (matches the .ps1 launchers' `Get-Date -Format`).

    Args:
        prefix: 'PA' / 'SA' / 'DISCORD-LIVE'.

    Returns:
        The composed name string.
    """
    stamp = datetime.now().strftime("%Y-%m-%d-%H-%M-%S")
    return f"{prefix}-{stamp}"
```

Update `__all__`:

```python
__all__ = [
    "MARKETPLACE_PLACEHOLDER",
    "check_marketplace_substituted",
    "project_hash_for",
    "resolve_project_dir",
    "resolve_resume_target",
    "supersede_existing_pa",
    "make_session_name",
]
```

- [ ] **Step 4: Run the test (expected: pass)**

```
cd plugins/orchestrator
uvx --from pytest pytest tests/launchers/test_session_name.py -v
```

Expected: 3 passed.

- [ ] **Step 5: Commit**

```bash
git add plugins/orchestrator/skills/install-launchers/scripts/_launcher_common.py \
        plugins/orchestrator/tests/launchers/test_session_name.py
git commit -m "feat(orchestrator): _launcher_common — make_session_name

Adds make_session_name(prefix: str) -> str. Returns
'<PREFIX>-YYYY-MM-DD-HH-MM-SS' using local time (matches the .ps1
launchers' Get-Date format).

Tests verify regex shape for PA, SA, and DISCORD-LIVE prefixes."
```

---

## Task 8: `_launcher_common.py` — `setup_env`

**Files:**
- Modify: `plugins/orchestrator/skills/install-launchers/scripts/_launcher_common.py` (add `setup_env`)
- Create: `plugins/orchestrator/tests/launchers/test_setup_env.py`

- [ ] **Step 1: Write the failing test**

Create `plugins/orchestrator/tests/launchers/test_setup_env.py`:

```python
"""Tests for setup_env: env-var assembly with role/kind/name + SPAWNBOX_
aliases + relay flag."""

import importlib
import os
import sys
from pathlib import Path

import pytest


def _reload():
    if "_launcher_common" in sys.modules:
        del sys.modules["_launcher_common"]
    return importlib.import_module("_launcher_common")


def test_pa_role_env(env_snapshot, project_dir: Path):
    """role=prime + kind=prime + session name + relay flag set."""
    mod = _reload()
    mod.setup_env(
        role="prime",
        session_kind="prime",
        project_dir=project_dir,
        session_name="PA-2026-05-13-12-00-00",
    )
    assert os.environ["MCP_TIMEOUT"] == "30000"
    assert os.environ["ORCHESTRATOR_PROJECT_ROOT"] == str(project_dir)
    assert os.environ["ORCHESTRATOR_AGENT_ROLE"] == "prime"
    assert os.environ["SPAWNBOX_AGENT_ROLE"] == "prime"
    assert os.environ["ORCHESTRATOR_SESSION_KIND"] == "prime"
    assert os.environ["SPAWNBOX_SESSION_KIND"] == "prime"
    assert os.environ["ORCHESTRATOR_AGENT_NAME"] == "PA-2026-05-13-12-00-00"
    assert os.environ["SPAWNBOX_AGENT_NAME"] == "PA-2026-05-13-12-00-00"
    assert os.environ["ORCHESTRATOR_PA_PERMISSION_RELAY"] == "1"


def test_sa_subordinate_env(env_snapshot, project_dir: Path):
    """role=subordinate + kind=subordinate."""
    mod = _reload()
    mod.setup_env(
        role="subordinate",
        session_kind="subordinate",
        project_dir=project_dir,
        session_name="SA-2026-05-13-12-00-00",
    )
    assert os.environ["ORCHESTRATOR_AGENT_ROLE"] == "subordinate"
    assert os.environ["ORCHESTRATOR_SESSION_KIND"] == "subordinate"


def test_discord_kind_env(env_snapshot, project_dir: Path):
    """role=subordinate + kind=discord-bot (the only place these diverge)."""
    mod = _reload()
    mod.setup_env(
        role="subordinate",
        session_kind="discord-bot",
        project_dir=project_dir,
        session_name="DISCORD-LIVE-2026-05-13-12-00-00",
    )
    assert os.environ["ORCHESTRATOR_AGENT_ROLE"] == "subordinate"
    assert os.environ["ORCHESTRATOR_SESSION_KIND"] == "discord-bot"


def test_no_session_name_skips_name_env(env_snapshot, project_dir: Path):
    """On --resume without an explicit name, session_name=None and the
    NAME envs are NOT set (preserves the resumed session's existing name)."""
    mod = _reload()
    mod.setup_env(
        role="prime",
        session_kind="prime",
        project_dir=project_dir,
        session_name=None,
    )
    assert "ORCHESTRATOR_AGENT_NAME" not in os.environ
    assert "SPAWNBOX_AGENT_NAME" not in os.environ
    # Other envs still set.
    assert os.environ["ORCHESTRATOR_AGENT_ROLE"] == "prime"
```

- [ ] **Step 2: Run the test (expected: fail)**

```
cd plugins/orchestrator
uvx --from pytest pytest tests/launchers/test_setup_env.py -v
```

Expected: 4 errors.

- [ ] **Step 3: Implement `setup_env`**

Append to `_launcher_common.py` (after `make_session_name`):

```python
def setup_env(
    *,
    role: str,
    session_kind: str,
    project_dir: Path,
    session_name: str | None,
) -> None:
    """Set the launcher env vars on os.environ.

    Inherited by the spawned claude.exe → orchestrator MCP. Matches the
    .ps1 launchers' env-block exactly:

      - MCP_TIMEOUT = '30000' (bump from CC's 5s default; bun cold-start)
      - ORCHESTRATOR_PROJECT_ROOT (project root; for MCP when
        CLAUDE_PROJECT_DIR isn't reliably set)
      - ORCHESTRATOR_AGENT_ROLE + SPAWNBOX_AGENT_ROLE alias
      - ORCHESTRATOR_SESSION_KIND + SPAWNBOX_SESSION_KIND alias
      - ORCHESTRATOR_AGENT_NAME + SPAWNBOX_AGENT_NAME alias
        (ONLY if session_name is provided — leaving unset preserves a
        resumed session's existing /rename name)
      - ORCHESTRATOR_PA_PERMISSION_RELAY = '1' (opt into PA-gated
        permission relay)

    Args:
        role: 'prime' or 'subordinate'.
        session_kind: 'prime' / 'subordinate' / 'discord-bot'.
        project_dir: Absolute project root.
        session_name: New session name, or None on --resume-without-name.
    """
    os.environ["MCP_TIMEOUT"] = "30000"
    os.environ["ORCHESTRATOR_PROJECT_ROOT"] = str(project_dir)

    os.environ["ORCHESTRATOR_AGENT_ROLE"] = role
    os.environ["SPAWNBOX_AGENT_ROLE"] = role

    os.environ["ORCHESTRATOR_SESSION_KIND"] = session_kind
    os.environ["SPAWNBOX_SESSION_KIND"] = session_kind

    os.environ["ORCHESTRATOR_PA_PERMISSION_RELAY"] = "1"

    if session_name:
        os.environ["ORCHESTRATOR_AGENT_NAME"] = session_name
        os.environ["SPAWNBOX_AGENT_NAME"] = session_name
```

Update `__all__`:

```python
__all__ = [
    "MARKETPLACE_PLACEHOLDER",
    "check_marketplace_substituted",
    "project_hash_for",
    "resolve_project_dir",
    "resolve_resume_target",
    "supersede_existing_pa",
    "make_session_name",
    "setup_env",
]
```

- [ ] **Step 4: Run the test (expected: pass)**

```
cd plugins/orchestrator
uvx --from pytest pytest tests/launchers/test_setup_env.py -v
```

Expected: 4 passed.

- [ ] **Step 5: Commit**

```bash
git add plugins/orchestrator/skills/install-launchers/scripts/_launcher_common.py \
        plugins/orchestrator/tests/launchers/test_setup_env.py
git commit -m "feat(orchestrator): _launcher_common — setup_env

Adds setup_env(*, role, session_kind, project_dir, session_name). Sets
the same env vars the .ps1 launchers set on the spawned claude.exe:
MCP_TIMEOUT, ORCHESTRATOR_PROJECT_ROOT, role + kind + name (each with
the SPAWNBOX_ alias for back-compat), and the PA permission-relay flag.

When session_name is None (--resume without --name), the NAME envs are
left unset so the resumed session's existing /rename name is preserved.

Tests cover PA, SA, Discord-bot, and no-session-name paths."
```

---

## Task 9: `_launcher_common.py` — `build_claude_args`

**Files:**
- Modify: `plugins/orchestrator/skills/install-launchers/scripts/_launcher_common.py` (add `build_claude_args`)
- Create: `plugins/orchestrator/tests/launchers/test_build_args.py`

- [ ] **Step 1: Write the failing test**

Create `plugins/orchestrator/tests/launchers/test_build_args.py`:

```python
"""Tests for build_claude_args: claude argv assembly per launcher kind."""

import importlib
import sys


def _reload():
    if "_launcher_common" in sys.modules:
        del sys.modules["_launcher_common"]
    return importlib.import_module("_launcher_common")


def test_pa_minimal():
    """PA: dev-channels flag + plugin spec + --effort max + --name."""
    mod = _reload()
    argv = mod.build_claude_args(
        marketplace="spawnbox-dev-claude-plugins",
        session_name="PA-2026-05-13-12-00-00",
        resume=None,
        effort="max",
        extra_channels=None,
    )
    assert "--dangerously-load-development-channels" in argv
    assert "plugin:orchestrator@spawnbox-dev-claude-plugins" in argv
    assert argv[argv.index("--effort") + 1] == "max"
    assert argv[argv.index("--name") + 1] == "PA-2026-05-13-12-00-00"
    assert "--resume" not in argv


def test_sa_with_resume():
    """SA with --resume and no --effort or --name (resumed sessions
    preserve their existing name and effort)."""
    mod = _reload()
    argv = mod.build_claude_args(
        marketplace="spawnbox-dev-claude-plugins",
        session_name=None,
        resume="abcdef01-2345-6789-abcd-ef0123456789",
        effort=None,
        extra_channels=None,
    )
    assert "--resume" in argv
    assert argv[argv.index("--resume") + 1] == "abcdef01-2345-6789-abcd-ef0123456789"
    assert "--effort" not in argv
    assert "--name" not in argv


def test_discord_extra_channels():
    """Discord: both --channels (allowlisted) and
    --dangerously-load-development-channels (orchestrator) present, in that order."""
    mod = _reload()
    argv = mod.build_claude_args(
        marketplace="spawnbox-dev-claude-plugins",
        session_name="DISCORD-LIVE-2026-05-13-12-00-00",
        resume=None,
        effort=None,
        extra_channels=["plugin:discord@claude-plugins-official"],
    )
    assert "--channels" in argv
    assert argv[argv.index("--channels") + 1] == "plugin:discord@claude-plugins-official"
    assert "--dangerously-load-development-channels" in argv
    assert "plugin:orchestrator@spawnbox-dev-claude-plugins" in argv


def test_marketplace_slug_appears_verbatim():
    """The marketplace slug is interpolated into the plugin spec literal."""
    mod = _reload()
    argv = mod.build_claude_args(
        marketplace="custom-marketplace-slug",
        session_name="X",
        resume=None,
        effort=None,
        extra_channels=None,
    )
    assert "plugin:orchestrator@custom-marketplace-slug" in argv
```

- [ ] **Step 2: Run the test (expected: fail)**

```
cd plugins/orchestrator
uvx --from pytest pytest tests/launchers/test_build_args.py -v
```

Expected: 4 errors.

- [ ] **Step 3: Implement `build_claude_args`**

Append to `_launcher_common.py` (after `setup_env`):

```python
def build_claude_args(
    *,
    marketplace: str,
    session_name: str | None,
    resume: str | None,
    effort: str | None,
    extra_channels: list[str] | None = None,
) -> list[str]:
    """Assemble the argv passed to `claude` (after the program name).

    Layout:
        [--channels <slug>] *   # extra_channels (Discord uses this)
        --dangerously-load-development-channels plugin:orchestrator@<mkt>
        [--effort <level>]      # if set
        [--name <session_name>] # if set
        [--resume <uuid>]       # if set

    Args:
        marketplace: Resolved marketplace slug (e.g. spawnbox-dev-claude-plugins).
        session_name: Session name from make_session_name(), or None.
        resume: Session UUID, or None.
        effort: 'low'|'medium'|'high'|'xhigh'|'max', or None.
        extra_channels: List of '--channels <slug>' values (Discord:
            ['plugin:discord@claude-plugins-official']).

    Returns:
        The argv list, suitable for passing to subprocess or execvp.
    """
    argv: list[str] = []
    for channel in extra_channels or []:
        argv.extend(["--channels", channel])
    argv.append("--dangerously-load-development-channels")
    argv.append(f"plugin:orchestrator@{marketplace}")
    if effort:
        argv.extend(["--effort", effort])
    if session_name:
        argv.extend(["--name", session_name])
    if resume:
        argv.extend(["--resume", resume])
    return argv
```

Update `__all__`:

```python
__all__ = [
    "MARKETPLACE_PLACEHOLDER",
    "check_marketplace_substituted",
    "project_hash_for",
    "resolve_project_dir",
    "resolve_resume_target",
    "supersede_existing_pa",
    "make_session_name",
    "setup_env",
    "build_claude_args",
]
```

- [ ] **Step 4: Run the test (expected: pass)**

```
cd plugins/orchestrator
uvx --from pytest pytest tests/launchers/test_build_args.py -v
```

Expected: 4 passed.

- [ ] **Step 5: Commit**

```bash
git add plugins/orchestrator/skills/install-launchers/scripts/_launcher_common.py \
        plugins/orchestrator/tests/launchers/test_build_args.py
git commit -m "feat(orchestrator): _launcher_common — build_claude_args

Adds build_claude_args(*, marketplace, session_name, resume, effort,
extra_channels) -> list[str]. Constructs the argv passed to the spawned
'claude' process. Mirrors the .ps1 launchers' \$claudeArgs assembly:

  - extra_channels prepended (Discord-only)
  - --dangerously-load-development-channels plugin:orchestrator@<mkt>
  - --effort <level> if set (PA: hardcoded 'max'; SA: optional CLI;
    Discord: never)
  - --name <session_name> if set (omitted on --resume without --name)
  - --resume <uuid> if set

Tests cover: PA minimal shape, SA --resume, Discord with both channel
flags in correct order, marketplace-slug verbatim interpolation."
```

---

## Task 10: `_launcher_common.py` — `launch` (terminal-spawn abstraction)

**Files:**
- Modify: `plugins/orchestrator/skills/install-launchers/scripts/_launcher_common.py` (add `launch`)
- Create: `plugins/orchestrator/tests/launchers/test_launch.py`

- [ ] **Step 1: Write the failing test**

Create `plugins/orchestrator/tests/launchers/test_launch.py`:

```python
"""Tests for launch(): terminal-spawn abstraction.

We don't actually exec claude or wt.exe — we monkeypatch the spawn
functions and assert on their call arguments.
"""

import importlib
import shutil
import sys
from pathlib import Path

import pytest


def _reload():
    if "_launcher_common" in sys.modules:
        del sys.modules["_launcher_common"]
    return importlib.import_module("_launcher_common")


def test_launch_missing_claude_exits(project_dir: Path, monkeypatch):
    """When `claude` isn't on PATH, exit 127 with actionable message."""
    mod = _reload()
    monkeypatch.setattr(shutil, "which", lambda name: None)
    with pytest.raises(SystemExit) as exc_info:
        mod.launch(
            ["--name", "X"],
            project_dir=project_dir,
            tab_color=None,
            no_wt=False,
        )
    assert exc_info.value.code == 127


def test_launch_posix_execvp(project_dir: Path, monkeypatch):
    """On POSIX (or when no_wt=True), launch calls os.execvp('claude', ...)."""
    mod = _reload()
    monkeypatch.setattr(shutil, "which", lambda name: "/usr/bin/claude" if name == "claude" else None)
    captured = {}

    def fake_execvp(file, args):
        captured["file"] = file
        captured["args"] = args
        raise SystemExit(0)  # simulate exec succeeding (process replaced)

    monkeypatch.setattr("os.execvp", fake_execvp)
    monkeypatch.setattr("platform.system", lambda: "Linux")

    with pytest.raises(SystemExit) as exc_info:
        mod.launch(
            ["--name", "X"],
            project_dir=project_dir,
            tab_color="#F59E0B",
            no_wt=False,
        )
    assert exc_info.value.code == 0
    assert captured["file"] == "claude"
    assert captured["args"] == ["claude", "--name", "X"]


def test_launch_windows_with_wt(project_dir: Path, monkeypatch):
    """On Windows with wt.exe present, launch invokes
    `wt.exe -w new new-tab [--tabColor X] -d <dir> claude <argv>`."""
    mod = _reload()

    def which_stub(name):
        if name == "claude":
            return "C:/Program Files/claude.exe"
        if name == "wt.exe":
            return "C:/Users/x/AppData/Local/Microsoft/WindowsApps/wt.exe"
        return None

    monkeypatch.setattr(shutil, "which", which_stub)
    monkeypatch.setattr("platform.system", lambda: "Windows")

    captured = {}

    def fake_run(cmd, **kwargs):
        captured["cmd"] = cmd
        class R:
            returncode = 0
        return R()

    monkeypatch.setattr("subprocess.run", fake_run)

    rc = mod.launch(
        ["--name", "PA-X"],
        project_dir=project_dir,
        tab_color="#F59E0B",
        no_wt=False,
    )
    assert rc == 0
    cmd = captured["cmd"]
    assert cmd[0].endswith("wt.exe")
    assert "new-tab" in cmd
    assert "--tabColor" in cmd
    assert "#F59E0B" in cmd
    assert "-d" in cmd
    assert str(project_dir) in cmd
    assert "claude" in cmd
    assert "--name" in cmd
    assert "PA-X" in cmd


def test_launch_no_wt_flag_skips_wt(project_dir: Path, monkeypatch):
    """When no_wt=True on Windows, falls back to direct subprocess.run
    of claude (not wt.exe)."""
    mod = _reload()

    def which_stub(name):
        if name == "claude":
            return "C:/Program Files/claude.exe"
        if name == "wt.exe":
            return "C:/wt.exe"  # available but should NOT be used
        return None

    monkeypatch.setattr(shutil, "which", which_stub)
    monkeypatch.setattr("platform.system", lambda: "Windows")

    captured = {}

    def fake_run(cmd, **kwargs):
        captured["cmd"] = cmd
        class R:
            returncode = 0
        return R()

    monkeypatch.setattr("subprocess.run", fake_run)

    rc = mod.launch(
        ["--name", "X"],
        project_dir=project_dir,
        tab_color="#F59E0B",
        no_wt=True,
    )
    assert rc == 0
    assert "wt.exe" not in captured["cmd"][0]
    assert "claude" in captured["cmd"][0] or captured["cmd"][0].endswith("claude.exe")
```

- [ ] **Step 2: Run the test (expected: fail)**

```
cd plugins/orchestrator
uvx --from pytest pytest tests/launchers/test_launch.py -v
```

Expected: 4 errors.

- [ ] **Step 3: Implement `launch`**

Append to `_launcher_common.py` (after `build_claude_args`):

```python
import platform
import shutil
import subprocess


def launch(
    claude_args: list[str],
    *,
    project_dir: Path,
    tab_color: str | None,
    no_wt: bool,
) -> int:
    """Spawn the claude process, optionally in a new Windows Terminal tab.

    Platform branching:
      - Windows + wt.exe present + not no_wt:
            wt.exe -w new new-tab [--tabColor X] -d <project_dir> claude <argv>
      - Windows otherwise:
            subprocess.run([claude, *argv])
      - POSIX (Linux/macOS/WSL):
            os.execvp('claude', ['claude', *argv])
            (replaces the Python process so the user's terminal stays)

    Exits 127 with an actionable message if `claude` isn't on PATH.

    Args:
        claude_args: Args after the program name (from build_claude_args).
        project_dir: Project root (used as -d for wt.exe tab cwd).
        tab_color: Hex color for the wt.exe tab, e.g. '#F59E0B'. None for
            no tab-color flag (SA launcher).
        no_wt: When True, skip wt.exe even on Windows.

    Returns:
        The exit code of the launched claude (0 on POSIX via execvp).
    """
    claude_path = shutil.which("claude")
    if not claude_path:
        print(
            "ERROR: 'claude' not found on PATH. Install Claude Code CLI: "
            "https://docs.claude.com/en/docs/claude-code/quickstart",
            file=sys.stderr,
        )
        sys.exit(127)

    is_windows = platform.system() == "Windows"

    if not is_windows:
        # POSIX path: replace the Python process with claude.
        os.execvp("claude", ["claude", *claude_args])
        # execvp does not return on success; reachable only on failure.
        print("ERROR: os.execvp returned (claude exec failed)", file=sys.stderr)
        return 1

    # Windows path.
    wt_path = shutil.which("wt.exe")
    use_wt = (not no_wt) and (wt_path is not None)

    if use_wt:
        cmd: list[str] = [
            wt_path,
            "-w", "new",
            "new-tab",
        ]
        if tab_color:
            cmd.extend(["--tabColor", tab_color])
        cmd.extend(["-d", str(project_dir), "claude", *claude_args])
        result = subprocess.run(cmd)
        return result.returncode

    result = subprocess.run([claude_path, *claude_args])
    return result.returncode
```

Update `__all__` (final form):

```python
__all__ = [
    "MARKETPLACE_PLACEHOLDER",
    "check_marketplace_substituted",
    "project_hash_for",
    "resolve_project_dir",
    "resolve_resume_target",
    "supersede_existing_pa",
    "make_session_name",
    "setup_env",
    "build_claude_args",
    "launch",
]
```

- [ ] **Step 4: Run the test (expected: pass)**

```
cd plugins/orchestrator
uvx --from pytest pytest tests/launchers/test_launch.py -v
```

Expected: 4 passed.

- [ ] **Step 5: Run the full test suite (expected: all green)**

```
cd plugins/orchestrator
uvx --from pytest pytest tests/launchers/ -v
```

Expected: ~30 tests pass (all functions tested so far).

- [ ] **Step 6: Commit**

```bash
git add plugins/orchestrator/skills/install-launchers/scripts/_launcher_common.py \
        plugins/orchestrator/tests/launchers/test_launch.py
git commit -m "feat(orchestrator): _launcher_common — launch (terminal-spawn abstraction)

Adds launch(claude_args, *, project_dir, tab_color, no_wt) -> int.
The only place in _launcher_common.py that branches on platform.

  - shutil.which('claude') gate: missing → exit 127 with install hint
  - POSIX: os.execvp('claude', ...) — replaces Python process
  - Windows + wt.exe + not no_wt: wt.exe -w new new-tab [--tabColor X]
    -d <dir> claude <argv>
  - Windows otherwise: subprocess.run([claude, ...])

Tests use shutil.which / platform.system / os.execvp / subprocess.run
monkeypatching to assert on the resolved spawn command without
actually exec'ing claude or wt.exe.

This completes the _launcher_common.py shared module."
```

---

## Task 11: `pa_start.py` entry point

**Files:**
- Create: `plugins/orchestrator/skills/install-launchers/scripts/pa_start.py`
- Create: `plugins/orchestrator/tests/launchers/test_entry_pa.py`

- [ ] **Step 1: Write the failing test**

Create `plugins/orchestrator/tests/launchers/test_entry_pa.py`:

```python
"""Smoke tests for pa_start.py via --dry-run mode."""

import importlib
import json
import sys
from pathlib import Path

import pytest


def _reload(name: str):
    if name in sys.modules:
        del sys.modules[name]
    return importlib.import_module(name)


def test_pa_dry_run_emits_argv_and_env(
    env_snapshot, project_dir: Path, monkeypatch: pytest.MonkeyPatch, capsys
):
    """`pa_start.py --dry-run --project-dir <tmp>` prints a JSON envelope
    on stdout describing the resolved argv + env_overrides."""
    # Substitute the marketplace so check_marketplace_substituted doesn't exit.
    common = _reload("_launcher_common")
    monkeypatch.setattr(common, "MARKETPLACE_PLACEHOLDER", "spawnbox-dev-claude-plugins")

    pa = _reload("pa_start")
    # pa_start re-imports common at module load; ensure that import sees the patched value.
    monkeypatch.setattr(pa.common, "MARKETPLACE_PLACEHOLDER", "spawnbox-dev-claude-plugins")

    rc = pa.main(["--dry-run", "--project-dir", str(project_dir)])
    assert rc == 0

    out = capsys.readouterr().out
    payload = json.loads(out)
    assert "argv" in payload
    assert "env_overrides" in payload
    assert payload["tab_color"] == "#F59E0B"
    # PA always hardcodes --effort max.
    assert "max" in payload["argv"]
    # Role env is prime.
    assert payload["env_overrides"]["ORCHESTRATOR_AGENT_ROLE"] == "prime"
    assert payload["env_overrides"]["ORCHESTRATOR_SESSION_KIND"] == "prime"


def test_pa_dry_run_session_name_shape(
    env_snapshot, project_dir: Path, monkeypatch: pytest.MonkeyPatch, capsys
):
    """Session name has the PA-YYYY-MM-DD-HH-MM-SS shape."""
    import re

    common = _reload("_launcher_common")
    monkeypatch.setattr(common, "MARKETPLACE_PLACEHOLDER", "spawnbox-dev-claude-plugins")
    pa = _reload("pa_start")
    monkeypatch.setattr(pa.common, "MARKETPLACE_PLACEHOLDER", "spawnbox-dev-claude-plugins")

    pa.main(["--dry-run", "--project-dir", str(project_dir)])
    out = capsys.readouterr().out
    payload = json.loads(out)
    name = payload["env_overrides"]["ORCHESTRATOR_AGENT_NAME"]
    assert re.fullmatch(r"PA-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}", name)
```

- [ ] **Step 2: Run the test (expected: fail — `pa_start` not found)**

```
cd plugins/orchestrator
uvx --from pytest pytest tests/launchers/test_entry_pa.py -v
```

Expected: 2 errors, `ModuleNotFoundError: No module named 'pa_start'`.

- [ ] **Step 3: Implement `pa_start.py`**

Create `plugins/orchestrator/skills/install-launchers/scripts/pa_start.py`:

```python
#!/usr/bin/env python3
"""Launch the PrimeAgent (PA) Claude Code session for the current project.

PA is the persistent orchestrator session running Opus at max effort with
agent-channel attached. Project-agnostic. Single source-of-truth lives
in the orchestrator plugin's install-launchers skill; install per-project
via `/orchestrator:install-launchers`.

Usage:
    ./pa-start.sh                       # POSIX wrapper
    .\\pa-start.ps1                      # Windows wrapper
    python3 pa_start.py [--resume X] [--project-dir Y] [--no-windows-terminal] [--dry-run]
"""

from __future__ import annotations

import argparse
import json
import os
import sys

import _launcher_common as common


def main(argv: list[str] | None = None) -> int:
    common.check_marketplace_substituted()

    parser = argparse.ArgumentParser(
        description="Launch the PrimeAgent (PA) Claude Code session.",
    )
    parser.add_argument(
        "--resume",
        default="",
        help="Session UUID or display name (set via /rename in Claude Code).",
    )
    parser.add_argument(
        "--project-dir",
        default="",
        help="Project root. Defaults to current working directory.",
    )
    parser.add_argument(
        "--no-windows-terminal",
        action="store_true",
        help="Skip wt.exe and launch claude directly in the current console.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Print resolved argv + env-overrides as JSON; don't spawn claude.",
    )
    args = parser.parse_args(argv)

    project_dir = common.resolve_project_dir(args.project_dir or None)

    resume = ""
    if args.resume:
        resume = common.resolve_resume_target(args.resume, project_dir)

    if not args.dry_run:
        common.supersede_existing_pa(project_dir)

    session_name: str | None = None
    if not resume:
        session_name = common.make_session_name("PA")

    # Snapshot env before setup_env mutates it, so --dry-run can show the
    # diff cleanly.
    env_before = dict(os.environ)
    common.setup_env(
        role="prime",
        session_kind="prime",
        project_dir=project_dir,
        session_name=session_name,
    )
    env_overrides = {
        k: v for k, v in os.environ.items() if env_before.get(k) != v
    }

    claude_args = common.build_claude_args(
        marketplace=common.MARKETPLACE_PLACEHOLDER,
        session_name=session_name,
        resume=resume or None,
        effort="max",  # PA always launches at max effort.
        extra_channels=None,
    )

    if args.dry_run:
        payload = {
            "argv": claude_args,
            "env_overrides": env_overrides,
            "tab_color": "#F59E0B",
            "use_wt": not args.no_windows_terminal,
        }
        print(json.dumps(payload, indent=2))
        return 0

    return common.launch(
        claude_args,
        project_dir=project_dir,
        tab_color="#F59E0B",
        no_wt=args.no_windows_terminal,
    )


if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 4: Run the test (expected: pass)**

```
cd plugins/orchestrator
uvx --from pytest pytest tests/launchers/test_entry_pa.py -v
```

Expected: 2 passed.

- [ ] **Step 5: Commit**

```bash
git add plugins/orchestrator/skills/install-launchers/scripts/pa_start.py \
        plugins/orchestrator/tests/launchers/test_entry_pa.py
git commit -m "feat(orchestrator): pa_start.py entry point

PA launcher entry point. Composes _launcher_common helpers:

  - check_marketplace_substituted() (fail-fast guard)
  - resolve_project_dir → resolve_resume_target (if --resume)
  - supersede_existing_pa (singleton enforcement; skipped on --dry-run)
  - make_session_name('PA') unless resuming
  - setup_env(role='prime', session_kind='prime', ...)
  - build_claude_args(effort='max', ...)
  - launch(tab_color='#F59E0B', ...) OR --dry-run JSON output

--dry-run mode performs all state mutations EXCEPT the sessions.json
write and launch() call, then prints a JSON envelope describing the
resolved argv + env_overrides + tab_color + use_wt. Used by the smoke
tests and as a user-facing debug tool.

Two smoke tests: dry-run output shape + PA-prefixed session name."
```

---

## Task 12: `sa_start.py` entry point

**Files:**
- Create: `plugins/orchestrator/skills/install-launchers/scripts/sa_start.py`
- Create: `plugins/orchestrator/tests/launchers/test_entry_sa.py`

- [ ] **Step 1: Write the failing test**

Create `plugins/orchestrator/tests/launchers/test_entry_sa.py`:

```python
"""Smoke tests for sa_start.py via --dry-run mode."""

import importlib
import json
import sys
from pathlib import Path

import pytest


def _reload(name: str):
    if name in sys.modules:
        del sys.modules[name]
    return importlib.import_module(name)


def test_sa_dry_run_no_effort(
    env_snapshot, project_dir: Path, monkeypatch: pytest.MonkeyPatch, capsys
):
    """SA without --effort: no --effort in argv, default tab color, role=
    subordinate."""
    common = _reload("_launcher_common")
    monkeypatch.setattr(common, "MARKETPLACE_PLACEHOLDER", "spawnbox-dev-claude-plugins")
    sa = _reload("sa_start")
    monkeypatch.setattr(sa.common, "MARKETPLACE_PLACEHOLDER", "spawnbox-dev-claude-plugins")

    rc = sa.main(["--dry-run", "--project-dir", str(project_dir)])
    assert rc == 0

    payload = json.loads(capsys.readouterr().out)
    assert payload["tab_color"] is None
    assert "--effort" not in payload["argv"]
    assert payload["env_overrides"]["ORCHESTRATOR_AGENT_ROLE"] == "subordinate"
    assert payload["env_overrides"]["ORCHESTRATOR_SESSION_KIND"] == "subordinate"


def test_sa_dry_run_with_effort_max(
    env_snapshot, project_dir: Path, monkeypatch: pytest.MonkeyPatch, capsys
):
    """SA with --effort max: --effort appears in argv."""
    common = _reload("_launcher_common")
    monkeypatch.setattr(common, "MARKETPLACE_PLACEHOLDER", "spawnbox-dev-claude-plugins")
    sa = _reload("sa_start")
    monkeypatch.setattr(sa.common, "MARKETPLACE_PLACEHOLDER", "spawnbox-dev-claude-plugins")

    sa.main(["--dry-run", "--project-dir", str(project_dir), "--effort", "max"])
    payload = json.loads(capsys.readouterr().out)
    assert "--effort" in payload["argv"]
    assert payload["argv"][payload["argv"].index("--effort") + 1] == "max"


def test_sa_dry_run_with_explicit_name(
    env_snapshot, project_dir: Path, monkeypatch: pytest.MonkeyPatch, capsys
):
    """SA with --name uses that name verbatim (no SA- prefix injection)."""
    common = _reload("_launcher_common")
    monkeypatch.setattr(common, "MARKETPLACE_PLACEHOLDER", "spawnbox-dev-claude-plugins")
    sa = _reload("sa_start")
    monkeypatch.setattr(sa.common, "MARKETPLACE_PLACEHOLDER", "spawnbox-dev-claude-plugins")

    sa.main(["--dry-run", "--project-dir", str(project_dir), "--name", "SA-frontend"])
    payload = json.loads(capsys.readouterr().out)
    assert payload["env_overrides"]["ORCHESTRATOR_AGENT_NAME"] == "SA-frontend"
```

- [ ] **Step 2: Run the test (expected: fail)**

```
cd plugins/orchestrator
uvx --from pytest pytest tests/launchers/test_entry_sa.py -v
```

Expected: 3 errors.

- [ ] **Step 3: Implement `sa_start.py`**

Create `plugins/orchestrator/skills/install-launchers/scripts/sa_start.py`:

```python
#!/usr/bin/env python3
"""Launch a Subordinate Agent (SA) Claude Code session.

SA is a peer subordinate of PA, participating in the orchestrator
agent-channel. Project-agnostic.

Usage:
    ./sa-start.sh                       # POSIX wrapper
    .\\sa-start.ps1                      # Windows wrapper
    python3 sa_start.py [--resume X] [--name Y] [--project-dir Z] \\
                        [--effort low|medium|high|xhigh|max] \\
                        [--no-windows-terminal] [--dry-run]
"""

from __future__ import annotations

import argparse
import json
import os
import sys

import _launcher_common as common


def main(argv: list[str] | None = None) -> int:
    common.check_marketplace_substituted()

    parser = argparse.ArgumentParser(
        description="Launch a Subordinate Agent (SA) Claude Code session.",
    )
    parser.add_argument("--resume", default="")
    parser.add_argument("--name", default="")
    parser.add_argument("--project-dir", default="")
    parser.add_argument(
        "--effort",
        choices=["low", "medium", "high", "xhigh", "max"],
        default=None,
        help="Reasoning effort. Omit to leave Claude Code on session default.",
    )
    parser.add_argument("--no-windows-terminal", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args(argv)

    project_dir = common.resolve_project_dir(args.project_dir or None)

    resume = ""
    if args.resume:
        resume = common.resolve_resume_target(args.resume, project_dir)

    session_name: str | None = None
    if args.name:
        session_name = args.name
    elif not resume:
        session_name = common.make_session_name("SA")

    env_before = dict(os.environ)
    common.setup_env(
        role="subordinate",
        session_kind="subordinate",
        project_dir=project_dir,
        session_name=session_name,
    )
    env_overrides = {
        k: v for k, v in os.environ.items() if env_before.get(k) != v
    }

    claude_args = common.build_claude_args(
        marketplace=common.MARKETPLACE_PLACEHOLDER,
        session_name=session_name,
        resume=resume or None,
        effort=args.effort,
        extra_channels=None,
    )

    if args.dry_run:
        payload = {
            "argv": claude_args,
            "env_overrides": env_overrides,
            "tab_color": None,
            "use_wt": not args.no_windows_terminal,
        }
        print(json.dumps(payload, indent=2))
        return 0

    return common.launch(
        claude_args,
        project_dir=project_dir,
        tab_color=None,
        no_wt=args.no_windows_terminal,
    )


if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 4: Run the test (expected: pass)**

```
cd plugins/orchestrator
uvx --from pytest pytest tests/launchers/test_entry_sa.py -v
```

Expected: 3 passed.

- [ ] **Step 5: Commit**

```bash
git add plugins/orchestrator/skills/install-launchers/scripts/sa_start.py \
        plugins/orchestrator/tests/launchers/test_entry_sa.py
git commit -m "feat(orchestrator): sa_start.py entry point

SA launcher entry point. Same composition as pa_start.py with the
SA-specific deltas:

  - role='subordinate', session_kind='subordinate'
  - no singleton-supersede (subordinates are not singleton)
  - --effort is an optional CLI flag (validated against
    low/medium/high/xhigh/max); omitted from claude argv when not set
  - --name is an optional CLI flag (overrides auto-generated SA- name)
  - tab_color=None (no special tab color for SAs)

Tests cover: no --effort, --effort max, --name override."
```

---

## Task 13: `discord_start.py` entry point

**Files:**
- Create: `plugins/orchestrator/skills/install-launchers/scripts/discord_start.py`
- Create: `plugins/orchestrator/tests/launchers/test_entry_discord.py`

- [ ] **Step 1: Write the failing test**

Create `plugins/orchestrator/tests/launchers/test_entry_discord.py`:

```python
"""Smoke tests for discord_start.py via --dry-run mode."""

import importlib
import json
import sys
from pathlib import Path

import pytest


def _reload(name: str):
    if name in sys.modules:
        del sys.modules[name]
    return importlib.import_module(name)


def test_discord_dry_run_dual_channels(
    env_snapshot, project_dir: Path, monkeypatch: pytest.MonkeyPatch, capsys
):
    """Discord launcher emits both --channels (Discord allowlisted) and
    --dangerously-load-development-channels (orchestrator)."""
    common = _reload("_launcher_common")
    monkeypatch.setattr(common, "MARKETPLACE_PLACEHOLDER", "spawnbox-dev-claude-plugins")
    discord = _reload("discord_start")
    monkeypatch.setattr(discord.common, "MARKETPLACE_PLACEHOLDER", "spawnbox-dev-claude-plugins")

    rc = discord.main(["--dry-run", "--project-dir", str(project_dir)])
    assert rc == 0

    payload = json.loads(capsys.readouterr().out)
    argv = payload["argv"]
    assert "--channels" in argv
    assert "plugin:discord@claude-plugins-official" in argv
    assert "--dangerously-load-development-channels" in argv
    assert "plugin:orchestrator@spawnbox-dev-claude-plugins" in argv

    assert payload["tab_color"] == "#DC2626"
    assert payload["env_overrides"]["ORCHESTRATOR_SESSION_KIND"] == "discord-bot"
    assert payload["env_overrides"]["ORCHESTRATOR_AGENT_ROLE"] == "subordinate"


def test_discord_dry_run_name_shape(
    env_snapshot, project_dir: Path, monkeypatch: pytest.MonkeyPatch, capsys
):
    """Discord session name has the DISCORD-LIVE-YYYY-... shape."""
    import re

    common = _reload("_launcher_common")
    monkeypatch.setattr(common, "MARKETPLACE_PLACEHOLDER", "spawnbox-dev-claude-plugins")
    discord = _reload("discord_start")
    monkeypatch.setattr(discord.common, "MARKETPLACE_PLACEHOLDER", "spawnbox-dev-claude-plugins")

    discord.main(["--dry-run", "--project-dir", str(project_dir)])
    payload = json.loads(capsys.readouterr().out)
    name = payload["env_overrides"]["ORCHESTRATOR_AGENT_NAME"]
    assert re.fullmatch(r"DISCORD-LIVE-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}", name)
```

- [ ] **Step 2: Run the test (expected: fail)**

```
cd plugins/orchestrator
uvx --from pytest pytest tests/launchers/test_entry_discord.py -v
```

Expected: 2 errors.

- [ ] **Step 3: Implement `discord_start.py`**

Create `plugins/orchestrator/skills/install-launchers/scripts/discord_start.py`:

```python
#!/usr/bin/env python3
"""Launch a Discord-ops Claude Code session.

Participates in BOTH the Discord plugin channel (incoming chat) AND the
orchestrator agent-channel (cross-session coordination). Discord-ops
sessions register as role=subordinate with session_kind=discord-bot, so
the discord-bootstrap skill and per-kind classifier policies can gate
on kind without relying on fragile name-pattern matching.

Usage:
    ./discord-start.sh                  # POSIX wrapper
    .\\discord-start.ps1                 # Windows wrapper
    python3 discord_start.py [--project-dir X] [--no-windows-terminal] [--dry-run]
"""

from __future__ import annotations

import argparse
import json
import os
import sys

import _launcher_common as common


def main(argv: list[str] | None = None) -> int:
    common.check_marketplace_substituted()

    parser = argparse.ArgumentParser(
        description="Launch a Discord-ops Claude Code session.",
    )
    parser.add_argument("--project-dir", default="")
    parser.add_argument("--no-windows-terminal", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args(argv)

    project_dir = common.resolve_project_dir(args.project_dir or None)
    session_name = common.make_session_name("DISCORD-LIVE")

    env_before = dict(os.environ)
    common.setup_env(
        role="subordinate",
        session_kind="discord-bot",
        project_dir=project_dir,
        session_name=session_name,
    )
    env_overrides = {
        k: v for k, v in os.environ.items() if env_before.get(k) != v
    }

    claude_args = common.build_claude_args(
        marketplace=common.MARKETPLACE_PLACEHOLDER,
        session_name=session_name,
        resume=None,
        effort=None,
        extra_channels=["plugin:discord@claude-plugins-official"],
    )

    if args.dry_run:
        payload = {
            "argv": claude_args,
            "env_overrides": env_overrides,
            "tab_color": "#DC2626",
            "use_wt": not args.no_windows_terminal,
        }
        print(json.dumps(payload, indent=2))
        return 0

    return common.launch(
        claude_args,
        project_dir=project_dir,
        tab_color="#DC2626",
        no_wt=args.no_windows_terminal,
    )


if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 4: Run the test (expected: pass)**

```
cd plugins/orchestrator
uvx --from pytest pytest tests/launchers/test_entry_discord.py -v
```

Expected: 2 passed.

- [ ] **Step 5: Run the FULL test suite — expected all green**

```
cd plugins/orchestrator
uvx --from pytest pytest tests/launchers/ -v
```

Expected: ~40 tests pass.

- [ ] **Step 6: Commit**

```bash
git add plugins/orchestrator/skills/install-launchers/scripts/discord_start.py \
        plugins/orchestrator/tests/launchers/test_entry_discord.py
git commit -m "feat(orchestrator): discord_start.py entry point

Discord-ops launcher entry point. SA-shaped composition with the
Discord-specific deltas:

  - role='subordinate', session_kind='discord-bot' (gates classifier
    policies + discord-bootstrap skill identity check)
  - session name always auto-generated DISCORD-LIVE-<timestamp>
    (no --name flag, no --resume flag)
  - extra --channels plugin:discord@claude-plugins-official IN
    ADDITION to the orchestrator dev-channels flag
  - tab_color='#DC2626' (red)

This completes the three Python entry points."
```

---

## Task 14: POSIX wrappers (3 .sh files)

**Files:**
- Create: `plugins/orchestrator/skills/install-launchers/scripts/pa-start.sh`
- Create: `plugins/orchestrator/skills/install-launchers/scripts/sa-start.sh`
- Create: `plugins/orchestrator/skills/install-launchers/scripts/discord-start.sh`

- [ ] **Step 1: Create `pa-start.sh`**

```bash
#!/usr/bin/env bash
# Thin wrapper for pa_start.py. Locates a Python 3.10+ interpreter and
# execs the canonical Python launcher. See pa_start.py for documentation
# and supported CLI flags.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PYTHON="${ORCH_PYTHON:-python3}"

if ! command -v "$PYTHON" >/dev/null 2>&1; then
  echo "ERROR: '$PYTHON' not found on PATH." >&2
  echo "Install Python 3.10+ (apt install python3, brew install python@3.12," >&2
  echo "or set \$ORCH_PYTHON to a working interpreter)." >&2
  exit 127
fi

exec "$PYTHON" "$SCRIPT_DIR/pa_start.py" "$@"
```

- [ ] **Step 2: Create `sa-start.sh`** (identical structure, different .py target)

```bash
#!/usr/bin/env bash
# Thin wrapper for sa_start.py. See sa_start.py for documentation.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PYTHON="${ORCH_PYTHON:-python3}"

if ! command -v "$PYTHON" >/dev/null 2>&1; then
  echo "ERROR: '$PYTHON' not found on PATH." >&2
  echo "Install Python 3.10+ (apt install python3, brew install python@3.12," >&2
  echo "or set \$ORCH_PYTHON to a working interpreter)." >&2
  exit 127
fi

exec "$PYTHON" "$SCRIPT_DIR/sa_start.py" "$@"
```

- [ ] **Step 3: Create `discord-start.sh`**

```bash
#!/usr/bin/env bash
# Thin wrapper for discord_start.py. See discord_start.py for documentation.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PYTHON="${ORCH_PYTHON:-python3}"

if ! command -v "$PYTHON" >/dev/null 2>&1; then
  echo "ERROR: '$PYTHON' not found on PATH." >&2
  echo "Install Python 3.10+ (apt install python3, brew install python@3.12," >&2
  echo "or set \$ORCH_PYTHON to a working interpreter)." >&2
  exit 127
fi

exec "$PYTHON" "$SCRIPT_DIR/discord_start.py" "$@"
```

- [ ] **Step 4: Make all three executable**

```
chmod +x plugins/orchestrator/skills/install-launchers/scripts/pa-start.sh \
         plugins/orchestrator/skills/install-launchers/scripts/sa-start.sh \
         plugins/orchestrator/skills/install-launchers/scripts/discord-start.sh
```

- [ ] **Step 5: Smoke-test each wrapper invokes the right .py with --dry-run**

Substitute the marketplace placeholder temporarily so the guard passes
(this is what install-launchers does):

```
cd plugins/orchestrator/skills/install-launchers/scripts
sed -i.bak 's/__ORCH_MARKETPLACE__/spawnbox-dev-claude-plugins/' _launcher_common.py
./pa-start.sh --dry-run --project-dir /tmp
./sa-start.sh --dry-run --project-dir /tmp
./discord-start.sh --dry-run --project-dir /tmp
# Restore the placeholder.
mv _launcher_common.py.bak _launcher_common.py
```

Expected: three JSON envelopes printed, each with the right role / tab_color / argv shape for its launcher.

- [ ] **Step 6: Commit**

```bash
git add plugins/orchestrator/skills/install-launchers/scripts/pa-start.sh \
        plugins/orchestrator/skills/install-launchers/scripts/sa-start.sh \
        plugins/orchestrator/skills/install-launchers/scripts/discord-start.sh
git update-index --chmod=+x \
        plugins/orchestrator/skills/install-launchers/scripts/pa-start.sh \
        plugins/orchestrator/skills/install-launchers/scripts/sa-start.sh \
        plugins/orchestrator/skills/install-launchers/scripts/discord-start.sh
git commit -m "feat(orchestrator): POSIX wrappers for Python launchers

Three thin Bash wrappers (~12 LOC each) that:
  - locate a Python interpreter (\$ORCH_PYTHON > python3)
  - emit an actionable 'Python not found' error with install hints if
    none available
  - exec the corresponding pa_start / sa_start / discord_start .py
    with passthrough args

Mode 755 — git tracks the executable bit.

Smoke-tested locally: each wrapper invokes its .py and emits a valid
--dry-run JSON envelope when the marketplace slug is substituted."
```

---

## Task 15: Windows wrappers (3 .ps1 files — replace existing fat scripts)

**Files:**
- Modify: `plugins/orchestrator/skills/install-launchers/scripts/pa-start.ps1` (replace 208 LOC with ~22)
- Modify: `plugins/orchestrator/skills/install-launchers/scripts/sa-start.ps1` (replace 175 LOC with ~22)
- Modify: `plugins/orchestrator/skills/install-launchers/scripts/discord-start.ps1` (replace 113 LOC with ~22)

- [ ] **Step 1: Replace `pa-start.ps1` with the wrapper version**

Replace the **entire contents** of `plugins/orchestrator/skills/install-launchers/scripts/pa-start.ps1` with:

```powershell
# Thin wrapper for pa_start.py. Locates a Python 3.10+ interpreter
# (honoring $env:ORCH_PYTHON override and detecting the Microsoft Store
# stub) and execs the canonical Python launcher. See pa_start.py for
# documentation and supported CLI flags.

$ErrorActionPreference = 'Stop'

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$candidates = @($env:ORCH_PYTHON, 'python.exe', 'py.exe') | Where-Object { $_ }
$python = $null

foreach ($c in $candidates) {
  $cmd = Get-Command $c -ErrorAction SilentlyContinue
  if (-not $cmd) { continue }
  $vout = & $cmd.Source --version 2>&1
  if ($LASTEXITCODE -eq 0 -and $vout -notmatch 'Python was not found') {
    $python = $cmd.Source
    break
  }
}

if (-not $python) {
  Write-Host "ERROR: Python 3.10+ not found." -ForegroundColor Red
  Write-Host "Install via:" -ForegroundColor Red
  Write-Host "  winget install Python.Python.3.12" -ForegroundColor Red
  Write-Host "  - or python.org installer" -ForegroundColor Red
  Write-Host "  - or Microsoft Store (the real Python 3.x app, not the App Execution Alias stub)" -ForegroundColor Red
  Write-Host "Or set `$env:ORCH_PYTHON to a working interpreter." -ForegroundColor Red
  exit 127
}

& $python "$here\pa_start.py" @args
exit $LASTEXITCODE
```

- [ ] **Step 2: Replace `sa-start.ps1` with the wrapper version**

Replace the **entire contents** of `plugins/orchestrator/skills/install-launchers/scripts/sa-start.ps1` with:

```powershell
# Thin wrapper for sa_start.py. See sa_start.py for documentation.

$ErrorActionPreference = 'Stop'

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$candidates = @($env:ORCH_PYTHON, 'python.exe', 'py.exe') | Where-Object { $_ }
$python = $null

foreach ($c in $candidates) {
  $cmd = Get-Command $c -ErrorAction SilentlyContinue
  if (-not $cmd) { continue }
  $vout = & $cmd.Source --version 2>&1
  if ($LASTEXITCODE -eq 0 -and $vout -notmatch 'Python was not found') {
    $python = $cmd.Source
    break
  }
}

if (-not $python) {
  Write-Host "ERROR: Python 3.10+ not found." -ForegroundColor Red
  Write-Host "Install via:" -ForegroundColor Red
  Write-Host "  winget install Python.Python.3.12" -ForegroundColor Red
  Write-Host "  - or python.org installer" -ForegroundColor Red
  Write-Host "  - or Microsoft Store (the real Python 3.x app, not the App Execution Alias stub)" -ForegroundColor Red
  Write-Host "Or set `$env:ORCH_PYTHON to a working interpreter." -ForegroundColor Red
  exit 127
}

& $python "$here\sa_start.py" @args
exit $LASTEXITCODE
```

- [ ] **Step 3: Replace `discord-start.ps1` with the wrapper version**

Replace the **entire contents** of `plugins/orchestrator/skills/install-launchers/scripts/discord-start.ps1` with:

```powershell
# Thin wrapper for discord_start.py. See discord_start.py for documentation.

$ErrorActionPreference = 'Stop'

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$candidates = @($env:ORCH_PYTHON, 'python.exe', 'py.exe') | Where-Object { $_ }
$python = $null

foreach ($c in $candidates) {
  $cmd = Get-Command $c -ErrorAction SilentlyContinue
  if (-not $cmd) { continue }
  $vout = & $cmd.Source --version 2>&1
  if ($LASTEXITCODE -eq 0 -and $vout -notmatch 'Python was not found') {
    $python = $cmd.Source
    break
  }
}

if (-not $python) {
  Write-Host "ERROR: Python 3.10+ not found." -ForegroundColor Red
  Write-Host "Install via:" -ForegroundColor Red
  Write-Host "  winget install Python.Python.3.12" -ForegroundColor Red
  Write-Host "  - or python.org installer" -ForegroundColor Red
  Write-Host "  - or Microsoft Store (the real Python 3.x app, not the App Execution Alias stub)" -ForegroundColor Red
  Write-Host "Or set `$env:ORCH_PYTHON to a working interpreter." -ForegroundColor Red
  exit 127
}

& $python "$here\discord_start.py" @args
exit $LASTEXITCODE
```

- [ ] **Step 4: Verify `.bat` trampolines are unchanged in shape**

The existing `.bat` files (`pa-start.bat`, `sa-start.bat`, `discord-start.bat`) call the corresponding `.ps1` file — that linkage is unchanged. Verify the existing files have the expected shape:

```
cat plugins/orchestrator/skills/install-launchers/scripts/pa-start.bat
```

Expected: 4 lines, last line is `@powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0pa-start.ps1" %*`. Same for sa-start.bat and discord-start.bat (with the launcher name swapped).

No changes needed to .bat files.

- [ ] **Step 5: Commit**

```bash
git add plugins/orchestrator/skills/install-launchers/scripts/pa-start.ps1 \
        plugins/orchestrator/skills/install-launchers/scripts/sa-start.ps1 \
        plugins/orchestrator/skills/install-launchers/scripts/discord-start.ps1
git commit -m "feat(orchestrator): replace .ps1 launchers with thin Python wrappers

Replaces the three canonical PowerShell launcher scripts (208 + 175 +
113 = 496 LOC of business logic) with thin wrappers (~22 LOC each
identical-pattern) that:

  - try \$env:ORCH_PYTHON, then python.exe, then py.exe
  - detect the Microsoft Store App-Execution-Alias stub by output
    match ('Python was not found') per anti-pattern adf2b104
  - check \$LASTEXITCODE after every native-exe call (PowerShell
    try/catch does NOT catch native-exe failure)
  - emit actionable install hints (winget / python.org / MS Store
    Python real / \$ORCH_PYTHON) if no interpreter resolves
  - exec the corresponding pa_start / sa_start / discord_start .py
    with PowerShell splat (@args) for full argument passthrough

.bat trampolines unchanged — they dispatch to the .ps1 by filename,
which is unchanged in name (only the .ps1 body differs)."
```

---

## Task 16: `install-launchers/SKILL.md` updates

**Files:**
- Modify: `plugins/orchestrator/skills/install-launchers/SKILL.md`

The skill currently documents installing 6 files (3 .ps1 + 3 .bat) and substituting the marketplace placeholder in the 3 .ps1 files. It needs five targeted updates.

- [ ] **Step 1: Read the current SKILL.md to find the exact passages to update**

```
cat plugins/orchestrator/skills/install-launchers/SKILL.md
```

Note line numbers / contents of the following sections (used in subsequent steps):

  - The "SIX files" paragraph in the Overview section.
  - The launcher inventory table near the top.
  - Step 4 (or equivalent) that substitutes `__ORCH_MARKETPLACE__` in .ps1 files.
  - The file-copy step (currently copies 6 files).
  - The "When to use" / prerequisites section.

- [ ] **Step 2: Update the file-count claim**

Find the line that says "copies SIX files" (or similar). Replace with:

```markdown
This skill copies THIRTEEN files into the user's CWD (one shared
Python module + three Python entry-point modules + three POSIX
wrappers + three Windows PowerShell wrappers + three Windows batch
trampolines) and substitutes the marketplace slug into the shared
Python module so it references the right
`plugin:orchestrator@<marketplace>` for
`--dangerously-load-development-channels`.
```

- [ ] **Step 3: Replace the launcher inventory table**

Find the existing table near the top of the skill. Replace with:

```markdown
| Launcher | Role | Channels attached | Tab color | Files installed |
|---|---|---|---|---|
| `pa-start` | PrimeAgent (prime) | orchestrator | gold (#F59E0B) | `pa_start.py` + `pa-start.sh` + `pa-start.ps1` + `pa-start.bat` |
| `sa-start` | Subordinate (subordinate) | orchestrator | default | `sa_start.py` + `sa-start.sh` + `sa-start.ps1` + `sa-start.bat` |
| `discord-start` | Discord-ops (subordinate, kind=discord-bot) | orchestrator + Discord | red (#DC2626) | `discord_start.py` + `discord-start.sh` + `discord-start.ps1` + `discord-start.bat` |

All three launchers share a single canonical Python implementation
(`_launcher_common.py`), which is the 13th file installed.
```

- [ ] **Step 4: Update the prerequisites section**

Find the existing "When to use" / prerequisites section. Add the
Python prerequisite block:

```markdown
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
```

- [ ] **Step 5: Update the substitution step**

Find the step (likely Step 4 of the current skill) that runs sed/sed-equivalent to substitute `__ORCH_MARKETPLACE__` in three `.ps1` files. Replace with the new single-file substitution:

```markdown
### Substitute the marketplace slug

The Python launchers' `--dangerously-load-development-channels` flag
needs `plugin:orchestrator@<marketplace-slug>`. The placeholder
`__ORCH_MARKETPLACE__` lives in `_launcher_common.py` as a module-level
constant; substitute it in that single file at copy time:

```bash
# Linux/macOS/WSL
sed -i.bak "s/__ORCH_MARKETPLACE__/$MARKETPLACE/" \
    "$INSTALL_DIR/_launcher_common.py"
rm "$INSTALL_DIR/_launcher_common.py.bak"
```

```powershell
# Windows
(Get-Content "$InstallDir\_launcher_common.py") `
  -replace '__ORCH_MARKETPLACE__', $Marketplace `
  | Set-Content "$InstallDir\_launcher_common.py"
```

Verify the substitution by running:

```bash
python3 -c "import sys; sys.path.insert(0, '$INSTALL_DIR'); \
  import _launcher_common; _launcher_common.check_marketplace_substituted()"
```

If the placeholder wasn't substituted, the script exits 1 with an
actionable error pointing back at this install skill.
```

- [ ] **Step 6: Update the file-copy step to enumerate all 13 files + chmod**

Find the step that copies files. Replace with:

```markdown
### Copy files into the project root

```bash
# Linux/macOS/WSL
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
```

- [ ] **Step 7: Commit**

```bash
git add plugins/orchestrator/skills/install-launchers/SKILL.md
git commit -m "docs(orchestrator): update install-launchers SKILL.md for Python launchers

Updates the install skill to reflect the 13-file layout (1 shared
Python module + 3 entry points + 3 .sh + 3 .ps1 + 3 .bat). Five
targeted edits:

  1. 'SIX files' → 'THIRTEEN files' in the overview paragraph.
  2. Launcher inventory table extended with a 'Files installed'
     column enumerating the 4 files per launcher kind.
  3. New 'Prerequisites' section calling out Python 3.10+ as a
     hard requirement (with install hints per platform) and noting
     that Python is already a baseline plugin dep via the sidecar.
  4. Substitution step rewritten: single sed/PowerShell replace
     against _launcher_common.py instead of three .ps1 files.
  5. File-copy step enumerates all 13 filenames + chmod 755 on the
     three .sh wrappers (no-op on Windows).

Inline test runnable to verify substitution: an import + call of
_launcher_common.check_marketplace_substituted() raises if the
placeholder wasn't replaced."
```

---

## Task 17: Final integration check + repo-relative path verification

**Files:**
- Read: `plugins/orchestrator/skills/install-launchers/scripts/` (verify file inventory)
- Test: re-run full pytest suite

- [ ] **Step 1: List the scripts directory and verify the 13 files are present**

```
ls -la plugins/orchestrator/skills/install-launchers/scripts/
```

Expected file inventory (alphabetical):

```
_launcher_common.py
discord-start.bat
discord-start.ps1
discord-start.sh
discord_start.py
pa-start.bat
pa-start.ps1
pa-start.sh
pa_start.py
sa-start.bat
sa-start.ps1
sa-start.sh
sa_start.py
```

13 files. .sh files are mode 755. .py files are mode 644. .ps1 / .bat unchanged from their git-tracked mode.

- [ ] **Step 2: Run the full pytest suite**

```
cd plugins/orchestrator
uvx --from pytest pytest tests/launchers/ -v
```

Expected: all tests pass (target ~40+ tests across 9 test files).

If anything fails: do NOT skip ahead to commit. Halt, investigate, fix the underlying issue, re-run. The plan's earlier task definitions should not have introduced contradictions; a failure here is a regression or a typo in this task's verification.

- [ ] **Step 3: Run the existing TypeScript typecheck (sanity — no .ts changes in this PR)**

```
cd plugins/orchestrator
bun install
bun run typecheck
```

Expected: clean. No `.ts` files were touched in this PR — typecheck output should match `upstream/main`.

- [ ] **Step 4: Run the existing bun test suite (sanity — no .ts changes)**

```
cd plugins/orchestrator
bun test
```

Expected: same pass/fail count as `upstream/main`. (This PR doesn't change TypeScript, so the bun-test surface should be unaffected.)

- [ ] **Step 5: Diff against `upstream/main` for the PR shape**

```
git diff --stat upstream/main HEAD
```

Expected shape:

  - `plugins/orchestrator/docs/plans/2026-05-13-launcher-python-canonical-design.md` — new (~350 lines)
  - `plugins/orchestrator/docs/plans/2026-05-13-launcher-python-canonical-plan.md` — new (this plan; ~2000 lines)
  - `plugins/orchestrator/pyproject.toml` — new (~15 lines)
  - `plugins/orchestrator/package.json` — modified (+1 line)
  - `plugins/orchestrator/skills/install-launchers/SKILL.md` — modified (~50 line delta)
  - `plugins/orchestrator/skills/install-launchers/scripts/_launcher_common.py` — new (~250 lines)
  - `plugins/orchestrator/skills/install-launchers/scripts/pa_start.py` — new (~60 lines)
  - `plugins/orchestrator/skills/install-launchers/scripts/sa_start.py` — new (~60 lines)
  - `plugins/orchestrator/skills/install-launchers/scripts/discord_start.py` — new (~50 lines)
  - `plugins/orchestrator/skills/install-launchers/scripts/pa-start.sh` — new (~12 lines)
  - `plugins/orchestrator/skills/install-launchers/scripts/sa-start.sh` — new (~12 lines)
  - `plugins/orchestrator/skills/install-launchers/scripts/discord-start.sh` — new (~12 lines)
  - `plugins/orchestrator/skills/install-launchers/scripts/pa-start.ps1` — modified (208 → ~22 lines)
  - `plugins/orchestrator/skills/install-launchers/scripts/sa-start.ps1` — modified (175 → ~22 lines)
  - `plugins/orchestrator/skills/install-launchers/scripts/discord-start.ps1` — modified (113 → ~22 lines)
  - `plugins/orchestrator/tests/launchers/__init__.py` — new (empty)
  - `plugins/orchestrator/tests/launchers/conftest.py` — new (~60 lines)
  - 8 `plugins/orchestrator/tests/launchers/test_*.py` — new (~400 lines total across them)

Total: 20 changed paths, ~3500 lines net add. PR is large but mechanically reviewable.

- [ ] **Step 6: Commit a final summary tag commit (optional integration marker)**

If the PR-body convention requires an explicit "integration complete" commit, add it; otherwise skip. Default: no extra commit.

- [ ] **Step 7: Push the branch and open the PR**

```
git push -u origin feat/orchestrator-launcher-python-canonical
```

Open the PR upstream:

```
gh pr create \
  --repo SpawnBox-dev/claude-plugins \
  --base main \
  --head evannadeau:feat/orchestrator-launcher-python-canonical \
  --title "feat(orchestrator): Python-canonical launchers (replaces PR#3 bash port)" \
  --body "$(cat <<'EOF'
## Why

Per upstream operator decision (sequenced after PR#4 — backup-plugin-db
skill — though that PR remains unmerged at time of opening), this PR
retires the cross-language drift between the canonical PowerShell
launchers and the closed-PR#3 bash port by consolidating both
implementations into a single Python-canonical surface.

Python is already a baseline dependency of the orchestrator plugin via
`sidecar/embed_server.py` and `sidecar/requirements.txt`, so this PR
adds no new runtime dependency.

## What changes

**Removed** (replaced in place):
- ~496 LOC of canonical PowerShell logic across the three `.ps1`
  launchers.

**Added**:
- `_launcher_common.py` — shared module (project-dir resolution,
  CC project-hash transform, sessions.json singleton-supersede,
  env-var assembly, claude argv builder, terminal-spawn abstraction).
- `pa_start.py` / `sa_start.py` / `discord_start.py` — three entry
  points (one each per launcher kind).
- `pa-start.sh` / `sa-start.sh` / `discord-start.sh` — thin POSIX
  wrappers that locate `python3` (honoring `$ORCH_PYTHON`) and exec
  the entry .py.
- `pa-start.ps1` / `sa-start.ps1` / `discord-start.ps1` — thin
  Windows PS wrappers that locate `python.exe` / `py.exe` with
  Microsoft Store stub detection (per the published preflight rule).
- `tests/launchers/` — pytest suite for the shared module
  (project-hash, resume-resolve, supersede, session-name, setup-env,
  build-args, launch) + smoke tests for each entry point via the new
  `--dry-run` mode.
- `pyproject.toml` — Python 3.10+ floor, pytest as dev-only
  dependency.
- One-line addition to `package.json`:
  `"test:py": "uvx --from pytest pytest tests/launchers/"`.

**Unchanged**:
- The three `.bat` double-click trampolines retain their shape (they
  dispatch to the same-name `.ps1`, which is unchanged in name only).

## Behavior

User-observable behavior is preserved: same CLI flags, same env vars
set on the spawned `claude` process, same sessions.json mutations,
same wt.exe tab colors. One tightening: `sessions.json` write failure
during the supersede block is now FATAL (the .ps1 treated it as
warn-only, which could silently leave two `role=prime` entries and
break the singleton invariant).

Discord-start was omitted from the closed bash port (PR#3) — this PR
ships it.

## Test plan

Locally (CI surface):

```bash
cd plugins/orchestrator
bun install
bun run typecheck                      # unchanged — no .ts touched
bun test                               # unchanged — no .ts touched
uvx --from pytest pytest tests/launchers/   # new — should be all green
```

Operator-driven E2E on real systems (per the bash-port verification
protocol from the closed PR#3):
- WSL/Ubuntu with `python3` already present.
- Windows with python.org install.
- Windows with the real Microsoft Store Python 3.x (the legitimate
  distribution, distinct from the App Execution Alias stub).
- Optional: Windows without Python installed (verifies wrapper's
  "install Python" error message is actionable).

## Stack independence

This PR is independent of:
- PR#2 (sidecar boot timeout + stderr capture) — touches different
  files in `mcp/server.ts`.
- PR#4 (backup-plugin-db skill) — touches a different skill directory.

Cleanly mergeable in any order.

## Design + Plan

Both committed alongside the code:
- `docs/plans/2026-05-13-launcher-python-canonical-design.md`
- `docs/plans/2026-05-13-launcher-python-canonical-plan.md`
EOF
)"
```

- [ ] **Step 8: Capture the PR URL and close out the task**

Save the PR URL in the orchestrator KB and update the relevant
work-item to point at it. (Use whichever tracking command applies for
this session.)

---

## Self-Review Checklist (Plan Author)

Confirmed before finalizing the plan:

- **Spec coverage:** Every section of the design doc maps to at least one task. The `--dry-run` mode is implemented in each entry point; the `launch()` abstraction is unit-tested with monkeypatched spawn calls; the marketplace-substitution guard is the second-implemented piece; the SKILL.md update is its own task; the wrapper templates match the design's literal code.
- **No placeholders:** Every step contains the actual code to write, the actual command to run, and the expected output. No "TBD" / "TODO" / "implement later". No "similar to Task N" references — code is repeated when relevant.
- **Type consistency:** Function signatures cross-checked. `project_hash_for(project_dir: PurePath) -> str`, `resolve_project_dir(arg: str | None) -> Path`, `supersede_existing_pa(project_dir: Path) -> None`, `setup_env(*, role, session_kind, project_dir, session_name)`, `build_claude_args(*, marketplace, session_name, resume, effort, extra_channels)`, `launch(claude_args, *, project_dir, tab_color, no_wt)` — all match across tasks where they're referenced.
- **Scope:** 17 tasks, each ~2-7 steps. Single PR, single design doc. No decomposition needed.
- **Test/code mirroring:** Each shared-module function gets its own pytest file. Entry points get smoke tests via `--dry-run`. The `launch()` test monkeypatches `os.execvp` / `subprocess.run` to avoid actually spawning anything.

---

## Execution Notes

This plan assumes execution in the worktree at `/tmp/cp-launcher` on
branch `feat/orchestrator-launcher-python-canonical`. The branch was
cut from `upstream/main` (no in-flight feature branches in the
lineage). Commits are frequent (one per task) so each green test pass
becomes a recovery point.

If a task's pytest run fails unexpectedly, the recovery is to fix the
implementation IN-LINE (do not skip ahead). The TDD red-green pattern
gives each task its own "this worked on green" anchor.
