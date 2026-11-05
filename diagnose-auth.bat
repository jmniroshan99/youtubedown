@echo off
setlocal
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\diagnose-auth.ps1
exit /b %errorlevel%
