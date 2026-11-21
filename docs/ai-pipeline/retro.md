# Retro

**Who reads this:** C (operators) and D. How the agents' records become lessons and proposed factory changes.

The retro turns what the agents logged into changes a
person reviews: lessons for this repository's agents, and fixes to the factory itself.

```bash
factory retro run [--dry-run] [--local] [--if-due] [--no-push]
factory retro calibrate [--stage plan|automation] [--sample 3]
factory retro status
factory retro resume [--force]
```

(`factory fv lessons` and `factory fv calibrate` still work; they are the names these commands had while
the retro was part of feature verification.)

## What a run does

1. **Reads the metrics.** This checkout's `.factory/metrics/`, plus, when the
   [metrics store](../observability.md) can be read back, the records other machines and CI shipped since
   the last lessons commit on the base branch.
2. **Works out the lessons.** For each agent, from denial categories that recur across stories: add a rule,
   strengthen one whose category keeps recurring, retire one that has not been needed, revert one that made
   things worse. Thresholds are in `lessons.*`.
3. **Holds the factory retro.** A bounded digest of the decision log (why plans were written, why verifiers
   denied, what reviews found, which tests caught product bugs, how people reviewed the pipeline's PRs),
   plus what did not go through on its own (every stage's escalations from `escalations.jsonl`, runs that
   did not end done, each verifier's first score, the PR checks' rounds and upheld findings), goes to the
   `retro` agent, which may fix root causes a lessons rule cannot. Whether or not it changes anything, it
   accounts for each of those in `observations` (what happened, likely root cause, one-off or pattern),
   recorded in `.factory/metrics/retro-observations.jsonl` and printed with the run.
4. **Routes each fix by the file that would fix it:**

   | Fix | Where it goes | Paths the agent may edit |
   | --- | --- | --- |
   | A rule that holds for this codebase | this repository's lessons pull request | `.factory/lessons/`, and `lessons.retro.allowedPaths` (default `.factory/agents/`, `.factory/policy/`) |
   | A root cause every codebase would hit | a branch pushed to the factory's repository, for a person to open the pull request | `agents/`, `docs/`, `templates/`, `skills/` in the factory checkout (`retro.factory.allowedPaths`) |
   | The review gate's approvals table | this repository's pull request, written by the harness (never the agent) to `.factory/config.json` | |

   Edits anywhere else are discarded before the commit.
5. **Checks every lesson against its agent.** A lesson may narrow or add to an agent's definition, never
   contradict it. The read-only `lessons-check` agent (Sonnet) compares each rule of each lessons file with its
   agent's definition (base prompt and addendum). The harness removes the rules it finds contradicting, and the
   pull request lists them with the definition's rule quoted. A lessons file that changed since the last check
   makes a run due even when nothing else is.
6. **Delivers the changes.** This repository's lessons pull request goes through the same delivery as every
   pipeline PR (`implement.mjs` `deliverFinished`): the branch is pushed, its CI proven on the head with no
   fixing agent (a red lessons branch opens no PR), then the PR opens once, as the PR bot. Where the branch push
   runs no pipeline it opens as a draft and is marked ready only when its checks are green. The factory change is
   pushed as a branch with the developer's own `git` login, and a person opens its pull request from the compare
   repository and branch the app pull request names (the pipeline opens no PR it cannot prove CI on); without push access the change
   is saved as a patch under `.factory/state/retro/`.

## Factory issues

The retro agent can edit only the factory's agent definitions, docs, templates and skills. A root cause it places in the factory's engine (its scripts) or templates, and sees recur (`where` `engine` or `template`, `pattern` `pattern` in its observations), is filed as an issue against the factory repository (the factory checkout's `origin`), one open issue per title. Ticket keys are removed from the issue; it carries the agent's reading of what the decision log shows and of the root cause, nothing of the application's code. Nothing is filed in a dry run or with `--no-push`.

## The factory checkout

The agent works in a worktree of the app repository on a `retro/lessons-<date>` branch. When the engine is
installed from a git checkout, the run clones it into that worktree's ignored state folder
(`.factory/state/factory-src/`), on a `retro/<project>-<date>` branch, and tells the agent it is there.

| `retro.factory` setting | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | `false`: factory-level findings are only listed as proposals |
| `source` | the pin's `source`, else the install's `origin` | the repository the proposal branch is pushed to |
| `allowedPaths` | `agents/`, `docs/`, `templates/`, `skills/` | what the agent may edit there |
| `evidence` | `summary` | what the factory proposal says about the app: the agent's one-line reason per file, or `none` |

The decision log is never copied to the factory. A factory fix reaches the app when a release that
contains it is pinned: `factory upgrade <version>`, then `factory render`.

The factory running a retro on itself (install root = repository) has one root; its fixes are ordinary
edits of the lessons branch.

## Checking the factory proposal path

`factory retro selftest` checks the plumbing a factory proposal goes through, without proposing anything:
it clones the factory source the pin names (`.factory/factory.json` `source`), pushes a branch
`retro/selftest-<date>` holding one scratch file (`.retro-selftest`), checks the branch is on the remote at
the commit it pushed, then deletes it. It opens no pull request, as the retro opens none against the factory. It records each step in `.factory/metrics/retro-selftests.jsonl` and exits non-zero
when a step fails. It shows that the credentials and permissions work. It is not evidence that the retro
proposes good changes.

## Not done yet

- A factory fix is not also written as a local override in the app pull request, so it takes effect only
  after the upgrade. Until then, put the same instruction in the agent's addendum.
- There is no cross-repository promotion rule ("the same root cause in two repositories"); routing is by
  the agent's judgment and the allowed paths. A store with `scope: "all"` gives the agent the other
  repositories' records to judge from.

## Crash recovery

A run records itself in `.factory/state/lessons-run.json` and holds `locks/lessons.lock`. A run that died
is resumed on the next session start or by `factory retro resume`: from the push if it had committed,
else from the start. After `recovery.maxAttempts` it is escalated
(`.factory/state/escalations/lessons-retro.md`); `resume --force` retries it.
