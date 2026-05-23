<#
.SYNOPSIS
Register a Windows Scheduled Task that snapshots an orchestrator plugin DB nightly.

.DESCRIPTION
Idempotent on -TaskName: re-running with the same name replaces the prior task.
The task runs the bundled snapshot-plugin-db.py via pyw.exe (windowless) when
present, falling back to python.exe. Runs as the current user when logged in;
snapshots are skipped on days when the user never logs in.

Run this helper once per DB you want backed up. The plugin uses two DBs:
  1. ~/.claude/orchestrator/global.db          (default -Source)
  2. <project>/.orchestrator/project.db        (pass -Source explicitly)
Give each install a distinct -TaskName so they don't replace each other.

.PARAMETER CloudRoot
Destination directory for snapshots. Must exist. Required.

.PARAMETER Source
Source DB file. Default: '~/.claude/orchestrator/global.db' (resolved at runtime
on Windows via $env:USERPROFILE). Override to back up a project DB.

.PARAMETER Time
Daily snapshot time, HH:mm, local TZ. Default: 04:07.

.PARAMETER TaskName
Scheduled Task display name. Default: "Claude orchestrator DB snapshot".

.PARAMETER RetainDays
Optional. After each run, delete snapshots for this same source older than N
days. Only files matching the source's <stem>-YYYY-MM-DD.db pattern in the
destination directory are eligible. Omit to keep all snapshots forever.

.EXAMPLE
.\install-snapshot-task.ps1 -CloudRoot 'C:\Users\me\OneDrive\plugin-backups'

.EXAMPLE
.\install-snapshot-task.ps1 -CloudRoot 'D:\backups\claude' `
    -Source 'D:\repos\myproj\.orchestrator\project.db' `
    -TaskName 'Claude DB nightly (myproj)' -RetainDays 30
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string] $CloudRoot,

    [Parameter(Mandatory = $false)]
    [string] $Source = '',

    [Parameter(Mandatory = $false)]
    [ValidatePattern('^([01][0-9]|2[0-3]):[0-5][0-9]$')]
    [string] $Time = '04:07',

    [Parameter(Mandatory = $false)]
    [string] $TaskName = 'Claude orchestrator DB snapshot',

    [Parameter(Mandatory = $false)]
    [ValidateRange(1, 36500)]
    [int] $RetainDays = 0
)

$ErrorActionPreference = 'Stop'

$scriptDir = $PSScriptRoot
$pyScript = Join-Path $scriptDir 'snapshot-plugin-db.py'

if (-not (Test-Path -LiteralPath $pyScript -PathType Leaf)) {
    throw "snapshot script not found next to this helper: $pyScript"
}

$resolvedCloudRoot = Resolve-Path -LiteralPath $CloudRoot -ErrorAction SilentlyContinue
if (-not $resolvedCloudRoot -or -not (Test-Path -LiteralPath $resolvedCloudRoot -PathType Container)) {
    throw "-CloudRoot does not exist or is not a directory: $CloudRoot"
}
$resolvedCloudRoot = $resolvedCloudRoot.Path

# Prefer pyw.exe (no console window). Fall back to python.exe.
$pyExe = (Get-Command pyw.exe -ErrorAction SilentlyContinue).Source
if (-not $pyExe) {
    $pyExe = (Get-Command python.exe -ErrorAction SilentlyContinue).Source
}
if (-not $pyExe) {
    throw "Neither pyw.exe nor python.exe found in PATH. Install Python 3.8+ and retry."
}

$resolvedSource = ''
if ($Source) {
    $sourcePath = Resolve-Path -LiteralPath $Source -ErrorAction SilentlyContinue
    if (-not $sourcePath -or -not (Test-Path -LiteralPath $sourcePath -PathType Leaf)) {
        throw "-Source does not exist or is not a file: $Source"
    }
    $resolvedSource = $sourcePath.Path
}

Write-Host "[install-snapshot-task] python:      $pyExe"
Write-Host "[install-snapshot-task] script:      $pyScript"
Write-Host "[install-snapshot-task] cloud-root:  $resolvedCloudRoot"
Write-Host "[install-snapshot-task] source:      $(if ($resolvedSource) { $resolvedSource } else { '<default: ~/.claude/orchestrator/global.db>' })"
Write-Host "[install-snapshot-task] time:        $Time"
Write-Host "[install-snapshot-task] task name:   $TaskName"
Write-Host "[install-snapshot-task] retain-days: $(if ($RetainDays -gt 0) { $RetainDays } else { '<keep forever>' })"
Write-Host ""

# Quote each argument that may contain spaces.
$pyArgs = @(
    '"{0}"' -f $pyScript
    '--cloud-root'
    '"{0}"' -f $resolvedCloudRoot
)
if ($resolvedSource) {
    $pyArgs += '--source'
    $pyArgs += '"{0}"' -f $resolvedSource
}
if ($RetainDays -gt 0) {
    $pyArgs += '--retain-days'
    $pyArgs += $RetainDays.ToString()
}
$argList = $pyArgs -join ' '

$action = New-ScheduledTaskAction -Execute $pyExe -Argument $argList
$trigger = New-ScheduledTaskTrigger -Daily -At $Time
$settings = New-ScheduledTaskSettingsSet `
    -StartWhenAvailable `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -MultipleInstances IgnoreNew
$principal = New-ScheduledTaskPrincipal `
    -UserId ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) `
    -LogonType Interactive `
    -RunLevel Limited

# Replace if already registered.
$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existing) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}

Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Principal $principal `
    -Description 'Nightly snapshot of the Claude orchestrator plugin DB.' | Out-Null

Write-Host "Registered scheduled task: $TaskName"
Write-Host ""
Write-Host "Verify with:"
Write-Host "  Get-ScheduledTask -TaskName '$TaskName'"
Write-Host "  Get-ScheduledTaskInfo -TaskName '$TaskName'"
Write-Host ""
Write-Host "One-off verification (run the snapshot now):"
$verifyArgs = @("'$pyScript'", "--cloud-root", "'$resolvedCloudRoot'")
if ($resolvedSource) { $verifyArgs += @('--source', "'$resolvedSource'") }
if ($RetainDays -gt 0) { $verifyArgs += @('--retain-days', $RetainDays.ToString()) }
Write-Host "  & '$pyExe' $($verifyArgs -join ' ')"
Write-Host ""
Write-Host "Note: this task runs only while you are logged in. Snapshots are skipped on"
Write-Host "      days when you never log in. For run-while-logged-out behavior, switch"
Write-Host "      the principal to -LogonType S4U (requires no stored password but only"
Write-Host "      works on domain-joined or appropriately-configured machines)."
