@echo off
REM Thin shim that dispatches to sa-start.ps1 in this directory.
REM See sa-start.ps1 for full documentation and supported params.
@powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0sa-start.ps1" %*
