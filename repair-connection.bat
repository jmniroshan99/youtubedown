@echo off
setlocal
cd /d "%~dp0"
echo youtubedown 1.3.0 - repair local gateway startup
echo For Host could not be resolved, use repair-downloads.bat instead.
echo This recreates only the local gateway, then checks the existing stack.
echo No backend image rebuild or data reset is required.
where node >nul 2>nul
if errorlevel 1 (
  echo Install Node.js 24 before running this repair.
  pause
  exit /b 1
)
node scripts\diagnose.mjs --local --preflight
if errorlevel 1 (
  echo Fix the setup errors above first.
  pause
  exit /b 1
)
docker compose -f docker-compose.yml -f docker-compose.local.yml up -d --no-build --no-deps --force-recreate local-gateway
if errorlevel 1 (
  echo Repair could not start. If the existing backend image is missing, run start.bat for a normal build.
  pause
  exit /b 1
)
call start.bat --no-build
exit /b %errorlevel%
