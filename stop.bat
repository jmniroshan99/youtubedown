@echo off
cd /d "%~dp0"
docker compose -f docker-compose.yml -f docker-compose.local.yml stop
echo Backend stopped. Close the youtubedown frontend terminal to stop Vite.
echo Your Redis volume has been preserved.
pause
