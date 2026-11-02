@echo off
setlocal
cd /d "%~dp0"
echo youtubedown - apply application, API and worker update
echo This rebuilds the API, worker, scheduler and egress code, then recreates affected services.
echo Finish or cancel active jobs first. No accounts, records or volumes are deleted.
where node >nul 2>nul
if errorlevel 1 (
  echo Install Node.js 24 and run setup.bat first.
  pause
  exit /b 1
)
node scripts\diagnose.mjs --local --preflight
if errorlevel 1 (
  pause
  exit /b 1
)
docker compose -f docker-compose.yml -f docker-compose.local.yml up -d --build
if errorlevel 1 (
  echo Backend update failed. Read the Docker error above.
  pause
  exit /b 1
)
echo Checking source-host DNS through the guarded proxy from the worker...
docker compose -f docker-compose.yml -f docker-compose.local.yml exec -T worker python -m app.egress_check
if errorlevel 1 (
  echo Egress check did not pass. See docs\CONNECTION_FIX.md for the reported category.
  echo The app will still perform its normal API readiness and CORS checks.
)
call start.bat --no-build
exit /b %errorlevel%
