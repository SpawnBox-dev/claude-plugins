#!/usr/bin/env bash
#
# Install a nightly snapshot timer for an orchestrator plugin SQLite DB.
#
# Detects systemd-user; falls back to cron if unavailable. Idempotent on
# --name: re-running with the same name replaces the prior install.
#
# Run this helper once per DB you want backed up. The plugin uses two DBs:
#   1. ~/.claude/orchestrator/global.db          (default --source)
#   2. <project>/.orchestrator/project.db        (pass --source explicitly)
# Give each install a distinct --name so they don't replace each other.
#
# Usage:
#   ./install-snapshot-timer.sh --cloud-root /path/to/destination
#                                [--source /path/to/db]
#                                [--time HH:MM]
#                                [--name <slug>]
#                                [--retain-days N]
#
# Required:
#   --cloud-root PATH    Destination directory for snapshots.
#
# Optional:
#   --source PATH        Source DB. Default: ~/.claude/orchestrator/global.db.
#   --time HH:MM         Daily snapshot time, local TZ. Default: 04:07.
#   --name SLUG          Unit / cron tag name. Default: claude-orchestrator-db-snapshot.
#   --retain-days N      Delete snapshots older than N days (matching the same
#                        source's filename pattern) after each run. Default:
#                        keep forever.
#   --help               Show this help and exit.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PYSCRIPT="$SCRIPT_DIR/snapshot-plugin-db.py"

CLOUD_ROOT=""
SOURCE=""
TIME="04:07"
NAME="claude-orchestrator-db-snapshot"
RETAIN_DAYS=""

usage() {
  # Print the leading comment block of this file as the help text.
  awk '
    NR == 1 { next }
    /^#/    { sub(/^# ?/, ""); print; next }
              { exit }
  ' "${BASH_SOURCE[0]}"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --cloud-root)  CLOUD_ROOT="$2"; shift 2 ;;
    --source)      SOURCE="$2"; shift 2 ;;
    --time)        TIME="$2"; shift 2 ;;
    --name)        NAME="$2"; shift 2 ;;
    --retain-days) RETAIN_DAYS="$2"; shift 2 ;;
    --help|-h)     usage; exit 0 ;;
    *) echo "unknown arg: $1" >&2; usage; exit 2 ;;
  esac
done

if [[ -n "$RETAIN_DAYS" ]] && ! [[ "$RETAIN_DAYS" =~ ^[1-9][0-9]*$ ]]; then
  echo "error: --retain-days must be a positive integer. Got: $RETAIN_DAYS" >&2
  exit 2
fi

if [[ -z "$CLOUD_ROOT" ]]; then
  echo "error: --cloud-root is required." >&2
  usage
  exit 2
fi

if [[ ! -d "$CLOUD_ROOT" ]]; then
  echo "error: --cloud-root does not exist or is not a directory: $CLOUD_ROOT" >&2
  exit 2
fi

if [[ ! "$TIME" =~ ^([01][0-9]|2[0-3]):[0-5][0-9]$ ]]; then
  echo "error: --time must be HH:MM (24h, zero-padded). Got: $TIME" >&2
  exit 2
fi

if [[ ! -f "$PYSCRIPT" ]]; then
  echo "error: snapshot script not found next to this helper: $PYSCRIPT" >&2
  exit 1
fi
chmod 0755 "$PYSCRIPT"

PYTHON_BIN="$(command -v python3 || true)"
if [[ -z "$PYTHON_BIN" ]]; then
  echo "error: python3 not found in PATH. Install Python 3.8+ and retry." >&2
  exit 1
fi

CLOUD_ROOT_ABS="$(cd "$CLOUD_ROOT" && pwd)"

EXEC_ARGS=("$PYSCRIPT" "--cloud-root" "$CLOUD_ROOT_ABS")
if [[ -n "$SOURCE" ]]; then
  if [[ ! -f "$SOURCE" ]]; then
    echo "error: --source does not exist or is not a file: $SOURCE" >&2
    exit 2
  fi
  SOURCE_ABS="$(cd "$(dirname "$SOURCE")" && pwd)/$(basename "$SOURCE")"
  EXEC_ARGS+=("--source" "$SOURCE_ABS")
fi
if [[ -n "$RETAIN_DAYS" ]]; then
  EXEC_ARGS+=("--retain-days" "$RETAIN_DAYS")
fi

have_systemd_user() {
  command -v systemctl >/dev/null 2>&1 || return 1
  systemctl --user --version >/dev/null 2>&1 || return 1
  # systemd-user can be installed but disabled (no user-bus); check that too.
  [[ -S "${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/bus" ]]
}

shell_quote() {
  # Single-quote-wrap a single argument for safe use in a systemd ExecStart
  # or a shell command line.
  printf "'%s'" "${1//\'/\'\\\'\'}"
}

install_systemd() {
  local unit_dir="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
  local service="$unit_dir/${NAME}.service"
  local timer="$unit_dir/${NAME}.timer"

  mkdir -p "$unit_dir"

  local exec_line="$PYTHON_BIN"
  for arg in "${EXEC_ARGS[@]}"; do
    exec_line="$exec_line $(shell_quote "$arg")"
  done

  cat > "$service" <<EOF
[Unit]
Description=Nightly snapshot of the Claude orchestrator plugin DB
Documentation=https://github.com/SpawnBox-dev/claude-plugins

[Service]
Type=oneshot
ExecStart=$exec_line
EOF

  cat > "$timer" <<EOF
[Unit]
Description=Nightly snapshot of the Claude orchestrator plugin DB
Documentation=https://github.com/SpawnBox-dev/claude-plugins

[Timer]
OnCalendar=*-*-* ${TIME}:00
Persistent=true
Unit=${NAME}.service

[Install]
WantedBy=timers.target
EOF

  systemctl --user daemon-reload
  systemctl --user enable --now "${NAME}.timer"

  echo
  echo "Installed systemd user units:"
  echo "  $service"
  echo "  $timer"
  echo
  echo "Verify with:"
  echo "  systemctl --user list-timers ${NAME}.timer"
  echo "  systemctl --user status ${NAME}.timer"
  echo
  if command -v loginctl >/dev/null 2>&1; then
    if ! loginctl show-user "$(id -un)" 2>/dev/null | grep -q '^Linger=yes'; then
      echo "Note: linger is OFF for this user. Timers stop when you log out."
      echo "      Enable with: sudo loginctl enable-linger $(id -un)"
      echo "      (Especially relevant on WSL2 and headless servers.)"
    fi
  fi
}

install_cron() {
  local marker="# managed by install-snapshot-timer.sh: ${NAME}"
  local minute="${TIME#*:}"
  local hour="${TIME%:*}"
  # Strip leading zeros for cron (it accepts them but some implementations
  # have warned historically; safer to feed plain decimals).
  minute=$((10#$minute))
  hour=$((10#$hour))
  local cmd="$PYTHON_BIN"
  for arg in "${EXEC_ARGS[@]}"; do
    cmd="$cmd $(shell_quote "$arg")"
  done
  local entry="${minute} ${hour} * * * ${cmd} ${marker}"

  local current new
  current="$(crontab -l 2>/dev/null || true)"
  # Drop any prior entry with our marker; append the new one.
  new="$(printf '%s\n' "$current" | grep -v -F "$marker" || true)"
  new="${new%$'\n'}"
  if [[ -n "$new" ]]; then
    new="${new}"$'\n'"${entry}"
  else
    new="${entry}"
  fi
  printf '%s\n' "$new" | crontab -

  echo
  echo "Installed cron entry (marker: ${NAME}):"
  echo "  ${entry}"
  echo
  echo "Verify with:"
  echo "  crontab -l | grep ${NAME}"
}

echo "[install-snapshot-timer] python:      $PYTHON_BIN"
echo "[install-snapshot-timer] script:      $PYSCRIPT"
echo "[install-snapshot-timer] cloud-root:  $CLOUD_ROOT_ABS"
echo "[install-snapshot-timer] source:      ${SOURCE:-<default: ~/.claude/orchestrator/global.db>}"
echo "[install-snapshot-timer] time:        $TIME"
echo "[install-snapshot-timer] name:        $NAME"
echo "[install-snapshot-timer] retain-days: ${RETAIN_DAYS:-<keep forever>}"
echo

if have_systemd_user; then
  echo "[install-snapshot-timer] scheduler:  systemd-user"
  install_systemd
else
  echo "[install-snapshot-timer] scheduler:  cron (no systemd-user available)"
  install_cron
fi

verify_cmd="$PYTHON_BIN"
for arg in "${EXEC_ARGS[@]}"; do
  verify_cmd="$verify_cmd $(shell_quote "$arg")"
done
echo
echo "One-off verification (run the snapshot now):"
echo "  $verify_cmd"
