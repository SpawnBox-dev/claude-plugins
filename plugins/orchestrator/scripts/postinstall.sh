#!/usr/bin/env bash
# Post-install: install dependencies so the MCP server can start
set -e

cd "$(dirname "$0")/.."

# Find bun
BUN="${HOME}/.bun/bin/bun"
if [ ! -f "$BUN" ]; then
  BUN="$(which bun 2>/dev/null || true)"
fi

if [ -z "$BUN" ]; then
  echo "Error: bun not found. Install bun first: https://bun.sh" >&2
  exit 1
fi

"$BUN" install --frozen-lockfile 2>/dev/null || "$BUN" install
