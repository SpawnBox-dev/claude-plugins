#!/usr/bin/env bash
# sa-start.sh — bash port of sa-start.ps1
#
# Launch a Subordinate Agent (SA) Claude Code session participating in
# the orchestrator's agent-channel.
#
# Project-agnostic. Single source-of-truth lives in the orchestrator plugin
# at `plugins/orchestrator/skills/install-launchers/scripts/sa-start.sh`.
# Install per-project via `/orchestrator:install-launchers`.
#
# Usage:
#   ./sa-start.sh
#       Fresh session in current dir, auto-named SA-YYYY-MM-DD-HH-MM-SS
#   ./sa-start.sh --name SA-frontend
#       Fresh session with explicit name
#   ./sa-start.sh --resume <uuid-or-display-name>
#       Resume an existing session
#   ./sa-start.sh --name SA-architecture --effort max
#       Fresh session at max effort for heavy reasoning
#
# Requirements: bash 4+. (jq + GNU coreutils only needed by pa-start.sh's
# singleton check; SA has no such logic, so SA's runtime deps are minimal.)

set -euo pipefail

# ---------------------------------------------------------------------------
# Arg parsing
# ---------------------------------------------------------------------------

resume=""
name=""
project_dir=""
effort=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --resume)
      resume="${2:?--resume requires a value}"
      shift 2
      ;;
    --name)
      name="${2:?--name requires a value}"
      shift 2
      ;;
    --project-dir)
      project_dir="${2:?--project-dir requires a value}"
      shift 2
      ;;
    --effort)
      effort="${2:?--effort requires a value}"
      case "$effort" in
        low|medium|high|xhigh|max) ;;
        *)
          echo "ERROR: --effort must be one of: low, medium, high, xhigh, max" >&2
          exit 2
          ;;
      esac
      shift 2
      ;;
    -h|--help)
      sed -n '2,/^set -euo/p' "$0" | sed 's/^# \{0,1\}//; $d'
      exit 0
      ;;
    *)
      echo "ERROR: Unknown argument: $1" >&2
      echo "Usage: $0 [--name <name>] [--resume <uuid-or-name>] [--effort <level>] [--project-dir <path>]" >&2
      exit 2
      ;;
  esac
done

if [[ -z "$project_dir" ]]; then
  project_dir="$PWD"
fi
project_dir="$(cd "$project_dir" && pwd)"

# ---------------------------------------------------------------------------
# Resolve display name -> UUID if needed
# ---------------------------------------------------------------------------

uuid_re='^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'

if [[ -n "$resume" && ! "$resume" =~ $uuid_re ]]; then
  project_hash="${project_dir//\//-}"
  project_hash="${project_hash#"${project_hash%%[!-]*}"}"

  jsonl_dir="$HOME/.claude/projects/$project_hash"
  if [[ ! -d "$jsonl_dir" ]]; then
    echo "ERROR: Projects dir not found: $jsonl_dir" >&2
    exit 1
  fi

  resolved_uuid=""
  while IFS= read -r f; do
    if grep -qF "Session renamed to: $resume" "$f"; then
      resolved_uuid="$(basename "$f" .jsonl)"
      break
    fi
  done < <(ls -t "$jsonl_dir"/*.jsonl 2>/dev/null)

  if [[ -z "$resolved_uuid" ]]; then
    echo "ERROR: No session in $jsonl_dir has been renamed to: $resume" >&2
    exit 1
  fi
  echo " Resolved display name to session: $resolved_uuid"
  resume="$resolved_uuid"
fi

# ---------------------------------------------------------------------------
# Naming policy
#   --resume given  -> let claude use the resumed session's name
#   --name given    -> use that name
#   neither         -> auto-generate SA-YYYY-MM-DD-HH-MM-SS
# ---------------------------------------------------------------------------

session_name=""
if [[ -n "$name" ]]; then
  session_name="$name"
elif [[ -z "$resume" ]]; then
  session_name="SA-$(date '+%Y-%m-%d-%H-%M-%S')"
fi

# ---------------------------------------------------------------------------
# Env vars
# ---------------------------------------------------------------------------

export MCP_TIMEOUT=30000
export ORCHESTRATOR_PROJECT_ROOT="$project_dir"

# Canonical role env. SPAWNBOX_ prefix kept for backwards compatibility.
export ORCHESTRATOR_AGENT_ROLE=subordinate
export SPAWNBOX_AGENT_ROLE=subordinate

# Opt into the PA-gated permission relay (0.30.17+). When set, this SA's MCP
# declares the `claude/channel/permission` capability so tool permission
# requests route through agent-channel to PA for authorization instead of
# falling back to in-terminal prompts.
export ORCHESTRATOR_PA_PERMISSION_RELAY=1

if [[ -n "$session_name" ]]; then
  export ORCHESTRATOR_AGENT_NAME="$session_name"
  export SPAWNBOX_AGENT_NAME="$session_name"
fi

# ---------------------------------------------------------------------------
# Build claude args
# ---------------------------------------------------------------------------

# Marketplace slug substituted by /orchestrator:install-launchers at copy time.
# If you see the literal `__ORCH_MARKETPLACE__` below, re-run the install skill.
claude_args=(
  --dangerously-load-development-channels
  "plugin:orchestrator@__ORCH_MARKETPLACE__"
)
if [[ -n "$session_name" ]]; then
  claude_args+=(--name "$session_name")
fi
# 0.30.28+: optional reasoning-effort override. Only emitted when --effort is
# explicitly set; otherwise Claude Code uses its session default.
if [[ -n "$effort" ]]; then
  claude_args+=(--effort "$effort")
fi
if [[ -n "$resume" ]]; then
  claude_args+=(--resume "$resume")
fi

# ---------------------------------------------------------------------------
# Launch
# ---------------------------------------------------------------------------

cd "$project_dir"
exec claude "${claude_args[@]}"
