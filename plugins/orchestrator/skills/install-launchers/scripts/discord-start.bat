@echo off
REM Thin shim that dispatches to discord-start.ps1 in this directory.
REM See discord-start.ps1 for full documentation.
@powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0discord-start.ps1" %*
