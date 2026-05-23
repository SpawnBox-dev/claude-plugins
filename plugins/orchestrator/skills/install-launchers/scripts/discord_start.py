#!/usr/bin/env python3
"""Launch a Discord-ops Claude Code session.

Participates in BOTH the Discord plugin channel (incoming chat) AND the
orchestrator agent-channel (cross-session coordination). Discord-ops
sessions register as role=subordinate with session_kind=discord-bot, so
the discord-bootstrap skill and per-kind classifier policies can gate
on kind without relying on fragile name-pattern matching.

Usage:
    ./discord-start.sh                  # POSIX wrapper
    .\\discord-start.ps1                 # Windows wrapper
    python3 discord_start.py [--project-dir X] [--no-windows-terminal] [--dry-run]
"""

from __future__ import annotations

import argparse
import json
import os
import sys

import _launcher_common as common


def main(argv: list[str] | None = None) -> int:
    common.check_marketplace_substituted()

    parser = argparse.ArgumentParser(
        description="Launch a Discord-ops Claude Code session.",
    )
    parser.add_argument("--project-dir", default="")
    parser.add_argument("--no-windows-terminal", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args(argv)

    project_dir = common.resolve_project_dir(args.project_dir or None)
    session_name = common.make_session_name("DISCORD-LIVE")

    env_before = dict(os.environ)
    common.setup_env(
        role="subordinate",
        session_kind="discord-bot",
        project_dir=project_dir,
        session_name=session_name,
    )
    env_overrides = {
        k: v for k, v in os.environ.items() if env_before.get(k) != v
    }

    claude_args = common.build_claude_args(
        marketplace=common.MARKETPLACE_PLACEHOLDER,
        session_name=session_name,
        resume=None,
        effort=None,
        extra_channels=["plugin:discord@claude-plugins-official"],
    )

    if args.dry_run:
        payload = {
            "argv": claude_args,
            "env_overrides": env_overrides,
            "tab_color": "#DC2626",
            "use_wt": not args.no_windows_terminal,
        }
        print(json.dumps(payload, indent=2))
        return 0

    return common.launch(
        claude_args,
        project_dir=project_dir,
        tab_color="#DC2626",
        no_wt=args.no_windows_terminal,
    )


if __name__ == "__main__":
    sys.exit(main())
