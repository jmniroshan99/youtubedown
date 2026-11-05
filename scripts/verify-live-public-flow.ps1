param([string]$MediaUrl = 'https://raw.githubusercontent.com/mediaelement/mediaelement-files/master/big_buck_bunny.mp4')
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
Push-Location $projectRoot
try {
    $liveMounts = @()
    foreach ($relativePath in @('backend/app', 'verification/live-public-flow.py')) {
        $sourcePath = Join-Path $projectRoot $relativePath
        $liveMounts += @('--mount', "type=bind,source=$sourcePath,target=/workspace/$relativePath,readonly")
    }
    # Requires the existing guarded egress service and the verification image.
    # Real backend secrets are passed by Docker; never print or copy their values.
    docker run --rm --network videoflow_private --env-file backend/.env `
        -e HTTP_PROXY=http://egress:8080 -e HTTPS_PROXY=http://egress:8080 `
        -e NO_PROXY=redis,localhost,127.0.0.1 -e PYTHONPATH=/workspace/backend `
        @liveMounts videoflow-verification:local python /workspace/verification/live-public-flow.py $MediaUrl
    if ($LASTEXITCODE) { throw 'Live public-media verification failed. Review the safe failure category above.' }
} finally { Pop-Location }
