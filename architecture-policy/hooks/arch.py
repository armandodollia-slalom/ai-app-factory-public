#!/usr/bin/env python3
"""Single executable entry point for the Architecture Policy Pack engine.

    python <factory>/architecture-policy/hooks/arch.py validate --checkpoint pre_commit
    python <factory>/architecture-policy/hooks/arch.py call get_rule '{"rule_id": "SEC-001"}'
    python <factory>/architecture-policy/hooks/arch.py --policy-dir <dir> selfcheck

The engine holds no rules. It reads the policy of the repository in the current directory from
<repo>/.factory/policy; --policy-dir / $ARCH_POLICY_DIR and --workspace / $ARCH_WORKSPACE override both.
Pre-commit, CI, the Review Agent and the Test Agent all call this (or import `architecture` directly).
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

from architecture.cli import main  # noqa: E402

if __name__ == "__main__":
    sys.exit(main())
