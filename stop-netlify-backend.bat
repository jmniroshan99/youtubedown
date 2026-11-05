@echo off
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\stop-netlify-backend.ps1"
if errorlevel 1 exit /b 1
