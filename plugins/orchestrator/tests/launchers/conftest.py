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
