@echo off
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\verify-website-support.ps1"
if errorlevel 1 exit /b 1
