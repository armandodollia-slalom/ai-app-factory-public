#!/usr/bin/env bash
# CI/CD adapter (Linux runners). Thin wrapper only - all rules and decisions live in the policy.
# Run it from the repository under review; the policy is that repository's .factory/policy.
# Usage: ci.sh [extra arch.py validate args]   e.g. ci.sh --base origin/main --test-results 'artifacts/**/*.xml'
# The engine is found beside this file; set ARCH_ENGINE_DIR when the file is copied elsewhere.
set -euo pipefail
ENGINE="${ARCH_ENGINE_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
REPO_ROOT="$(git rev-parse --show-toplevel)"
OUT_DIR="${ARCH_OUT_DIR:-$REPO_ROOT/artifacts/architecture}"
mkdir -p "$OUT_DIR"
PYTHON="${PYTHON:-python3}"
"$PYTHON" -m pip install --quiet -r "$ENGINE/requirements.txt"
"$PYTHON" "$ENGINE/hooks/arch.py" selfcheck --skip-self-tests
set +e
"$PYTHON" "$ENGINE/hooks/arch.py" validate --checkpoint ci --caller ci \
  --format sarif --output "$OUT_DIR/architecture.sarif" "$@" > /dev/null
code=$?
"$PYTHON" "$ENGINE/hooks/arch.py" validate --checkpoint ci --caller ci --no-evidence --no-history "$@"
exit $code
