# CI parity

**Who reads this:** D, adding a CI job; C, reading a parity failure.

Every job of the CI workflows the factory installs (`templates/ci/github-actions/workflows/`, rendered as `.github/workflows/factory-*.yml`) has a step that runs the same check before the pipeline opens a pull request, so CI never finds what the pipeline could have. A job with no pre-PR equivalent says why. `scripts/implement/lib/ci-parity.mjs` holds the same list, and a test keeps the workflows, the code and this table in step.

Before a PR opens (single ticket and bug group), the pipeline runs every check below that has a command, against the PR base: `factory check`, `factory models check`, `factory teststack validate`, `factory arch selfcheck`, `factory fv check --changed-from <base>`, and the changed-line lint (`factory lint --base`). A failure goes back through the PR check fixing loop as a finding (at most one more fixing run); the PR body lists what ran and how it ended. The changed-line lint also runs after every implementer run and after every PR check fixer commit. `implement.ciParity: false` turns the run before the PR off.

| Workflow | Job | Before the PR | Why none |
| --- | --- | --- | --- |
| `gate.yml` | `pipeline` | parity run before the PR: factory check, factory models check, factory teststack validate (and factory teststack drift when the repository configures it) | — |
| `gate.yml` | `policy` | architecture review stage (Architecture Policy Pack), and the parity run: factory arch selfcheck | — |
| `gate.yml` | `lint` | changed-line lint after every implementer run and every PR check fixer commit, and in the parity run (same code as factory lint --base) | — |
| `gate.yml` | `feature-verification` | feature verification stage, and the parity run: `factory fv check --changed-from <base>` | — |
| `feature-verification-check.yml` | `check` | the parity run: `factory fv check --changed-from <base>` (this workflow is what gate.yml calls) | — |
| `pr-check.yml` | `check` | the PR check stage before the PR opens (fix mode) | — |
| `review-quorum.yml` | `review-quorum` | — | counts approvals from people; the review gate sets how many |
| `board-epic-assign.yml` | `sync` | — | not a pull request check (issue events) |
| `board-escalation-resolve.yml` | `resolve` | — | not a pull request check (issue comments) |
| `graphify-cache-prune.yml` | `prune` | — | not a pull request check (schedule) |
| `retro.yml` | `lessons` | — | not a pull request check (manual) |
| `tracker-sweep.yml` | `sweep` | — | not a pull request check (scheduled tracker sweep) |

## The analysis jobs

The generated `factory-analysis` workflow is not a template of this registry: its jobs come from the analysis configuration. The delivery runs each of them with CI's own script on a clean checkout of HEAD right before it pushes the branch (`scripts/implement/lib/analysis-gate.mjs`; [analysis.md](analysis.md#only-what-the-change-introduces)). Failures go through one fixing round like the other parity checks; nothing is pushed while a job still fails.

## CI on the branch before the PR

The parity run checks locally what CI will check. The real CI also runs before the PR exists ([the PR opens finished](implement.md#the-pr-opens-finished)): the pipeline pushes the story branch and waits until every pipeline a push of that branch runs has passed on that exact head; a red head gets the CI fixing round against those runs ([implement.md](implement.md#the-pr-opens-finished)), then, once, the harness's own way out: the analysis jobs run here on the same head and the secret decision table's fold or one more local fixing round, before the new head is proven. The PR opens only then. Its own runs of the same workflows reuse the push runs (a `reuse` job that verifies the push run of the same workflow on the same head passed in every job, with the base not ahead), so CI runs once per head. What only a PR runs (the review quorum, a repository's own pull-request-only workflows) runs after the open, and a failure there puts the PR on hold before any agent fixes it.
