#!/usr/bin/env bash
# pa-start.sh — bash port of pa-start.ps1
#
# Launch the PrimeAgent (PA) Claude Code session for the current project.
# PA runs Opus at max effort with agent-channel attached. Singleton per project.
#
# Project-agnostic. Single source-of-truth lives in the orchestrator plugin
# at `plugins/orchestrator/skills/install-launchers/scripts/pa-start.sh`.
# Install per-project via `/orchestrator:install-launchers` from inside a
# Claude session.
#
# Usage:
#   ./pa-start.sh
#       Fresh PA session in the current directory, auto-named PA-YYYY-MM-DD-HH-MM-SS
#   ./pa-start.sh --resume <uuid-or-display-name>
#       Resume an existing session as PA. Display names resolved via JSONL grep.
#   ./pa-start.sh --project-dir /path/to/project
#       Run against a different project root than $PWD
#
# Requirements: bash 4+, jq, GNU coreutils (date -d, mktemp). Standard on
# WSL/Ubuntu. macOS users need `brew install coreutils jq` and may need to
# use `gdate`-aware shells.

set -euo pipefail

# ---------------------------------------------------------------------------
# Arg parsing
# ---------------------------------------------------------------------------

resume=""
project_dir=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --resume)
      resume="${2:?--resume requires a value}"
      shift 2
      ;;
    --project-dir)
      project_dir="${2:?--project-dir requires a value}"
      shift 2
      ;;
    -h|--help)
      sed -n '2,/^set -euo/p' "$0" | sed 's/^# \{0,1\}//; $d'
      exit 0
      ;;
    *)
      echo "ERROR: Unknown argument: $1" >&2
      echo "Usage: $0 [--resume <uuid-or-name>] [--project-dir <path>]" >&2
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
  # Match Claude Code's project-dir -> hash transform. POSIX paths only contain
  # `/` separators (no `\` or `:`), so the transform reduces to s|/|-|g plus a
  # leading-dash trim. CC does NOT collapse consecutive dashes.
  project_hash="${project_dir//\//-}"
  project_hash="${project_hash#"${project_hash%%[!-]*}"}"  # strip leading dashes

  jsonl_dir="$HOME/.claude/projects/$project_hash"
  if [[ ! -d "$jsonl_dir" ]]; then
    echo "ERROR: Projects dir not found: $jsonl_dir" >&2
    exit 1
  fi

  # Find newest JSONL containing "Session renamed to: <name>".
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
# Singleton awareness - auto-supersede existing PA if any.
#
# Pre-emptively demote any role=prime entry to subordinate in sessions.json.
# In the normal "user closed old window and is relaunching" flow, the old
# MCP is already dead and the demotion sticks. If the old MCP is still
# alive, its heartbeat will overwrite back to role=prime briefly until the
# user runs /pa-takeover or closes the older window.
# ---------------------------------------------------------------------------

state_file="$project_dir/.orchestrator-state/agent-channel/sessions.json"
if [[ -f "$state_file" ]]; then
  now_epoch="$(date -u +%s)"
  cutoff=$((now_epoch - 90))

  # `fromdateiso8601` rejects fractional seconds — strip `.NNN` before `Z`.
  fresh_pa_json="$(jq --argjson cutoff "$cutoff" '
    [ .sessions[]?
      | select(.role == "prime")
      | select(((.last_heartbeat_at | sub("\\.[0-9]+Z$"; "Z") | fromdateiso8601) // 0) > $cutoff)
    ]
  ' "$state_file" 2>/dev/null || echo "[]")"

  fresh_pa_count="$(echo "$fresh_pa_json" | jq 'length')"

  if [[ "$fresh_pa_count" -gt 0 ]]; then
    echo
    echo " Existing PrimeAgent detected - auto-superseding:"
    echo "$fresh_pa_json" | jq -r '.[] | "   * \(.session_id) (\(.name // "unnamed"))"'

    tmp="$(mktemp)"
    jq '(.sessions[]? | select(.role == "prime") | .role) = "subordinate"' \
      "$state_file" > "$tmp"
    mv "$tmp" "$state_file"

    echo " (Existing PA(s) demoted. New PA will register as prime.)"
    echo " (Press Ctrl+C in the next ~2s to cancel.)"
    echo
    sleep 2
  fi
fi

# ---------------------------------------------------------------------------
# Naming policy
# ---------------------------------------------------------------------------

session_name=""
if [[ -z "$resume" ]]; then
  session_name="PA-$(date '+%Y-%m-%d-%H-%M-%S')"
fi

# ---------------------------------------------------------------------------
# Env vars (inherited by child `claude` -> MCP server)
# ---------------------------------------------------------------------------

# Bump MCP startup timeout from the 5s default to 30s. The orchestrator
# MCP server's `npx -y bun` cold-start can exceed 5s on first invocation.
export MCP_TIMEOUT=30000

# Tell the MCP which project root we're operating in.
export ORCHESTRATOR_PROJECT_ROOT="$project_dir"

# Canonical role env. SPAWNBOX_ prefix kept for backwards compatibility.
export ORCHESTRATOR_AGENT_ROLE=prime
export SPAWNBOX_AGENT_ROLE=prime

# Opt into the PA-gated permission relay (0.30.17+). When set, SA permission
# requests route through agent-channel to PA for authorization instead of
# falling back to in-terminal prompts. PA needs the `respond_to_permission`
# tool registered, which is gated on this env var.
export ORCHESTRATOR_PA_PERMISSION_RELAY=1

# Only set the NAME env when we have an explicit name. On --resume without an
# explicit name, leave NAME unset so the resumed session's existing
# /rename-set name is preserved.
if [[ -n "$session_name" ]]; then
  export ORCHESTRATOR_AGENT_NAME="$session_name"
  export SPAWNBOX_AGENT_NAME="$session_name"
fi

# ---------------------------------------------------------------------------
# Build claude args
# ---------------------------------------------------------------------------

# The marketplace slug below is substituted by the
# /orchestrator:install-launchers skill at copy-into-project time. If you see
# the literal `__ORCH_MARKETPLACE__` below, re-run /orchestrator:install-launchers.
#
# 0.30.28+: PA always launches at max effort. PA is the singleton
# orchestration session - judgment calls, cross-cutting coordination, holding
# the macro view. Token cost is the right tradeoff for the role.
claude_args=(
  --dangerously-load-development-channels
  "plugin:orchestrator@__ORCH_MARKETPLACE__"
  --effort max
)
if [[ -n "$session_name" ]]; then
  claude_args+=(--name "$session_name")
fi
if [[ -n "$resume" ]]; then
  claude_args+=(--resume "$resume")
fi

# ---------------------------------------------------------------------------
# Launch
# ---------------------------------------------------------------------------

cd "$project_dir"
exec claude "${claude_args[@]}"
