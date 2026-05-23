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
