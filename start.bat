@echo off
setlocal
cd /d "%~dp0"
echo youtubedown - local gateway startup
where node >nul 2>nul
if errorlevel 1 (
  echo Install Node.js 24 and run setup.bat first.
  pause
  exit /b 1
)
if not exist "frontend\node_modules\.bin\vite.cmd" (
  echo Run setup.bat first to install frontend dependencies.
  pause
  exit /b 1
)
node scripts\diagnose.mjs --local --preflight
if errorlevel 1 (
  echo Fix the setup errors above before starting.
  pause
  exit /b 1
)
if /I "%~1"=="--no-build" (
  docker compose -f docker-compose.yml -f docker-compose.local.yml up -d --no-build
) else (
  docker compose -f docker-compose.yml -f docker-compose.local.yml up -d --build
)
if errorlevel 1 (
  echo Backend build or startup failed. Read the error above, then run diagnose.bat.
  pause
  exit /b 1
)
node scripts\check-gateway.mjs
if errorlevel 1 (
  node scripts\diagnose.mjs --local
  echo Gateway startup failed. Read diagnostics.txt and docs\CONNECTION_FIX.md.
  pause
  exit /b 1
)
node scripts\diagnose.mjs --local --wait 120
if errorlevel 1 (
  echo The backend is not ready. Read diagnostics.txt or run diagnose.bat.
  echo The frontend was not opened. Existing containers and data were preserved.
  pause
  exit /b 1
)
start "youtubedown frontend" cmd /k npm --prefix "%~dp0frontend" run dev
echo Open http://127.0.0.1:5173 when Vite is ready.
echo If port 5173 is busy, close the old frontend terminal and run start.bat again.
pause
