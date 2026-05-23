#!/usr/bin/env bash
# Thin wrapper for discord_start.py. See discord_start.py for documentation.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PYTHON="${ORCH_PYTHON:-python3}"

if ! command -v "$PYTHON" >/dev/null 2>&1; then
  echo "ERROR: '$PYTHON' not found on PATH." >&2
  echo "Install Python 3.10+ (apt install python3, brew install python@3.12," >&2
  echo "or set \$ORCH_PYTHON to a working interpreter)." >&2
  exit 127
fi

exec "$PYTHON" "$SCRIPT_DIR/discord_start.py" "$@"
