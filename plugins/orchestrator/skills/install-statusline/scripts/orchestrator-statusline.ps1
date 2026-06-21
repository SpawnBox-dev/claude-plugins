# Thin wrapper for orchestrator_statusline.py on Windows.
# Locates a Python 3.10+ interpreter and execs the canonical script.
# Wire into Claude Code's `statusLine` setting (on Windows):
#
#   "statusLine": {
#     "type": "command",
#     "command": "powershell -NoProfile -ExecutionPolicy Bypass -File C:\\abs\\path\\to\\orchestrator-statusline.ps1"
#   }

$ErrorActionPreference = 'Continue'

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$candidates = @($env:ORCH_PYTHON, 'python.exe', 'py.exe') | Where-Object { $_ }
$python = $null

foreach ($c in $candidates) {
  $cmd = Get-Command $c -ErrorAction SilentlyContinue
  if (-not $cmd) { continue }
  $vout = & $cmd.Source --version 2>&1
  if ($LASTEXITCODE -eq 0 -and $vout -notmatch 'Python was not found') {
    $python = $cmd.Source
    break
  }
}

if (-not $python) {
  # Don't break the Claude UI; emit a fallback line.
  Write-Output "orchestrator (python missing)"
  exit 0
}

& $python "$here\orchestrator_statusline.py"
exit 0
