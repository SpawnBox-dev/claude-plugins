#!/usr/bin/env bash
# Shared helpers for orchestrator hooks. Source this, do not execute.
# All orchestrator hooks use these helpers so state management,
# JSON escaping, and session parsing stay consistent.

escape_for_json() {
    local s="$1"
    s="${s//\\/\\\\}"
    s="${s//\"/\\\"}"
    s="${s//$'\n'/\\n}"
    s="${s//$'\r'/\\r}"
    s="${s//$'\t'/\\t}"
    printf '%s' "$s"
}

# Returns a per-project state directory. Prefers CLAUDE_PROJECT_DIR so state
# is scoped to the project the session is attached to; falls back to the OS
# temp dir for environments where CLAUDE_PROJECT_DIR is not set. Works under
# Git Bash on Windows where /tmp is often missing or empty.
get_state_dir() {
    local base
    if [ -n "${CLAUDE_PROJECT_DIR:-}" ]; then
        base="$CLAUDE_PROJECT_DIR/.orchestrator-state"
    elif [ -n "${TMPDIR:-}" ]; then
        base="$TMPDIR/orchestrator-state"
    elif [ -n "${TEMP:-}" ]; then
        base="$TEMP/orchestrator-state"
    else
        base="/tmp/orchestrator-state"
    fi
    mkdir -p "$base" 2>/dev/null || true
    # Drop a .gitignore so the state dir never shows up in the user's
    # git status. Overwrites are cheap and make this self-healing.
    if [ -d "$base" ] && [ ! -f "$base/.gitignore" ]; then
        printf '*\n' > "$base/.gitignore" 2>/dev/null || true
    fi
    printf '%s' "$base"
}

# Extract session_id from the hook's stdin JSON. Usage: SID=$(get_session_id "$INPUT")
get_session_id() {
    local input="$1"
    local sid
    sid=$(printf '%s' "$input" | grep -o '"session_id":"[^"]*"' | head -1 | cut -d'"' -f4)
    printf '%s' "${sid:-unknown}"
}

# Extract a top-level string field from the hook's stdin JSON (simple cases only).
# Usage: TOOL=$(get_field "$INPUT" tool_name)
get_field() {
    local input="$1"
    local field="$2"
    printf '%s' "$input" | grep -o "\"${field}\":\"[^\"]*\"" | head -1 | cut -d'"' -f4
}
