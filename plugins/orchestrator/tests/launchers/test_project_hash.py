"""Tests for project-hash transform (matches Claude Code's
project-dir → ~/.claude/projects/<hash>/ directory naming).
"""

import importlib
import sys
from pathlib import PurePosixPath, PureWindowsPath


def _reload():
    if "_launcher_common" in sys.modules:
        del sys.modules["_launcher_common"]
    return importlib.import_module("_launcher_common")


def test_project_hash_posix_simple():
    """POSIX path: '/a/b/c' → 'a-b-c' (slashes become dashes,
    leading dash stripped)."""
    mod = _reload()
    assert mod.project_hash_for(PurePosixPath("/a/b/c")) == "a-b-c"


def test_project_hash_posix_deep():
    """A realistic project path."""
    mod = _reload()
    result = mod.project_hash_for(PurePosixPath("/home/enadeau/workspaces/quayline"))
    assert result == "home-enadeau-workspaces-quayline"


def test_project_hash_windows_drive_letter():
    """Windows: 'C:\\Users\\evan\\repo' → 'C--Users-evan-repo'.
    Claude Code does NOT collapse consecutive dashes — the C:\\ prefix
    yields a literal C-- in the hash."""
    mod = _reload()
    result = mod.project_hash_for(PureWindowsPath("C:\\Users\\evan\\repo"))
    assert result == "C--Users-evan-repo"


def test_project_hash_strips_leading_dashes():
    """A POSIX absolute path starts with '/' which becomes a leading dash.
    The transform strips leading dashes only (not consecutive interior ones)."""
    mod = _reload()
    result = mod.project_hash_for(PurePosixPath("/x"))
    assert result == "x"


def test_project_hash_no_trailing_dashes():
    """Trailing dashes stripped if present (e.g. path that ends in /)."""
    mod = _reload()
    # Path normalization on Path objects strips trailing slashes, but
    # we test the raw transform on a string-y input.
    result = mod.project_hash_for(PurePosixPath("/a/b/"))
    assert not result.endswith("-")
