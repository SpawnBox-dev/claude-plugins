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
