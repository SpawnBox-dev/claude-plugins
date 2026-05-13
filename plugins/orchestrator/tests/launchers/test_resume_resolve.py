"""Tests for resolve_resume_target: UUID passthrough + display-name → UUID
resolution via JSONL grep."""

import importlib
import sys
import time
from pathlib import Path

import pytest


def _reload():
    if "_launcher_common" in sys.modules:
        del sys.modules["_launcher_common"]
    return importlib.import_module("_launcher_common")


def test_uuid_passes_through(fake_projects_dir: Path, project_dir: Path):
    """A canonical UUID is returned unchanged, no JSONL grep performed."""
    mod = _reload()
    uuid_str = "abcdef01-2345-6789-abcd-ef0123456789"
    result = mod.resolve_resume_target(uuid_str, project_dir)
    assert result == uuid_str


def test_display_name_resolved_to_uuid(fake_projects_dir: Path, project_dir: Path):
    """A display name is looked up across the project's JSONLs and resolved
    to the UUID of the JSONL whose content contains
    'Session renamed to: <name>'."""
    mod = _reload()
    project_hash = mod.project_hash_for(project_dir)
    jsonl_dir = fake_projects_dir / project_hash
    jsonl_dir.mkdir(parents=True)
    target_uuid = "deadbeef-1111-2222-3333-444455556666"
    (jsonl_dir / f"{target_uuid}.jsonl").write_text(
        '{"event": "Session renamed to: MyAgent"}\n'
    )
    # Decoy JSONL — no rename event.
    (jsonl_dir / "00000000-aaaa-bbbb-cccc-dddddddddddd.jsonl").write_text(
        '{"event": "unrelated"}\n'
    )
    result = mod.resolve_resume_target("MyAgent", project_dir)
    assert result == target_uuid


def test_display_name_picks_newest_when_multiple(
    fake_projects_dir: Path, project_dir: Path
):
    """If multiple JSONLs have been renamed to the same name, the newest
    by mtime wins."""
    mod = _reload()
    project_hash = mod.project_hash_for(project_dir)
    jsonl_dir = fake_projects_dir / project_hash
    jsonl_dir.mkdir(parents=True)

    older_uuid = "11111111-1111-1111-1111-111111111111"
    newer_uuid = "22222222-2222-2222-2222-222222222222"

    (jsonl_dir / f"{older_uuid}.jsonl").write_text(
        '{"event": "Session renamed to: Duplicate"}\n'
    )
    time.sleep(0.05)
    (jsonl_dir / f"{newer_uuid}.jsonl").write_text(
        '{"event": "Session renamed to: Duplicate"}\n'
    )

    result = mod.resolve_resume_target("Duplicate", project_dir)
    assert result == newer_uuid


def test_display_name_no_match_exits(fake_projects_dir: Path, project_dir: Path):
    """No matching JSONL → exit 1 with message naming the dir + name."""
    mod = _reload()
    project_hash = mod.project_hash_for(project_dir)
    jsonl_dir = fake_projects_dir / project_hash
    jsonl_dir.mkdir(parents=True)
    (jsonl_dir / "11111111-1111-1111-1111-111111111111.jsonl").write_text(
        '{"event": "Session renamed to: Other"}\n'
    )
    with pytest.raises(SystemExit) as exc_info:
        mod.resolve_resume_target("Missing", project_dir)
    assert exc_info.value.code == 1


def test_projects_dir_missing_exits(fake_projects_dir: Path, project_dir: Path):
    """No <hash> dir under ~/.claude/projects/ → exit 1."""
    mod = _reload()
    # Deliberately do NOT create the hash dir.
    with pytest.raises(SystemExit) as exc_info:
        mod.resolve_resume_target("MyAgent", project_dir)
    assert exc_info.value.code == 1
