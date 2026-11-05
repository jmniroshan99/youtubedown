@echo off
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-netlify-backend.ps1" %*
if errorlevel 1 exit /b 1
