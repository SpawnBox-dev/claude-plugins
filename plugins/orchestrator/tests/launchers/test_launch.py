"""Tests for launch(): terminal-spawn abstraction.

We don't actually exec claude or wt.exe — we monkeypatch the spawn
functions and assert on their call arguments.
"""

import importlib
import shutil
import sys
from pathlib import Path

import pytest


def _reload():
    if "_launcher_common" in sys.modules:
        del sys.modules["_launcher_common"]
    return importlib.import_module("_launcher_common")


def test_launch_missing_claude_exits(project_dir: Path, monkeypatch):
    """When `claude` isn't on PATH, exit 127 with actionable message."""
    mod = _reload()
    monkeypatch.setattr(shutil, "which", lambda name: None)
    with pytest.raises(SystemExit) as exc_info:
        mod.launch(
            ["--name", "X"],
            project_dir=project_dir,
            tab_color=None,
            no_wt=False,
        )
    assert exc_info.value.code == 127


def test_launch_posix_execvp(project_dir: Path, monkeypatch):
    """On POSIX (or when no_wt=True), launch calls os.execvp('claude', ...)."""
    mod = _reload()
    monkeypatch.setattr(shutil, "which", lambda name: "/usr/bin/claude" if name == "claude" else None)
    captured = {}

    def fake_execvp(file, args):
        captured["file"] = file
        captured["args"] = args
        raise SystemExit(0)  # simulate exec succeeding (process replaced)

    monkeypatch.setattr("os.execvp", fake_execvp)
    monkeypatch.setattr("platform.system", lambda: "Linux")

    with pytest.raises(SystemExit) as exc_info:
        mod.launch(
            ["--name", "X"],
            project_dir=project_dir,
            tab_color="#F59E0B",
            no_wt=False,
        )
    assert exc_info.value.code == 0
    assert captured["file"] == "claude"
    assert captured["args"] == ["claude", "--name", "X"]


def test_launch_windows_with_wt(project_dir: Path, monkeypatch):
    """On Windows with wt.exe present, launch invokes
    `wt.exe -w new new-tab [--tabColor X] -d <dir> claude <argv>`."""
    mod = _reload()

    def which_stub(name):
        if name == "claude":
            return "C:/Program Files/claude.exe"
        if name == "wt.exe":
            return "C:/Users/x/AppData/Local/Microsoft/WindowsApps/wt.exe"
        return None

    monkeypatch.setattr(shutil, "which", which_stub)
    monkeypatch.setattr("platform.system", lambda: "Windows")

    captured = {}

    def fake_run(cmd, **kwargs):
        captured["cmd"] = cmd
        class R:
            returncode = 0
        return R()

    monkeypatch.setattr("subprocess.run", fake_run)

    rc = mod.launch(
        ["--name", "PA-X"],
        project_dir=project_dir,
        tab_color="#F59E0B",
        no_wt=False,
    )
    assert rc == 0
    cmd = captured["cmd"]
    assert cmd[0].endswith("wt.exe")
    assert "new-tab" in cmd
    assert "--tabColor" in cmd
    assert "#F59E0B" in cmd
    assert "-d" in cmd
    assert str(project_dir) in cmd
    assert "claude" in cmd
    assert "--name" in cmd
    assert "PA-X" in cmd


def test_launch_no_wt_flag_skips_wt(project_dir: Path, monkeypatch):
    """When no_wt=True on Windows, falls back to direct subprocess.run
    of claude (not wt.exe)."""
    mod = _reload()

    def which_stub(name):
        if name == "claude":
            return "C:/Program Files/claude.exe"
        if name == "wt.exe":
            return "C:/wt.exe"  # available but should NOT be used
        return None

    monkeypatch.setattr(shutil, "which", which_stub)
    monkeypatch.setattr("platform.system", lambda: "Windows")

    captured = {}

    def fake_run(cmd, **kwargs):
        captured["cmd"] = cmd
        class R:
            returncode = 0
        return R()

    monkeypatch.setattr("subprocess.run", fake_run)

    rc = mod.launch(
        ["--name", "X"],
        project_dir=project_dir,
        tab_color="#F59E0B",
        no_wt=True,
    )
    assert rc == 0
    assert "wt.exe" not in captured["cmd"][0]
    assert "claude" in captured["cmd"][0] or captured["cmd"][0].endswith("claude.exe")
