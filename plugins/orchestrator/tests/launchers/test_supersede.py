"""Tests for supersede_existing_pa: pre-emptively demote any role=prime
entries with fresh heartbeats."""

import importlib
import json
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest


def _reload():
    if "_launcher_common" in sys.modules:
        del sys.modules["_launcher_common"]
    return importlib.import_module("_launcher_common")


def _iso(dt: datetime) -> str:
    return dt.isoformat()


def test_no_state_file_is_noop(project_dir: Path):
    """When sessions.json doesn't exist, supersede is a no-op (returns None,
    doesn't raise)."""
    mod = _reload()
    # Deliberately do not create sessions.json.
    mod.supersede_existing_pa(project_dir)
    # No assertion needed — just check it doesn't raise.


def test_no_prime_sessions_no_changes(project_dir: Path, sessions_file: Path):
    """A sessions.json with only subordinates is left unchanged."""
    mod = _reload()
    state = {
        "sessions": [
            {"role": "subordinate", "session_id": "abc", "last_heartbeat_at": _iso(datetime.now(timezone.utc))},
        ]
    }
    sessions_file.write_text(json.dumps(state))
    mod.supersede_existing_pa(project_dir)
    after = json.loads(sessions_file.read_text())
    assert after == state


def test_stale_prime_not_demoted(project_dir: Path, sessions_file: Path):
    """A role=prime entry with last_heartbeat older than 90 seconds is left
    alone (already dead, no need to demote)."""
    mod = _reload()
    stale_heartbeat = datetime.now(timezone.utc) - timedelta(seconds=120)
    state = {
        "sessions": [
            {"role": "prime", "session_id": "stale", "last_heartbeat_at": _iso(stale_heartbeat)},
        ]
    }
    sessions_file.write_text(json.dumps(state))
    mod.supersede_existing_pa(project_dir)
    after = json.loads(sessions_file.read_text())
    assert after["sessions"][0]["role"] == "prime"  # unchanged


def test_fresh_prime_demoted_to_subordinate(project_dir: Path, sessions_file: Path, monkeypatch):
    """A role=prime entry with a fresh heartbeat (<90s) is demoted.
    Patch out the 2-second sleep so the test runs fast."""
    mod = _reload()
    monkeypatch.setattr("time.sleep", lambda _: None)
    fresh_heartbeat = datetime.now(timezone.utc) - timedelta(seconds=10)
    state = {
        "sessions": [
            {"role": "prime", "session_id": "fresh", "name": "PA-old",
             "last_heartbeat_at": _iso(fresh_heartbeat)},
        ]
    }
    sessions_file.write_text(json.dumps(state))
    mod.supersede_existing_pa(project_dir)
    after = json.loads(sessions_file.read_text())
    assert after["sessions"][0]["role"] == "subordinate"


def test_parse_failure_is_warning_not_fatal(project_dir: Path, sessions_file: Path, capsys):
    """Corrupt JSON → warning to stderr, function returns normally
    (treated as no-PA)."""
    mod = _reload()
    sessions_file.write_text("not valid json {{{")
    mod.supersede_existing_pa(project_dir)  # should not raise
    captured = capsys.readouterr()
    assert "WARNING" in captured.err
    assert str(sessions_file) in captured.err


def test_write_failure_is_fatal(project_dir: Path, sessions_file: Path, monkeypatch):
    """If the sessions.json write fails after a demotion was decided,
    the function exits 1 — silent write failure leaves two primes."""
    mod = _reload()
    monkeypatch.setattr("time.sleep", lambda _: None)
    fresh_heartbeat = datetime.now(timezone.utc) - timedelta(seconds=10)
    state = {
        "sessions": [
            {"role": "prime", "session_id": "fresh",
             "last_heartbeat_at": _iso(fresh_heartbeat)},
        ]
    }
    sessions_file.write_text(json.dumps(state))

    real_write_text = Path.write_text

    def fake_write_text(self: Path, *args, **kwargs):
        if self == sessions_file:
            raise PermissionError("simulated write failure")
        return real_write_text(self, *args, **kwargs)

    monkeypatch.setattr(Path, "write_text", fake_write_text)

    with pytest.raises(SystemExit) as exc_info:
        mod.supersede_existing_pa(project_dir)
    assert exc_info.value.code == 1
