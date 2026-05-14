#!/usr/bin/env python3
"""Orchestrator role-aware statusline.

Reads $ORCHESTRATOR_SESSION_KIND (set by pa-start / sa-start /
discord-start launchers) and emits a one-line statusline to stdout with
a colored role indicator + project basename. Suitable for Claude Code's
`statusLine` setting.

Output format (single line, ANSI-colored):
    🟡 PA       quayline    (yellow, kind=prime)
    ⚪ SA       quayline    (default, kind=subordinate)
    🔴 DISCORD  quayline    (red, kind=discord-bot)

Session names (e.g. PA-2026-05-13-12-00-00) are intentionally not
included — they add timestamp noise without informational value. The
role indicator + project basename is enough for at-a-glance distinction.

If the env var is unset, emits a neutral line that just identifies the
project root, so the statusline is never empty / never errors out
the Claude UI.

Stdlib only. No third-party deps. Stdin is ignored (this renderer is
purely env-var driven); a composed wrapper script handles stdin fan-out
when this is chained with a user-provided statusline.
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
    project = os.environ.get(
        "ORCHESTRATOR_PROJECT_ROOT",
        os.environ.get("CLAUDE_PROJECT_DIR", ""),
    ).strip()

    project_label = ""
    if project:
        project_label = f"{DIM}{os.path.basename(project.rstrip('/'))}{RESET}"

    if kind not in ROLE_STYLES:
        return f"{DIM}orchestrator{RESET}  {project_label}".rstrip()

    glyph, color, label = ROLE_STYLES[kind]
    role_display = f"{color}{BOLD}{glyph} {label}{RESET}"

    line = role_display
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
