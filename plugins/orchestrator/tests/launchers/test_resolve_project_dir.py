"""Tests for resolve_project_dir: default-to-CWD, --project-dir override,
must-exist validation."""

import importlib
import os
import sys
from pathlib import Path

import pytest


def _reload():
    if "_launcher_common" in sys.modules:
        del sys.modules["_launcher_common"]
    return importlib.import_module("_launcher_common")


def test_default_resolves_to_cwd(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    """Calling with None / empty string returns the absolute CWD."""
    mod = _reload()
    monkeypatch.chdir(tmp_path)
    result = mod.resolve_project_dir(None)
    assert result == tmp_path.resolve()


def test_explicit_arg_resolved_to_absolute(tmp_path: Path):
    """Passing an explicit directory returns its absolute path."""
    mod = _reload()
    result = mod.resolve_project_dir(str(tmp_path))
    assert result == tmp_path.resolve()
    assert result.is_absolute()


def test_relative_arg_resolved_against_cwd(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    """A relative path is resolved against CWD."""
    mod = _reload()
    sub = tmp_path / "sub"
    sub.mkdir()
    monkeypatch.chdir(tmp_path)
    result = mod.resolve_project_dir("sub")
    assert result == sub.resolve()


def test_missing_dir_exits(tmp_path: Path):
    """A non-existent path exits with code 1 + stderr message."""
    mod = _reload()
    missing = tmp_path / "does-not-exist"
    with pytest.raises(SystemExit) as exc_info:
        mod.resolve_project_dir(str(missing))
    assert exc_info.value.code == 1
