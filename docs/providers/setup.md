# Setting up the providers: the interview

**Who reads this:** B, answering the setup interview.

`factory init` asks about every stage the factory sets up: the code host, the ticket board (including how its lanes map to the board's statuses), the CI system, merging and reviews, the agents and their models, UI verification, observability, static analysis and a commercial scanner. What detection found (the `origin` remote, the agent CLIs installed, an existing config) is shown as the default to confirm. Nothing is assumed silently. The same questions run in three ways and give the same result for the same answers.

**Nothing secret is asked.** A credential question takes the *name* of the environment variable (or CI secret) that will hold it. The config gets a `${NAME}` reference, and an answer that looks like a token is refused. `.factory/interview.json` records the last answers (variable names only), so a re-run starts from them.

## In a terminal

```sh
factory init                 # in a terminal it interviews; Enter keeps the default shown
factory init --interview     # interview even when the config exists or stdin is not a terminal
```

The [`onboard-codebase`](../../skills/onboard-codebase/SKILL.md) skill runs the same interview conversationally and explains each choice. The [`setup-board`](../../skills/setup-board/SKILL.md) skill covers the board's own setup: lanes, fields, and what a person creates by hand on each tracker (`factory board guide` prints that tracker's steps).

## Headless

```sh
factory init --questions                         # the answer ids, kinds and choices
factory init --answers setup.json --dry-run      # what would change, path by path; writes nothing
factory init --answers setup.json                # apply
factory init --set tracker.type=jira --set tracker.project=SHOP --set tracker.token=JIRA_API_TOKEN
```

An answers file maps answer ids to values. Any question it leaves out keeps its default, the same as Enter in a terminal:

```json
{
  "host.type": "bitbucket", "host.repo": "acme/shop", "host.token": "BITBUCKET_TOKEN",
  "tracker.type": "jira", "tracker.url": "https://acme.atlassian.net", "tracker.project": "SHOP",
  "tracker.user": "JIRA_EMAIL", "tracker.token": "JIRA_API_TOKEN",
  "ci.provider": "jenkins", "ci.url": "https://jenkins.acme.io", "ci.job": "team/shop", "ci.user": "JENKINS_USER", "ci.token": "JENKINS_API_TOKEN",
  "scanner.id": "sonarqube", "scanner.mode": "server", "scanner.token": "SONAR_TOKEN", "scanner.server": "https://sonar.acme.io",
  "scanner.project": "shop", "scanner.check": "SonarQube Code Analysis", "scanner.acceptedBy": "Pat Doe (client security lead), 2026-11-17"
}
```

## Running it again

On a repository that already has `.factory/config.json`, the interview's defaults are what the config and `.factory/factory.json` hold now. Only what an answer changes is written: keys the interview does not ask about are kept as they are. Use `--dry-run` to see the change first. `--force` (rebuild the config from detection) is the only way to start over.

After the interview, `factory init` renders the CI system's files and prints what a person still does by hand for that CI system. Then run:

```sh
factory doctor                    # every configured product: variables set, API reachable, permissions, required checks
factory adapter check tracker     # each adapter's operations, read-only (then --write on a test project)
factory adapter check host
factory adapter check ci
factory board setup --dry-run     # the lanes, labels and fields the board needs
factory review-gate enforce --dry-run
```

## The questions

Generated from `scripts/factory/lib/interview.mjs`. "When it applies" questions depend on earlier answers: a Jenkins URL only with Jenkins, a scanner's check name only in server mode.

<!-- generated:interview -->
| Section | Answer id | Question | Answer | Asked |
| --- | --- | --- | --- | --- |
| Code host | `host.type` | Which code host holds this repository? | `github`, `gitlab`, `azure-devops`, `bitbucket`, `custom` | always |
| Code host | `host.url` | Its base URL (a self-managed server, GitHub Enterprise, Azure DevOps Server)? | text | when it applies |
| Code host | `host.repo` | The repository (owner/name; group/project; organization/project/repository; workspace/repository)? | text | always |
| Code host | `host.token` | The environment variable (or CI secret) that will hold the code host token? | a variable NAME | when it applies |
| Code host | `host.command` | The command that implements the code host contract (docs/providers/custom.md)? | text | when it applies |
| Ticket board | `tracker.type` | Which ticket board holds the stories? | `github`, `jira`, `azure-boards`, `gitlab`, `linear`, `custom` | always |
| Ticket board | `tracker.url` | Its URL (Jira site or Data Center base URL; Azure DevOps organization URL; GitLab server)? | text | when it applies |
| Ticket board | `tracker.project` | The project (Jira project key; Azure DevOps project; GitLab project path; Linear team key)? | text | when it applies |
| Ticket board | `tracker.board` | The board (Jira board id; Azure DevOps team; GitHub project number; blank: find or create it)? | text | always |
| Ticket board | `tracker.existing` | Use an existing board as it is (yes), or let `board setup` create the missing lanes, labels and fields (no)? Existing statuses are never renamed or removed either way. | bool | always |
| Ticket board | `tracker.shared` | Is the board shared with other teams or repositories? (setup then changes nothing that is not this repository's) | bool | always |
| Ticket board | `tracker.lanes.backlog` | The board's status or column for the pipeline's "backlog" lane? | text | always |
| Ticket board | `tracker.lanes.ready` | The board's status or column for the pipeline's "ready" lane? | text | always |
| Ticket board | `tracker.lanes.inProgress` | The board's status or column for the pipeline's "inProgress" lane? | text | always |
| Ticket board | `tracker.lanes.testing` | The board's status or column for the pipeline's "testing" lane? | text | always |
| Ticket board | `tracker.lanes.review` | The board's status or column for the pipeline's "review" lane? | text | always |
| Ticket board | `tracker.lanes.failed` | The board's status or column for the pipeline's "failed" lane? | text | always |
| Ticket board | `tracker.lanes.done` | The board's status or column for the pipeline's "done" lane? | text | always |
| Ticket board | `tracker.user` | The environment variable that will hold the Jira user (Cloud: the account e-mail; Data Center with a personal access token: leave blank)? | text | when it applies |
| Ticket board | `tracker.token` | The environment variable that will hold the board token? | a variable NAME | when it applies |
| Ticket board | `tracker.command` | The command that implements the tracker contract (docs/providers/custom.md)? | text | when it applies |
| CI system | `ci.provider` | Which CI system runs the pipelines? | `github-actions`, `gitlab-ci`, `azure-pipelines`, `jenkins`, `circleci`, `bitbucket-pipelines`, `custom` | always |
| CI system | `ci.url` | The CI server URL (Jenkins)? | text | when it applies |
| CI system | `ci.job` | The Jenkins job that builds this repository's pull requests (a Multibranch Pipeline job path, e.g. team/shop)? | text | when it applies |
| CI system | `ci.project` | The CircleCI project slug (gh/org/repo, bb/workspace/repo, or circleci/\<org id>/\<project id>)? | text | when it applies |
| CI system | `ci.user` | The environment variable that will hold the Jenkins user name? | a variable NAME | when it applies |
| CI system | `ci.token` | The environment variable that will hold the CI API token (to read runs and logs)? | a variable NAME | when it applies |
| CI system | `ci.command` | The command that implements the CI contract (docs/providers/custom.md)? | text | when it applies |
| Merging and reviews | `review.autoMerge` | May the review gate merge a Low-risk, high-confidence bug fix by itself once its CI is green on that head? | bool | always |
| Merging and reviews | `review.mergeIdentity` | Who merges: the developer's own login (gh-user), the pipeline's PR bot (bot), or an app/token with a rule bypass (app)? | `gh-user`, `bot`, `app` | when it applies |
| Merging and reviews | `review.owners` | Who owns the factory's files (code owners: handles or teams, comma-separated)? | list | always |
| Merging and reviews | `review.enforce` | Will a repository admin let `factory review-gate enforce` require review-quorum and the CI checks on the default branch? (yes: doctor warns until it is done; no: reviews are advisory and doctor says so) | bool | always |
| Agents | `agents.local` | Which agent CLIs are installed and signed in on this machine? | list | always |
| Agents | `agents.ci` | Which agent CLIs may run in CI (the PR check, the retro)? | list | always |
| Agents | `agents.default` | The default agent CLI for the pipeline's agents? | `claude`, `codex`, `copilot` | always |
| Agents | `agents.models.claude` | Which models may claude use (aliases: opus, sonnet, sol, ...; your subscription decides)? | list | when it applies |
| Agents | `agents.models.codex` | Which models may codex use (aliases: opus, sonnet, sol, ...; your subscription decides)? | list | when it applies |
| Agents | `agents.models.copilot` | Which models may copilot use (aliases: opus, sonnet, sol, ...; your subscription decides)? | list | when it applies |
| Agents | `council.seat` | Seat a council of verifiers from those CLIs and models (review and PR check)? | bool | always |
| UI verification | `browser.available` | Is a browser (Playwright) and the test stack (Docker) available for UI verification and feature videos? | bool | always |
| Observability | `metrics.sink` | Where do agent metrics go: none, directory, http, otlp or command? | `none`, `directory`, `http`, `otlp`, `command` | always |
| Observability | `metrics.target` | The store's path, URL or command? | text | when it applies |
| Observability | `metrics.token` | The environment variable that holds the store's token (blank: none)? | text | when it applies |
| Static analysis | `analysis.enabled` | Run the open-source static analysis (secrets, dependencies, security patterns) in the fix loop and CI? | bool | always |
| Static analysis | `analysis.licenceReview` | Licence review mode: default (items pending legal review stay on) or strict (they are off)? | `default`, `strict` | when it applies |
| Commercial scanner | `scanner.id` | Does the client have a commercial scanner to integrate? | `none`, `semgrep`, `codeql`, `snyk-code`, `snyk-open-source`, `sonarqube`, `checkmarx`, `veracode` | always |
| Commercial scanner | `scanner.mode` | How does it run: local (its CLI in the fix loop and CI) or server (it scans in the client's CI or SaaS; the harness waits for the result of each head)? | `local`, `server` | when it applies |
| Commercial scanner | `scanner.replaces` | Which open-source jobs does it replace (sast, sca, secrets; blank: it runs beside them, findings deduplicated)? | list | when it applies |
| Commercial scanner | `scanner.token` | The environment variable (and CI secret) that holds the scanner's token? | a variable NAME | when it applies |
| Commercial scanner | `scanner.server` | The scanner's server or tenant URL (SonarQube, Checkmarx; blank for the vendor's default)? | text | when it applies |
| Commercial scanner | `scanner.project` | The scanner's project or application name for this repository? | text | when it applies |
| Commercial scanner | `scanner.deployment` | The Semgrep deployment slug (the organisation in Semgrep AppSec Platform)? | text | when it applies |
| Commercial scanner | `scanner.check` | The exact name of the check the scanner reports on a pull request (it joins the checks a head needs before a merge)? | text | when it applies |
| Commercial scanner | `scanner.acceptedBy` | Who accepts the scanner's licence for this engagement (a named person and the date)? The tool stays off until a person is named. | text | when it applies |
<!-- /generated:interview -->
