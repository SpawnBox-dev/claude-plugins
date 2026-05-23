# Thin wrapper for pa_start.py. Locates a Python 3.10+ interpreter
# (honoring $env:ORCH_PYTHON override and detecting the Microsoft Store
# stub) and execs the canonical Python launcher. See pa_start.py for
# documentation and supported CLI flags.

$ErrorActionPreference = 'Stop'

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
  Write-Host "ERROR: Python 3.10+ not found." -ForegroundColor Red
  Write-Host "Install via:" -ForegroundColor Red
  Write-Host "  winget install Python.Python.3.12" -ForegroundColor Red
  Write-Host "  - or python.org installer" -ForegroundColor Red
  Write-Host "  - or Microsoft Store (the real Python 3.x app, not the App Execution Alias stub)" -ForegroundColor Red
  Write-Host "Or set `$env:ORCH_PYTHON to a working interpreter." -ForegroundColor Red
  exit 127
}

& $python "$here\pa_start.py" @args
exit $LASTEXITCODE
