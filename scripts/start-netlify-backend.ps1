param([switch]$Rebuild)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$frontendOrigin = 'https://youtubedownl.netlify.app'
$composeArgs = @('compose', '-f', 'docker-compose.yml', '-f', 'docker-compose.local.yml', '-f', 'docker-compose.tunnel.yml')
Push-Location $projectRoot
try {
    if (-not (Test-Path -LiteralPath 'backend/.env')) { throw 'Run the existing backend setup first. backend/.env is required.' }
    Write-Host 'Starting the existing Docker backend and a temporary HTTPS testing tunnel.'
    if ($Rebuild) { & docker @composeArgs up -d --build --quiet-pull }
    else { & docker @composeArgs up -d --quiet-pull }
    if ($LASTEXITCODE) { throw 'Docker startup failed. Keep Docker Desktop running and review the error above.' }
    $publicUrl = $null
    $retriedBootstrap = $false
    for ($attempt = 0; $attempt -lt 45; $attempt++) {
        $tunnelId = (& docker @composeArgs ps -a -q tunnel | Select-Object -First 1)
        $tunnelStatus = (& docker inspect --format '{{.State.Status}}' $tunnelId)
        if ($tunnelStatus -eq 'exited') {
            if ($retriedBootstrap) { throw 'The tunnel connector stopped before issuing an address. Inspect its safe network diagnostics.' }
            & docker @composeArgs restart tunnel | Out-Null
            if ($LASTEXITCODE) { throw 'The tunnel bootstrap retry could not start.' }
            $retriedBootstrap = $true
            Start-Sleep -Seconds 2
            continue
        }
        $startedAt = (& docker inspect --format '{{.State.StartedAt}}' $tunnelId)
        $tunnelLogs = (& docker @composeArgs logs --since $startedAt --no-color --tail 300 tunnel 2>&1 | Out-String)
        $addresses = [regex]::Matches($tunnelLogs, 'https://[a-z0-9-]+\.trycloudflare\.com')
        foreach ($address in $addresses) {
            if ($address.Value -ne 'https://api.trycloudflare.com') { $publicUrl = $address.Value }
        }
        if ($publicUrl) { break }
        Start-Sleep -Seconds 2
    }
    if (-not $publicUrl) { throw 'No temporary tunnel address was issued. Inspect the tunnel service; do not disable TLS verification.' }
    $healthy = $false
    for ($attempt = 0; $attempt -lt 12; $attempt++) {
        try {
            $health = Invoke-WebRequest -UseBasicParsing -Uri "$publicUrl/health" -Headers @{ Origin = $frontendOrigin } -TimeoutSec 12
            if (($health.Content | ConvertFrom-Json).status -eq 'ready') { $healthy = $true; break }
        } catch { }
        Start-Sleep -Seconds 2
    }
    if (-not $healthy) { throw 'The tunnel address exists, but the public backend has not passed its readiness check.' }
    $preflight = Invoke-WebRequest -UseBasicParsing -Method Options -Uri "$publicUrl/api/analyze" -Headers @{
        Origin = $frontendOrigin
        'Access-Control-Request-Method' = 'POST'
        'Access-Control-Request-Headers' = 'authorization,content-type'
    } -TimeoutSec 12
    if ($preflight.Headers['Access-Control-Allow-Origin'] -ne $frontendOrigin) {
        throw 'The public backend did not allow the exact Netlify origin.'
    }
    $runtimeRoot = Join-Path $projectRoot '.runtime'
    New-Item -ItemType Directory -Path $runtimeRoot -Force | Out-Null
    @{ url = $publicUrl; frontend_origin = $frontendOrigin; created_at = [DateTime]::UtcNow.ToString('o') } |
        ConvertTo-Json | Set-Content -LiteralPath (Join-Path $runtimeRoot 'netlify-tunnel.json') -Encoding UTF8
    # This is public endpoint metadata, never credentials or source URLs.
    # It applies only to this exact production hostname; only known retired
    # tunnel values migrate, while other VITE_API_BASE_URL values stay primary.
    $deploymentPath = Join-Path $projectRoot 'frontend/src/publicDeployment.json'
    $retiredUrls = @()
    $previous = $null
    if (Test-Path -LiteralPath $deploymentPath) {
        $previous = Get-Content -LiteralPath $deploymentPath -Raw | ConvertFrom-Json
        if ($previous.hostname -eq ([Uri]$frontendOrigin).Host) {
            $retiredUrls = @(@($previous.apiBaseUrl) + @($previous.retiredApiBaseUrls) | Where-Object {
                $_ -and $_ -ne $publicUrl -and $_ -match '^https://[a-z0-9-]+\.trycloudflare\.com$'
            } | Select-Object -Unique -First 16)
        }
    }
    $deploymentConfig = [ordered]@{ hostname = ([Uri]$frontendOrigin).Host; apiBaseUrl = $publicUrl; retiredApiBaseUrls = @($retiredUrls) }
    if ($previous -and $previous.hostname -eq ([Uri]$frontendOrigin).Host) {
        if ($previous.supabaseUrl) { $deploymentConfig['supabaseUrl'] = $previous.supabaseUrl }
        if ($previous.retiredSupabaseUrls) { $deploymentConfig['retiredSupabaseUrls'] = @($previous.retiredSupabaseUrls) }
    }
    [System.IO.File]::WriteAllText($deploymentPath, (($deploymentConfig | ConvertTo-Json) + "`n"), (New-Object System.Text.UTF8Encoding($false)))
    Write-Host ''
    Write-Host 'PASS: public HTTPS health and exact-origin CORS checks.'
    Write-Host "Set this Netlify build variable: VITE_API_BASE_URL=$publicUrl"
    Write-Host 'Public deployment fallback updated. Push the changed publicDeployment.json to GitHub to publish it, or update the Netlify variable and redeploy.'
    Write-Host 'Keep this PC and Docker Desktop running.'
    Write-Host 'This temporary address changes when a new tunnel is created. Use stop-netlify-backend.bat to close public access.'
} finally { Pop-Location }
