@echo off
REM Thin shim that dispatches to pa-start.ps1 in this directory.
REM See pa-start.ps1 for full documentation and supported params.
@powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0pa-start.ps1" %*
