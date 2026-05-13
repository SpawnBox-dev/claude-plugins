#!/usr/bin/env bash
# Thin wrapper for pa_start.py. Locates a Python 3.10+ interpreter and
# execs the canonical Python launcher. See pa_start.py for documentation
# and supported CLI flags.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PYTHON="${ORCH_PYTHON:-python3}"

if ! command -v "$PYTHON" >/dev/null 2>&1; then
  echo "ERROR: '$PYTHON' not found on PATH." >&2
  echo "Install Python 3.10+ (apt install python3, brew install python@3.12," >&2
  echo "or set \$ORCH_PYTHON to a working interpreter)." >&2
  exit 127
fi

exec "$PYTHON" "$SCRIPT_DIR/pa_start.py" "$@"
