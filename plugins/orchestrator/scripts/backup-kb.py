"""Take a consistent SQLite snapshot while another host continues using WAL."""
import argparse
import json
import sqlite3
from pathlib import Path

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("source", type=Path)
parser.add_argument("destination", type=Path)
args = parser.parse_args()
source, destination = args.source.resolve(strict=True), args.destination.resolve()
if destination.exists():
    raise SystemExit("Destination already exists; choose a new snapshot path")
destination.parent.mkdir(parents=True, exist_ok=True)
with sqlite3.connect(source.as_uri() + "?mode=ro", uri=True, timeout=30) as original:
    with sqlite3.connect(destination) as snapshot:
        original.backup(snapshot, pages=512, sleep=0.02)
        check = snapshot.execute("PRAGMA quick_check").fetchone()[0]
        if check != "ok":
            raise SystemExit("Snapshot validation failed: " + check)
print(json.dumps({"snapshot": str(destination), "bytes": destination.stat().st_size, "quick_check": check}))
