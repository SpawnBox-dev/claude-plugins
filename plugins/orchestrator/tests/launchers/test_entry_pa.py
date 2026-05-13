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
