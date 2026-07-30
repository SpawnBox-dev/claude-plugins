#!/usr/bin/env python3
"""Take a WAL-safe, point-in-time snapshot of an orchestrator plugin SQLite DB.

The orchestrator plugin uses TWO local SQLite databases:

    ~/.claude/orchestrator/global.db          (cross-project)
    <project>/.orchestrator/project.db        (per-project)

Run this script once per DB you want backed up - one invocation snapshots
one source file via SQLite's online backup API. Default --source is the
global DB. Override with --source <path> to snapshot a project DB.

The snapshot lands at:

    <cloud-root>/<hostname>/<source-stem>-YYYY-MM-DD.db

where <source-stem> is the source filename without extension (e.g.
"global" or "project"). This keeps separate-DB snapshots from colliding
when they share a destination directory.

The destination is entirely the user's choice. No defaults are inferred.
The script hard-fails unless --cloud-root is given or
$CLAUDE_ORCHESTRATOR_BACKUP_ROOT is set in the environment. Typical
destinations are a cloud-sync folder (OneDrive, Dropbox, Google Drive,
iCloud, Syncthing) or a path on backed-up local storage. See SKILL.md.

WAL-safety: a naive file copy of the live DB risks copying the main file
while transactions still live in the -wal sidecar (the plugin keeps a
multi-megabyte WAL during normal operation). The online backup API
iterates pages under SQLite's own locking, so concurrent writes from the
running orchestrator MCP server are safe.

The snapshot is written to a tempfile in the destination directory, then
atomically renamed into place. This prevents cloud-sync clients from
picking up a partial write, and prevents same-day catch-up runs from
corrupting an existing valid snapshot mid-write.

Retention: --retain-days N (optional) deletes snapshots in the same
destination directory matching the same source-stem pattern that are
older than N days. Files that do not match the exact pattern are never
touched. Omit --retain-days to keep all snapshots forever.

Exit non-zero on any failure (useful for systemd OnFailure= and Windows
Task Scheduler's "if the task fails" handlers).
"""

from __future__ import annotations

import argparse
import datetime
import os
import re
import socket
import sqlite3
import sys
from pathlib import Path


DEFAULT_SOURCE = Path.home() / ".claude" / "orchestrator" / "global.db"
ENV_CLOUD_ROOT = "CLAUDE_ORCHESTRATOR_BACKUP_ROOT"


def resolve_cloud_root(override: Path | None) -> Path:
    """Pick the destination root from --cloud-root, env, or fail explicitly."""
    if override is not None:
        root = override
    else:
        env_val = os.environ.get(ENV_CLOUD_ROOT)
        if not env_val:
            raise SystemExit(
                f"no backup destination configured. "
                f"Pass --cloud-root <path> or set ${ENV_CLOUD_ROOT}."
            )
        root = Path(env_val)
    if not root.is_dir():
        raise SystemExit(
            f"cloud root not found or not a directory: {root}. "
            f"Create it first (or fix ${ENV_CLOUD_ROOT})."
        )
    return root


def build_dest_path(
    cloud_root: Path,
    hostname: str | None,
    source_stem: str,
    date: datetime.date,
) -> Path:
    """Compose the snapshot destination path under cloud_root."""
    filename = f"{source_stem}-{date.isoformat()}.db"
    if hostname:
        return cloud_root / hostname / filename
    return cloud_root / filename


def _assert_dest_outside_source(source: Path, dest: Path) -> None:
    """Refuse to write the snapshot inside the source DB's own directory.

    Catches the footgun of pointing --cloud-root at ~/.claude/orchestrator (or
    a parent of it) - the snapshot would land next to the live DB and could
    be picked up as a competing SQLite file by the running MCP server.
    """
    src_dir = source.resolve().parent
    dest_dir = dest.resolve().parent
    try:
        dest_dir.relative_to(src_dir)
    except ValueError:
        return  # dest_dir is NOT under src_dir, which is what we want
    raise SystemExit(
        f"refusing to write snapshot inside the source DB's directory: "
        f"{dest_dir} is under {src_dir}. "
        f"Pick a destination outside the source DB's directory."
    )


def snapshot(source: Path, dest: Path) -> None:
    """Write a WAL-safe, atomic point-in-time copy of source to dest."""
    if not source.is_file():
        raise SystemExit(f"source DB not found: {source}")
    _assert_dest_outside_source(source, dest)
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_name(f"{dest.name}.tmp.{os.getpid()}")
    src = sqlite3.connect(f"file:{source}?mode=ro", uri=True)
    try:
        dst = sqlite3.connect(tmp)
        try:
            src.backup(dst)
        finally:
            dst.close()
    finally:
        src.close()
    os.replace(tmp, dest)


def prune_old(dest_dir: Path, source_stem: str, retain_days: int, today: datetime.date) -> list[Path]:
    """Delete snapshots in dest_dir matching <stem>-YYYY-MM-DD.db older than retain_days.

    Returns the list of files deleted. Files that do not match the exact
    pattern are never touched. retain_days must be >= 1.
    """
    if retain_days < 1:
        raise SystemExit(f"--retain-days must be >= 1, got {retain_days}")
    pattern = re.compile(rf"^{re.escape(source_stem)}-(\d{{4}}-\d{{2}}-\d{{2}})\.db$")
    cutoff = today - datetime.timedelta(days=retain_days)
    deleted: list[Path] = []
    if not dest_dir.is_dir():
        return deleted
    for entry in dest_dir.iterdir():
        if not entry.is_file():
            continue
        m = pattern.match(entry.name)
        if not m:
            continue
        try:
            file_date = datetime.date.fromisoformat(m.group(1))
        except ValueError:
            continue
        if file_date < cutoff:
            entry.unlink()
            deleted.append(entry)
    return deleted


def main(argv: list[str] | None = None) -> int:
    """Parse args, take the snapshot, optionally prune older snapshots."""
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument(
        "--source",
        type=Path,
        default=DEFAULT_SOURCE,
        help=f"source DB path (default: {DEFAULT_SOURCE})",
    )
    p.add_argument(
        "--cloud-root",
        type=Path,
        default=None,
        help=(
            f"destination root directory. Required unless ${ENV_CLOUD_ROOT} is set. "
            "No default; pick whatever path you want snapshots written to "
            "(typically a cloud-sync folder or backed-up local path)."
        ),
    )
    p.add_argument(
        "--hostname",
        default=socket.gethostname(),
        help="hostname segment for the destination subdir (default: this machine's hostname)",
    )
    p.add_argument(
        "--flat",
        action="store_true",
        help="omit the <hostname>/ subdir; write directly under --cloud-root",
    )
    p.add_argument(
        "--date",
        type=datetime.date.fromisoformat,
        default=None,
        help="override date for the filename (default: today, local TZ)",
    )
    p.add_argument(
        "--retain-days",
        type=int,
        default=None,
        help=(
            "after writing the snapshot, delete snapshots for this same source "
            "older than N days. Only files matching <stem>-YYYY-MM-DD.db in the "
            "destination directory are eligible. Omit to keep all snapshots forever."
        ),
    )
    args = p.parse_args(argv)

    cloud_root = resolve_cloud_root(args.cloud_root)
    date = args.date if args.date else datetime.date.today()
    hostname = None if args.flat else args.hostname
    source_stem = args.source.stem
    dest = build_dest_path(cloud_root, hostname, source_stem, date)

    print(f"[snapshot-plugin-db] source: {args.source}")
    print(f"[snapshot-plugin-db] dest:   {dest}")
    snapshot(args.source, dest)
    size = dest.stat().st_size
    print(f"[snapshot-plugin-db] wrote {size:,} bytes")

    if args.retain_days is not None:
        deleted = prune_old(dest.parent, source_stem, args.retain_days, date)
        if deleted:
            print(f"[snapshot-plugin-db] pruned {len(deleted)} snapshot(s) older than {args.retain_days} days:")
            for path in deleted:
                print(f"  - {path.name}")
        else:
            print(f"[snapshot-plugin-db] retention: nothing to prune (keep-days={args.retain_days})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
