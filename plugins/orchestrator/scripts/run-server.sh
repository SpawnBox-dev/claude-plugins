#!/usr/bin/env bash
# Finds bun and runs the MCP server
SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

if command -v bun &>/dev/null; then
  exec bun run "$SCRIPT_DIR/mcp/server.ts"
elif [ -x "$HOME/.bun/bin/bun" ]; then
  exec "$HOME/.bun/bin/bun" run "$SCRIPT_DIR/mcp/server.ts"
else
  echo "Error: bun not found" >&2
  exit 1
fi
