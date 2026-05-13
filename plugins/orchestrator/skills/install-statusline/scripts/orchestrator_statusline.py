#!/usr/bin/env python3
"""Orchestrator role-aware statusline.

Reads $ORCHESTRATOR_SESSION_KIND (set by pa-start / sa-start /
discord-start launchers) and emits a one-line statusline to stdout with
a colored role indicator + session name. Suitable for Claude Code's
`statusLine` setting.

Output format (single line, ANSI-colored):
    🟡 PA-2026-05-13-12-00-00    (yellow, kind=prime)
    ⚪ SA-frontend                (default, kind=subordinate)
    🔴 DISCORD-LIVE-...           (red, kind=discord-bot)

If the env var is unset, emits a neutral line that just identifies the
project root, so the statusline is never empty / never errors out
the Claude UI.

Stdlib only. No third-party deps.
"""

from __future__ import annotations

import os
import sys


# ANSI color codes (256-color palette where helpful).
RESET = "\033[0m"
BOLD = "\033[1m"
DIM = "\033[2m"

# Kind → (glyph, ANSI color sequence, human-readable label).
ROLE_STYLES: dict[str, tuple[str, str, str]] = {
    "prime": ("🟡", "\033[38;5;220m", "PA"),         # gold-ish yellow
    "subordinate": ("⚪", "\033[38;5;245m", "SA"),    # neutral grey
    "discord-bot": ("🔴", "\033[38;5;160m", "DISCORD"),  # red
}


def render_statusline() -> str:
    kind = os.environ.get("ORCHESTRATOR_SESSION_KIND", "").strip()
    name = os.environ.get("ORCHESTRATOR_AGENT_NAME", "").strip()
    project = os.environ.get(
        "ORCHESTRATOR_PROJECT_ROOT",
        os.environ.get("CLAUDE_PROJECT_DIR", ""),
    ).strip()

    project_label = ""
    if project:
        # Show just the project's basename to keep the line short.
        project_label = f"{DIM}{os.path.basename(project.rstrip('/'))}{RESET}"

    if kind not in ROLE_STYLES:
        # No launcher env present — emit a neutral indicator so the
        # statusline still renders something useful.
        return f"{DIM}orchestrator{RESET}  {project_label}".rstrip()

    glyph, color, label = ROLE_STYLES[kind]
    role_display = f"{color}{BOLD}{glyph} {label}{RESET}"

    name_display = ""
    if name:
        name_display = f"  {color}{name}{RESET}"

    line = f"{role_display}{name_display}"
    if project_label:
        line = f"{line}  {project_label}"
    return line


def main() -> int:
    try:
        line = render_statusline()
    except Exception as err:  # noqa: BLE001
        # Never crash the Claude UI; fall back to a minimal hint.
        print(f"orchestrator-statusline error: {err}", file=sys.stderr)
        print("orchestrator")
        return 0
    print(line)
    return 0


if __name__ == "__main__":
    sys.exit(main())
