---
name: council
description: "Review a change as a council of independent verifiers from several models and CLIs, not one. USE FOR: \"council\", \"review this as a council\", \"get other models' opinions on this branch\", and every verification stage of the AI pipeline. Members, lenses, CLIs, models, pass score and rounds come from `council` in `.factory/config.json`."
---

# Council

A council is several verifiers who review the same change independently, each
through one lens, on different models and CLIs. You are the orchestrator or
one member. Your task says which. In the pipeline the harness is the
orchestrator and starts you as a member.

The structure follows the council skill of t3dotgg/tstack
(https://github.com/t3dotgg/tstack/blob/main/skills/council/SKILL.md).

## Before the council sits (orchestrator)

Fix known issues first: outstanding review comments, failing checks, findings
you already agree with. Run the build, lint and the relevant tests. Give the
council the updated change; do not hold known fixes until reviews return. If
the plan is to discard the implementation and try another approach, skip
fixes to code that is being replaced.

## Seating (orchestrator)

- Seat the members `council` configures for this stage: each with its own
  CLI, model, reasoning effort and lens. If the user names members, use those.
  With no configuration, use one flagship model from each of three different
  providers, at high effort.
- Start all members in parallel. Give each the request, the ticket, the diff
  and this file. Members are read-only.
- If a member's CLI or model is unavailable, report it. Never substitute
  another model. `onUnavailable` says whether the round fails or goes on
  without that member.
- Do not wait idle. When a result arrives, check its findings against the
  code at once and decide what to fix while the others run. Do not edit a
  checkout a member is still reviewing.
- Do not wait for a member marked `blocking: false`. Treat its late result as
  feedback and do not record its score.

## What every member must know

1. **This is a feature branch. None of this code is precious.** Everything
   the branch adds or changes can be deleted and written again. Do not protect
   work because it exists. If a better implementation is possible by deleting
   what the branch did and writing it another way, say so (see "Rewrite").
   This covers the branch's own changes only. Code already on the base branch
   is outside the ticket unless the ticket names it.
2. **No nits.** Style, naming and preference that touch none of the
   acceptance criteria, correctness, security or the mockup are not findings.
   If you must mention one, give it `severity: "minor"`. Minor never blocks
   and never lowers your score.
3. **No major scope creep.** Judge the change against the ticket: its
   acceptance criteria, its `owns`, its mockup. Never ask for features,
   refactors or fixes outside them. A real problem outside the ticket is a
   `followUp`, not a finding. A change that resolves a finding the council
   upheld in an earlier round is required by that finding: it is in scope.
4. **Evidence or nothing.** Every finding names a file and line, a command
   and its output, or a screenshot. A suspicion you cannot prove is a
   question. The harness enforces this at the merge: a finding with none of
   them (a test case id, a named test in a file or a region to delete also
   locate one) never blocks and never starts a fix cycle; it is recorded as
   a question.
5. **Work alone.** Do not read other members' output. Do not start
   subagents. Do not edit files.

## Lenses

| Lens | Look for |
| --- | --- |
| `correctness` | Wrong results, edge cases, error paths, concurrency, numeric bounds, defects the change itself introduces. |
| `acceptance` | Each Expected and acceptance line: met, partly met, unmet or unverifiable. Anything not fully met blocks. |
| `security` | Authorization weaker than the ticket states, secrets, injection, data exposure. |
| `test-value` | Tests that add bloat. See "Useless tests". |
| `rewrite` | A simpler design. See "Rewrite". |
| `ui` | The running app against the mockup, with screenshots. |

## Useless tests

Every member watches for these; the `test-value` member hunts them. A test is
useless when deleting it would let no plausible bug through:

- it asserts what the compiler, the framework or a mock already guarantees;
- it repeats another test with different literals and no new branch;
- it tests a getter, a constructor or a constant;
- it mocks the thing under test, so it only checks the mock;
- it restates the implementation line by line and breaks on any refactor.

Raise each as a finding with `action: "delete-test"`, the test's name, and
one sentence on which bug would still be caught without it. These findings
are `major`: bloat is a defect here, not a nit.

Never propose deleting:

- a test that is the only cover for an acceptance line or an error path;
- a regression test kept for an upheld finding (`kept-for` in the plan);
- a test that belongs to another story.

## Rewrite

If the branch's approach is wrong or needlessly complex, propose replacing
it. A rewrite proposal is one finding with `action: "rewrite"` and:

- what to delete (files or regions the branch added or changed);
- the new approach in five lines or fewer;
- why it is better for this ticket: fewer moving parts, fewer files, an
  existing pattern in the repository reused, a defect class removed;
- which acceptance lines it covers, to show it stays inside the ticket.

A rewrite must deliver the same ticket and nothing more. "While we are here"
is scope creep. A rewrite that needs code outside the ticket's `owns` is a
`followUp`.

## Member output

End with one line:

`AGENT_RESULT: {"score": <0-10>, "verdict": "APPROVED" | "CHANGES_REQUESTED", "findings": [...], "disputes": [...], "followUps": [...]}`

Each finding: `id`, `lens`, `severity` (`blocking` | `major` | `minor`),
`action` (`fix` | `delete-test` | `rewrite`), `title`, `evidence`, `where`.
Keep a finding's `id` whenever you raise it again. Score the change against
the ticket through your lens. If you cannot score it, say why and give no
score.

## Rounds

- One full review pass by the council is one round. A fresh review after
  fixes starts a new round.
- The council passes when every blocking member scores `passScore` or more
  and no blocking finding stands.
- At most `rounds` rounds. If the council has not passed by then, stop and
  escalate to a person with the open findings. Do not keep going.
- From round 2 a member's task lists the implementer's disputes: findings it
  did not act on because it calls them a nit or out of scope. Rule on each:
  `accepted` (drop it) or `reasserted` with new evidence. A finding
  reasserted twice can no longer be disputed. A disputed finding raised again
  without evidence does not block.

## Merging results (orchestrator)

1. Merge findings that name the same defect; keep every member's evidence.
2. Drop findings that break rules 2 or 3 above, and say which rule.
3. Apply `blockOn` to decide what blocks.
4. When members contradict each other, state both positions and decide with
   evidence, or escalate as an owner question. Never pick one silently.
5. An upheld `rewrite` replaces the fix list for the regions it deletes: do
   not patch code that is about to go.
6. A later round does not undo an earlier one silently. A scope objection to
   the fix of a finding upheld in an earlier round stands until the blocking
   members, asked fresh whether the agreed fix requires that behaviour, all
   answer yes with evidence (adjudication); only then is it a note. A blocking
   finding that asks for no change is a note.
7. Summarise the useful findings, the disagreements and the next steps.
8. Do not let repeated reviews widen the work. It is your job to fight to
   keep the scope to the ticket.

## Pull request

If the work ends in a pull request, put the results in its description,
before the model and harness line at the end:

```markdown
## Council review

Rounds: 2

| Member | Round 1 | Round 2 |
| --- | --- | --- |
| opus (claude) | 7/10 | 9/10 |
| sol (codex) | 8/10 | 10/10 |
| tests (copilot) | 7/10 | 9/10 |
```

Write `no score` when a member gave none. Never invent one. Edit the
description of an open PR; do not post a comment for this. With no PR, put
the same table in the final reply.

## By hand

`factory council review [--stage <stage>] [--base <ref>]` seats the
configured council on the current branch and prints the merged result.
Without the factory, you are the orchestrator: start one read-only subagent
per member with the harness's own tools, and follow this file.
