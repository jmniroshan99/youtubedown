@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Install Node.js 24, then try again.
  pause
  exit /b 1
)
node scripts\diagnose.mjs --local
set "DIAG_EXIT=%errorlevel%"
pause
exit /b %DIAG_EXIT%
