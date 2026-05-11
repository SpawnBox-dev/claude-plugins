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

.EXAMPLE
.\sa-start.ps1
  Fresh session in current dir, auto-named SA-YYYY-MM-DD-HH-MM-SS

.EXAMPLE
.\sa-start.ps1 -Name "SA-frontend"
  Fresh session with explicit name

.EXAMPLE
.\sa-start.ps1 -Resume "abc12345-1234-5678-9abc-def012345678"
  Resume by UUID
#>

param(
  [string]$Resume = '',
  [string]$Name = '',
  [string]$ProjectDir = '',
  [switch]$NoWindowsTerminal
)

$ErrorActionPreference = 'Stop'

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
    # Match Claude Code's project-dir → hash transform: replace path separators
    # and drive colons with `-`, collapse runs of dashes, trim ends.
    $projectHash = $ProjectDir -replace '[\\/:]', '-' -replace '-{2,}', '-' -replace '^-+', '' -replace '-+$', ''
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
if ($Resume) {
  $claudeArgs += '--resume'
  $claudeArgs += $Resume
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
