#!/usr/bin/env python3
"""Launch a Subordinate Agent (SA) Claude Code session.

SA is a peer subordinate of PA, participating in the orchestrator
agent-channel. Project-agnostic.

Usage:
    ./sa-start.sh                       # POSIX wrapper
    .\\sa-start.ps1                      # Windows wrapper
    python3 sa_start.py [--resume X] [--name Y] [--project-dir Z] \\
                        [--effort low|medium|high|xhigh|max] \\
                        [--no-windows-terminal] [--dry-run]
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
        description="Launch a Subordinate Agent (SA) Claude Code session.",
    )
    parser.add_argument("--resume", default="")
    parser.add_argument("--name", default="")
    parser.add_argument("--project-dir", default="")
    parser.add_argument(
        "--effort",
        choices=["low", "medium", "high", "xhigh", "max"],
        default=None,
        help="Reasoning effort. Omit to leave Claude Code on session default.",
    )
    parser.add_argument("--no-windows-terminal", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args(argv)

    project_dir = common.resolve_project_dir(args.project_dir or None)

    resume = ""
    if args.resume:
        resume = common.resolve_resume_target(args.resume, project_dir)

    session_name: str | None = None
    if args.name:
        session_name = args.name
    elif not resume:
        session_name = common.make_session_name("SA")

    env_before = dict(os.environ)
    common.setup_env(
        role="subordinate",
        session_kind="subordinate",
        project_dir=project_dir,
        session_name=session_name,
    )
    env_overrides = {
        k: v for k, v in os.environ.items() if env_before.get(k) != v
    }

    claude_args = common.build_claude_args(
        marketplace=common.MARKETPLACE_PLACEHOLDER,
        session_name=session_name,
        resume=resume or None,
        effort=args.effort,
        extra_channels=None,
    )

    if args.dry_run:
        payload = {
            "argv": claude_args,
            "env_overrides": env_overrides,
            "tab_color": None,
            "use_wt": not args.no_windows_terminal,
        }
        print(json.dumps(payload, indent=2))
        return 0

    return common.launch(
        claude_args,
        project_dir=project_dir,
        tab_color=None,
        no_wt=args.no_windows_terminal,
    )


if __name__ == "__main__":
    sys.exit(main())
