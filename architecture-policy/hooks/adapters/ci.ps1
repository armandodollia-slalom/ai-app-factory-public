# CI/CD adapter (Windows runners). Thin wrapper only - all rules and decisions live in the policy.
# Run it from the repository under review; the policy is that repository's .factory/policy.
# Usage: ci.ps1 [extra arch.py validate args]
# The engine is found beside this file; set ARCH_ENGINE_DIR when the file is copied elsewhere.
$ErrorActionPreference = 'Stop'
$engine = if ($env:ARCH_ENGINE_DIR) { $env:ARCH_ENGINE_DIR } else { (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path }
$repoRoot = (git rev-parse --show-toplevel).Trim()
$outDir = if ($env:ARCH_OUT_DIR) { $env:ARCH_OUT_DIR } else { Join-Path $repoRoot 'artifacts/architecture' }
New-Item -ItemType Directory -Force $outDir | Out-Null
$python = if ($env:PYTHON) { $env:PYTHON } else { 'python' }
$arch = Join-Path $engine 'hooks/arch.py'
& $python -m pip install --quiet -r (Join-Path $engine 'requirements.txt')
& $python $arch selfcheck --skip-self-tests
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& $python $arch validate --checkpoint ci --caller ci --format sarif --output (Join-Path $outDir 'architecture.sarif') @args | Out-Null
$code = $LASTEXITCODE
& $python $arch validate --checkpoint ci --caller ci --no-evidence --no-history @args
exit $code
