#!/usr/bin/env sh
# Git pre-commit adapter. Call it from the repository's own pre-commit hook (for example .githooks/pre-commit):
#   exec "$FACTORY_HOME/architecture-policy/hooks/adapters/pre-commit.sh" "$@"
# The engine is found beside this file; set ARCH_ENGINE_DIR when the file is copied or symlinked elsewhere.
# The policy is the repository's own (.factory/policy); without one the engine reports that and exits 0.
# Thin wrapper only - all rules and decisions live in the policy.
set -e
ENGINE="${ARCH_ENGINE_DIR:-$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)}"
PYTHON="${PYTHON:-python3}"
command -v "$PYTHON" >/dev/null 2>&1 || PYTHON=python
exec "$PYTHON" "$ENGINE/hooks/arch.py" validate \
  --checkpoint pre_commit --caller git-pre-commit --no-evidence "$@"
