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


import json
import os
import time
from datetime import datetime, timedelta, timezone


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
    time.sleep(2)


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
    "resolve_resume_target",
    "supersede_existing_pa",
    "make_session_name",
    "setup_env",
    "build_claude_args",
]
