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


import re
from pathlib import Path, PurePath


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


__all__ = [
    "MARKETPLACE_PLACEHOLDER",
    "check_marketplace_substituted",
    "project_hash_for",
    "resolve_project_dir",
]
