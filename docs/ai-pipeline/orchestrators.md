# Stage orchestrators

**Who reads this:** B and C, when they configure who leads each stage. Every stage of a ticket is led by an
orchestrator: one agent run where judgement about who does the stage's producing work is exercised, with a written
reason. Whatever it decides, it never verifies its own work: the stage's [council](council.md) does.

| Stage | Its orchestrator | "Doing the work itself" | Delegating |
| --- | --- | --- | --- |
| implement | the `implementer` agent ([implement.md](implement.md)) | implementing the ticket itself (`self` mode) | planning subtasks for verifier pairs |
| test plan | `stage-orchestrator` | writing the test plan | the test planner (`test-planner`) |
| test automation | `stage-orchestrator` | writing the tests | the test automation agent (`test-automation`) |
| architecture review | `stage-orchestrator` | fixing the findings the council upheld, in the worktree; the council then sits again at once | returning them to the implement stage (the code agent's stop is blocked with the findings, as before) |
| PR check | `stage-orchestrator`, never the judge | fixing the upheld findings on the PR's branch | the PR check fixer (`pr-check-fixer`); findings about the production change still go back to the implement stage under `prCheck.returnToImplementation` |

The decision is made once per stage per ticket and kept across rounds and on resume. It goes to the decision log
(`decisions.jsonl`, stage `<section>-orchestrator`, decision `self` or `delegate` with its reason, pool entry, family and
effort); the implement stage's is its plan decision (`implement-plan`, `mode` and `modeReason`). An answer it cannot
read delegates, and says so. When it does the work itself it runs as itself, on its own pool entry and effort, with the
stage agent's instructions and output contract; that agent is not started. The guards and protections of that
agent's work hold for it too (`PIPELINE_AGENT_WORK` names the work: the PR check fixer's test guard, the files only
some agents may write), and a fix's protected tests are restored before the commit whoever fixed, with a council or
not. Its runs are agent runs like any other:
they count toward the ticket's budgets and are in its usage. The orchestrator also picks the stage's council, one seat too ([seats](council.md#seats)), and rules on a
split in a council discussion (`council.intercom.onSplit: orchestrator`).

## Settings

| Setting | Meaning |
| --- | --- |
| `orchestrator.model` | the `models.pool` entry every stage's orchestrator runs on (default `opus`); required |
| `orchestrator.effort` | its reasoning effort (`null`: the entry's own) |
| `<section>.orchestrator.model`, `<section>.orchestrator.effort` | one stage's own, for `implement`, `architectureReview`, `testPlan`, `testAutomation` or `prCheck` (`null`: the above) |

A name that is not in the pool fails the settings load. There is no switch to run a lone implementer instead: an
orchestrator that implements a ticket itself covers it.
