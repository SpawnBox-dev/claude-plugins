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
