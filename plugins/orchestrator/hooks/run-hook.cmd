@echo off
REM Windows wrapper for hook scripts
set "SCRIPT_DIR=%~dp0"
bash "%SCRIPT_DIR%%1" %*
