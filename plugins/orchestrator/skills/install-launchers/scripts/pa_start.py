#!/usr/bin/env python3
"""Launch the PrimeAgent (PA) Claude Code session for the current project.

PA is the persistent orchestrator session running Opus at max effort with
agent-channel attached. Project-agnostic. Single source-of-truth lives
in the orchestrator plugin's install-launchers skill; install per-project
via `/orchestrator:install-launchers`.

Usage:
    ./pa-start.sh                       # POSIX wrapper
    .\\pa-start.ps1                      # Windows wrapper
    python3 pa_start.py [--resume X] [--project-dir Y] [--no-windows-terminal] [--dry-run]
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
        description="Launch the PrimeAgent (PA) Claude Code session.",
    )
    parser.add_argument(
        "--resume",
        default="",
        help="Session UUID or display name (set via /rename in Claude Code).",
    )
    parser.add_argument(
        "--project-dir",
        default="",
        help="Project root. Defaults to current working directory.",
    )
    parser.add_argument(
        "--no-windows-terminal",
        action="store_true",
        help="Skip wt.exe and launch claude directly in the current console.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Print resolved argv + env-overrides as JSON; don't spawn claude.",
    )
    args = parser.parse_args(argv)

    project_dir = common.resolve_project_dir(args.project_dir or None)

    resume = ""
    if args.resume:
        resume = common.resolve_resume_target(args.resume, project_dir)

    if not args.dry_run:
        common.supersede_existing_pa(project_dir)

    session_name: str | None = None
    if not resume:
        session_name = common.make_session_name("PA")

    # Snapshot env before setup_env mutates it, so --dry-run can show the
    # diff cleanly.
    env_before = dict(os.environ)
    common.setup_env(
        role="prime",
        session_kind="prime",
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
        effort="max",  # PA always launches at max effort.
        extra_channels=None,
    )

    if args.dry_run:
        payload = {
            "argv": claude_args,
            "env_overrides": env_overrides,
            "tab_color": "#F59E0B",
            "use_wt": not args.no_windows_terminal,
        }
        print(json.dumps(payload, indent=2))
        return 0

    return common.launch(
        claude_args,
        project_dir=project_dir,
        tab_color="#F59E0B",
        no_wt=args.no_windows_terminal,
    )


if __name__ == "__main__":
    sys.exit(main())
