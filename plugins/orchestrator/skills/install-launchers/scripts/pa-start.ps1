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
    $resolvedUuid = ''

    # Layer 1 (original, unchanged): transcript grep for the /rename stdout
    # line. `$matches` is a PowerShell automatic variable - use custom name.
    if (Test-Path $jsonlDir) {
      $foundSessions = Get-ChildItem -Path $jsonlDir -Filter '*.jsonl' -File | Where-Object {
        Select-String -Path $_.FullName -SimpleMatch "Session renamed to: $Resume" -Quiet
      }
      if ($foundSessions) {
        $resolvedUuid = ($foundSessions | Sort-Object LastWriteTime -Descending | Select-Object -First 1).BaseName
      }
    }

    # Layer 2 (0.30.56, WI f0d66029 follow-up): the session-start hook's
    # append-only launch-name map - covers LAUNCH-TIME names (--name), which
    # CC records nowhere durable. Multiple distinct ids for one name = list
    # candidates and refuse to guess.
    if (-not $resolvedUuid) {
      $nameMap = Join-Path $ProjectDir ".orchestrator-state\session-names.tsv"
      if (Test-Path $nameMap) {
        $entries = @(Get-Content $nameMap -ErrorAction SilentlyContinue | ForEach-Object {
          $f = $_ -split "`t"
          if ($f.Count -ge 3 -and $f[1] -match $uuidRegex -and $f[2] -eq $Resume) {
            [pscustomobject]@{ Ts = $f[0]; Uuid = $f[1] }
          }
        })
        if ($entries.Count -gt 0) {
          $distinct = @($entries | Select-Object -ExpandProperty Uuid -Unique)
          if ($distinct.Count -eq 1) {
            $resolvedUuid = $distinct[0]
          } else {
            Write-Host "ERROR: name '$Resume' maps to multiple sessions - resume by UUID instead:" -ForegroundColor Red
            foreach ($u in $distinct) {
              $last = ($entries | Where-Object { $_.Uuid -eq $u } | Select-Object -Last 1).Ts
              Write-Host "  $u  (last seen $last)"
            }
            exit 1
          }
        }
      }
    }

    # Layer 3 (Claude Desktop tab rename): the Windows app's "rename tab"
    # writes a {"type":"custom-title","customTitle":"<name>","sessionId":"<uuid>"}
    # record into the session's OWN transcript jsonl. CC persists these nowhere
    # else (not the /rename stdout line, not the launch-name map), so a session
    # renamed only via the Desktop tab is otherwise resumable only by raw UUID.
    # Take the LAST custom-title per transcript (= that tab's current name). The
    # sessionId==filename guard rejects message text that merely quotes an event.
    if (-not $resolvedUuid -and (Test-Path $jsonlDir)) {
      $titleHits = @(Get-ChildItem -Path $jsonlDir -Filter '*.jsonl' -File | ForEach-Object {
        $file = $_
        $last = Select-String -Path $file.FullName -SimpleMatch '"type":"custom-title"' | Select-Object -Last 1
        if ($last -and
            $last.Line -match '"customTitle":"([^"]*)".*?"sessionId":"([^"]*)"' -and
            $matches[2] -eq $file.BaseName -and
            $matches[1] -eq $Resume) {
          [pscustomobject]@{ Uuid = $file.BaseName; Ts = $file.LastWriteTimeUtc }
        }
      })
      if ($titleHits.Count -gt 0) {
        $distinct = @($titleHits | Select-Object -ExpandProperty Uuid -Unique)
        if ($distinct.Count -eq 1) {
          $resolvedUuid = $distinct[0]
        } else {
          Write-Host "ERROR: tab name '$Resume' maps to multiple sessions - resume by UUID instead:" -ForegroundColor Red
          foreach ($h in ($titleHits | Sort-Object Ts -Descending)) {
            Write-Host "  $($h.Uuid)  (last active $($h.Ts.ToString('u')))"
          }
          exit 1
        }
      }
    }

    if (-not $resolvedUuid) {
      Write-Host "ERROR: no session named '$Resume' found via /rename history, the launch-name map (.orchestrator-state\session-names.tsv), or Claude Desktop tab titles ($jsonlDir). Resume by raw UUID instead." -ForegroundColor Red
      exit 1
    }
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

# Bump MCP startup timeout from the 5s default to 120s. The orchestrator
# MCP server's `npx -y bun` cold-start can exceed the smaller timeouts on
# first invocation (sessions were bouncing on the prior 30s value), and stdio
# MCP servers get ONE chance per Claude Code docs.
$env:MCP_TIMEOUT = '120000'

# Tell the MCP which project root we're operating in (helps when CC's
# CLAUDE_PROJECT_DIR isn't reliably set in the spawned subprocess env).
$env:ORCHESTRATOR_PROJECT_ROOT = $ProjectDir

# Canonical role env. SPAWNBOX_ prefix kept for backwards compatibility
# with older orchestrator MCPs that haven't been updated yet.
$env:ORCHESTRATOR_AGENT_ROLE = 'prime'
$env:SPAWNBOX_AGENT_ROLE = 'prime'

# 0.30.31 (WI c03c9d6a): functional kind, distinct from role. PA is
# both role='prime' and kind='prime' - they collapse for this session
# type. Kept as a separate field so consumers can gate on kind uniformly
# alongside SAs and discord-bot sessions without role-special-casing.
$env:ORCHESTRATOR_SESSION_KIND = 'prime'
$env:SPAWNBOX_SESSION_KIND = 'prime'

# Opt into the PA-gated permission relay (0.30.17+). When set, SA permission
# requests for unallowlisted tools route through agent-channel to PA for
# authorization instead of falling back to in-terminal prompts. PA needs the
# `respond_to_permission` tool registered, which is gated on this env var.
$env:ORCHESTRATOR_PA_PERMISSION_RELAY = '1'
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
  'plugin:orchestrator@__ORCH_MARKETPLACE__',
  # 0.30.28+: PA always launches at max effort. PA is the singleton
  # orchestration session - judgment calls, cross-cutting coordination,
  # holding the macro view. Token cost is the right tradeoff for the role.
  '--effort', 'max'
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
