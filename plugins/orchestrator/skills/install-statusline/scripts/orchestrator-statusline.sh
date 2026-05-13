#!/usr/bin/env bash
# Thin wrapper for orchestrator_statusline.py.
# Locates a Python 3.10+ interpreter (honoring $ORCH_PYTHON override)
# and execs the canonical Python statusline renderer.
#
# Designed to be wired into Claude Code's `statusLine` setting:
#
#   "statusLine": {
#     "type": "command",
#     "command": "/abs/path/to/orchestrator-statusline.sh"
#   }

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PYTHON="${ORCH_PYTHON:-python3}"

if ! command -v "$PYTHON" >/dev/null 2>&1; then
  # Don't break the Claude UI if Python is missing; emit a fallback line.
  echo "orchestrator (python missing)"
  exit 0
fi

exec "$PYTHON" "$SCRIPT_DIR/orchestrator_statusline.py"
