<#
.SYNOPSIS
Launch a Subordinate Agent (SA) Claude Code session participating in
the orchestrator's agent-channel.

.DESCRIPTION
Project-agnostic. Single source-of-truth lives in the orchestrator plugin
at `plugins/orchestrator/launchers/sa-start.ps1`. Install per-project via
`/orchestrator:install-launchers`.

.PARAMETER Resume
Optional. Session UUID or display name (set via /rename in Claude Code).

.PARAMETER Name
Optional. Friendly name for the session.

.PARAMETER ProjectDir
Optional. The project root. Defaults to current working directory ($PWD).

.PARAMETER NoWindowsTerminal
Optional. Skip wt.exe and launch claude directly in the current console.

.PARAMETER Effort
Optional. Reasoning effort level: low | medium | high | xhigh | max.
Omit to leave Claude Code on its session default. Set this when an SA
is doing complex/judgment-heavy work that benefits from deeper reasoning
(at higher token cost).

.EXAMPLE
.\sa-start.ps1
  Fresh session in current dir, auto-named SA-YYYY-MM-DD-HH-MM-SS

.EXAMPLE
.\sa-start.ps1 -Name "SA-frontend"
  Fresh session with explicit name

.EXAMPLE
.\sa-start.ps1 -Resume "abc12345-1234-5678-9abc-def012345678"
  Resume by UUID

.EXAMPLE
.\sa-start.ps1 -Name "SA-architecture" -Effort max
  Fresh session at max effort for a heavy reasoning task
#>

param(
  [string]$Resume = '',
  [string]$Name = '',
  [string]$ProjectDir = '',
  [ValidateSet('', 'low', 'medium', 'high', 'xhigh', 'max')]
  [string]$Effort = '',
  # Seed prompt submitted as the session's first turn. Without one, a freshly
  # spawned SA idles forever: agent-channel injection needs an existing
  # conversation, and nothing else starts one (WI f0d66029).
  [string]$Seed = '',
  # Pass --dangerously-skip-permissions. Required for unattended SAs while
  # the PA permission relay gets no permission_request notifications from
  # CC 2.1.17x (WI f0d66029) - without it they hang at the first gated tool.
  [switch]$BypassPermissions,
  [switch]$NoWindowsTerminal
)

$ErrorActionPreference = 'Stop'

# CC 2.1.x nested-session guard: a claude spawned with inherited CLAUDECODE /
# CLAUDE_CODE_* env is treated as a nested/child session - it runs but writes
# NO transcript and NO ~/.claude/sessions/<pid>.json entry, which kills
# agent-channel outbound routing, console visibility, and resume. Scrub the
# markers so the SA boots top-level even when launched from another claude
# session (PA /sa-launch). WI f0d66029, 2026-06-11.
Get-ChildItem Env: | Where-Object {
  $_.Name -eq 'CLAUDECODE' -or $_.Name -like 'CLAUDE_CODE_*' -or
  $_.Name -eq 'CLAUDE_EFFORT' -or $_.Name -eq 'AI_AGENT'
} | ForEach-Object { Remove-Item "Env:$($_.Name)" -ErrorAction SilentlyContinue }

if (-not $ProjectDir) {
  $ProjectDir = (Get-Location).Path
}
$ProjectDir = (Resolve-Path $ProjectDir).Path

# ---------------------------------------------------------------------------
# Resolve display name -> UUID if needed
# ---------------------------------------------------------------------------

if ($Resume) {
  $uuidRegex = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
  if ($Resume -notmatch $uuidRegex) {
    # Match Claude Code's project-dir → hash transform: literal char-for-char
    # substitution. CC does NOT collapse consecutive dashes (the `C:\` prefix
    # produces `C--` in the hash).
    $projectHash = $ProjectDir -replace '[\\/:]', '-' -replace '^-+', '' -replace '-+$', ''
    $jsonlDir = Join-Path $env:USERPROFILE ".claude\projects\$projectHash"
    if (-not (Test-Path $jsonlDir)) {
      Write-Host "ERROR: Projects dir not found: $jsonlDir" -ForegroundColor Red
      exit 1
    }
    $foundSessions = Get-ChildItem -Path $jsonlDir -Filter '*.jsonl' -File | Where-Object {
      Select-String -Path $_.FullName -SimpleMatch "Session renamed to: $Resume" -Quiet
    }
    if (-not $foundSessions) {
      Write-Host "ERROR: No session in $jsonlDir has been renamed to: $Resume" -ForegroundColor Red
      exit 1
    }
    $resolvedUuid = ($foundSessions | Sort-Object LastWriteTime -Descending | Select-Object -First 1).BaseName
    Write-Host " Resolved display name to session: $resolvedUuid"
    $Resume = $resolvedUuid
  }
}

# ---------------------------------------------------------------------------
# Naming policy
#   -Resume given         -> let claude.exe use the resumed session's name
#   -Name given           -> use that name
#   neither               -> auto-generate SA-YYYY-MM-DD-HH-MM-SS
# ---------------------------------------------------------------------------

$sessionName = ''
if ($Name) {
  $sessionName = $Name
} elseif (-not $Resume) {
  $sessionName = "SA-$(Get-Date -Format 'yyyy-MM-dd-HH-mm-ss')"
}

# ---------------------------------------------------------------------------
# Env vars
# ---------------------------------------------------------------------------

$env:MCP_TIMEOUT = '30000'
$env:ORCHESTRATOR_PROJECT_ROOT = $ProjectDir

# Canonical role env. SPAWNBOX_ prefix kept for backwards compatibility.
$env:ORCHESTRATOR_AGENT_ROLE = 'subordinate'
$env:SPAWNBOX_AGENT_ROLE = 'subordinate'

# 0.30.31 (WI c03c9d6a): functional kind, distinct from role. Generic
# SAs are kind='subordinate' (same string as role). Discord-ops sessions
# launched via discord-start.ps1 set kind='discord-bot' while remaining
# role='subordinate'. Skills + classifier policy gate on kind, not role.
$env:ORCHESTRATOR_SESSION_KIND = 'subordinate'
$env:SPAWNBOX_SESSION_KIND = 'subordinate'

# Opt into the PA-gated permission relay (0.30.17+). When set, this SA's MCP
# declares the `claude/channel/permission` capability so tool permission
# requests route through agent-channel to PA for authorization instead of
# falling back to in-terminal prompts.
$env:ORCHESTRATOR_PA_PERMISSION_RELAY = '1'
# Only set the NAME env when we have an explicit name. On --resume without an
# explicit name, leave NAME unset so the existing session's name is preserved.
if ($sessionName) {
  $env:ORCHESTRATOR_AGENT_NAME = $sessionName
  $env:SPAWNBOX_AGENT_NAME = $sessionName
}

# ---------------------------------------------------------------------------
# Build claude args
# ---------------------------------------------------------------------------

# Marketplace slug substituted by /orchestrator:install-launchers at copy time.
# If you see the literal `__ORCH_MARKETPLACE__` below, re-run the install skill.
$claudeArgs = @(
  '--dangerously-load-development-channels',
  'plugin:orchestrator@__ORCH_MARKETPLACE__'
)
if ($sessionName) {
  $claudeArgs += '--name'
  $claudeArgs += $sessionName
}
# 0.30.28+: optional reasoning-effort override. Only emitted when -Effort
# is explicitly set; otherwise Claude Code uses its session default.
if ($Effort) {
  $claudeArgs += '--effort'
  $claudeArgs += $Effort
}
if ($Resume) {
  $claudeArgs += '--resume'
  $claudeArgs += $Resume
}
if ($BypassPermissions) {
  $claudeArgs += '--dangerously-skip-permissions'
}
# Positional seed prompt LAST (claude treats the trailing positional arg as
# the initial prompt and starts the conversation with it).
if ($Seed) {
  $claudeArgs += $Seed
}

# ---------------------------------------------------------------------------
# Launch
# ---------------------------------------------------------------------------

$useWt = (-not $NoWindowsTerminal) -and ($null -ne (Get-Command wt.exe -ErrorAction SilentlyContinue))
if ($useWt) {
  $wtArgs = @(
    '-w', 'new',
    'new-tab',
    '-d', $ProjectDir,
    'claude'
  ) + $claudeArgs
  & wt.exe @wtArgs
} else {
  & claude @claudeArgs
}
