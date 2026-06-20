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
  # Opt back into the PA-gated permission relay capability (default OFF
  # since 2026-06-11 - see the relay block below, WI f0d66029).
  [switch]$PermissionRelay,
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
    # Layered name resolution (0.30.56, WI f0d66029 follow-up):
    #   1. Transcript grep for the literal /rename stdout line - the original
    #      mechanism, unchanged and tried FIRST (covers in-app /rename names).
    #   2. The session-start hook's append-only launch-name map
    #      (.orchestrator-state/session-names.tsv: <utc-ts> TAB <uuid> TAB <name>)
    #      - covers LAUNCH-TIME names (--name), which CC records nowhere
    #      durable. If the name maps to multiple distinct session ids we list
    #      the candidates and refuse to guess.
    # Match Claude Code's project-dir → hash transform: literal char-for-char
    # substitution. CC does NOT collapse consecutive dashes (the `C:\` prefix
    # produces `C--` in the hash).
    $projectHash = $ProjectDir -replace '[\\/:]', '-' -replace '^-+', '' -replace '-+$', ''
    $jsonlDir = Join-Path $env:USERPROFILE ".claude\projects\$projectHash"
    $resolvedUuid = ''

    if (Test-Path $jsonlDir) {
      $foundSessions = Get-ChildItem -Path $jsonlDir -Filter '*.jsonl' -File | Where-Object {
        Select-String -Path $_.FullName -SimpleMatch "Session renamed to: $Resume" -Quiet
      }
      if ($foundSessions) {
        $resolvedUuid = ($foundSessions | Sort-Object LastWriteTime -Descending | Select-Object -First 1).BaseName
      }
    }

    if (-not $resolvedUuid) {
      $nameMap = Join-Path $ProjectDir ".orchestrator-state\session-names.tsv"
      if (Test-Path $nameMap) {
        # Parse defensively: require 3 tab-separated fields and a valid uuid;
        # malformed lines are skipped. File order is append order.
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

# PA-gated permission relay (0.30.17+) - now OPT-IN via -PermissionRelay.
# DEFAULT OFF since 2026-06-11 (WI f0d66029): on CC 2.1.17x, declaring the
# `claude/channel/permission` capability kills the MCP's ENTIRE channel-
# injection path (SA receives no <channel> events at all - verified by A/B
# test COMMS-TEST-3 vs COMMS-TEST-4), and CC no longer delivers
# permission_request notifications anyway. Use -BypassPermissions for
# unattended SAs until the relay is re-validated on a fixed CC build.
if ($PermissionRelay) {
  $env:ORCHESTRATOR_PA_PERMISSION_RELAY = '1'
} else {
  Remove-Item Env:ORCHESTRATOR_PA_PERMISSION_RELAY -ErrorAction SilentlyContinue
}
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
