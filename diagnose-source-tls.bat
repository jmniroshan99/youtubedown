@echo off
setlocal
cd /d "%~dp0"
echo Checking guarded DNS/TCP and verified HTTPS HEAD connections to fixed source hosts.
echo This does not download pages or videos, import certificates, or disable TLS verification.
docker compose exec -T worker python -m app.egress_check --tls
if errorlevel 1 (
  echo A source check failed. SOURCE_TLS_ERROR requires administrator review of the approved HTTPS certificate chain and network inspection policy.
  exit /b 1
)
