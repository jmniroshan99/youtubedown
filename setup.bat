@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Install Node.js 24 LTS, then run setup.bat again.
  pause
  exit /b 1
)
where docker >nul 2>nul
if errorlevel 1 (
  echo Install Docker Desktop with WSL 2 support, then try again.
  pause
  exit /b 1
)
if not exist "frontend\.env.local" copy "frontend\.env.example" "frontend\.env.local" >nul
if not exist "backend\.env" copy "backend\.env.example" "backend\.env" >nul
call npm --prefix "%~dp0frontend" ci
if errorlevel 1 (
  echo Dependency installation failed. Read the error above.
  pause
  exit /b 1
)
echo Setup complete. Read START_HERE.md before starting.
echo Set backend\.env SUPABASE_SECRET_KEY and apply the Supabase migration.
echo Then double-click start.bat.
pause
