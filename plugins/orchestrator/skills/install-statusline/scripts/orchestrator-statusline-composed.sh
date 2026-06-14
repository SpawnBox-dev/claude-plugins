#!/usr/bin/env bash
# Composed statusline: orchestrator role indicator + user's personal statusline.
#
# Wraps the user's existing statusline (typically at ~/.claude/statusline.sh)
# so the orchestrator role indicator appears ABOVE the user's content, without
# replacing or modifying the user's script.
#
# Output lines:
#   line 1: orchestrator role indicator (env-var driven via orchestrator-statusline.sh)
#   line 2+: user's personal statusline (reads JSON from stdin)
#
# Wired into Claude Code's `statusLine` setting in .claude/settings.json by
# the /orchestrator:install-statusline skill (AUTO-COMPOSE option). Removing
# this file and pointing statusLine back at the user's script reverts to the
# original personal statusline; removing the statusLine block entirely reverts
# to user-level default. Either operation is non-destructive of the user's
# ~/.claude/statusline.sh.
#
# To point at a user statusline located somewhere other than the default
# ~/.claude/statusline.sh, edit the USER_STATUSLINE assignment below.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
USER_STATUSLINE="${HOME}/.claude/statusline.sh"

# Claude Code pipes session JSON to stdin on each refresh. Capture it once so we
# can fan out to both downstream renderers without consuming stdin twice (the
# orchestrator renderer ignores stdin, but the user's renderer typically reads
# it).
JSON=""
if [ ! -t 0 ]; then
  JSON="$(cat)"
fi

# Line 1: orchestrator role indicator. Pure env-var driven, ignores stdin.
"${SCRIPT_DIR}/orchestrator-statusline.sh" || true

# Lines 2+: user's personal statusline. Re-feeds the captured JSON via stdin.
if [ -f "${USER_STATUSLINE}" ] || [ -L "${USER_STATUSLINE}" ]; then
  printf '%s' "${JSON}" | bash "${USER_STATUSLINE}" || true
fi

exit 0
