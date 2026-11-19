"""Arch_review_Agent - architecture review agent callable by any code agent.

    import sys; sys.path.insert(0, "<factory>/architecture-policy/agents")
    from arch_review_agent import ArchReviewAgent
    agent = ArchReviewAgent()                       # policy of the repository in the current directory
    agent = ArchReviewAgent(policy_dir="...", workspace="...", reviewer=fn)   # all optional
    agent.advise({"files": ["services/orders/api/orders.py"]})
    agent.review({"requester": {"agent": "code-agent", "task_id": "T-42"},
                  "files": {"services/orders/api/orders.py": "<proposed content>"}})

The policy is read from <workspace>/.factory/policy (or policy_dir / $ARCH_POLICY_DIR).
Also exposed as a JSON CLI and a stdio MCP server: <factory>/architecture-policy/agents/arch_review.py.
Contract: agent.json (operations + input schemas).
"""
import sys
from pathlib import Path

_HOOKS = Path(__file__).resolve().parents[2] / "hooks"
if str(_HOOKS) not in sys.path:
    sys.path.insert(0, str(_HOOKS))

from .agent import (AGENT_ID, AGENT_NAME, AGENT_OPERATIONS, AGENT_VERSION, CARD, AgentRequestError,  # noqa: E402
                    ArchReviewAgent)
from .reviewers import CallableReviewer, CommandReviewer, Reviewer  # noqa: E402

__all__ = ["ArchReviewAgent", "AgentRequestError", "AGENT_ID", "AGENT_NAME", "AGENT_VERSION", "AGENT_OPERATIONS",
           "CARD", "Reviewer", "CallableReviewer", "CommandReviewer", "review", "advise"]


def review(request: dict, reviewer=None, policy_dir=None, workspace=None) -> dict:
    return ArchReviewAgent(reviewer=reviewer, policy_dir=policy_dir, workspace=workspace).review(request)


def advise(request: dict, policy_dir=None, workspace=None) -> dict:
    return ArchReviewAgent(policy_dir=policy_dir, workspace=workspace).advise(request)
