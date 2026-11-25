# Retro

**Who reads this:** C (operators) and D. How the agents' records become lessons and proposed factory changes.

The retro turns what the agents logged into changes a
person reviews: lessons for this repository's agents, and fixes to the factory itself.

```bash
factory retro run [--dry-run] [--local] [--if-due] [--no-push]
factory retro calibrate [--stage plan|automation] [--sample 3]
factory retro scorecard [--check]
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
   | A rule that holds for this codebase | this repository's lessons pull request | `.factory/lessons/`, and `retro.allowedPaths` (default `.factory/agents/`, `.factory/policy/`) |
   | A root cause every codebase would hit | a branch pushed to the factory's repository, for a person to open the pull request | `agents/`, `docs/`, `templates/`, `skills/` in the factory checkout (`retro.factory.allowedPaths`) |
   | The review gate's approvals table | this repository's pull request, written by the harness (never the agent) to `.factory/config.json` | |

   Edits anywhere else are discarded before the commit.
5. **Checks every lesson against its agent.** A lesson may narrow or add to an agent's definition, never
   contradict it. The read-only `lessons-check` agent (Sonnet) compares each rule of each lessons file with its
   agent's definition (base prompt and addendum). The harness removes the rules it finds contradicting, and the
   pull request lists them with the definition's rule quoted. A lessons file that changed since the last check
   makes a run due even when nothing else is.
6. **Writes the council scorecard.** After the agent, the harness computes the [scorecard](#council-scorecard) from
   the council records and writes it to `<lessonsDir>/scorecard.json`, over any edit the agent made to it. A
   scorecard the records would change makes a run due even when nothing else is.
7. **Delivers the changes.** This repository's lessons pull request goes through the same delivery as every
   pipeline PR (`implement.mjs` `deliverFinished`): the branch is pushed, its CI proven on the head with no
   fixing agent (a red lessons branch opens no PR), then the PR opens once, as the PR bot. Where the branch push
   runs no pipeline it opens as a draft and is marked ready only when its checks are green. The factory change is
   pushed as a branch with the developer's own `git` login, and a person opens its pull request from the compare
   repository and branch the app pull request names (the pipeline opens no PR it cannot prove CI on); without push access the change
   is saved as a patch under `.factory/state/retro/`.

## Council scorecard

How each model does in each lens and stage, by plain arithmetic over the council records
([council.md](council.md#records)): `council-rounds.jsonl` (who sat), `council-findings.jsonl` (findings, outcomes,
misses) and the members' rows of `token-usage.jsonl`. No agent writes or edits its numbers; the retro agent may add
short notes to the lessons files, which never change them. It is per repository (records another repository shipped
to a store with scope `all` are left out) and starts empty. The stage orchestrators read it when they pick a council
([seats](council.md#seats)), and every `council.selection` event quotes its version.

One row per model, lens and stage:

| Field | What it counts |
| --- | --- |
| `seats` | the councils (ticket, stage and subtask) the model sat on with that lens, once however many rounds; a council of one counts its verifier (lens `all`), and the PR check's panel each critic, by the council lens it judges |
| `judged`, `upheld`, `upheldRate` | the row's findings with an outcome; those upheld (a PR check judge's `upheld`, another stage's `led-to-change`); the share upheld |
| `unique` | upheld findings no other member of the same council raised: members are compared within a ticket, never across tickets |
| `misses`, `lowWeightMisses` | problems found after a council the model sat on passed; the lower-weight ones (a person's "changes requested", a later bug ticket) apart |
| `tokensPerUpheld`, `secondsPerUpheld` | the row's member runs per upheld finding (seconds once per run); a run counts for the model it ran on, by its seat (ticket, stage, seat name, a PR check's check run) and its own entry or model |
| `score` | (upheld × the stage's weight − misses × `miss` − lower-weight misses × `lowWeightMiss`) / seats; the stage's weight is `prCheckRuling` for the PR check and `ledToChange` for the others |

A row with fewer seats than `council.scorecard.minSeats` (default 10) is `unknown`: its numbers are `null`, and it is
neither good nor bad for selection. The weights are `council.scorecard.weights.prCheckRuling` (1.0), `.miss` (1.0),
`.ledToChange` (0.5) and `.lowWeightMiss` (0.25).

Beside the rows, `bias`: per PR check judge family, the upheld rate of the judge's own rulings on findings raised by
members of the same family (`sameFamily`) and of other families (`otherFamilies`); an outcome the harness decided (no
ruling, or a ruling it reversed) is not the judge's and is left out.

The file holds no timestamp, so the same records give the same file. Its `version` is a hash of its content and
`inputs` a hash of the records it was computed from. It is pipeline-owned, like the lessons: agent tools cannot write
it (the [factory guard](../internals.md#guards) protects `.factory/lessons`), and the retro stage's `pre-push` hook
refuses a push that changes it by hand: one whose version does not match its content, or, when this checkout holds
the records it was computed from, whose numbers differ from theirs.

```bash
factory retro scorecard          # compute it from the records and write it
factory retro scorecard --check  # exit 1 unless the file is the pipeline's own and matches the records
```

## Writer clean-code rules

The writing agents carry a short clean-code core and a small set of the [`clean-code`](../../skills/clean-code/SKILL.md)
rules ([agents.md](agents.md#clean-code)). Which rules is decided by the retro, by arithmetic over the traces, never by
an agent: the set lives in `.factory/lessons/clean-code-writers.json`, a pipeline-owned file committed with the
lessons, and the next writer task carries exactly its rules (`writer-rules.mjs`).

Each retro reads one window: the records after the previous ledger's last one (all of them the first time). Per rule:

- **Breach cost:** its upheld clean-code findings on writers' work (the clean-code seat's findings citing it, upheld by
  the PR check judge or that led to a change) times the mean cost and time of a writer fix run (a writer run after the
  first round; with none measured, a writer run).
- **Carry cost:** the tokens its text adds to a writer task (four characters a token), times the writer runs, at the
  writers' measured price per prompt token.
- **Accuracy:** the writers' first-round pass rate on it (first-round sittings with no upheld finding citing it) while
  carried and while not, by the set each round recorded (`writerRules` in `council-rounds.jsonl`).

The decisions, each only with at least `retro.writerRules.minSamples` (default 10) first-round sittings on writers'
work in the window; with fewer, nothing changes, the window stays open so the evidence builds up, and the report says
the evidence is insufficient:

- **Add** a rule outside the set when its breach cost exceeds its carry cost.
- **Remove, on probation,** a carried rule with no upheld breach in the window. If in the trial window (the next one)
  its breach cost returns above its carry cost, it is put back and cannot be removed for two windows; otherwise it
  stays out.
- **Density:** when the last change added rules and the writers' first-round pass rate on all rules has fallen since,
  the carried rule with the lowest net value (breach cost minus carry cost) is removed first.
- At most `retro.writerRules.maxChangesPerRetro` (default 2) changes a retro, the largest net value first, so each
  change's effect can be measured before the next; the others are listed as deferred.

There is no size limit: the numbers alone decide how many rules writers carry. `SCOPE` (change only what the task owns)
is not a clean-code rule: it is never weighed and never removed. The business rules of the proven-rules epic
(`rules/`, `RULE-<n>`) belong to the owner: the retro never reads, adds, removes or changes them. The same traces give
the same decisions and the same file. Every change, deferral or insufficient window is a record in
`writer-rules.jsonl` (the rule, add, remove or restore, the numbers behind it and the window), the file and the
records are committed with the retro's other files, and the retro report has a "Writer clean-code rules" section.

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
else from the start. After `recovery.maxRetries` it is escalated
(`.factory/state/escalations/lessons-retro.md`); `resume --force` retries it.
