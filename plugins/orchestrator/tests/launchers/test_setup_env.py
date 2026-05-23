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
