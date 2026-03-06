#!/usr/bin/env bash
# Start MCP server, auto-installing deps if missing
set -e

DIR="$(cd "$(dirname "$0")/.." && pwd)"

BUN="${HOME}/.bun/bin/bun"
if [ ! -f "$BUN" ]; then
  BUN="$(which bun 2>/dev/null || true)"
fi
if [ -z "$BUN" ]; then
  echo "Error: bun not found" >&2
  exit 1
fi

# Install deps if node_modules missing
if [ ! -d "$DIR/node_modules" ]; then
  "$BUN" install --cwd "$DIR" >&2 2>&1
fi

exec "$BUN" run "$DIR/mcp/server.ts"
