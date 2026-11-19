#!/usr/bin/env python3
"""Entry point for Arch_review_Agent (callable by any code agent).

    python <factory>/architecture-policy/agents/arch_review.py review '{"requester": {"agent": "code-agent"}, "base": "origin/main"}'
    python <factory>/architecture-policy/agents/arch_review.py advise '{"files": ["services/orders/api/orders.py"]}'
    python <factory>/architecture-policy/agents/arch_review.py review request.json      # or '-' for stdin
    python <factory>/architecture-policy/agents/arch_review.py mcp                      # stdio MCP server
    python <factory>/architecture-policy/agents/arch_review.py card                     # agent.json contract

Options (anywhere on the command line):
    --policy-dir <dir>   policy content; default $ARCH_POLICY_DIR, else <workspace>/.factory/policy
    --workspace <dir>    repository under review; default $ARCH_WORKSPACE, else the git top level of the current directory

JSON in, JSON out. Exit codes: 0 PASS/WARN, 1 BLOCK, 2 error. A repository without a policy gets exit 0 and
{"status": "not_configured", "decision": "NOT_CONFIGURED", ...}: nothing is enforced.
"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
for stream in (sys.stdout, sys.stdin):
    if hasattr(stream, "reconfigure"):
        stream.reconfigure(encoding="utf-8")

from arch_review_agent import AGENT_OPERATIONS, CARD, ArchReviewAgent  # noqa: E402  (puts the engine's hooks/ on sys.path)
import architecture  # noqa: E402

OPTIONS = {"--policy-dir": "policy_dir", "--workspace": "workspace"}


def _load(value: str):
    if value == "-":
        return json.load(sys.stdin)
    p = Path(value)
    if len(value) < 260 and p.is_file():
        return json.loads(p.read_text(encoding="utf-8"))
    return json.loads(value)


def _options(argv: list[str]) -> tuple[list[str], dict]:
    """Split --policy-dir/--workspace (as `--opt value` or `--opt=value`) from the positional arguments."""
    rest, where, i = [], {}, 0
    while i < len(argv):
        name, eq, value = argv[i].partition("=")
        if name in OPTIONS and (eq or i + 1 < len(argv)):
            where[OPTIONS[name]] = value if eq else argv[i + 1]
            i += 1 if eq else 2
        else:
            rest.append(argv[i])
            i += 1
    return rest, where


def main(argv: list[str]) -> int:
    usage = (f"usage: arch_review.py [--policy-dir <dir>] [--workspace <dir>] "
             f"({'|'.join(sorted(AGENT_OPERATIONS))}) [request-json|file|-] | mcp | card")
    if not argv or argv[0] in ("-h", "--help"):
        print(usage)
        return 0 if argv else 2
    argv, where = _options(argv)
    if not argv:
        print(usage)
        return 2
    op = argv[0]
    if op == "mcp":
        from arch_review_agent.mcp_server import serve
        return serve(**where)
    if op == "card":
        print(json.dumps(CARD, indent=2))
        return 0
    try:
        request = _load(argv[1]) if len(argv) > 1 else {}
        out = ArchReviewAgent(**where).call(op, request)
    except architecture.NoPolicyConfigured as exc:
        print(json.dumps(architecture.not_configured(exc), indent=2))
        return 0
    except Exception as exc:
        print(json.dumps({"error": type(exc).__name__, "message": str(exc), "usage": usage}), file=sys.stderr)
        return 2
    print(json.dumps(out, indent=2, default=str))
    return 1 if op == "review" and out.get("decision") == "BLOCK" else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
