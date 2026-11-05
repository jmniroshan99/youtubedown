$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$deployment = Get-Content (Join-Path $projectRoot 'frontend/src/publicDeployment.json') -Raw | ConvertFrom-Json
$frontend = 'https://' + $deployment.hostname
$supabase = $deployment.supabaseUrl.TrimEnd('/')
$callback = $frontend + '/auth/callback'
$keyLine = Get-Content (Join-Path $projectRoot 'frontend/.env.local') |
    Where-Object { $_ -match '^VITE_SUPABASE_PUBLISHABLE_KEY=' } | Select-Object -First 1
if (-not $keyLine) { throw 'Set the existing public Supabase frontend key before running this diagnostic.' }
$publicKey = ($keyLine -split '=', 2)[1].Trim().Trim('"', "'")
$cookies = New-Object Net.CookieContainer
function Read-VerifiedResponse($Address, $Headers = @{}) {
    $request = [Net.HttpWebRequest]::Create($Address)
    $request.Method = 'GET'
    $request.AllowAutoRedirect = $false
    $request.Timeout = 15000
    $request.ReadWriteTimeout = 15000
    $request.CookieContainer = $cookies
    $request.AutomaticDecompression = [Net.DecompressionMethods]::GZip -bor [Net.DecompressionMethods]::Deflate
    foreach ($name in $Headers.Keys) { $request.Headers[$name] = $Headers[$name] }
    $response = $null
    try {
        try { $response = $request.GetResponse() }
        catch [Net.WebException] {
            if (-not $_.Exception.Response) { throw 'A required HTTPS connection could not be verified or reached.' }
            $response = $_.Exception.Response
        }
        $reader = New-Object IO.StreamReader($response.GetResponseStream())
        try { $body = $reader.ReadToEnd() } finally { $reader.Dispose() }
        return [pscustomobject]@{ Status = [int]$response.StatusCode; Location = $response.Headers['Location']; Body = $body }
    } finally { if ($response) { $response.Close() } }
}
function Write-Check($Passed, $Stage, $Code) {
    Write-Host (('{0}: {1} ({2})' -f $(if ($Passed) { 'PASS' } else { 'FAIL' }), $Stage, $Code))
}
$failed = $false
Write-Host 'Checking public Auth configuration and a temporary OAuth cancellation flow.'
Write-Host 'No password, consent, account creation, email or media download is used.'
try {
    $settingsResponse = Read-VerifiedResponse ($supabase + '/auth/v1/settings') @{ apikey = $publicKey }
    if ($settingsResponse.Status -ne 200) { throw 'Public sign-in settings could not be checked.' }
    $settings = $settingsResponse.Body | ConvertFrom-Json
    foreach ($provider in @('google', 'facebook', 'email', 'anonymous_users')) {
        $enabled = $settings.external.$provider -eq $true
        Write-Check $enabled ('Provider ' + $provider) $(if ($enabled) { 'ENABLED' } else { 'DISABLED' })
        if (-not $enabled) { $failed = $true }
    }
    if ($settings.external.google -eq $true) {
        $random = New-Object byte[] 32
        $generator = [Security.Cryptography.RandomNumberGenerator]::Create()
        try { $generator.GetBytes($random) } finally { $generator.Dispose() }
        $verifier = [Convert]::ToBase64String($random).TrimEnd('=').Replace('+', '-').Replace('/', '_')
        $digest = [Security.Cryptography.SHA256]::Create()
        try { $challenge = [Convert]::ToBase64String($digest.ComputeHash([Text.Encoding]::ASCII.GetBytes($verifier))).TrimEnd('=').Replace('+', '-').Replace('/', '_') }
        finally { $digest.Dispose() }
        $start = $supabase + '/auth/v1/authorize?provider=google&redirect_to=' + [Uri]::EscapeDataString($callback) + '&code_challenge_method=s256&code_challenge=' + $challenge
        $authorization = Read-VerifiedResponse $start
        if ($authorization.Status -ne 302 -or -not $authorization.Location) { throw 'Google OAuth could not be started.' }
        $google = [Uri]$authorization.Location
        if ($google.Host -ne 'accounts.google.com') { throw 'The authorization destination was not Google.' }
        Add-Type -AssemblyName System.Web
        $query = [Web.HttpUtility]::ParseQueryString($google.Query)
        $providerCallbackCorrect = $query['redirect_uri'] -eq ($supabase + '/auth/v1/callback')
        Write-Check $providerCallbackCorrect 'Google provider callback' 'PROVIDER_CALLBACK'
        if (-not $providerCallbackCorrect) { $failed = $true }
        if (-not $query['state']) { throw 'The diagnostic OAuth flow did not return its state.' }
        $cancel = $supabase + '/auth/v1/callback?error=access_denied&state=' + [Uri]::EscapeDataString($query['state'])
        $returned = Read-VerifiedResponse $cancel
        if ($returned.Status -ne 302 -or -not $returned.Location) { throw 'The diagnostic cancellation did not return a redirect.' }
        $destination = [Uri]$returned.Location
        $returnCorrect = $destination.GetLeftPart([UriPartial]::Path) -eq $callback -and -not $destination.UserInfo
        Write-Check $returnCorrect 'Frontend OAuth return' $(if ($returnCorrect) { 'AUTH_CALLBACK_OK' } else { 'AUTH_REDIRECT_CONFIGURATION' })
        if (-not $returnCorrect) {
            $failed = $true
            Write-Host ('Set Supabase Site URL to ' + $frontend)
            Write-Host ('Keep existing Redirect URLs and add ' + $callback + ' and ' + $frontend + '/reset-password')
        }
    }
} catch {
    $failed = $true
    Write-Check $false 'Auth diagnostic' 'AUTH_SERVICE_CHECK_FAILED'
}
try {
    $health = Read-VerifiedResponse ($deployment.apiBaseUrl.TrimEnd('/') + '/health')
    $body = $health.Body | ConvertFrom-Json
    $ready = $health.Status -eq 200 -and $body.status -eq 'ready'
    Write-Check $ready 'Download backend' $(if ($ready) { 'READY' } else { 'SERVICE_UNAVAILABLE' })
    if (-not $ready) { $failed = $true }
} catch {
    $failed = $true
    Write-Check $false 'Download backend' 'SERVICE_UNAVAILABLE'
}
Write-Host 'This does not verify Google consent, a completed login, SMTP delivery or a media transfer.'
if ($failed) { exit 1 }
