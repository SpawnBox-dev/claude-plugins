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
