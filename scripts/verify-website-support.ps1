$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
Push-Location $projectRoot
try {
    docker compose build api worker scheduler egress
    if ($LASTEXITCODE) { throw 'Production image build failed.' }
    docker build -f backend/Dockerfile.verify -t videoflow-verification:local backend
    if ($LASTEXITCODE) { throw 'Verification image build failed.' }
    # Mount source and fixtures only. Never give the test container real .env files.
    $testMounts = @()
    foreach ($relativePath in @('backend/app', 'backend/tests', 'egress', 'backend/pyproject.toml', 'backend/requirements.in', 'backend/requirements.txt', 'backend/requirements-dev.txt')) {
        $sourcePath = Join-Path $projectRoot $relativePath
        $testMounts += @('--mount', "type=bind,source=$sourcePath,target=/workspace/$relativePath,readonly")
    }
    docker run --rm --network none @testMounts videoflow-verification:local python -m pytest -q -p no:cacheprovider
    if ($LASTEXITCODE) { throw 'Backend tests failed.' }
    docker run --rm --network none @testMounts videoflow-verification:local ruff check app tests /workspace/egress/proxy.py --no-cache
    if ($LASTEXITCODE) { throw 'Backend lint failed.' }
    Push-Location frontend
    try {
        npm ci
        if ($LASTEXITCODE) { throw 'Frontend dependency installation failed.' }
        npm run build
        if ($LASTEXITCODE) { throw 'Frontend production build failed.' }
        npm run lint
        if ($LASTEXITCODE) { throw 'Frontend lint failed.' }
        npm test
        if ($LASTEXITCODE) { throw 'Frontend tests failed.' }
    } finally { Pop-Location }
} finally { Pop-Location }
