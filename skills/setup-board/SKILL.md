---
name: setup-board
description: "Connect the factory in this repository to its ticket board, whatever it is (GitHub Projects, Jira Cloud or Data Center, Azure Boards, GitLab issues and boards, Linear, or the team's own tracker through a custom adapter): confirm the tracker, map the pipeline's lanes, ticket types and triage fields to it, create only what is missing, and check the repository settings the review gate relies on. USE FOR: \"set up the story board\", \"connect the factory to our board\", \"use Jira (or Linear, Azure Boards, GitLab) for the tickets\", \"map our board columns\", or `factory board status` / `factory doctor` reporting that the tracker is not set up. The PR identity and branch rules are the setup-host skill."
---

# Set up the ticket board and the review gate

Stories, bugs and epics are tickets on one board. The pipeline reads them through a local cache and moves them
across the board's lanes as it works. The board can be a different product from the code host (Jira tickets for a
Bitbucket repository, Linear for a GitHub one). Everything product-specific comes from the tracker's adapter: this
skill is the same for every board.

Safety, for every board:

- Say what you are about to do before each step that changes something on the board.
- Never change, rename or delete what already exists: statuses, columns, workflows, fields, labels, other teams'
  tickets. Setup only adds what is missing, and reports what a person must add by hand.
- A board shared with other teams or repositories is never rewritten: setup gives only this repository's tickets a
  lane, and reports missing columns instead of adding them (rewriting a status field can reset every card).
- Never ask for a token's value. The config holds `${NAME}` references; the person sets the variable.

## 1. Confirm the tracker

`factory init` asked about the board (the interview: `tracker.*` answers, recorded in `.factory/interview.json`).
Read `tracker` in `.factory/config.json` (governance: it stays there, never in `app.json`; GitHub keeps its older
`board` and `tickets` keys). When it is missing or wrong, run the interview again for this part only:

```bash
factory init --interview          # Enter keeps each current value; only what changes is written
```

## 2. The board's own steps

```bash
factory board guide               # the configured tracker's setup steps: credentials, scopes, what a person creates
```

Follow what it prints, in order. It names the token variable and the scopes the features need, the lanes it will map,
the issue types and the custom fields, and what only an administrator can create (a Jira workflow status, an Azure
Boards inherited process field, a GitHub Project's single-select option). Wait until the person says each credential
variable is set, then:

```bash
factory adapter check tracker     # every operation, read-only, against the live board; report what fails
factory doctor                    # the tracker row runs board setup as a dry run: what it would create
```

## 3. Lanes, types and fields

Map each pipeline lane to the board's existing status or column, keeping the team's names: `tracker.lanes` (GitHub:
`board.columns`) with `backlog`, `ready`, `inProgress`, `testing`, `review`, `failed`, `done`. Propose a new status
only for a lane nothing matches, and say that a person adds it. Ticket types (`tracker.types`: `epic`, `story`,
`bug`, `spike`) and the review gate's triage fields (`tracker.fields`: `severity`, `impact`, `complexity`,
`fixRisk`, `confidence`, `reopens`) map the same way. A board without custom fields keeps the triage values in the
ticket's triage section (the adapter's `customFields` capability; doctor says which).

Then, once the person agrees:

```bash
factory board setup --dry-run     # every change it would make; none made
factory board setup
```

## 4. Repository settings (the owner's call; never change them yourself)

Tell the person which of these are missing and what each does (`factory doctor` reads them on any code host):

| Setting | Why |
| --- | --- |
| `review-quorum` and the CI checks required on the base branch, and code-owner review for the factory's files | enforces each pull request's `approvals:N` and that CI ran on that head, and an owner's review of any change to `.factory/` or the generated files |
| The host's auto-merge allowed | a Low-risk bug fix with high confidence merges once checks pass |
| `implement.autoMerge.enabled: false` in `.factory/config.json` | turns auto-merge off entirely |

When the person decides to enforce the gate, they run `factory review-gate enforce --dry-run`, read what it would
change, then `factory review-gate enforce`. It sets the host's own rule (a GitHub ruleset, GitLab's "Pipelines must
succeed" and code owner approval, an Azure DevOps status policy, Bitbucket's merge checks) and lists what a person
must add by hand. A code-owner rule that only the pipeline's own PR author could satisfy is left out, with a warning:
setting up the PR bot (setup-host) or naming a second owner makes it satisfiable. A host that cannot require checks at
all is reported by doctor; the review gate then refuses to merge until every expected pipeline of the head is green
on that SHA, so nothing merges early either way.

## 5. Verify

```bash
factory doctor
factory board status
factory board new                          # a first story, then delete it if the team prefers
factory implement run <KEY> --dry-run      # order, branches and bases, without starting an agent
```

When the CI system cannot start jobs on the board's events (every board but GitHub issues with GitHub Actions), the
tracker automations (epic assignees, resolved escalations) run on a schedule (`factory automations`): remind the
person to schedule the tracker job the CI templates render.
