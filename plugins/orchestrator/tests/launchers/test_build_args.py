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
