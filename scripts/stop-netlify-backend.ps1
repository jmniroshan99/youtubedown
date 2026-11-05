$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
Push-Location $projectRoot
try {
    docker compose -f docker-compose.yml -f docker-compose.local.yml -f docker-compose.tunnel.yml stop tunnel
    if ($LASTEXITCODE) { throw 'The tunnel could not be stopped. Check Docker Desktop.' }
    $stateFile = Join-Path $projectRoot '.runtime/netlify-tunnel.json'
    if (Test-Path -LiteralPath $stateFile) { Remove-Item -LiteralPath $stateFile }
    Write-Host 'Public tunnel stopped. Existing local backend services and volumes are retained.'
} finally { Pop-Location }
