# Thin wrapper for sa_start.py. See sa_start.py for documentation.

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

& $python "$here\sa_start.py" @args
exit $LASTEXITCODE
