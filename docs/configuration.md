# Configuration

**Who reads this:** B and C, looking up a setting. Everything the factory knows about a codebase is in that repository's `.factory/` folder; the engine holds only language-neutral defaults. Each stage page explains its settings in context; this page lists them all, and the files the factory writes into a repository.

## What ends up in the app repository

| Where | What | Owner |
| --- | --- | --- |
| `.factory/config.json` | the project model and every setting (this page) | the team, through the skills |
| `.factory/app.json` | the application's topology (services, ports, test roots) | the team and the agents that add services |
| `.factory/factory.json` | the engine version this repository pins, the agent tools and features in use | the team |
| `.factory/agents/`, `lessons/`, `policy/` | agent addenda, learned rules, architecture rules | the team and the retro |
| `.factory/stack/`, `plans/` | compose file, scenarios, test plans | the pipeline's agents |
| `.factory/metrics/` | the agents' records, one file per branch and stream | the pipeline |
| `.factory/state/` | runs, logs, ticket cache, the main checkout's metrics spool (ignored by git) | the machine |
| `.factory/bin/`, `githooks/`, `manifest.json` | the launcher that finds the engine, git hooks, the list of generated files | generated |
| `.claude/`, `.codex/`, `.gemini/`, `.cursor/`, `.mcp.json`, the CI files (`.github/workflows/factory-*.yml`, `.gitlab/ci/factory-*.yml` with an include block in `.gitlab-ci.yml`, `.azure-pipelines/factory-*.yml`, or the factory's file for Jenkins, CircleCI or Bitbucket Pipelines with `.factory/ci/factory-ci.sh`), the e2e fixtures with the `demoVideo` feature, blocks in `AGENTS.md` and `.gitattributes` | what the agent tools and CI require at fixed paths | generated; only the factory's entries |

Generated files are never edited by hand: `factory check` (run in CI) fails when one was, and `factory render`
writes them again. `factory uninstall` removes everything in the manifest, which is how you prove the application
does not depend on the factory. Pipeline agents are blocked from editing the factory's files (the
[factory guard](#factory-guard-factoryguard)); only the retro may. Tests the pipeline writes live in the
application's own test tree, tagged with their ticket, and belong to the team.

## Where settings come from

Later entries override earlier ones. Objects merge key by key; a list replaces the default list.

1. `scripts/pipeline/config.json` in the factory: settings every stage shares.
2. `scripts/<stage>/config.json` in the factory: each stage's defaults.
3. `<repo>/.factory/config.json`: the repository's overlay. Drafted by `factory init`, then yours.
4. `<repo>/.factory/app.json`: the application's topology, merged on top of config.json. Only these keys: `project.services`, `project.frontendPaths`, `project.testRoots`, `stack.ports`, `stack.urls`, `stack.baseUrl`, `stack.env`, `stack.services` (`project`, `image`, `inputs` per service), `stack.rebuildAll`, `stack.publishAppHost`, `stack.publishOverrides` (the test-only overrides of a published stack), `teststack.services`, `teststack.stores`, `teststack.infrastructureServices`, `teststack.restartAfterLoad`, `policy.services` (NEW services for the architecture policy: id, the roots of their projects, the datastores they own; a project's class is derived from the project itself: docs/architecture-policy.md, "Who classifies a project"). The agents that change the application may change it with the file-editing tools (a story that adds a service registers it here; the factory guard checks each edit and the file after every run, and refuses shell commands that write it). Any other key fails loading, except under `policy`: the policy engine reports a bad declaration there as TOPOLOGY-001, and `policy` is not merged into the settings. Models, gates, review, policy, the guard and every command the engine runs are governance and stay in config.json, which only people and the retro change. `factory config split` moves the topology keys of an older config.json here.
5. Environment variables and `git config` switches, for one shell or one developer (listed at the end).

Three sections of the overlay (`lsp`, `stack`, `teststack`) belong to tools with their own defaults (`scripts/lsp/config.json`, `scripts/stack/config.json`, `scripts/teststack/config.json`) and merge the same way.

`examples/eshop/.factory/config.json` is a complete overlay for a large multi-service repository.

## The pin: `.factory/factory.json`

```json
{
  "source": "https://github.com/your-org/ai-app-factory",
  "version": "0.1.0",
  "features": { "lsp": true, "graphify": false, "ci": true, "agentFiles": true, "gitHooks": true, "demoVideo": false }
}
```

| Key | Meaning |
| --- | --- |
| `version` | the factory version this repository is rendered with. `factory doctor` reports a mismatch with the installed engine; `factory upgrade` moves the pin and renders again |
| `source` | where the factory comes from: used in the install hint and as the repository the retro pushes its factory proposal branches to (a person opens the pull request) |
| `features.lsp` | the `lsp` MCP server and its hooks in the agent tools' settings |
| `features.graphify` | graphify instructions and hooks |
| `features.ci` | the CI jobs for `ci.provider`: `.github/workflows/factory-*.yml` and the `setup-*` actions (GitHub Actions), `.gitlab/ci/factory-*.yml` and an include block in `.gitlab-ci.yml` (GitLab CI), or `.azure-pipelines/factory-*.yml` (Azure Pipelines). See [hosts-and-trackers.md](hosts-and-trackers.md#ci-systems) |
| `features.agentFiles` | agent definitions for each tool (`.claude/agents/`, `.github/agents/`) and the instruction blocks in `AGENTS.md`, `CLAUDE.md`, `GEMINI.md` |
| `owners` | the code owners of `.factory/` and of every file the factory generates (handles or teams, such as `["@alice", "@org/platform"]`). `factory render` writes them in a block of `CODEOWNERS` (`.github/CODEOWNERS`, or `.gitlab/CODEOWNERS` on GitLab, unless the repository has one at the root or in `docs/`; Azure DevOps has no CODEOWNERS: use a required-reviewers branch policy on these paths). `factory init` takes `--owners`, or the GitHub repository's owner or the GitLab project's top-level group. GitHub only requires their review when a branch rule asks for code-owner review, which needs a public repository or a paid plan: `factory doctor` warns when the default branch does not require `review-quorum` and code-owner review (GitHub rulesets or classic branch protection, GitLab protected branch, Azure DevOps branch policies), or cannot; `factory review-gate enforce` sets it |
| `features.gitHooks` | `.factory/githooks/` |
| `features.demoVideo` | demo videos and API summaries, produced on the machine that runs the pipeline before a PR opens ([pr-demo-video.md](ai-pipeline/pr-demo-video.md)); render keeps the shared e2e fixtures (`fixtures.ts`, `demo.ts`, `video-reporter.ts`) in step and copies the CI toolchain skeleton once. No CI system gets a demo-video job |

After changing the pin or the overlay, run `factory render`. Every file it writes outside `.factory/` is listed in `.factory/manifest.json`; `factory uninstall` removes exactly those.

### Upgrading from 0.2.96

- Payment request and response bodies are no longer published in a backend bug's request evidence: an exchange with any
  card data by name or by shape shows only its method, its path without the query and its status, with "bodies
  withheld: payment data" (`video.apiEvidence.paymentBodies`, default `withhold`). Set `paymentBodies: "mask"` to
  publish them with card data masked (best effort; [card data](ai-pipeline/pr-demo-video.md#backend-bugs-the-requests-before-and-after-the-fix)).
  A value other than `withhold` or `mask` stops every command that loads the config.
- A bug PR's rating is bound to its own change (its diff against the merge base, read from the target fetched now), not
  to its head commit: the pipeline's base merges keep it; a rating made by an earlier version is rated again once.

### Upgrading from 0.2.95

- New optional setting `council.intercom`, off by default: a council's members can discuss their first round with each other before the merge ([council-intercom.md](ai-pipeline/council-intercom.md#settings)). Without it nothing runs differently, except as listed under [Changes when the setting is off](ai-pipeline/council-intercom.md#changes-when-the-setting-is-off).
- The read-only check of every council round is stricter: a member that rewrites a file that was already untracked now fails the round.
- `factory council review --rulings <file>` is new; with the setting off it stops with an error.

### Upgrading from 0.2.92

- A `video.script.scope` other than `headline`, `all` or `none` now stops every command that loads the pipeline config (it used to act as `none`).
- `factory render` updates `e2e/fixtures.ts`; until then (or a hand merge, for an edited copy) a backend bug gets no request evidence.
- On Bitbucket, `close-reopen` holds now use `draft`.
- `implement run` reads the state of a ticket's PR whose last run did not end `done`, once, at plan time, as a fallback after the skip, resume and reopen routing, and treats a failed read as open (it holds the PR first). `--dry-run` makes no read and prints `PR state not checked`.
- Three new outcomes stop a run ([escalations](ai-pipeline/escalations.md#outcomes)): `gate-assessment-failed` (with the review gate on, a bug fix whose rating fails opens no new PR), `hold-failed` and `release-unconfirmed` (a hold or release the host does not confirm).
- A backend reproduction counts only when a Playwright `expect` fails inside the block after its first recorded response ([the rule](ai-pipeline/pr-demo-video.md#what-the-reproduction-check-proves)). With `video.bugPair.requireBefore` on and the demo video step enabled, a reproduction the step reports as missing stops the delivery (`demo-video-blocked`); a failed step does not.
- The redaction boundary is unchanged: it has no card rule ([card data](ai-pipeline/pr-demo-video.md#backend-bugs-the-requests-before-and-after-the-fix)).

## Code host, tracker and CI

Which products the repository uses, each chosen separately. Only the GitHub adapters have run against the live service; every other one is verified against fakes only ([proof](../README.md#what-has-been-proven)). [providers/](providers/README.md) has a page per product (settings, token scopes, capabilities, what to create by hand), the contracts, the `custom` adapter and the verification status. [hosts-and-trackers.md](hosts-and-trackers.md) covers the combinations. `factory init` asks for all of it ([providers/setup.md](providers/setup.md)):

```json
{
  "host": { "type": "azure-devops", "url": "https://dev.azure.com", "repo": "acme/Shop/web", "token": "${AZURE_DEVOPS_TOKEN}" },
  "tracker": {
    "type": "jira",
    "url": "https://acme.atlassian.net",
    "project": "SHOP",
    "auth": { "user": "${JIRA_EMAIL}", "token": "${JIRA_API_TOKEN}" },
    "board": { "id": 12 },
    "lanes": { "backlog": "Backlog", "ready": "Ready", "inProgress": "In Progress", "review": "In Review", "done": "Done", "blocked": "Blocked" },
    "types": { "epic": "Epic", "story": "Story", "bug": "Bug", "spike": "Task" },
    "fields": { "severity": "customfield_10050" }
  },
  "ci": { "provider": "azure-pipelines" }
}
```

| Key | Meaning | Default |
| --- | --- | --- |
| `host.type` | `github`, `gitlab`, `azure-devops`, `bitbucket` (Cloud) or `custom` | detected from the `origin` remote (github.com, gitlab.com, dev.azure.com, `*.visualstudio.com`, bitbucket.org, https and ssh forms); `github` without a remote |
| `host.url` | the base URL; set it for a self-hosted server (GitHub Enterprise Server, GitLab self-managed, Azure DevOps Server), which detection then recognises by it | `https://github.com`, `https://gitlab.com`, `https://dev.azure.com` |
| `host.repo` | GitHub `owner/name`; GitLab the project's full path; Azure DevOps `organization/project/repository` (Server: `collection/project/repository`); Bitbucket `workspace/repository` | from the remote |
| `host.user` | Bitbucket only: `${NAME}` of the account for an API token or app password (basic auth); without it the token is a bearer access token | |
| `host.token` | `${NAME}`: the environment variable holding the token, never the token. GitHub uses the `gh` login instead | none |
| `tracker.type` | `github`, `jira`, `azure-boards`, `gitlab`, `linear` or `custom` | `github` when the legacy `tickets`/`board` repository keys are set and there is no `host` section; otherwise the host's own: `github` for GitHub, `azure-boards` for Azure DevOps, `gitlab` for GitLab; Bitbucket has none, so set it (the board and doctor stop with an error that says so) |
| `tracker.url`, `tracker.project`, `tracker.auth` | the Jira site or server and project key; `https://dev.azure.com/<organization>` and the project; the GitLab server and project path; the Linear team key. Credentials as `${NAME}` references (Jira Cloud: `user` email and API `token`; the others: `token`) | |
| `tracker.board`, `tracker.lanes`, `tracker.types`, `tracker.fields` | the board, the factory's lanes and ticket types mapped to the tracker's statuses or columns and types, and the factory's fields (severity, impact, ...) to custom field ids or names | the [`setup-board`](../skills/setup-board/SKILL.md) skill writes them |
| `ci.provider` | `github-actions`, `gitlab-ci`, `azure-pipelines`, `jenkins`, `circleci`, `bitbucket-pipelines` or `custom`: which CI files `factory render` writes and which API the gate reads the head's runs from | the host's own CI system |
| `ci.url`, `ci.job`, `ci.project`, `ci.user`, `ci.token` | the CI system's API: Jenkins `url`, Multibranch `job`, `user` and API `token`; CircleCI project slug and `token`; GitLab CI, Azure Pipelines and Bitbucket Pipelines use the host's token unless `ci.token` names another | |
| `ci.expected`, `ci.ignore` | the pipelines a head must run, instead of the ones derived from the CI system; pipelines never waited for | derived |
| `<kind>.command`, `.env`, `.timeoutSec`, `.capabilities` | the `custom` adapter of that kind: [providers/custom.md](providers/custom.md) | |

These sections are governance: they live in `.factory/config.json` (never `app.json`), which the factory guard denies to pipeline agents, and `factory check` fails when an agent's prompt, addendum or lessons tells it to put them in `app.json`. `factory init` drafts `host` and `ci` from the remote, and `tracker` for Azure DevOps (Azure Boards). With GitHub the existing keys `tickets` (`repo`) and `board` (`owner`, `repo`, `projectNumber`, ...) remain the tracker's settings: a repository that has only them means `host.type = tracker.type = "github"`. `factory doctor` checks each configured product (token variable, API, permissions, required check).

## The project model: `project`

What the codebase is, in terms every stage shares.

```json
{
  "project": {
    "name": "shop",
    "languages": ["rust", "typescript"],
    "toolPaths": ["~/.cargo/bin"],
    "services": [
      { "name": "orders", "kind": "backend", "paths": ["crates/orders/**"], "unitTests": "crates/orders", "dependsOn": ["catalog"] },
      { "name": "web", "kind": "frontend", "paths": ["web/**"] }
    ],
    "frontendPaths": ["web/**"],
    "testRoots": ["tests"]
  }
}
```

| Key | Used for |
| --- | --- |
| `name` | names machine-wide state (stack project, LSP sockets), so two repositories on one machine never collide. Defaults to the folder name of the main checkout |
| `languages` | the language packs (`packs/<id>/`) in use |
| `toolPaths` | folders added to `PATH` for every command and agent the pipeline starts |
| `services[]` | the buildable units: which paths belong to which service, where its unit tests are, which other test projects cover it (`testProjects`, optional: a test project that references the service's folder in its manifest counts too), what it depends on (`dependsOn`). `kind`: `backend`, `frontend`, `worker`, `library` (builds no executable), `host` (an orchestrator); `partOf` puts a library in one service; `ui: true` marks a library with UI components. Drives subtask planning, which unit tests run after a change, which services the test stack rebuilds, and the review gate's systems |
| `frontendPaths` | what counts as UI: UI verifiers, design critics and demo videos apply only to changes here |
| `testRoots` | where tests live; with `implExclude` it separates implementation from tests |

## Stage sections

Each stage page under [ai-pipeline/](ai-pipeline/README.md) documents its own settings. The ones a new repository usually sets:

| Section | Keys to look at first |
| --- | --- |
| `implement` | `prepareCmd` (run once in each new story or subtask worktree), `checks` (build and lint commands a subtask must pass), `unitTests.cmd` (`{project}` is a service's `unitTests` path), `uiStory` (how a UI story is recognised), `ui.teststackCmd` (how to start the app for UI verifiers), `roles.<role>.cli` and `roles.<role>.env` (a role's own CLI and its process variables, such as a second login's `CODEX_HOME`; never secrets, see [council.md](ai-pipeline/council.md)) |
| `precheck` | `lint` and `fix` by file extension (`{files}`), `testRunners` (how written tests are run and discovered) |
| `testRoots`, `testExtensions`, `implExclude` | what is a test file, and what is not implementation |
| `implement.prCheck` | `mode` (`fix` or `report`), `fixUntil` (`major`), `bugFixUntil` (`minor`), `fixLenses`, `fixRounds` (3), and `returnToImplementation`: `enabled` (true), `maxReturns` (2), `minSeverity` (`major`), `implementationLenses`, `lightLenses`, `lightPaths` (governance; [pr-check.md](ai-pipeline/pr-check.md#findings-about-the-production-change-go-back-to-implementation)) |
| `implement.preOpen` | how the PR opens finished (governance): `branches` (branch patterns whose pushes run CI before the PR; default from the branch prefixes), `afterOpen` (`draft`, `label` or `close-reopen`: how an open PR is held while agents work on it again; `close-reopen` becomes `draft` on a host that cannot reopen, such as Bitbucket, with a warning when `implement`, the review gate or `factory doctor` load the config, and a WARN row in `factory doctor`), `wipLabel` (`work-in-progress`), `draftCycles` (1). An unknown or removed key, or a value not listed, stops the config from loading, whichever command reads it first. The order itself is not a setting ([implement.md](ai-pipeline/implement.md#the-pr-opens-finished)) |
| `implement.ciFixRounds`, `implement.ciWait` | `ciFixRounds` (1): `0` means no CI fixing round, any positive number one round per CI wait (`PIPELINE_CI_FIX_ROUNDS` for one run); `ciWait` (true): `false` skips both the CI proof before the open and the wait after it ([implement-reference.md](ai-pipeline/implement-reference.md#config)) |
| `implement.delivery`, `implement.epic` | `delivery` (`epic` or `story`), and for epics `prSplit` (`epic`, `story` or `groups`; `story` and `groups` proven by fixture tests only), `maxStoriesPerGroup`, `grouping` (`auto`, `epic`, `ticket`), `branchPrefix`, `bugfixPrefix`, `featureVerification`, `prCheck` (`fix`, `report`, `off`) ([implement.md](ai-pipeline/implement.md#delivery-modes)) |
| `implement.reviewGate`, `implement.autoMerge` | the review gate's severity floor, confidence and approvals per severity; auto-merge on or off, merge identity and method ([review-gate.md](ai-pipeline/review-gate.md)) |
| `review` | `maxRounds`, `policy` (the architecture policy step) |
| `prCheck` | `frontendPaths`, `conventions` (documents the style critic checks against) |
| `prVideo` | `specPatterns` (which e2e specs record a demo), `videosDir`, `storageBranch`, `recordCmd`, `slotWaitSec`, `localTimeoutSec`, `testTimeoutSec`, `backendPaths`, `neutralPaths`, `api` |
| `video` | narration (`enabled`, `voice`, `speed`, `lang`, `model`), `pacing`, `size`, `ffmpeg`, `licenceReview`, `critic`; `script` (narration by the `demo-narrator` agent: `scope` `headline`, `all` or `none`, checked when the config loads, `model`, `timeoutSec`, the length limits, `speakEvidence`); `bugPair` (`enabled`, `requireBefore`: a bug whose reproduction cannot be shown before the fix opens no PR); `apiEvidence` (a backend bug's requests before and after the fix: `enabled`, `headers`, `maxBodyBytes`, `maxPairs`, `paymentBodies`: `withhold` (default) or `mask`, checked when the config loads) ([pr-demo-video.md](ai-pipeline/pr-demo-video.md#turning-it-on)) |
| `tickets`, `board` | the GitHub tracker: `repo`, `owner`, `projectNumber`. `repo` and `owner` default to the GitHub `origin`. Other trackers: [`tracker`](#code-host-tracker-and-ci) |
| `agent` | `cli` (`claude`, `copilot`, `codex`), `models` per agent, `modelIds`, `claude.promptCacheTtl` (`5m` by default: a headless agent run is one short session, and the 1-hour cache Claude Code picks on a subscription is written at 1.6x the price), `claude.toolSearch` (`false` by default: MCP tools such as the language servers are listed to the agent directly, not deferred behind ToolSearch) |
| `bot` | the PR bot ([setup](ai-pipeline/setup.md#the-pipelines-pr-bot)) |
| `council` | opt-in council verifiers (governance): `members` (each with `name`, `cli` (`claude`, `codex`, `copilot`, `custom` with `cmd`), `model`, `effort`, `lens`, `blocking`, `env`), `stages` (`pairVerify`, `pairUiVerify`, `review`, `testPlan`, `testAutomation`, `prCheck`, each with its `members` and optional `rounds`), `rounds` (3), `passScore` (9), `blockOn` (`any`, `majority`, `all`), `onUnavailable` (`fail` or `report`). Scope objections to sealed fixes are settled by an adjudication sitting of the blocking members. Without it every stage runs its single verifier ([council.md](ai-pipeline/council.md)) |
| `council.intercom` | off by default: the council's members discuss round 1 with each other in a chat room before the merge (`enabled`, `host`, `port`, `advertiseHost`, `allowInsecureRemote`, `maxTurnsPerMember`, `maxEscalations`, `onSplit`; also per stage) ([council-intercom.md](ai-pipeline/council-intercom.md)) |

## Tool sections

| Section | Sets | Page |
| --- | --- | --- |
| `lsp` | `servers[]`: for each language server its command, file extensions, whether it is heavy (`leased`), an optional `prepare` and `scope` helper | [code-intelligence.md](code-intelligence.md) |
| `stack` | compose file, ports and URLs per slot, services and how each is built | [test-stack.md](test-stack.md) |
| `teststack` | scenario folders, the data stores and how a scenario loads into each | [test-stack.md](test-stack.md) |
| `prune` | the disk prune (`enabled`, `minFreeGb`, `worktreeDays`, ...); `afterDelivery` (alpha, default `false`: off, nothing of a delivered run is removed; `true` removes what the run made once the remote confirms it) and `keepLocal` (default `false`), both `true` or `false` or the config does not load | [disk.md](ai-pipeline/disk.md#settings) |

## Metrics: `metrics.sink`

Where agent run records go besides the local files in `.factory/metrics/`. Types: `none` (default), `directory`, `http`, `command`, `otlp`. Values of the form `${NAME}` are read from the environment, so secrets stay out of the file. See [observability.md](observability.md); the [`setup-observability`](../skills/setup-observability/SKILL.md) skill writes this section for you.

### Where metrics are written

Pipeline branches (story, group and epic worktrees) append to their own file of each stream, `.factory/metrics/<stream>.jsonl.d/<branch>.jsonl`, and commit it with their work, so a merged PR brings it to the base branch and no two branches write the same file (`FACTORY_METRICS_SHARD=0` writes the stream's own file instead; the engine's tests use it). The older shared `<stream>.jsonl` files are still read, and `.gitattributes` merges them as a union. The main checkout (the main worktree, on the base branch) never writes the tracked files: its own commands (`board sync`, the review gate's bookkeeping, `retro run`) spool to `.factory/state/metrics-spool/` (ignored), the sink ships the spool with its own cursors, and every reader sees the tracked records and the spooled ones. So `git pull`, merge and rebase of the main checkout never meet local metric edits. `FACTORY_METRICS_SPOOL=1|0` forces it on or off.

GitHub's mergeability ignores merge drivers, so two open pipeline PRs that both appended to a shared metrics file looked conflicting once one merged; the per-branch files avoid that. The runner merges the latest base into a branch before it pushes it, and `board sync` merges the base into each open pipeline PR GitHub reports as conflicting (or not yet computed) when git merges it cleanly, then pushes it so its checks run again.

## Retro: `retro.factory`

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | let the retro propose changes to the factory itself, as a branch pushed to `source`; a person opens its pull request |
| `source` | the pin's `source`, else the install's `origin` | the repository the proposal branch is pushed to |
| `allowedPaths` | `agents/`, `docs/`, `templates/`, `skills/` | what such a proposal may touch |
| `evidence` | `summary` | how much of this repository's run data the proposal quotes |

See [ai-pipeline/retro.md](ai-pipeline/retro.md).

## Factory guard: `factoryGuard`

Agents the pipeline starts may not edit the factory's files in the repository; only the retro may.

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | |
| `protected` | the settings, pin, manifest, launcher, hooks, addenda, lessons and policy under `.factory/` | paths no pipeline agent may write. Every file in the manifest is added |
| `writers` | `["retro"]` | agents exempt from the guard |

The guard checks file edit tools and shell commands that write a protected path (redirections, `tee`, `sed -i`, `cp`/`mv`/`rm`/..., `git checkout`/`restore`/`apply`, interpreters handed a protected path). Because a shell can still hide a write, the engine also snapshots the protected files around every pipeline agent run: a run that changed them by any means is reverted and fails. CODEOWNERS on `.factory/` and `factory check` in CI remain the last line for generated files.

**Texts agents read are checked against the guard** (`factory check`, `scripts/pipeline/lib/instruction-check.mjs`). A sentence that mentions a path the reading agent may not write is a problem, unless it is recognisably harmless:
- a prohibition: every write cue in it is negated;
- a statement of ownership or location ("are the factory's", "is in", "are declared in");
- read-only: a read cue (read, see, follow, consult, load, ...) and no write cue;
- marked `read-only`;
- the path run as a command (`node .factory/bin/factory.mjs ...`).

A sentence that places topology keys in `config.json` is also a problem, and so is a `.factory/` path that does not exist, in a sentence with a write cue.

How it reads sentences, and which texts it reads: [internals.md](internals.md#instruction-check).

The factory's own tests apply it to the base agents, templates and pack policy texts, and the topology check to the skills, engine messages and validator messages.

It is a heuristic over English sentences that errs towards flagging. A sentence it misjudges is reworded or marked `read-only`. The guard and the post-run restore remain what actually stops a write.

## Static analysis: `analysis`

Opt-in: without this section nothing below runs and nothing the factory renders changes. What it does and why: [ai-pipeline/analysis.md](ai-pipeline/analysis.md). `{}` turns on the `security` pack and the packs of `project.languages` (their tools, slots and CI jobs). A bad key, tool, parser, slot, pin or licence entry fails at load time with the key named.

| Key | Default | Meaning |
| --- | --- | --- |
| `tools.<id>` | the packs' tools | a tool, as data (below). For a pack's tool, only the keys you name change (`{ "enabled": true }` turns an optional one on); `null` turns it off |
| `stages.<slot>` | the repository's linters (`precheck`) plus the packs' | the tools each slot runs: `pair`, `story`, `prCheck`, `featureVerification`, `ci` |
| `fixLoop.bounces` | `2` | harness fix bounces per pair round (and at story level); not pair or council rounds |
| `ci.jobs` | the packs' jobs | `[{ id, name, tools, required, toolchain, timeoutMin }]`, rendered for the CI system; `ci.enabled: false` renders none |
| `suppressions.inline` | the packs' patterns | `[{ id, pattern }]` (regular expressions on added lines), listed for the members as suppressions to justify |
| `protect` | the packs' and tools' lists | more paths the factory guard protects while analysis is on |
| `coverage` | none | `{ run, format: "lcov" \| "cobertura", output }`: coverage of the added production lines, evidence for the `test-value` lens, never a gate |
| `vars` | from the packs | values for a pack's placeholders, such as `{ "solution": "eShop.Web.slnf" }` (else the single root file matching the pack's candidates; with two or more candidates nothing is picked, and `factory analysis check` and `factory doctor` fail naming them) |
| `secrets` | none | `{ "allow": { "stopwords": [...], "regexes": [...] } }`: values a person declares are not secrets (the seeded demo users' password every e2e spec signs in with). The secret scanner keeps its default rules and ignores exactly these, locally and in CI |
| `commercial` | none | a client's licensed scanner, or a list of them: `{ scanner, mode: local \| server, token: "${NAME}", env, replaces, severity, check, url, project, timeoutMin, stages }` ([providers/commercial-scanners.md](providers/commercial-scanners.md)). Off until a person accepts its licence |
| `acceptLicence` | `[]` | `[{ tool \| source: "<tool>:<rule source>", licence, by, rejected? }]`: a person's acceptance of a licence outside the allowlist |
| `licenceReview` | `"default"` | `"strict"` turns off every item marked `licenceReview: "pending"` (enabled pending legal review) |
| `maxConcurrent` | `2` | tools running at once on the machine |
| `reports.keep` | `200` | commits whose reports are kept (see also `prune.analysisReports`) |

A tool:

| Key | Meaning |
| --- | --- |
| `run`, `fix` | argv (preferred) or a command line. Placeholders: `{files}` (one argument per file), `{out}`, `{base}`, `{mergeBase}`, `{range}` (`<mergeBase>..HEAD`), `{root}`, `{packs}`, `{bin}` (a pinned binary), `{rules}` (`--config <dir>` per rule folder), `{cache}` (its per-machine data folder), and `vars` |
| `parse` | `sarif`, `msbuild`, `eslint-json`, `eslint`, `lines` / `gcc`, `gitleaks-json`, `actionlint-json`, `osv-json`, or `module:<path>` (a pack's parser) |
| `output` | `stdout` (default), `stderr`, or a path with `{out}` |
| `scope` | `changed-lines` (default), `changed-files`, `repo` |
| `baseline` | `lines`, `merge-base` (alias `fingerprint`), `native` |
| `block` | `{ levels: ["error"], rules: ["CA5*"] }`: what blocks; the rest is a note |
| `lens` | the council lens of its findings |
| `when`, `onChange` | globs: run only when a tracked file matches; outside CI, only when a touched file matches |
| `licence`, `licenceReview` | the tool's licence (required for a tool the packs do not declare); `"pending"` marks an item enabled pending legal review |
| `install` | `{ name, version, platforms: { "<os>-<arch>": { url, sha256, bin } } }`: a pinned binary, never `latest` |
| `rules` | rule sources: `[{ id, repo, commit, include, exclude, licence, requireHeader, licenceReview }]`, `{ id, dir, licence }` or `{ id, builtin, include }` |
| `validateRule` | how to load one rule file (`{rule}`, `{empty}`): files that do not load are dropped once, after the fetch |
| `data` | data sources and their licences (`paths`, `excluded`, `licenceReview`); excluded folders are deleted after `prepare` |
| `prepare`, `freshness` | a preparation step (an offline database download) and how old its result may be |
| `exclude` | globs of files the tool never reads (the TypeScript pack's eslint-security leaves test code alone) |
| `worktreeRun` | for a tool that reads commits: a second command for the files not committed yet (`{files}`), run only when there are some; findings on their changed lines count as introduced |
| `offline`, `forbid` | flags its run commands must have, and must never have (doctor checks both) |
| `severity` | a vendor severity map `{ critical, high, medium, low, info }` → `blocking` \| `major` \| `minor` (the commercial definitions have one; a tool without one blocks by its `block` list) |
| `commercial` | a scanner definition's vendor data: `vendor`, `modes`, `tokenEnv`, `check`, `server` (`adapter`, `submit`, or a custom adapter's `command`), docs and verification |
| `timeoutSec`, `okExit`, `extensions`, `env`, `ruleFilter`, `errorPattern`, `missingPattern`, `version`, `sample`, `protect` | as named; `env` values may be `${NAME}` references, read from the environment when the tool runs |

## Redaction

The redaction boundary has no switch: everything the pipeline writes or publishes passes it ([observability.md](observability.md#redaction)). What it treats as a secret:

- the secret scanner's high-confidence rules, and a name containing key, secret, token or password directly before a hex or base64-like value;
- the values of environment variables named like credentials (`*TOKEN`, `*SECRET`, `*PASSWORD`, `*_KEY`, `*CREDENTIALS`), and of every variable the config names in a setting ending in `tokenEnv`, `Env` or `EnvVar`;
- a value written directly into the config under a credential-named setting (write `${NAME}` instead);
- any value detected earlier in the same run.

Test data that needs a credential-like value uses the factory's placeholder marker, which the boundary leaves alone; `analysis.secrets.allow` declares values the secret scanner ignores ([analysis.md](ai-pipeline/analysis.md)).

## Agent prompts

An agent's prompt is built from three files:

1. the base definition, `agents/<name>.agent.md` in the factory (stack-neutral);
2. the addendum, `.factory/agents/<name>.md` in the repository (its "Project context": commands, conventions, paths). A skeleton that was never filled in contributes nothing;
3. the lessons, `.factory/lessons/<name>.md`, written by the retro.

`.factory/agents/<name>.agent.md` replaces the base definition for one repository. Use it rarely: the repository then stops receiving improvements to that agent.

## Environment and git switches

| Setting | Effect |
| --- | --- |
| `FACTORY_HOME` | where the engine is installed |
| `PIPELINE_AGENT_CLI`, `PIPELINE_AGENT_CMD` | which agent CLI runs the agents |
| `PIPELINE_BASE_REF` | base branch for diffs and new stories (default `origin/main`) |
| `PIPELINE_DISABLE=1` | turn off every hook |
| `PIPELINE_BOARD=0`, `PIPELINE_TICKETS_OFFLINE=1` | work without the board |
| `GITLAB_TOKEN`, `AZURE_DEVOPS_TOKEN`, `JIRA_EMAIL`, `JIRA_API_TOKEN`, ... | the tokens the `host` and `tracker` sections name with `${NAME}` (the names are yours to choose) |
| `PIPELINE_BOT=0` | open PRs with your own `gh` login |
| `FV_SKIP=1`, `PR_CHECK_SKIP=1` | skip one stage's gate |
| `ARCH_POLICY_DIR` | a policy folder other than `.factory/policy` |
| `ARCH_MSBUILD_EVAL` | `0` stops the engine asking MSBuild (`dotnet msbuild -getProperty:`) to confirm a new project's facts; the parse alone still sends anything it cannot be sure of to a person |
| `git config fv.autoPlan true` | write test plans in the background when stories change |
| `git config retro.auto true` | run the retro after merges |
