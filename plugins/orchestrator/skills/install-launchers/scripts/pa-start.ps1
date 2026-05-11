<#
.SYNOPSIS
Launch the PrimeAgent (PA) Claude Code session for the current project.

.DESCRIPTION
PA is the persistent orchestrator session running Opus at max effort with
agent-channel attached. This launcher works in any project: invoke it from
the project root (or with -ProjectDir) and it spawns a new wt.exe tab
running `claude` with the right env + flags.

Project-agnostic. Single source-of-truth lives in the orchestrator plugin
at `plugins/orchestrator/launchers/pa-start.ps1`. Install per-project via
`/orchestrator:install-launchers` from inside a Claude session.

.PARAMETER Resume
Optional. Session UUID or display name (set via /rename in Claude Code).
If a display name is passed, it's resolved to a UUID by searching the
project's JSONLs for "Session renamed to: <name>".

.PARAMETER ProjectDir
Optional. The project root. Defaults to current working directory ($PWD).

.PARAMETER NoWindowsTerminal
Optional. Skip wt.exe and launch in the current console.

.EXAMPLE
.\pa-start.ps1
  Fresh PA session in the current directory, auto-named PA-YYYY-MM-DD-HH-MM-SS

.EXAMPLE
.\pa-start.ps1 -Resume "<session-uuid-or-display-name>"
  Resume an existing session as PA
#>

param(
  [string]$Resume = '',
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
    # Match Claude Code's project-dir → hash transform: literal char-for-char
    # substitution of path separators (`\` `/`) and drive colon (`:`) with `-`.
    # CC does NOT collapse consecutive dashes - the `C:\` prefix produces `C--`
    # in the hash, and that's what CC's actual `~/.claude/projects/<hash>/`
    # directory uses.
    $projectHash = $ProjectDir -replace '[\\/:]', '-' -replace '^-+', '' -replace '-+$', ''
    $jsonlDir = Join-Path $env:USERPROFILE ".claude\projects\$projectHash"
    if (-not (Test-Path $jsonlDir)) {
      Write-Host "ERROR: Projects dir not found: $jsonlDir" -ForegroundColor Red
      exit 1
    }
    # `$matches` is a PowerShell automatic variable - use custom name.
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
# Singleton awareness - auto-supersede existing PA if any.
#
# Pre-emptively demote any role=prime entry to subordinate in sessions.json.
# In the normal "user closed old window and is relaunching" flow, the old
# MCP is already dead and the demotion sticks. If the old MCP is still alive,
# its heartbeat will overwrite back to role=prime briefly until the user runs
# /pa-takeover or closes the older window.
# ---------------------------------------------------------------------------

$stateFile = Join-Path $ProjectDir '.orchestrator-state\agent-channel\sessions.json'
if (Test-Path $stateFile) {
  try {
    $state = Get-Content $stateFile -Raw | ConvertFrom-Json
    $now = Get-Date
    $freshPa = $state.sessions | Where-Object {
      $_.role -eq 'prime' -and
      ([datetime]$_.last_heartbeat_at) -gt $now.AddSeconds(-90)
    }
    if ($freshPa) {
      Write-Host ''
      Write-Host ' Existing PrimeAgent detected - auto-superseding:' -ForegroundColor Yellow
      foreach ($pa in $freshPa) {
        Write-Host "   * $($pa.session_id) ($($pa.name))" -ForegroundColor Yellow
      }
      $state.sessions | ForEach-Object {
        if ($_.role -eq 'prime') { $_.role = 'subordinate' }
      }
      $state | ConvertTo-Json -Depth 10 | Set-Content -Path $stateFile -Encoding UTF8 -NoNewline
      Write-Host ' (Existing PA(s) demoted. New PA will register as prime.)' -ForegroundColor Yellow
      Write-Host ' (Press Ctrl+C in the next ~2s to cancel.)' -ForegroundColor Yellow
      Write-Host ''
      Start-Sleep -Seconds 2
    }
  } catch {
    Write-Host "WARNING: Could not parse $stateFile (treating as no-PA): $_" -ForegroundColor Yellow
  }
}

# ---------------------------------------------------------------------------
# Naming policy
# ---------------------------------------------------------------------------

$sessionName = ''
if (-not $Resume) {
  $sessionName = "PA-$(Get-Date -Format 'yyyy-MM-dd-HH-mm-ss')"
}

# ---------------------------------------------------------------------------
# Env vars (inherited by child claude.exe -> MCP server)
# ---------------------------------------------------------------------------

# Bump MCP startup timeout from the 5s default to 30s. The orchestrator
# MCP server's `npx -y bun` cold-start can exceed 5s on first invocation.
# Stdio MCP servers get ONE chance per Claude Code docs.
$env:MCP_TIMEOUT = '30000'

# Tell the MCP which project root we're operating in (helps when CC's
# CLAUDE_PROJECT_DIR isn't reliably set in the spawned subprocess env).
$env:ORCHESTRATOR_PROJECT_ROOT = $ProjectDir

# Canonical role env. SPAWNBOX_ prefix kept for backwards compatibility
# with older orchestrator MCPs that haven't been updated yet.
$env:ORCHESTRATOR_AGENT_ROLE = 'prime'
$env:SPAWNBOX_AGENT_ROLE = 'prime'
# Only set the NAME env when we have an explicit name. On --resume without an
# explicit name, leave NAME unset: the MCP will register the session under its
# existing /rename-set name. Setting NAME=$Resume here would clobber the
# human-readable session name with the raw UUID.
if ($sessionName) {
  $env:ORCHESTRATOR_AGENT_NAME = $sessionName
  $env:SPAWNBOX_AGENT_NAME = $sessionName
}

# ---------------------------------------------------------------------------
# Build claude args
# ---------------------------------------------------------------------------

# The marketplace slug below is substituted by the /orchestrator:install-launchers
# skill at copy-into-project time. If you see the literal `__ORCH_MARKETPLACE__`
# below, re-run /orchestrator:install-launchers - the substitution step was
# skipped.
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
# Launch with gold tab color in wt
# ---------------------------------------------------------------------------

$useWt = (-not $NoWindowsTerminal) -and ($null -ne (Get-Command wt.exe -ErrorAction SilentlyContinue))
if ($useWt) {
  $wtArgs = @(
    '-w', 'new',
    'new-tab',
    '--tabColor', '#F59E0B',
    '-d', $ProjectDir,
    'claude'
  ) + $claudeArgs
  & wt.exe @wtArgs
} else {
  & claude @claudeArgs
}
