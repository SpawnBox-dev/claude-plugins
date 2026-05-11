<#
.SYNOPSIS
Launch a Discord-ops Claude Code session that participates in BOTH the
Discord channel (incoming chat messages) AND the orchestrator agent-channel
(cross-session coordination with PA and other SAs).

.DESCRIPTION
This session is a subordinate agent specialized for live community ops.
It receives messages from two channel sources:
  - <channel source="plugin:discord:discord" ...>: incoming Discord chat
  - <channel source="plugin:orchestrator:core" ...>: cross-session events

PA can observe and coordinate this session. The session can also @PA when
it needs help with a tricky Discord situation.

Project-agnostic. Lives in the orchestrator plugin source; installed
per-project via /orchestrator:install-launchers.

.PARAMETER ProjectDir
Optional. Project root. Defaults to current working directory ($PWD).

.PARAMETER NoWindowsTerminal
Optional. Skip wt.exe and launch claude in the current console.

.EXAMPLE
.\discord-start.ps1
  Fresh Discord-ops session in current dir, auto-named DISCORD-LIVE-<timestamp>,
  red tab.
#>

param(
  [string]$ProjectDir = '',
  [switch]$NoWindowsTerminal
)

$ErrorActionPreference = 'Stop'

if (-not $ProjectDir) {
  $ProjectDir = (Get-Location).Path
}
$ProjectDir = (Resolve-Path $ProjectDir).Path

# ---------------------------------------------------------------------------
# Session naming
# ---------------------------------------------------------------------------

$sessionName = "DISCORD-LIVE-$(Get-Date -Format 'yyyy-MM-dd-HH-mm-ss')"

# ---------------------------------------------------------------------------
# Env vars (inherited by child claude.exe -> MCP server)
# ---------------------------------------------------------------------------

$env:MCP_TIMEOUT = '30000'
$env:ORCHESTRATOR_PROJECT_ROOT = $ProjectDir

# Discord-ops sessions register as subordinate in the agent-channel.
$env:ORCHESTRATOR_AGENT_ROLE = 'subordinate'
$env:SPAWNBOX_AGENT_ROLE = 'subordinate'
$env:ORCHESTRATOR_AGENT_NAME = $sessionName
$env:SPAWNBOX_AGENT_NAME = $sessionName

# ---------------------------------------------------------------------------
# Build claude args
#
# --channels: for allowlisted plugins (Discord is on Anthropic's allowlist).
# --dangerously-load-development-channels: for unallowlisted plugins
# (orchestrator is third-party). Both flags coexist cleanly per the channels
# reference (https://code.claude.com/docs/en/channels-reference). The session
# receives events from both sources, distinguishable by the `source` attribute
# on the <channel> tag.
#
# The orchestrator marketplace slug is substituted at install time by the
# /orchestrator:install-launchers skill. If you see the literal
# `__ORCH_MARKETPLACE__` below, re-run the install skill.
# ---------------------------------------------------------------------------

$claudeArgs = @(
  '--channels', 'plugin:discord@claude-plugins-official',
  '--dangerously-load-development-channels', 'plugin:orchestrator@__ORCH_MARKETPLACE__',
  '--name', $sessionName
)

# ---------------------------------------------------------------------------
# Launch with red tab color in wt
# ---------------------------------------------------------------------------

$useWt = (-not $NoWindowsTerminal) -and ($null -ne (Get-Command wt.exe -ErrorAction SilentlyContinue))
if ($useWt) {
  $wtArgs = @(
    '-w', 'new',
    'new-tab',
    '--tabColor', '#DC2626',
    '-d', $ProjectDir,
    'claude'
  ) + $claudeArgs
  & wt.exe @wtArgs
} else {
  & claude @claudeArgs
}
