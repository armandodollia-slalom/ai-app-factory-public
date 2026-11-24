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

### Upgrading from 0.2.99

- Settings were combined and renamed to one pattern (`max<X>Rounds`, `max<X>Returns`, `max<X>Runs`, `maxRetries` with
  `retryDelaySec`, `<x>MinSeverity`, `<x>MinLevel`, durations in seconds with `Sec`, `enabled` for every switch). Where a
  rename combined settings that behaved differently, the new setting behaves as follows:
  - `implement.ci.maxFixRounds` (2) counts every CI fixing round of a ticket, before and after its PR opens (it replaces
    `implement.ciFixRounds` and `implement.preOpen.draftCycles`); 0 sends a red CI straight to a person.
  - `implement.worker.retryDelaySec` doubles after each retry, like `recovery.retryDelaySec`.
  - `implement.maxParallel` and `lsp.maxLanguageServers` are upper limits on the numbers worked out from free memory;
    `--parallel N` still forces N.
  - `featureVerification.slots.enabled` (on) lets every test run borrow its own copy of the app, not only parallel runs;
    `FV_USE_SLOTS` overrides it. `featureVerification.enabled` turns test planning and writing off; `FV_SKIP` overrides it.
  - `prCheck.mode` (`fix`, `report` or `off`) is one mode for single tickets and epics (epics fell back to `report`).
  - `prCheck.returnToImplementation.maxReturns` (2) also bounds the automatic PR check's failing runs (it replaces
    `prCheck.hook.maxRuns`).
  - `project.frontendPaths`, `project.testRoots` and `teststack.scenariosDir` are the only lists of their kind; the
    PR check, the feature verification stage and the implement stage read them.
  - `prCheck.video.maxFrames` and `prCheck.video.framesPerStep` are the PR check's only frame settings
    (`video.critic.*` was never read).
- Every verifier stage is a council, of one member unless more are seated ([council](ai-pipeline/council.md)). Each
  stage section has its own round limit and pass score, for any council size: `implement` (pair verifiers, 3 rounds,
  9.5), `architectureReview` (the `review` section's new name; 5, 9.5), `testPlan` (5, 9.0), `testAutomation` (5, 9.0)
  and `prCheck` (3, 9.5), as `maxCouncilRounds` and `councilPassScore`; scores may have one decimal place. The PR check
  reads `prCheck.maxCouncilRounds` in every caller; `--max-rounds` overrides it for a run by hand.
- Models are listed once, in the pool `models.pool` (name, CLI, the CLI's own model id, effort, optional `env`, `cmd`,
  `timeoutSec`), and every model setting names a pool entry: `models.agents.<agent>` for each agent (by agent name, such
  as `pr-check-judge`), `implement.subtaskModels` for the planner's choice per subtask (it names an entry per subtask in
  place of a size class). A council's size is `council.members` (default 1) or a stage section's `councilMembers`; the
  harness seats one entry per model family first. `agent.allowedModels`, `agent.modelIds`, `agent.strictModels`,
  `agent.models.*`, `agent.cli`, `modelClasses`, `implement.roles`, `implement.maxLargeSubtasks`, `prCheck.models`,
  `PR_CHECK_MODEL_<ROLE>`, `video.script.model`, the member list `council.members[]` and `council.stages` are gone:
  translate each model you used into a pool entry, then name it. `PIPELINE_AGENT_CLI` now moves every run onto the pool's
  entries of that CLI.
- Every stage is led by an orchestrator that decides whether to do the stage's producing work itself or delegate it,
  with a written reason in the decision log, and never verifies its own work ([orchestrators](ai-pipeline/orchestrators.md)).
  Its pool entry and effort are `orchestrator.model` and `orchestrator.effort`, with `<section>.orchestrator.*`
  overrides; the implement stage's orchestrator is the implementer. `implement.orchestrate` and `IMPLEMENT_ORCHESTRATE`
  are gone (the orchestrator decides).
- Every setting is checked when the settings load, against its description beside its defaults
  (`scripts/<dir>/settings.json`): a name no setting has fails the load, naming the closest setting, and a value outside
  a setting's allowed values fails it, listing them ([settings reference](#settings-reference)). No agent starts.
- A setting that was renamed or removed fails the load with "`<old>` was renamed: use `<new>`" (or why it was removed).
  Every old name and what replaced it:

<!-- generated:renamed-settings -->
| Old name | Now |
| --- | --- |
| `implement.preOpen.enabled` | removed: every pipeline PR now opens finished (all agent work done, CI proven on its head), and an open PR that agents work on again is held (implement.preOpen.afterOpen); remove the setting |
| `implement.preOpen.failedStory` | removed: a story whose PR check or CI never passes now always escalates on its ticket, with its branch pushed, the findings on the ticket and no PR; remove the setting |
| `analysis.reports.keep` | `prune.analysisReports` (factory prune keeps the newest analysis reports; the pipeline never pruned them itself) |
| `implement.ciFixRounds` | `implement.ci.maxFixRounds` (counts every CI fixing round, before and after the PR opens) |
| `implement.preOpen.draftCycles` | `implement.ci.maxFixRounds` (one count of every CI fixing round, before and after the PR opens) |
| `prCheck.hook.maxRuns` | `prCheck.returnToImplementation.maxReturns` |
| `implement.prCheck.returnToImplementation.maxReturns` | `prCheck.returnToImplementation.maxReturns` |
| `recovery.maxAttempts` | `recovery.maxRetries` |
| `recovery.backoffSec` | `recovery.retryDelaySec` |
| `implement.maxWorkerRetries` | `implement.worker.maxRetries` |
| `implement.retryDelaySec` | `implement.worker.retryDelaySec` (the wait now doubles each retry) |
| `implement.maxImplementerRuns` | `implement.maxOrchestratorRuns` |
| `implement.maxBugFixCycles` | `implement.maxBugFixReturns` |
| `analysis.fixLoop.bounces` | `analysis.maxFixRounds` |
| `prCheck.debateTurns` | `prCheck.maxDebateTurns` |
| `implement.maxBugsPerGroup` | `implement.epic.maxTicketsPerGroup` |
| `implement.epic.maxStoriesPerGroup` | `implement.epic.maxTicketsPerGroup` |
| `implement.parallel` | `implement.maxParallel` (an upper limit on the number worked out from free memory; `--parallel N` still forces N) |
| `resources.maxParallel` | `implement.maxParallel` (an upper limit on the number worked out from free memory; `--parallel N` still forces N) |
| `implement.prCheck.fixUntil` | `prCheck.fixMinSeverity` |
| `implement.prCheck.bugFixUntil` | `prCheck.bugFixMinSeverity` |
| `implement.prCheck.returnToImplementation.minSeverity` | `prCheck.returnToImplementation.minSeverity` |
| `implement.prCheck.returnToImplementation.implementationLenses` | `prCheck.returnToImplementation.implementationLenses` |
| `implement.prCheck.returnToImplementation.lightLenses` | `prCheck.returnToImplementation.lightLenses` |
| `implement.prCheck.returnToImplementation.lightPaths` | `prCheck.returnToImplementation.lightPaths` |
| `implement.reviewGate.confidence.maxPairRounds` | `implement.reviewGate.confidence.implementRoundsAtMost` |
| `implement.reviewGate.confidence.maxPrCheckRounds` | `implement.reviewGate.confidence.prCheckRoundsAtMost` |
| `implement.reviewGate.confidence.highMin` | `implement.reviewGate.confidence.highMinScore` |
| `implement.reviewGate.floor.level` | `implement.reviewGate.floor.minLevel` |
| `implement.reviewGate.sharedFloor` | `implement.reviewGate.floor.sharedMinLevel` |
| `implement.prCheckWaitSec` | `implement.waitSec.prCheck` |
| `implement.epic.prCheckTimeoutSec` | `implement.waitSec.prCheck` |
| `implement.prCheck.fixTimeoutSec` | `implement.waitSec.prCheck` |
| `implement.prCheckStartGraceSec` | `implement.waitSec.prCheckStart` |
| `implement.fvTimeoutSec` | `implement.waitSec.featureVerification` |
| `implement.fvPollSec` | `implement.pollSec.featureVerification` |
| `implement.ciWaitSec` | `implement.ci.wait.timeoutSec` |
| `implement.ciPollSec` | `implement.ci.wait.pollSec` |
| `implement.ciSettleSec` | `implement.ci.wait.settleSec` |
| `implement.timeouts.plannerSec` | `implement.timeoutsSec.planner` |
| `implement.timeouts.orchestratorSec` | `implement.timeoutsSec.orchestrator` |
| `implement.timeouts.pairImplementerSec` | `implement.timeoutsSec.pairImplementer` |
| `implement.timeouts.codeVerifierSec` | `implement.timeoutsSec.pairVerifier` |
| `implement.timeouts.uiVerifierSec` | `implement.timeoutsSec.pairUiVerifier` |
| `implement.timeouts.checkSec` | `implement.timeoutsSec.checks` |
| `implement.implementerTimeoutSec` | `implement.timeoutsSec.orchestratorFix` |
| `implement.epic.planTimeoutSec` | `implement.timeoutsSec.epicPlanner` |
| `timeoutsSec.plan` | `featureVerification.timeoutsSec.plan` |
| `timeoutsSec.automation` | `featureVerification.timeoutsSec.automation` |
| `timeoutsSec.verifier` | `featureVerification.timeoutsSec.verifier` |
| `timeoutsSec.lessons` | `featureVerification.timeoutsSec.lessons` |
| `timeoutsSec.tests` | `featureVerification.timeoutsSec.tests` |
| `prCheck.hook.waitForTestsMin` | `prCheck.hook.waitForTestsSec` |
| `teststack.timeoutSeconds` | `teststack.timeoutSec` |
| `teststack.healAfterSeconds` | `teststack.healAfterSec` |
| `stack.leaseTtlMinutes` | `stack.leaseTtlSec` |
| `analysis.ci.jobs[].timeoutMin` | `analysis.ci.jobs[].timeoutSec` |
| `analysis.commercial.timeoutMin` | `analysis.commercial.timeoutSec` |
| `analysis.commercial[].timeoutMin` | `analysis.commercial.timeoutSec` |
| `implement.requeue.outageCooldownMin` | `implement.requeue.outageCooldownSec` |
| `models.cacheTtlHours` | `models.cacheTtlSec` |
| `agent.claude.promptCacheTtl` | `agent.claude.promptCacheTtlSec` (in seconds: 300 (was 5m) or 3600 (was 1h)) |
| `prune.idleMinutes` | `prune.idleSec` |
| `prune.slotMaxAgeHours` | `prune.slotMaxAgeSec` |
| `prune.imageMinAgeHours` | `prune.imageMinAgeSec` |
| `video.pacing.stepDelayMs` | `video.pacing.stepDelaySec` |
| `video.pacing.holdMs` | `video.pacing.holdSec` |
| `video.pacing.typeDelayMs` | `video.pacing.typeDelaySec` |
| `video.pacing.cursorMs` | `video.pacing.cursorSec` |
| `video.pacing.pauseMs` | `video.pacing.pauseSec` |
| `implement.prCheck.mode` | `prCheck.mode` (one mode for single tickets and epics) |
| `implement.epic.prCheck` | `prCheck.mode` (one mode for single tickets and epics) |
| `useSlots` | `featureVerification.slots.enabled` |
| `implement.ciWait` | `implement.ci.wait.enabled` |
| `implement.ciParity` | `implement.ci.parity.enabled` |
| `implement.prCheck.returnToImplementation.enabled` | `prCheck.returnToImplementation.enabled` |
| `implement.autoMerge.native` | `implement.autoMerge.hostAutoMerge.enabled` |
| `lessons.retro.enabled` | `retro.enabled` |
| `prCheck.frontendPaths` | `project.frontendPaths` |
| `implement.uiStory.filePatterns` | `project.frontendPaths` |
| `testRoots` | `project.testRoots` |
| `scenariosDir` | `teststack.scenariosDir` |
| `review.codeAgents` | `hooks.codeAgents` |
| `prCheck.hook.codeAgents` | `hooks.codeAgents` |
| `lessons.retro.allowedPaths` | `retro.allowedPaths` |
| `lessons.retro.windowDays` | `retro.windowDays` |
| `lessons.intervalDays` | `retro.intervalDays` |
| `video.critic.maxFrames` | `prCheck.video.maxFrames` |
| `video.critic.framesPerStep` | `prCheck.video.framesPerStep` |
| `plansDir` | `featureVerification.plansDir` |
| `precheck` | `featureVerification.precheck` |
| `categories` | `featureVerification.categories` |
| `evidence` | `featureVerification.evidence` |
| `testExtensions` | `featureVerification.testExtensions` |
| `slotWaitSec` | `featureVerification.slotWaitSec` |
| `lessons.storyThreshold` | `retro.lessons.storyThreshold` |
| `lessons.maxRules` | `retro.lessons.maxRules` |
| `lessons.retireAfterStories` | `retro.lessons.retireAfterStories` |
| `lessons.revertMinRounds` | `retro.lessons.revertMinRounds` |
| `lessons.examplesPerCategory` | `retro.lessons.examplesPerCategory` |
| `implement.prCheck.fixLenses` | `prCheck.fixLenses` |
| `implement.lsp.enabled` | `lsp.client.enabled` |
| `implement.lsp.setupCmd` | `lsp.client.setupCmd` |
| `implement.lsp.lspdCmd` | `lsp.client.lspdCmd` |
| `implement.lsp.timeoutSec` | `lsp.client.timeoutSec` |
| `implement.lsp.leaseWaitSec` | `lsp.client.leaseWaitSec` |
| `implement.lsp.signaturePattern` | `lsp.client.signaturePattern` |
| `resources.roslynGb` | removed: it was the old name of resources.lspServerGb; use resources.lspServerGb |
| environment variable `FACTORY_EXTERNAL_RETRIES` | environment variable `FACTORY_EXTERNAL_MAX_RETRIES` |
| environment variable `FACTORY_EXTERNAL_PAUSE_MS` | environment variable `FACTORY_EXTERNAL_RETRY_DELAY_SEC` (in seconds) |
| `implement.maxPairRounds` | `implement.maxCouncilRounds` |
| `implement.prCheck.fixRounds` | `prCheck.maxCouncilRounds` |
| `prCheck.maxRounds` | `prCheck.maxCouncilRounds` |
| `review` | `architectureReview` (the section is named after its stage) |
| `review.maxRounds` | `architectureReview.maxCouncilRounds` |
| `loops.planMaxRounds` | `testPlan.maxCouncilRounds` |
| `loops.automationMaxRounds` | `testAutomation.maxCouncilRounds` |
| `loops.requiredScore` | `testPlan.councilPassScore` (and testAutomation.councilPassScore) |
| `loops.consecutivePasses` | removed: a test stage is verified once its council passes; nothing asks for a repeated pass on unchanged work |
| environment variable `FV_REQUIRED_SCORE` | removed: set testPlan.councilPassScore and testAutomation.councilPassScore |
| `council.rounds` | removed: every stage has its own round limit: implement.maxCouncilRounds, architectureReview.maxCouncilRounds, testPlan.maxCouncilRounds, testAutomation.maxCouncilRounds, prCheck.maxCouncilRounds |
| `council.passScore` | removed: every stage has its own pass score: implement.councilPassScore, architectureReview.councilPassScore, testPlan.councilPassScore, testAutomation.councilPassScore, prCheck.councilPassScore |
| `council.stages.<stage>.rounds` | removed: use the stage section's maxCouncilRounds (implement, architectureReview, testPlan, testAutomation or prCheck) |
| `council.stages.<stage>.intercom` | removed: use the stage section's councilIntercom (implement, architectureReview, testPlan, testAutomation or prCheck) |
| `council.blockOn` | `council.blockQuorum` |
| `council.stages.review` | removed: council members come from models.pool; seat several with council.members or architectureReview.councilMembers |
| `agent.cli` | removed: each models.pool entry names its CLI; models.agents.default is the entry an agent with none of its own runs on |
| `agent.allowedModels` | `models.pool` (list each model once as a pool entry: name, cli, the CLI's model id and effort) |
| `agent.modelIds` | `models.pool` (a pool entry holds the CLI's own model id) |
| `agent.strictModels` | removed: every agent runs on a models.pool entry, so nothing outside the pool can run |
| `agent.models.default` | `models.agents.default` (the value names a models.pool entry: its name, cli, the CLI's model id and effort) |
| `agent.models.implementer` | `implement.orchestrator.model` (the implementer is the implement stage's orchestrator; the value names a models.pool entry: its name, cli, the CLI's model id and effort) |
| `agent.models.plan` | `models.agents.test-planner` (the value names a models.pool entry: its name, cli, the CLI's model id and effort) |
| `agent.models.automation` | `models.agents.test-automation` (the value names a models.pool entry: its name, cli, the CLI's model id and effort) |
| `agent.models.verifier` | `models.agents.test-plan-verifier` (and models.agents.test-automation-verifier; each names a models.pool entry) |
| `agent.models.reviewer` | `models.agents.architecture-reviewer` (the value names a models.pool entry: its name, cli, the CLI's model id and effort) |
| `agent.models.bugTriage` | `models.agents.bug-triage` (the value names a models.pool entry: its name, cli, the CLI's model id and effort) |
| `agent.models.escalationQuestions` | `models.agents.escalation-questions` (the value names a models.pool entry: its name, cli, the CLI's model id and effort) |
| `agent.models.narrator` | `models.agents.demo-narrator` (the value names a models.pool entry: its name, cli, the CLI's model id and effort) |
| `agent.models.audit` | removed: the retro's audit re-check runs on the verifier's own models.agents entry |
| `agent.models.<agent>` | `models.agents.<agent>` (keyed by agent name (as in agents/); the value names a models.pool entry) |
| `agent.available.models` | removed: factory init writes the models you have as models.pool entries |
| `modelClasses` | removed: there are no size classes: the planner names a models.pool entry per subtask, from implement.subtaskModels |
| `implement.maxLargeSubtasks` | removed: there are no size classes: the planner names a models.pool entry per subtask, from implement.subtaskModels |
| `implement.roles` | removed: each implement agent names its models.pool entry in models.agents (implementer, pair-verifier, pair-ui-verifier); a subtask's pair implementer runs on the entry the planner picks from implement.subtaskModels; a role's env goes on the pool entry |
| environment variable `PIPELINE_VERIFIER_CLI` | removed: the pair verifiers run on their models.agents entries (pair-verifier, pair-ui-verifier) from models.pool |
| `prCheck.models` | removed: each PR check agent (pr-check-judge, -acceptance, -flow, -design, -style, -video, -defender, -fixer) names its models.pool entry in models.agents |
| `video.script.model` | `models.agents.demo-narrator` (the value names a models.pool entry: its name, cli, the CLI's model id and effort) |
| `council.stages` | removed: council members come from models.pool: council.members (or a stage section's councilMembers) says how many sit; lenses are no longer settings |
| environment variable `PR_CHECK_MODEL_JUDGE` | removed: name the models.pool entry in models.agents.pr-check-judge |
| environment variable `PR_CHECK_MODEL_ACCEPTANCE` | removed: name the models.pool entry in models.agents.pr-check-acceptance |
| environment variable `PR_CHECK_MODEL_FLOW` | removed: name the models.pool entry in models.agents.pr-check-flow |
| environment variable `PR_CHECK_MODEL_DESIGN` | removed: name the models.pool entry in models.agents.pr-check-design |
| environment variable `PR_CHECK_MODEL_STYLE` | removed: name the models.pool entry in models.agents.pr-check-style |
| environment variable `PR_CHECK_MODEL_VIDEO` | removed: name the models.pool entry in models.agents.pr-check-video |
| environment variable `PR_CHECK_MODEL_DEFENDER` | removed: name the models.pool entry in models.agents.pr-check-defender |
| environment variable `PR_CHECK_MODEL_FIXER` | removed: name the models.pool entry in models.agents.pr-check-fixer |
| `implement.orchestrate` | removed: the implement stage's orchestrator decides: it implements the ticket itself or plans subtasks for pairs (implement.orchestrator.model sets its pool entry) |
| `implement.orchestrator.enabled` | removed: the implement stage's orchestrator decides: it implements the ticket itself or plans subtasks for pairs |
| environment variable `IMPLEMENT_ORCHESTRATE` | removed: the implement stage's orchestrator decides whether it implements the ticket itself |
| `models.agents.implementer` | `implement.orchestrator.model` (the implementer is the implement stage's orchestrator) |
<!-- /generated:renamed-settings -->

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

Each stage page under [ai-pipeline/](ai-pipeline/README.md) explains its own settings in context. The ones a new repository usually sets: `implement.prepareCmd`, `implement.checks`, `implement.unitTests.cmd`, `implement.uiStory`, `implement.ui.teststackCmd`, `precheck.lint` and `precheck.fix`, `precheck.testRunners`, `testRoots`, `testExtensions`, `implExclude`, and the `tickets` and `board` sections (or [`tracker`](#code-host-tracker-and-ci)). Every setting, with what it does, its allowed values, its default and the environment variable that overrides it, is in the [settings reference](#settings-reference).

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

Whether the retro may propose changes to the factory itself, where its branch goes, what it may touch and how much run data it quotes: the `retro.factory` rows of the [settings reference](#settings-reference). See [ai-pipeline/retro.md](ai-pipeline/retro.md).

## Factory guard: `factoryGuard`

Agents the pipeline starts may not edit the factory's files in the repository; only the retro may. Its settings (`enabled`, `protected`, `writers`) are in the [settings reference](#settings-reference).

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
| `maxFixRounds` | `2` | harness fix rounds per pair round (and at ticket level); not pair or council rounds |
| `ci.jobs` | the packs' jobs | `[{ id, name, tools, required, toolchain, timeoutSec }]`, rendered for the CI system; `ci.enabled: false` renders none |
| `suppressions.inline` | the packs' patterns | `[{ id, pattern }]` (regular expressions on added lines), listed for the members as suppressions to justify |
| `protect` | the packs' and tools' lists | more paths the factory guard protects while analysis is on |
| `coverage` | none | `{ run, format: "lcov" \| "cobertura", output }`: coverage of the added production lines, evidence for the `test-value` lens, never a gate |
| `vars` | from the packs | values for a pack's placeholders, such as `{ "solution": "eShop.Web.slnf" }` (else the single root file matching the pack's candidates; with two or more candidates nothing is picked, and `factory analysis check` and `factory doctor` fail naming them) |
| `secrets` | none | `{ "allow": { "stopwords": [...], "regexes": [...] } }`: values a person declares are not secrets (the seeded demo users' password every e2e spec signs in with). The secret scanner keeps its default rules and ignores exactly these, locally and in CI |
| `commercial` | none | a client's licensed scanner, or a list of them: `{ scanner, mode: local \| server, token: "${NAME}", env, replaces, severity, check, url, project, timeoutSec, stages }` ([providers/commercial-scanners.md](providers/commercial-scanners.md)). Off until a person accepts its licence |
| `acceptLicence` | `[]` | `[{ tool \| source: "<tool>:<rule source>", licence, by, rejected? }]`: a person's acceptance of a licence outside the allowlist |
| `licenceReview` | `"default"` | `"strict"` turns off every item marked `licenceReview: "pending"` (enabled pending legal review) |
| `maxConcurrent` | `2` | tools running at once on the machine |

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

An environment variable that overrides a setting is listed on that setting's row of the [settings reference](#settings-reference), not here. These are the other switches:

| Setting | Effect |
| --- | --- |
| `FACTORY_HOME` | where the engine is installed |
| `PIPELINE_AGENT_CMD` | a command that runs every agent instead of an agent CLI (it reads the prompt on stdin) |
| `PIPELINE_AGENT_CLI` | `claude`, `copilot` or `codex`: every agent runs on a `models.pool` entry of that CLI (the entry of the same model when the pool has one, else the CLI's first); a CI job that installs one CLI sets it |
| `PIPELINE_DISABLE=1` | turn off every hook |
| `PIPELINE_BOARD=0`, `PIPELINE_TICKETS_OFFLINE=1` | work without the board |
| `GITLAB_TOKEN`, `AZURE_DEVOPS_TOKEN`, `JIRA_EMAIL`, `JIRA_API_TOKEN`, ... | the tokens the `host` and `tracker` sections name with `${NAME}` (the names are yours to choose) |
| `FACTORY_EXTERNAL_MAX_RETRIES`, `FACTORY_EXTERNAL_RETRY_DELAY_SEC` | how many times a read-only call to the code host or another service is repeated after a network failure (2), and the first pause between tries in seconds (2, doubling) |
| `ARCH_MSBUILD_EVAL` | `0` stops the engine asking MSBuild (`dotnet msbuild -getProperty:`) to confirm a new project's facts; the parse alone still sends anything it cannot be sure of to a person |
| `git config fv.autoPlan true` | write test plans in the background when stories change |
| `git config retro.auto true` | run the retro after merges |

## Settings reference

Every setting, generated from the descriptions beside the defaults (`scripts/<dir>/settings.json`, with the defaults in
`scripts/<dir>/config.json`; `node scripts/pipeline/lib/settings.mjs --write`). The settings test fails when this table
differs from them, when the code reads a setting no description has, when a described setting is read nowhere, or when a
default is not one of its setting's allowed values. Only a plain read counts on its own: `config.a.b`, `config['a'].b`,
joined literals, or `setting(<anything>, 'a.b')` with a literal name, whatever its first argument (or a read of a key
under it). A setting read any other way (a local name or destructured part of the settings, a part passed to a function
or carried in a context, a computed name) names the file that reads it in its description's `readBy`, and that file must
read the key (a property read, a destructuring or its `setting()` name; a word in a string or comment, or an object key,
is not one; a key it only copies into another object must be read on from there); words elsewhere never count. A
`setting()` call with a computed name may stand only for settings whose `readBy` is that call's file: each described
setting its name could be (a template's `${...}` as any text) must name the file, and at least one must. Undescribed
names found through local names, destructuring or one call level are still reported. Code never writes a default again:
not as `?? <literal>` after a read, a parameter's default or a module constant under the setting's own name. A name with
`<...>` is any key of a map (such as an agent's name); `[]` is every item of a list. The loader refuses a value outside
the allowed values, and a name not listed here.

<!-- generated:settings -->
### `agent`

| Setting | What it does | Type | Allowed values | Default | Environment variable |
| --- | --- | --- | --- | --- | --- |
| `agent.supervisor.idleSec` | How long an agent may produce no output before the supervisor stops it as stalled. | whole number | whole number of 1 or more seconds | `1800` | none |
| `agent.supervisor.ceilingFactor` | How many times its normal time an agent that still makes progress may run before it is stopped. | number | number of 1 or more | `10` | `PIPELINE_CEILING_FACTOR` |
| `agent.resultParseRetries` | How many times an agent whose answer has no readable result is asked again for it. | whole number | whole number of 0 or more | `1` | none |
| `agent.claude.promptCacheTtlSec` | The prompt cache lifetime of a headless Claude Code run (an agent run is one short session): 300 or 3600, the two Claude Code offers. | choice | `300`, `3600` | `300` | none |
| `agent.claude.toolSearch` | Defers MCP tools behind Claude Code's ToolSearch instead of listing them to the agent directly. | on/off | `true`, `false` | `false` | none |
| `agent.available.local` | The agent CLIs this machine's developers have (recorded by `factory init`). | list | list of `claude`, `copilot`, `codex` | none | none |
| `agent.available.ci` | The agent CLIs that may run in CI (recorded by `factory init`). | list | list of `claude`, `copilot`, `codex` | none | none |

### `agentOverlayDir`

| Setting | What it does | Type | Allowed values | Default | Environment variable |
| --- | --- | --- | --- | --- | --- |
| `agentOverlayDir` | The repository folder of the agent addenda (`<name>.md`) and replaced definitions (`<name>.agent.md`). | text | a folder relative to the repository | `.factory/agents` | none |

### `agentsDir`

| Setting | What it does | Type | Allowed values | Default | Environment variable |
| --- | --- | --- | --- | --- | --- |
| `agentsDir` | The folder of the base agent definitions inside the factory install. | text | a folder relative to the factory install | `agents` | none |

### `analysis`

| Setting | What it does | Type | Allowed values | Default | Environment variable |
| --- | --- | --- | --- | --- | --- |
| `analysis` | Static analysis, opt-in: `{}` turns on the security pack and the packs of `project.languages` ([analysis](ai-pipeline/analysis.md)); its own validator checks every key. | object | see the linked page, or `null` | off | none |
| `analysis.tools` | The analysis tools, as data; `null` turns a pack's tool off. | map | names to object | none | none |
| `analysis.stages` | The tools each slot runs (`pair`, `story`, `prCheck`, `featureVerification`, `ci`). | map | names to values | none | none |
| `analysis.suppressions` | Inline suppression patterns listed for the members as suppressions to justify. | object | see the linked page | none | none |
| `analysis.protect` | More paths the factory guard protects while analysis is on. | list | list of path | none | none |
| `analysis.coverage` | Coverage of the added production lines, evidence for the `test-value` lens, never a gate. | object | see the linked page | none | none |
| `analysis.ci` | The analysis CI jobs rendered for the CI system (`enabled`, `jobs`). | object | see the linked page | none | none |
| `analysis.ci.jobs[].timeoutSec` | How long one static analysis CI job may run. | whole number | whole number of 1 or more seconds | the pack job's, else `1800` | none |
| `analysis.coverageTimeoutSec` | How long the coverage run (`analysis.coverage`) may take when it names no `timeoutSec` of its own. | whole number | whole number of 1 or more seconds | `1800` | none |
| `analysis.maxConcurrent` | How many analysis tools run at once on the machine. | whole number | whole number of 1 or more | `2` | none |
| `analysis.acceptLicence` | A person's acceptance of a tool licence outside the allowlist. | list | list of object | none | none |
| `analysis.licenceReview` | `strict` turns off every tool enabled pending legal review. | choice | `default`, `strict` | `default` | none |
| `analysis.vars` | Values for a pack's placeholders. | map | names to values | none | none |
| `analysis.secrets` | Values a person declares are not secrets (`allow.stopwords`, `allow.regexes`). | object | see the linked page | none | none |
| `analysis.commercial` | A licensed scanner, or a list of them ([commercial scanners](providers/commercial-scanners.md)). | any | an object or a list of objects | none | none |
| `analysis.commercial.timeoutSec` | How long the gate waits for a licensed scanner's result on a head (each entry of a list has its own). | whole number | whole number of 1 or more seconds | `3600` | none |
| `analysis.maxFixRounds` | How many times static analysis findings are handed back for fixing within one round of verification (and at ticket level). | whole number | whole number of 0 or more rounds | `2` | none |

### `architectureReview`

| Setting | What it does | Type | Allowed values | Default | Environment variable |
| --- | --- | --- | --- | --- | --- |
| `architectureReview.timeoutSec` | The normal time the architecture reviewer may take. | whole number | whole number of 1 or more seconds | `1200` | none |
| `architectureReview.conventions` | Documents the reviewer checks the change against. | list | list of path | `["AGENTS.md","CONTRIBUTING.md"]` | none |
| `architectureReview.policy.enabled` | Runs the architecture policy step before the reviewer. | on/off | `true`, `false` | `true` | none |
| `architectureReview.policy.agent` | The policy engine's script, relative to the factory install. | text | text | `architecture-policy/agents/arch_review.py` | none |
| `architectureReview.policy.dir` | The folder of the repository's architecture rules. | text | text | `.factory/policy` | `ARCH_POLICY_DIR` |
| `architectureReview.policy.command` | The command that runs a policy review (`{agent}` is the engine's script). | command | a command line, or a list of arguments | `["python","{agent}","review","-"]` | none |
| `architectureReview.policy.lessonsCommand` | The command that reads the policy's lessons (`{agent}` is the engine's script). | command | a command line, or a list of arguments | `["python","{agent}","get_lessons","-"]` | none |
| `architectureReview.policy.categories` | The policy's finding categories mapped to the review's. | map | names to string | `{"security":"security","data":"data","resiliency":"resilience","observability":"resilience","error_handling":"correctness","api":"fit","architecture":"fit","testing":"maintainability"}` | none |
| `architectureReview.policy.maxLessons` | The most policy lessons handed to the reviewer. | whole number | whole number of 0 or more | `5` | none |
| `architectureReview.policy.requester` | The agent the policy review is requested for. | text | text | `implementer` | none |
| `architectureReview.policy.semantic` | Whether pending semantic rules go to the reviewer (`auto`) or are left out (`off`). | choice | `auto`, `off` | `auto` | none |
| `architectureReview.policy.timeoutSec` | How long the policy engine's command may take. | whole number | whole number of 1 or more seconds | `600` | none |
| `architectureReview.maxCouncilRounds` | How many rounds the architecture review council gets before the stage escalates to a person (any council size). | whole number | whole number from 1 to 50 rounds | `5` | none |
| `architectureReview.councilPassScore` | The score every blocking member of the architecture review council must give, with no blocking finding standing, for it to pass (any council size). | number | number with at most 1 decimal place from 0 to 10 | `9.5` | none |
| `architectureReview.councilMembers` | How many members sit on the architecture review council (`null`: `council.members`). | whole number | whole number from 1 to 10, or `null` | `null` | none |
| `architectureReview.orchestrator.model` | The `models.pool` entry the architecture review orchestrator runs on (`null`: `orchestrator.model`). | text | a `models.pool` entry name, or `null` | `null` | none |
| `architectureReview.orchestrator.effort` | The architecture review orchestrator's reasoning effort (`null`: `orchestrator.effort`, else its entry's). | choice | `low`, `medium`, `high`, `xhigh`, `max`, or `null` | `null` | none |
| `architectureReview.councilIntercom` | The architecture review council's own discussion settings, over `council.intercom` (a council of one holds no discussion). | object | the keys of `council.intercom` | none | none |

### `baseRef`

| Setting | What it does | Type | Allowed values | Default | Environment variable |
| --- | --- | --- | --- | --- | --- |
| `baseRef` | The branch diffs are taken against and new tickets start from. | text | a git ref | `origin/main` | `PIPELINE_BASE_REF` |

### `board`

| Setting | What it does | Type | Allowed values | Default | Environment variable |
| --- | --- | --- | --- | --- | --- |
| `board.owner` | The GitHub user or organisation that owns the story board project. | text | text, or `null` | the owner of `tickets.repo` | none |
| `board.ownerType` | Whether the board's owner is a user or an organisation. | choice | `user`, `organization` | `user` | none |
| `board.repo` | The repository whose issues are the board's tickets. | text | `owner/name`, or `null` | `tickets.repo` | none |
| `board.projectNumber` | The number of the GitHub project that is the story board. | whole number | whole number of 1 or more, or `null` | `null` | none |
| `board.projectTitle` | The title of the story board project. | text | text, or `null` | `<project name> story board` | none |
| `board.statusField` | The project's field that holds the lane. | text | text | `Status` | none |
| `board.shared` | Whether the GitHub board is shared with other teams or repositories (setup then changes nothing that is not this repository's). | on/off | `true`, `false` | `false` | none |
| `board.fields.<field>` | The project's field names for the pipeline's fields: `impact`, `complexity`, `fixRisk`, `severity`, `confidence`, `reopens`. | text | text | `Impact`, `Complexity`, `Fix risk`, `Severity`, `Confidence`, `Human reopens` | none |
| `board.columns.<lane>` | The board's column for each pipeline lane: `backlog`, `ready`, `inProgress`, `testing`, `review`, `failed`, `done`. | text | text | `Backlog`, `Ready`, `In Progress`, `Testing`, `Pending Review`, `Failed`, `Done` | none |
| `board.storyLabel` | The label of a story ticket. | text | text | `story` | none |
| `board.epicLabel` | The label of an epic ticket. | text | text | `epic` | none |
| `board.spikeLabel` | The label of a spike ticket. | text | text | `spike` | none |
| `board.blockedLabel` | The label of a ticket a person must decide. | text | text | `needs-human` | none |
| `board.resolvedLabel` | The label a person sets when an escalation is resolved. | text | text | `escalation-resolved` | none |
| `board.questions.maxQuestions` | The most questions a failed run's escalation asks a person. | whole number | whole number from 1 to 3 | `3` | none |
| `board.questions.timeoutSec` | The normal time the escalation questions agent may take. | whole number | whole number of 1 or more seconds | `300` | none |
| `board.questions.logTailChars` | How much of a failed run's log the escalation questions agent reads. | whole number | whole number of 0 or more characters | `4000` | none |
| `board.questions.noteChars` | How much of the escalation notes the escalation questions agent reads. | whole number | whole number of 0 or more characters | `6000` | none |
| `board.questions.storyChars` | How much of the ticket the escalation questions agent reads. | whole number | whole number of 0 or more characters | `6000` | none |
| `board.evidence.playwright` | The Playwright command board evidence is recorded with (`null`: the repository's). | command | a command line, or a list of arguments, or `null` | `null` | none |
| `board.evidence.timeoutSec` | How long recording a ticket's evidence may take. | whole number | whole number of 1 or more seconds | `1800` | none |
| `board.evidence.maxExchanges` | The most request and response pairs a ticket's evidence comment shows. | whole number | whole number of 0 or more | `60` | none |
| `board.evidence.maxBodyChars` | The most characters of one request or response body in the evidence. | whole number | whole number of 0 or more characters | `1500` | none |
| `board.evidence.maxCommentChars` | The most characters of one evidence comment. | whole number | whole number of 1 or more characters | `60000` | none |
| `board.evidence.extensions` | The file name endings of the test files board evidence looks through for a ticket's specs. | list | list of string | `[".ts",".js",".mjs"]` | none |

### `bot`

| Setting | What it does | Type | Allowed values | Default | Environment variable |
| --- | --- | --- | --- | --- | --- |
| `bot.enabled` | Opens and updates pull requests as the pipeline's PR bot instead of your own `gh` login. | on/off | `true`, `false` | `true` | `PIPELINE_BOT` |
| `bot.namePattern` | The PR bot's name, with `{login}` replaced by the developer's login. | text | text with `{login}` | `dev-bot-{login}` | none |
| `bot.credentialsDir` | The folder of the PR bot's credentials on this machine. | text | a folder (`~` allowed) | `~/.config/ai-app-factory` | `PIPELINE_BOT_CREDENTIALS_DIR` |

### `ci`

| Setting | What it does | Type | Allowed values | Default | Environment variable |
| --- | --- | --- | --- | --- | --- |
| `ci` | The CI system the factory renders jobs for and reads results from; [providers](providers/README.md) lists each one's keys. | object | see the linked page | the code host's own CI system | none |
| `ci.provider` | Which CI system runs the factory's jobs. | choice | `github-actions`, `gitlab-ci`, `azure-pipelines`, `jenkins`, `circleci`, `bitbucket-pipelines`, `custom` | the code host's own | none |
| `ci.url` | The CI system's API (Jenkins). | text | a URL | none | none |
| `ci.job` | The Jenkins Multibranch job. | text | text | none | none |
| `ci.project` | The CI project (CircleCI project slug). | text | text | none | none |
| `ci.user` | The CI account (Jenkins), as a `${NAME}` reference. | text | text | none | none |
| `ci.token` | The CI API token, as a `${NAME}` reference. | text | a `${NAME}` reference | none | none |
| `ci.expected` | The pipelines a head must run, instead of the ones derived from the CI system. | list | list of pipeline name | none | none |
| `ci.ignore` | Pipelines never waited for. | list | list of pipeline name | none | none |
| `ci.command` | The command of a `custom` CI adapter. | text | text | none | none |
| `ci.env` | Variables for a `custom` adapter's process (`${NAME}` references). | map | names to string | none | none |
| `ci.timeoutSec` | How long one call of a `custom` adapter may take. | whole number | whole number of 1 or more seconds | `60` | none |
| `ci.capabilities` | What a `custom` CI adapter can do. | object | see the linked page | none | none |

### `council`

| Setting | What it does | Type | Allowed values | Default | Environment variable |
| --- | --- | --- | --- | --- | --- |
| `council.blockQuorum` | How many blocking members must object to a finding for it to block (no effect on a council of one). | choice | `any`, `majority`, `all` | `any` | none |
| `council.onUnavailable` | What a round does when a member cannot run: fail the round, or report it and go on without the member (a council of one always fails). | choice | `fail`, `report` | `fail` | none |
| `council.lateGraceSec` | How long the PR check waits, after its last round, for a non-blocking member's late result. | whole number | whole number of 0 or more seconds | `120` | none |
| `council.members` | How many members a council seats, from `models.pool`; 1 seats the stage's own verifier alone. Each stage section's `councilMembers` overrides it. | whole number | whole number from 1 to 10 | `1` | none |
| `council.explorationSeat.enabled` | With two or more seats, reserves one seat for the eligible pool entry with the fewest seats in the stage (by the scorecard), so models it knows little about are still tried; the family rule still applies. | on/off | `true`, `false` | `true` | none |
| `council.shadowSeat.enabled` | With one seat, adds a second, non-blocking member from another model family: its findings are feedback, its score never decides and the stage does not wait for it; beside the PR check's critic panel it is one more critic. It doubles the verifier runs of a one-seat council. | on/off | `true`, `false` | `false` | none |
| `council.scorecard.minSeats` | The seats a model needs in a lens and stage before its scorecard row has numbers; a row with fewer is unknown, neither good nor bad for selection. | whole number | whole number of 1 or more | `10` | none |
| `council.scorecard.weights.prCheckRuling` | The weight of a PR check judge ruling (an upheld finding) in a scorecard row's score. | number | number with at most 2 decimal places of 0 or more | `1` | none |
| `council.scorecard.weights.miss` | The weight of a miss (a problem found after the council passed: a PR check upheld finding, a red CI check) in a scorecard row's score. | number | number with at most 2 decimal places of 0 or more | `1` | none |
| `council.scorecard.weights.ledToChange` | The weight of a pair or verifier stage finding that led to a change in a scorecard row's score. | number | number with at most 2 decimal places of 0 or more | `0.5` | none |
| `council.scorecard.weights.lowWeightMiss` | The weight of a lower-weight miss (a human "changes requested" review, a later bug ticket) in a scorecard row's score. | number | number with at most 2 decimal places of 0 or more | `0.25` | none |
| `council.intercom.enabled` | Lets a council's members discuss their first round with each other before the merge. | on/off | `true`, `false` | `false` | none |
| `council.intercom.host` | The address the discussion room listens on. | text | a host name or IP address | `127.0.0.1` | none |
| `council.intercom.port` | The port the discussion room listens on (0 picks a free one). | whole number | whole number from 0 to 65535 | `0` | none |
| `council.intercom.advertiseHost` | The address members on other machines reach the room at. | text | a host name or IP address, not a wildcard, or `null` | `null` | none |
| `council.intercom.allowInsecureRemote` | Allows a room on a non-loopback address, with plain-HTTP bearer tokens on the network. | on/off | `true`, `false` | `false` | none |
| `council.intercom.maxTurnsPerMember` | How many messages each member may post in a discussion. | whole number | whole number from 1 to 20 | `2` | none |
| `council.intercom.maxEscalations` | How many split questions a discussion may escalate. | whole number | whole number from 0 to 20 | `3` | none |
| `council.intercom.onSplit` | Who rules when the members' discussion splits. | choice | `orchestrator`, `owner` | `orchestrator` | none |

### `e2e`

| Setting | What it does | Type | Allowed values | Default | Environment variable |
| --- | --- | --- | --- | --- | --- |
| `e2e.dir` | The folder of the repository's e2e tests, where `factory render` keeps the shared e2e fixtures. | text | text | `e2e` | none |

### `experiment`

| Setting | What it does | Type | Allowed values | Default | Environment variable |
| --- | --- | --- | --- | --- | --- |
| `experiment.testCmd` | The command a delivery experiment runs a pooled e2e spec with (`{file}` is the spec). | text | a command line with `{file}` | `npx playwright test -c playwright.teststack.config.ts {file}` | none |
| `experiment.testTimeoutSec` | How long one pooled e2e spec of an experiment may run. | whole number | whole number of 1 or more seconds | `1800` | none |

### `factoryGuard`

| Setting | What it does | Type | Allowed values | Default | Environment variable |
| --- | --- | --- | --- | --- | --- |
| `factoryGuard.enabled` | Stops pipeline agents from editing the factory's files in the repository. | on/off | `true`, `false` | `true` | none |
| `factoryGuard.protected` | Paths no pipeline agent may write; every file in the manifest is added. | list | list of path | `[".factory/config.json",".factory/factory.json",".factory/manifest.json",".factory/bin",".factory/agents",".factory/lessons",".factory/policy",".factory/githooks"]` | none |
| `factoryGuard.writers` | The agents exempt from the factory guard. | list | list of agent name | `["retro"]` | none |

### `featureVerification`

| Setting | What it does | Type | Allowed values | Default | Environment variable |
| --- | --- | --- | --- | --- | --- |
| `featureVerification.evidence.manifest` | Where a recorded test run writes its manifest of videos and steps. | text | a path relative to the repository | `artifacts/e2e-videos/manifest.json` | none |
| `featureVerification.precheck.runTests` | Runs the written tests before the test automation verifier sees them. | on/off | `true`, `false` | `true` | none |
| `featureVerification.precheck.fix` | Auto-fix commands by file extension (`{files}`), run on written files before the checks. | map | names to command | `{".md":["node_modules/.bin/markdownlint","--fix","{files}"]}` | none |
| `featureVerification.precheck.lint` | Lint commands by file extension (`{files}`); a failure goes back to the writer before any verifier runs. | map | names to command | `{".md":["node_modules/.bin/markdownlint","{files}"]}` | none |
| `featureVerification.precheck.scenarioFile` | The file name of a test data scenario. | text | text, or `null` | `scenario.yaml` | none |
| `featureVerification.precheck.validateScenario` | A command that validates a written scenario. | command | a command line, or a list of arguments, or `null` | `null` | none |
| `featureVerification.precheck.testRunners` | How written tests are run and discovered ([test runners](ai-pipeline/feature-verification.md)); `null`: the language packs' runners. | list | list of any (runner objects, or a pack's runner names such as `dotnet/xunit`), or `null` | `null` | none |
| `featureVerification.precheck.automationNotes` | Extra lines for the test writer's task. | list | list of text | `[]` | none |
| `featureVerification.precheck.lintExclude` | Files the lint and fix commands never read. | list | list of glob | `["**/node_modules/**","**/bin/**","**/obj/**","**/dist/**","**/wwwroot/lib/**","**/*.min.js","**/*.min.css","**/*.bundle.js",".factory/bin/**","**/graphify-out/**"]` | none |
| `featureVerification.precheck.requireStack` | Fails a test run whose end-to-end runner found no running app stack. | on/off | `true`, `false` | `true` | none |
| `featureVerification.precheck.requireUiEvidence` | Fails a passing UI test run that recorded no evidence of the screens it tested. | on/off | `true`, `false` | `true` | none |
| `featureVerification.precheck.runFullProjects` | Runs a test project in full when none of the ticket's tests could be selected in it. | on/off | `true`, `false` | `true` | none |
| `featureVerification.precheck.fullProjectsEveryRound` | Runs the touched test projects in full in every round, not only the last. | on/off | `true`, `false` | `false` | none |
| `featureVerification.categories.plan` | The gap categories a test plan verifier may report. | list | list of category | `["ac-not-covered","missing-sad-path","untestable-expectation","invented-requirement","vague-steps","duplicate-case","stale-vs-story","other"]` | none |
| `featureVerification.categories.automation` | The gap categories a test automation verifier may report. | list | list of category | `["case-not-covered","tests-different-path","wrong-assertion","missing-assertion","missing-setup","over-mocked","flaky-wait","wrong-layer","visual-mismatch","other"]` | none |
| `featureVerification.categories.sadPathSubtypes` | The subtypes of a missing sad path. | list | list of subtype | `["validation","auth","ownership","not-found","boundary","concurrency","conflict","dependency-failure"]` | none |
| `featureVerification.timeoutsSec.plan` | The normal time the test planner may take. | whole number | whole number of 1 or more seconds | `1800` | none |
| `featureVerification.timeoutsSec.automation` | The normal time the test writer may take. | whole number | whole number of 1 or more seconds | `3600` | none |
| `featureVerification.timeoutsSec.verifier` | The normal time a test plan or test automation verifier may take. | whole number | whole number of 1 or more seconds | `900` | none |
| `featureVerification.timeoutsSec.lessons` | The normal time the lessons writer may take. | whole number | whole number of 1 or more seconds | `1200` | none |
| `featureVerification.timeoutsSec.tests` | The normal time a test run may take. | whole number | whole number of 1 or more seconds | `1800` | none |
| `featureVerification.slots.enabled` | Lets a test run borrow its own copy of the app instead of sharing the main one. | on/off | `true`, `false` | `true` | `FV_USE_SLOTS` |
| `featureVerification.plansDir` | The folder where test plans are written, one folder per ticket. | text | a folder relative to the repository | `.factory/plans` | none |
| `featureVerification.testExtensions` | File extensions of test files. | list | list of extension | `[]` | none |
| `featureVerification.slotWaitSec` | How long a test run waits for a free copy of the app. | whole number | whole number of 0 or more seconds | `21600` | none |
| `featureVerification.enabled` | Runs the automatic test planning and test writing for each ticket. | on/off | `true`, `false` | `true` | `FV_SKIP` |

### `hooks`

| Setting | What it does | Type | Allowed values | Default | Environment variable |
| --- | --- | --- | --- | --- | --- |
| `hooks.codeAgents` | Which agents, when they finish, start the architecture review and the automatic PR check. | list | list of agent name | `["implementer"]` | none |

### `host`

| Setting | What it does | Type | Allowed values | Default | Environment variable |
| --- | --- | --- | --- | --- | --- |
| `host` | The code host the factory acts on; [providers](providers/README.md) lists each one's keys. | object | see the linked page | detected from the `origin` remote | none |
| `host.type` | Which code host the repository is on. | choice | `github`, `gitlab`, `azure-devops`, `bitbucket`, `custom` | detected from the `origin` remote; `github` without one | none |
| `host.url` | The code host's base URL (set it for a self-hosted server). | text | a URL | the hosted service's | none |
| `host.repo` | The repository on the code host (GitHub `owner/name`, GitLab the project path, Azure DevOps `organization/project/repository`, Bitbucket `workspace/repository`). | text | text | from the remote | none |
| `host.user` | Bitbucket only: the `${NAME}` of the account for an API token or app password. | text | a `${NAME}` reference | none | none |
| `host.token` | The environment variable holding the code host's token, never the token (GitHub uses the `gh` login). | text | a `${NAME}` reference | none | none |
| `host.command` | The command of a `custom` code host adapter. | text | text | none | none |
| `host.env` | Variables for a `custom` adapter's process (`${NAME}` references). | map | names to string | none | none |
| `host.timeoutSec` | How long one call of a `custom` adapter may take. | whole number | whole number of 1 or more seconds | `60` | none |
| `host.capabilities` | What a `custom` code host adapter can do. | object | see the linked page | none | none |

### `implement`

| Setting | What it does | Type | Allowed values | Default | Environment variable |
| --- | --- | --- | --- | --- | --- |
| `implement.worktreeDir` | Where ticket and subtask worktrees go, relative to the repository root (`{repo}` is the checkout's folder name). | text | a folder, with `{repo}` | `../{repo}-worktrees` | `IMPLEMENT_WORKTREE_DIR` |
| `implement.branchPrefix` | The prefix of a ticket's branch name (subtasks: `<prefix><key>--<id>`). | text | text | `feat/` | `IMPLEMENT_BRANCH_PREFIX` |
| `implement.delivery` | How an epic run delivers: one PR for the epic, or one per ticket. | choice | `epic`, `story` | `epic` | none |
| `implement.epic.branchPrefix` | The prefix of an epic's branch name. | text | text | `epic/` | `IMPLEMENT_EPIC_BRANCH_PREFIX` |
| `implement.epic.bugfixPrefix` | The prefix of a bug group's branch name. | text | text | `bugfix/` | `IMPLEMENT_BUGFIX_BRANCH_PREFIX` |
| `implement.epic.grouping` | How an epic's tickets are grouped into pull requests. | choice | `auto`, `epic`, `ticket` | `auto` | none |
| `implement.epic.featureVerification` | Runs test planning and test writing for an epic's tickets. | on/off | `true`, `false` | `true` | none |
| `implement.epic.prSplit` | How a feature epic is split into pull requests. | choice | `epic`, `story`, `groups` | `epic` | none |
| `implement.maxSubtasks` | The most subtasks a plan may have. | whole number | whole number of 1 or more | `4` | none |
| `implement.selfModeMaxFiles` | Guidance for the planner: implement the ticket itself up to about this many files. | whole number | whole number of 1 or more | `6` | none |
| `implement.maxConcurrentPairs` | The most verifier pairs of one ticket running at once. | whole number | whole number of 1 or more | `2` | `IMPLEMENT_MAX_PAIRS` |
| `implement.maxConcurrentAgents` | The most agents running at once on the machine. | whole number | whole number of 1 or more | `6` | `IMPLEMENT_MAX_AGENTS` |
| `implement.maxTakeovers` | How many times the orchestrator may take over a subtask its pair could not finish. | whole number | whole number of 0 or more | `1` | none |
| `implement.maxAgentRunsPerStory` | The most agent runs one ticket may use. | whole number | whole number of 1 or more | `20` | none |
| `implement.storyWallClockSec` | The longest one ticket's implementation may take. | whole number | whole number of 1 or more seconds | `10800` | none |
| `implement.prepareCmd` | A shell command run in each new ticket and subtask worktree (a failure is logged, not fatal). | text | text, or `null` | `null` | none |
| `implement.checks` | Shell commands (`{ name, cmd }`) run in the worktree after every pair round; a failure fails the round. | list | list of object | `[]` | none |
| `implement.checks[].name` | A check's name in the verifiers' report. | text | text | none | none |
| `implement.checks[].cmd` | A check's shell command. | text | text | none | none |
| `implement.unitTests.cmd` | The unit test command, with `{project}` (a service's `unitTests` path) and `{service}` (its name). | text | text, or `null` | `null` | none |
| `implement.uiStory.titleTags` | Title tags that make a ticket a UI ticket. | list | list of tag | `["FE"]` | none |
| `implement.uiStory.components` | Ticket components that make a ticket a UI ticket (`null`: the project model's frontend services). | list | list of component, or `null` | `null` | none |
| `implement.pathHints.roots` | More top-level folders the harness recognises as repository paths in an implementer's blocked reason. | list | list of folder | `[]` | none |
| `implement.pathHints.extensions` | More file extensions the harness recognises as repository paths in an implementer's blocked reason. | list | list of extension | `[]` | none |
| `implement.requeue.envKeys` | Extra environment variables `factory requeue-schedule install` copies into the timer. | list | list of variable name | `[]` | none |
| `implement.ui.slotsCmd` | The command of the stack slot registry UI verifiers lease a slot from. | command | a command line, or a list of arguments | `["node","scripts/stack/slots.mjs"]` | none |
| `implement.ui.teststackCmd` | How a UI verifier starts the app on its slot. | command | a command line, or a list of arguments, or `null` | `null` | none |
| `implement.ui.leaseWaitSec` | How long a UI verifier waits for a free stack slot. | whole number | whole number of 0 or more seconds | `300` | none |
| `implement.ui.leaseRetrySec` | How often a UI verifier asks again for a slot. | whole number | whole number of 1 or more seconds | `30` | none |
| `implement.ui.stackTimeoutSec` | How long starting the app on a slot may take. | whole number | whole number of 1 or more seconds | `2400` | none |
| `implement.ui.screenshotsDir` | Where UI verifiers save their screenshots. | text | text | `artifacts/pairs` | none |
| `implement.ui.renewEverySec` | How often a held stack slot lease is renewed. | whole number | whole number of 1 or more seconds | `1800` | none |
| `implement.ui.artifactDirs` | The folders a UI verifier may write into (screenshots, recordings, test reports). | list | list of folder | `["artifacts","test-results","playwright-report","blob-report"]` | none |
| `implement.decisions.smallDiffLoc` | A subtask approved in round 1 at or under this many lines is labelled over-provisioned in the decision report. | whole number | whole number of 0 or more lines | `60` | none |
| `implement.decisions.tinySubtaskLoc` | A subtask at or under this many lines counts as tiny for the should-have-been-self label. | whole number | whole number of 0 or more lines | `40` | none |
| `implement.decisions.tinySubtaskFiles` | A subtask at or under this many files counts as tiny for the should-have-been-self label. | whole number | whole number of 0 or more files | `3` | none |
| `implement.decisions.selfMaxTotalLoc` | A plan of tiny subtasks at or under this many lines in total should have been done by the orchestrator itself. | whole number | whole number of 0 or more lines | `150` | none |
| `implement.decisions.selfOverheadRunsPerSubtask` | More agent runs than this per tiny subtask mark the plan should-have-been-self. | whole number | whole number of 0 or more | `2` | none |
| `implement.reviewGate.enabled` | Runs the review gate that rates bug-fix PRs and decides approvals and auto-merge. | on/off | `true`, `false` | `true` | `REVIEW_GATE` |
| `implement.reviewGate.timeoutSec` | The normal time the bug-triage agent may take. | whole number | whole number of 1 or more seconds | `900` | none |
| `implement.reviewGate.maxDiffChars` | The most characters of a PR's diff the bug-triage agent reads. | whole number | whole number of 1 or more characters | `120000` | none |
| `implement.reviewGate.systems` | The systems a PR can touch, by path (`name`, `paths`, `shared`, `contract`), for the review gate's ratings (`null`: the project model's services). | list | list of object, or `null` | `null` | none |
| `implement.reviewGate.sharedPaths` | Shared systems by name (build files, linked shared sources) added to the project model's services. | map | names to lists of globs | none | none |
| `implement.reviewGate.contractPaths` | Contract systems by name (integration events, API contracts) added to the project model's services. | map | names to lists of globs | none | none |
| `implement.reviewGate.ignore` | Files the review gate leaves out of a PR's change. | list | list of glob | `[".factory/metrics/**",".factory/lessons/**",".factory/state/**",".factory/plans/**",".factory/stack/scenarios/**","**/graphify-out/**","**/*.md"]` | none |
| `implement.reviewGate.ci` | How the review gate reads CI on a PR's head (expected and ignored pipelines). | object | see the linked page | none | none |
| `implement.reviewGate.enforced` | Whether a repository admin lets `factory review-gate enforce` require review quorum and the CI checks (doctor warns until it is done). | on/off | `true`, `false` | `true` | none |
| `implement.reviewGate.requiredChecks` | The checks `factory review-gate enforce` requires on the default branch (`null`: the factory's CI jobs). | list | list of check name, or `null` | `null` | none |
| `implement.reviewGate.floor.paths` | Sensitive paths (CI files, CODEOWNERS, the factory's settings) that put a PR at the floor level. | list | list of glob | `[".github/workflows/**",".github/CODEOWNERS","CODEOWNERS","docs/CODEOWNERS",".factory/config.json",".factory/factory.json",".factory/app.json",".factory/policy/**",".factory/agents/**",".factory/lessons/**",".factory/githooks/**",".factory/bin/**",".factory/stack/docker-compose.yaml"]` | none |
| `implement.reviewGate.floor.categories` | Sensitive categories (auth, payments, ...) that put a PR at the floor level. | list | list of category | `["auth","payments","migration","security"]` | none |
| `implement.reviewGate.manySystems` | A PR that touches at least this many systems is rated one level higher. | whole number | whole number of 1 or more | `3` | none |
| `implement.reviewGate.confidence.agentWeight` | How much the triage agent's own confidence weighs in the confidence score. | number | number from 0 to 1 | `0.2` | none |
| `implement.reviewGate.approvals.<level>` | How many human approvals a PR at each risk level (`Low` to `Severe`, or `default`) needs. | whole number | whole number of 0 or more | `1` for every level | none |
| `implement.reviewGate.labels.approvals` | The label that tells reviewers how many approvals a PR needs (`{n}`). | text | text with `{n}` | `approvals:{n}` | none |
| `implement.reviewGate.labels.needsHuman` | The label of a PR a person must decide. | text | text | `needs-human` | none |
| `implement.reviewGate.labels.autoMerged` | The label of a PR the gate merged by itself. | text | text | `auto-merged` | none |
| `implement.reviewGate.labels.mergeFailed` | The label of a PR whose automatic merge failed. | text | text | `merge-failed` | none |
| `implement.reviewGate.labels.reopened` | The label of a ticket reopened after its PR merged. | text | text | `reopened` | none |
| `implement.reviewGate.substantiveCommentChars` | A review comment at least this long counts as substantive for the gate's records. | whole number | whole number of 0 or more characters | `20` | none |
| `implement.reviewGate.retro.minSample` | The fewest PRs the review gate's retro needs before it proposes a change to a level. | whole number | whole number of 1 or more | `5` | none |
| `implement.reviewGate.retro.raiseFindRate` | A level whose reviews find problems at this rate or more is proposed for raising. | number | number from 0 to 1 | `0.3` | none |
| `implement.reviewGate.retro.raiseEscapeRate` | A level whose merged PRs let bugs escape at this rate or more is proposed for raising. | number | number from 0 to 1 | `0.2` | none |
| `implement.reviewGate.retro.lowerFindRate` | A level whose reviews find problems at this rate or less is proposed for lowering. | number | number from 0 to 1 | `0.05` | none |
| `implement.autoMerge.enabled` | Lets the review gate merge a Low-risk, high-confidence bug fix by itself once its CI is green. | on/off | `true`, `false` | `true` | none |
| `implement.autoMerge.identity` | Who merges: the developer's login, the pipeline's PR bot, or an app or token with a rule bypass. | choice | `gh-user`, `bot`, `app` | `gh-user` | none |
| `implement.autoMerge.method` | How an auto-merged PR is merged. | choice | `squash`, `merge`, `rebase` | `squash` | none |
| `implement.autoMerge.appTokenEnv` | The environment variable holding the token of the `app` merge identity. | text | a variable name | `REVIEW_GATE_APP_TOKEN` | none |
| `implement.preOpen.branches` | Branch patterns whose pushes run CI before a PR exists (`null`: from the branch prefixes). | list | list of branch pattern, or `null` | `null` | none |
| `implement.preOpen.afterOpen` | How an open PR is held while agents work on it again. | choice | `draft`, `label`, `close-reopen` | `draft` | none |
| `implement.preOpen.wipLabel` | The blocking label of a held PR (`label` mode). | text | text | `work-in-progress` | none |
| `implement.ci.maxFixRounds` | How many times agents try to fix CI failures on a ticket (or an epic group), counting every round: CI's checks run here before the push and before the PR, the branch's CI before the PR, and the PR's CI after it opens; a round counts in the run record when it starts, so a resumed run never gets more. Then a person decides (`0`: a person decides at once). | whole number | whole number of 0 or more rounds | `2` | `PIPELINE_CI_FIX_ROUNDS` |
| `implement.worker.maxRetries` | How many times a ticket whose run failed is started again. | whole number | whole number of 0 or more | `2` | none |
| `implement.worker.retryDelaySec` | How long to wait before a failed ticket's first retry; the wait doubles each time. | whole number | whole number of 0 or more seconds | `30` | none |
| `implement.maxOrchestratorRuns` | The most times the orchestrator may run on one ticket after the subtasks are done (integration, review fixes, bug fixes, PR check fixes); when reached, the ticket stops unresolved. | whole number | whole number of 1 or more | `8` | none |
| `implement.maxBugFixReturns` | How many times bugs found by the automated tests are sent back to the implementer before the ticket escalates. | whole number | whole number of 0 or more | `2` | none |
| `implement.epic.maxTicketsPerGroup` | The most tickets in one pull request when an epic is split into several PRs (`null`: no limit). | whole number | whole number of 1 or more, or `null` | `null` | none |
| `implement.maxParallel` | The most tickets worked on at the same time: an upper limit on the number worked out from free memory (`null`: no limit; `--parallel N` forces N). | whole number | whole number of 1 or more, or `null` | `null` | none |
| `implement.reviewGate.confidence.implementRoundsAtMost` | A bug fix counts toward high confidence only if its implementation checks passed within this many rounds. | whole number | whole number of 1 or more rounds | `2` | none |
| `implement.reviewGate.confidence.prCheckRoundsAtMost` | A bug fix counts toward high confidence only if the PR check passed within this many rounds. | whole number | whole number of 1 or more rounds | `2` | none |
| `implement.reviewGate.confidence.highMinScore` | The confidence score out of 100 a bug fix needs to count as high confidence. | whole number | whole number from 0 to 100 | `85` | none |
| `implement.reviewGate.floor.minLevel` | The lowest risk level a PR gets when it touches the floor's paths or categories. | choice | `Low`, `Medium`, `High`, `Severe` | `High` | none |
| `implement.reviewGate.floor.sharedMinLevel` | The lowest risk level a PR gets when it changes shared infrastructure or a contract between services. | choice | `Low`, `Medium`, `High`, `Severe` | `High` | none |
| `implement.waitSec.prCheck` | How long a ticket or epic run waits for a PR check to finish before the ticket ends with an incomplete PR check. | whole number | whole number of 1 or more seconds | `14400` | none |
| `implement.waitSec.prCheckStart` | How long a run waits for the automatic PR check to start at all before treating it as not done. | whole number | whole number of 1 or more seconds | `300` | none |
| `implement.waitSec.featureVerification` | How long a run waits for test planning and test writing to finish. | whole number | whole number of 1 or more seconds | `14400` | none |
| `implement.pollSec.featureVerification` | How often a run checks whether test planning and test writing have finished. | whole number | whole number of 1 or more seconds | `5` | none |
| `implement.ci.wait.timeoutSec` | How long a run waits for CI results on a PR. | whole number | whole number of 1 or more seconds | `10800` | none |
| `implement.ci.wait.pollSec` | How often a run checks CI results. | whole number | whole number of 1 or more seconds | `30` | none |
| `implement.ci.wait.settleSec` | How long CI must stay quiet before its result counts as final. | whole number | whole number of 0 or more seconds | `60` | none |
| `implement.timeoutsSec.planner` | The normal time the planner may take. | whole number | whole number of 1 or more seconds | `1800` | none |
| `implement.timeoutsSec.orchestrator` | The normal time the orchestrator may take. | whole number | whole number of 1 or more seconds | `3600` | none |
| `implement.timeoutsSec.pairImplementer` | The normal time a subtask implementer may take. | whole number | whole number of 1 or more seconds | `1800` | none |
| `implement.timeoutsSec.pairVerifier` | The normal time a pair verifier may take. | whole number | whole number of 1 or more seconds | `600` | none |
| `implement.timeoutsSec.pairUiVerifier` | The normal time a pair UI verifier may take. | whole number | whole number of 1 or more seconds | `1200` | none |
| `implement.timeoutsSec.checks` | The normal time the build checks after a pair round may take. | whole number | whole number of 1 or more seconds | `1800` | none |
| `implement.timeoutsSec.orchestratorFix` | The normal time one run of the main implementer may take after the subtasks. | whole number | whole number of 1 or more seconds | `5400` | none |
| `implement.timeoutsSec.epicPlanner` | The normal time the agent that plans an epic may take. | whole number | whole number of 1 or more seconds | `1800` | none |
| `implement.requeue.outageCooldownSec` | How long tickets stay paused after the AI provider was unavailable before they are queued again. | whole number | whole number of 0 or more seconds | `3600` | none |
| `implement.ci.wait.enabled` | Waits for CI before and after a PR opens (off: the PR says CI was not proven). | on/off | `true`, `false` | `true` | none |
| `implement.ci.parity.enabled` | Runs CI's own checks locally before pushing. | on/off | `true`, `false` | `true` | none |
| `implement.autoMerge.hostAutoMerge.enabled` | Lets the code host's own auto-merge finish an approved PR; off means the pipeline merges it after re-checking the final commit. | on/off | `true`, `false` | `false` | none |
| `implement.maxCouncilRounds` | How many rounds the pair verifier (and pair UI verifier) council gets before the stage escalates to a person (any council size). | whole number | whole number from 1 to 50 rounds | `3` | none |
| `implement.councilPassScore` | The score every blocking member of the pair verifier (and pair UI verifier) council must give, with no blocking finding standing, for it to pass (any council size). | number | number with at most 1 decimal place from 0 to 10 | `9.5` | none |
| `implement.councilMembers` | How many members sit on the pair verifier and pair UI verifier councils (`null`: `council.members`). | whole number | whole number from 1 to 10, or `null` | `null` | none |
| `implement.orchestrator.model` | The `models.pool` entry the implement stage (the implementer agent: it implements the ticket itself or plans subtasks for pairs) orchestrator runs on (`null`: `orchestrator.model`). | text | a `models.pool` entry name, or `null` | `null` | none |
| `implement.orchestrator.effort` | The implement stage orchestrator's reasoning effort (`null`: `orchestrator.effort`, else its entry's). | choice | `low`, `medium`, `high`, `xhigh`, `max`, or `null` | `null` | none |
| `implement.subtaskModels` | The `models.pool` entries the planner may give a subtask's pair implementer; it names one per subtask (`null`: every entry). | list | list of pool entry name (names of `models.pool` entries), or `null` | `null` | none |
| `implement.councilIntercom` | The pair verifiers' council's own discussion settings, over `council.intercom` (a council of one holds no discussion). | object | the keys of `council.intercom` | none | none |

### `implExclude`

| Setting | What it does | Type | Allowed values | Default | Environment variable |
| --- | --- | --- | --- | --- | --- |
| `implExclude` | Paths that are never implementation (records, generated graphs): left out of diffs the verifiers and the PR check read. | list | list of path | `[".factory","graphify-out"]` | none |

### `lessonsDir`

| Setting | What it does | Type | Allowed values | Default | Environment variable |
| --- | --- | --- | --- | --- | --- |
| `lessonsDir` | The folder of the learned rules the retro writes for each agent. | text | a folder relative to the repository | `.factory/lessons` | none |

### `lsp`

| Setting | What it does | Type | Allowed values | Default | Environment variable |
| --- | --- | --- | --- | --- | --- |
| `lsp.maxLanguageServers` | The most heavy (leased) code-intelligence servers running at once on the machine. | whole number | whole number of 0 or more | `6` | `LSP_MAX_SERVERS` |
| `lsp.idleSec` | How long the language server daemon may sit unused before it stops. | whole number | whole number of 1 or more seconds | `900` | `LSP_IDLE_SEC` |
| `lsp.callTimeoutSec` | How long one language server call may take. | whole number | whole number of 1 or more seconds | `60` | none |
| `lsp.diagnosticsTimeoutSec` | How long the diagnostics of one file may take. | whole number | whole number of 1 or more seconds | `20` | none |
| `lsp.loadTimeoutSec` | How long a server that reports its own state may stay loading before calls go through anyway. | whole number | whole number of 1 or more seconds | `900` | none |
| `lsp.prepareTimeoutSec` | How long a leased server's `prepare` command may take. | whole number | whole number of 1 or more seconds | `900` | none |
| `lsp.check` | Probes `factory lsp check` runs: `[server, file, line, column]`. | list | list of any (`[server, file, line?, column?]` lists) | `[]` | none |
| `lsp.servers` | The language servers, merged with the engine's and the packs' by `id` ([code intelligence](code-intelligence.md)). | list | list of object | `[{"id":"bash","extensions":[".sh",".bash"],"languageIds":["shellscript"],"command":"bash-language-server","args":["start"]},{"id":"json","extensions":[".json",".jsonc"],"languageIds":["json","jsonc"],"command":"vscode-json-language-server","args":["--stdio"],"hook":false},{"id":"yaml","extensions":[".yml",".yaml"],"languageIds":["yaml"],"command":"yaml-language-server","args":["--stdio"],"hook":false}]` | none |
| `lsp.client.enabled` | Starts code-intelligence servers for implementation runs. | on/off | `true`, `false` | `true` | none |
| `lsp.client.setupCmd` | The command that prepares the language servers. | command | a command line, or a list of arguments | `["node","scripts/lsp/setup.mjs"]` | none |
| `lsp.client.lspdCmd` | The command of the language server daemon. | command | a command line, or a list of arguments | `["node","scripts/lsp/lspd.mjs"]` | none |
| `lsp.client.timeoutSec` | How long preparing the language servers may take. | whole number | whole number of 1 or more seconds | `300` | none |
| `lsp.client.leaseWaitSec` | How long a run waits for a free language server slot. | whole number | whole number of 0 or more seconds | `300` | none |
| `lsp.client.leaseWaitPollSec` | How often a run waiting for a language server slot asks again. | whole number | whole number of 1 or more seconds | `15` | none |
| `lsp.client.signaturePattern` | A pattern of the lines a signature change is recognised by, for the references check. | text | text | the common declaration styles | none |

### `metrics`

| Setting | What it does | Type | Allowed values | Default | Environment variable |
| --- | --- | --- | --- | --- | --- |
| `metrics.sink.type` | Where agent run records go besides the local files. | choice | `none`, `directory`, `http`, `command`, `otlp` | `none` | `FACTORY_SINK` |
| `metrics.sink.path` | The shared folder a `directory` sink writes to. | text | text | none | none |
| `metrics.sink.url` | The collector a `http` sink posts to. | text | a URL | none | none |
| `metrics.sink.endpoint` | The OpenTelemetry logs endpoint an `otlp` sink posts to. | text | a URL | none | none |
| `metrics.sink.headers` | HTTP headers of an `http` or `otlp` sink (`${NAME}` references for secrets). | map | names to string | none | none |
| `metrics.sink.push` | The command a `command` sink pushes records with. | text | text | none | none |
| `metrics.sink.pull` | The command a `command` sink reads records back with. | text | text, or `null` | none | none |
| `metrics.sink.streams` | More metrics streams to ship besides the pipeline's own. | list | list of stream name | none | none |
| `metrics.sink.scope` | On a readable sink, `all` lets the retro read every project in the store. | choice | `project`, `all` | none | none |

### `metricsDir`

| Setting | What it does | Type | Allowed values | Default | Environment variable |
| --- | --- | --- | --- | --- | --- |
| `metricsDir` | The folder of the agents' committed records, one file per branch and stream. | text | a folder relative to the repository | `.factory/metrics` | none |

### `models`

| Setting | What it does | Type | Allowed values | Default | Environment variable |
| --- | --- | --- | --- | --- | --- |
| `models.cacheTtlSec` | How long the list of models each provider offers is remembered before it is fetched again. | whole number | whole number of 0 or more seconds | `86400` | none |
| `models.pool` | The models the pipeline may run, listed once: every agent and council member runs on one of these entries. At least one. | list | list of object | `[{"name":"opus","cli":"claude","model":"claude-opus-5-5","effort":"high"},{"name":"sonnet","cli":"claude","model":"claude-sonnet-5-5","effort":"medium"},{"name":"sol","cli":"codex","model":"gpt-6.1-sol","effort":"high"}]` | none |
| `models.pool[].name` | An entry's short unique name; settings name the entry by it. | text | letters, digits, `.`, `-` or `_`, up to 40 | `opus` | none |
| `models.pool[].cli` | The agent CLI the entry runs on (`custom` runs its `cmd`). | choice | `claude`, `codex`, `copilot`, `custom` | `claude` | none |
| `models.pool[].model` | The CLI's own model id (`claude-opus-5-5` on Claude Code, `claude-opus-5.5` on Copilot, `gpt-6.1-sol` on Codex); its family (Anthropic, OpenAI, Google) is derived from it. Optional for `custom`. | text | text | `claude-opus-5-5` | none |
| `models.pool[].effort` | The entry's reasoning effort (Claude Code's `--effort`, Codex's `model_reasoning_effort`; Copilot runs at its model's default). | choice | `low`, `medium`, `high`, `xhigh`, `max` | `high` | none |
| `models.pool[].env` | Variables for the entry's CLI process, such as a second login's home folder; never secrets (`${NAME}` references only). | map | names to string | none | none |
| `models.pool[].cmd` | The command a `custom` entry runs (it reads the prompt on stdin). | text | text | none | none |
| `models.pool[].timeoutSec` | The entry's normal run time as a council member (else the stage's verifier time limit). | whole number | whole number of 1 or more seconds | none | none |
| `models.agents.<agent>` | The `models.pool` entry one agent (named as in `agents/`, such as `pr-check-judge`) runs on; `default` for every agent with none of its own. The environment variable names one entry every agent runs on, for experiments. | text | a `models.pool` entry name | none | `PIPELINE_MODEL_OVERRIDE` |

### `orchestrator`

| Setting | What it does | Type | Allowed values | Default | Environment variable |
| --- | --- | --- | --- | --- | --- |
| `orchestrator.model` | The `models.pool` entry every stage's orchestrator runs on: it decides whether to do the stage's producing work itself or delegate it, and it never verifies its own work. | text | a `models.pool` entry name | `opus` | none |
| `orchestrator.effort` | The orchestrators' reasoning effort (`null`: the pool entry's own). | choice | `low`, `medium`, `high`, `xhigh`, `max`, or `null` | `null` | none |

### `policy`

| Setting | What it does | Type | Allowed values | Default | Environment variable |
| --- | --- | --- | --- | --- | --- |
| `policy` | New services for the architecture policy, declared in app.json only ([architecture policy](architecture-policy.md)); never merged into the settings. | object | see the linked page | none | none |

### `prCheck`

| Setting | What it does | Type | Allowed values | Default | Environment variable |
| --- | --- | --- | --- | --- | --- |
| `prCheck.timeoutSec` | The normal time a PR check critic, defender or judge may take. | whole number | whole number of 1 or more seconds | `1800` | none |
| `prCheck.fixTimeoutSec` | The normal time one run of the PR check's fixer may take. | whole number | whole number of 1 or more seconds | `3600` | none |
| `prCheck.maxDiffChars` | The most characters of a PR's diff the critics read. | whole number | whole number of 1 or more characters | `400000` | none |
| `prCheck.hook.enabled` | Runs the automatic PR check when the implementer finishes. | on/off | `true`, `false` | `true` | `PR_CHECK_SKIP` |
| `prCheck.hook.requireTests` | Makes the automatic PR check wait until the tests are verified. | on/off | `true`, `false` | `true` | none |
| `prCheck.hook.pollSec` | How often the automatic PR check looks whether the tests are verified. | whole number | whole number of 1 or more seconds | `20` | none |
| `prCheck.exclude` | Paths the PR check leaves out of the diff. | list | list of path | `[".factory/state",".factory/metrics","graphify-out"]` | none |
| `prCheck.conventions` | Documents the style critic checks the PR against. | list | list of path | `["AGENTS.md","CONTRIBUTING.md",".editorconfig",".markdownlint.json",".factory/agents/implementer.md"]` | none |
| `prCheck.infraPaths` | Changes to shared test setup, build and CI files the harness lists whatever the critics say (regular expressions). | list | list of regular expression | `["(^\|\\/)[^/]*(Fixture\|Collection\|TestBase\|TestSetup\|WebApplicationFactory)[^/]*\\.(cs\|ts\|js\|mjs\|py\|java\|kt)$","(^\|\\/)(xunit\\.runner\\.json\|[^/]*\\.runsettings\|conftest\\.py\|pytest\\.ini\|global-setup\\.[jt]s\|global-teardown\\.[jt]s)$","(^\|\\/)(playwright\|jest\|vitest\|karma\|cypress)[^/]*\\.config\\.[cm]?[jt]s$","(^\|\\/)[^/]*\\.(csproj\|fsproj\|sln\|slnx\|props\|targets)$","(^\|\\/)(Directory\\.Build\\.[^/]+\|Directory\\.Packages\\.props\|global\\.json\|nuget\\.config\|NuGet\\.Config\|package\\.json\|package-lock\\.json\|pnpm-lock\\.yaml\|yarn\\.lock\|requirements[^/]*\\.txt\|pyproject\\.toml\|go\\.mod\|pom\\.xml\|build\\.gradle(\\.kts)?)$","(^\|\\/)(Dockerfile[^/]*\|docker-compose[^/]*\\.ya?ml\|compose[^/]*\\.ya?ml)$","^\\.github\\/workflows\\/[^/]+\\.ya?ml$","(^\|\\/)(\\.gitlab-ci\\.yml\|azure-pipelines[^/]*\\.ya?ml\|Jenkinsfile)$"]` | none |
| `prCheck.video.extensions` | File extensions the PR check reads as videos. | list | list of extension | `[".webm",".mp4",".mov",".mkv"]` | none |
| `prCheck.video.defaultDirs` | Folders the PR check looks for videos in. | list | list of folder | `["artifacts/e2e-videos","test-results"]` | none |
| `prCheck.video.maxFrames` | The most still frames the PR check looks at per video. | whole number | whole number of 1 or more | `48` | none |
| `prCheck.video.maxTotalFrames` | The most frames across all of a PR's videos. | whole number | whole number of 1 or more | `60` | none |
| `prCheck.video.minFramesPerVideo` | The fewest frames taken from each video, whatever the total. | whole number | whole number of 1 or more | `6` | none |
| `prCheck.video.minIntervalSec` | The shortest time between two frames of a video without narrated steps. | number | number of 0 or more seconds | `1` | none |
| `prCheck.video.width` | The width frames are scaled to. | whole number | whole number of 1 or more pixels | `1280` | none |
| `prCheck.video.framesPerStep` | How many frames the PR check takes from each step of a narrated video. | whole number | whole number of 1 or more | `1` | none |
| `prCheck.returnToImplementation.maxReturns` | How many times a PR check failure can send the code back to the implementer before a person decides. | whole number | whole number of 0 or more | `2` | none |
| `prCheck.maxDebateTurns` | How many times the PR check's critics and defender answer each other in each round before the judge rules. | whole number | whole number of 0 or more | `2` | none |
| `prCheck.fixMinSeverity` | The least serious PR check finding that is fixed before a feature's PR opens; less serious ones are only listed. | choice | `blocking`, `major`, `minor` | `major` | none |
| `prCheck.bugFixMinSeverity` | The same, for bug-fix PRs. | choice | `blocking`, `major`, `minor` | `minor` | none |
| `prCheck.returnToImplementation.minSeverity` | The least serious PR check finding about the production code that goes back to the implementer; less serious ones go to the PR check's own fixer. | choice | `blocking`, `major`, `minor` | `major` | none |
| `prCheck.returnToImplementation.implementationLenses` | The PR check lenses whose findings are about the production code. | list | list of lens | `["acceptance","flow","design","correctness","security","ui","rewrite"]` | none |
| `prCheck.returnToImplementation.lightLenses` | The PR check lenses whose findings stay with the light fixer when they name no production file. | list | list of lens | `["video","style","test-value"]` | none |
| `prCheck.returnToImplementation.lightPaths` | Files that are only tests, docs or pipeline records: a finding about them alone stays with the light fixer. | list | list of glob | `["tests/**","test/**","e2e/**","**/*.spec.*","**/*.test.*","**/*Tests/**","**/*.Tests/**","**/*.md","docs/**",".factory/plans/**",".factory/stack/scenarios/**",".factory/metrics/**"]` | none |
| `prCheck.hook.waitForTestsSec` | How long the automatic PR check waits for the tests to be verified before it gives up. | whole number | whole number of 0 or more seconds | `86400` | none |
| `prCheck.mode` | What the PR check does before a ticket's or an epic's PR opens: fix what it finds, only report, or not run. | choice | `fix`, `report`, `off` | `fix` | none |
| `prCheck.returnToImplementation.enabled` | Sends PR check findings about the production code back to the implementer. | on/off | `true`, `false` | `true` | none |
| `prCheck.fixLenses` | Kinds of PR check findings that are always fixed, whatever their severity. | list | list of lens | `[]` | none |
| `prCheck.maxCouncilRounds` | How many rounds the PR check gets, in delivery, in an epic, in a CI fix and by hand (`--max-rounds` overrides it for a run by hand), before it escalates. | whole number | whole number from 1 to 50 rounds | `3` | none |
| `prCheck.councilPassScore` | The score every blocking member of the PR check council must give, with no blocking finding standing, for it to pass (any council size). | number | number with at most 1 decimal place from 0 to 10 | `9.5` | none |
| `prCheck.councilMembers` | How many members sit on the PR check council (`null`: `council.members`). | whole number | whole number from 1 to 10, or `null` | `null` | none |
| `prCheck.orchestrator.model` | The `models.pool` entry the PR check orchestrator runs on (`null`: `orchestrator.model`). | text | a `models.pool` entry name, or `null` | `null` | none |
| `prCheck.orchestrator.effort` | The PR check orchestrator's reasoning effort (`null`: `orchestrator.effort`, else its entry's). | choice | `low`, `medium`, `high`, `xhigh`, `max`, or `null` | `null` | none |
| `prCheck.councilIntercom` | The PR check council's own discussion settings, over `council.intercom` (a council of one holds no discussion). | object | the keys of `council.intercom` | none | none |

### `project`

| Setting | What it does | Type | Allowed values | Default | Environment variable |
| --- | --- | --- | --- | --- | --- |
| `project.name` | Names machine-wide state (stack project, language server sockets), so two repositories on one machine never collide. | text | text | the main checkout's folder name | none |
| `project.languages` | The language packs (`packs/<id>/`) in use. | list | list of pack id | `[]` | none |
| `project.toolPaths` | Folders added to `PATH` for every command and agent the pipeline starts. | list | list of folder (`~` allowed) | `[]` | none |
| `project.services` | The buildable units: their paths, unit tests and dependencies; drives subtask planning, unit tests, stack rebuilds and the review gate's systems. | list | list of object | `[]` | none |
| `project.services[].name` | A service's name. | text | text | none | none |
| `project.services[].kind` | What a service is. | choice | `backend`, `frontend`, `worker`, `library`, `host` | none | none |
| `project.services[].paths` | The paths that belong to a service. | list | list of glob | none | none |
| `project.services[].unitTests` | Where a service's unit tests are (`{project}` in `implement.unitTests.cmd`). | text | text, or `null` | none | none |
| `project.services[].testProjects` | Other test projects that cover a service. | list | list of path | none | none |
| `project.services[].dependsOn` | The services a service depends on. | list | list of service name | none | none |
| `project.services[].partOf` | The one service a library belongs to. | text | text | none | none |
| `project.services[].ui` | Marks a library that holds user interface components. | on/off | `true`, `false` | none | none |
| `project.frontendPaths` | Which files count as user interface: screen checks, design review and demo videos apply only to changes here. | list | list of glob | `[]` | none |
| `project.testRoots` | The folders where tests live; with `implExclude` it separates implementation from tests. | list | list of folder | `[]` | none |

### `prune`

| Setting | What it does | Type | Allowed values | Default | Environment variable |
| --- | --- | --- | --- | --- | --- |
| `prune.enabled` | Runs the automatic disk prune; the free-space check at the start of a run stays. | on/off | `true`, `false` | `true` | `FACTORY_PRUNE` |
| `prune.minFreeGb` | The free disk space a run needs to start or go on (`null`: no check). | number | number of 0 or more GB, or `null` | `20` | `FACTORY_DISK_MIN_GB` |
| `prune.buildDirs` | Build folders removed from idle pipeline worktrees. | list | list of folder | `[".factory/state/teststack","artifacts","test-results","playwright-report"]` | none |
| `prune.buildDirNames` | Git-ignored folder names removed from idle pipeline worktrees. | list | list of folder name | `["bin","obj"]` | none |
| `prune.slotMaxGb` | Leftovers of a stack copy larger than this may be cleaned up (`null`: no size cap). | number | number of 0 or more GB, or `null` | `4` | none |
| `prune.worktreeDays` | A ticket's worktree is removed this long after its PR merged or closed (`null`: never). | whole number | whole number of 0 or more days, or `null` | `7` | none |
| `prune.keepInstalls` | The newest engine installs that are always kept. | whole number | whole number of 0 or more | `3` | none |
| `prune.installRepos` | Other repositories on this machine whose pinned engine installs are kept. | list | list of path | `[]` | none |
| `prune.analysisCacheDays` | Analysis tools and rule sources unused this long are removed from the machine's cache. | whole number | whole number of 0 or more days | `30` | none |
| `prune.analysisReports` | Analysis reports beyond the newest this many commits are removed. | whole number | whole number of 0 or more | `200` | none |
| `prune.analysisBaseDays` | Analysis merge-base caches unused this long are removed. | whole number | whole number of 0 or more days | `14` | none |
| `prune.afterDelivery` | Alpha: removes what a delivered run made on this machine once the delivery remote confirms it. | on/off | `true`, `false` | `false` | none |
| `prune.keepLocal` | Keeps what a delivered run made, for debugging (with `afterDelivery` on). | on/off | `true`, `false` | `false` | `FACTORY_KEEP_LOCAL` |
| `prune.idleSec` | Files a run touched more recently than this are never cleaned up. | whole number | whole number of 0 or more seconds | `3600` | none |
| `prune.slotMaxAgeSec` | Leftovers of a stack copy older than this may be cleaned up. | whole number | whole number of 0 or more seconds | `86400` | none |
| `prune.imageMinAgeSec` | Old app images younger than this are kept. | whole number | whole number of 0 or more seconds | `10800` | none |

### `prVideo`

| Setting | What it does | Type | Allowed values | Default | Environment variable |
| --- | --- | --- | --- | --- | --- |
| `prVideo.specPatterns` | The e2e specs whose recordings demo a PR (empty: no spec is ever picked). | list | list of glob | `[]` | none |
| `prVideo.videosDir` | Where the Playwright reporter writes the raw videos, the step logs and the manifest. | text | text | `artifacts/e2e-videos` | none |
| `prVideo.storageBranch` | The branch the published videos are stored on. | text | text | `pr-videos` | none |
| `prVideo.backendPaths` | Globs of backend code (empty: the paths of every service whose kind is not `frontend`). | list | list of glob | `[]` | none |
| `prVideo.neutralPaths` | Globs that count as neither frontend nor backend. | list | list of glob | `[]` | none |
| `prVideo.api.extractor` | The built-in route extractor the API changes section reads endpoints with. | text | text, or `null` | `null` | none |
| `prVideo.api.sources` | The source files the route extractor reads. | list | list of glob | `[]` | none |
| `prVideo.api.exclude` | Source files the route extractor leaves out. | list | list of glob | `[]` | none |
| `prVideo.api.openapi` | OpenAPI documents the API changes section compares instead of extracted routes. | list | list of path | `[]` | none |
| `prVideo.recordCmd` | How the specs are run in demo mode (`{specs}`: the changed spec files). | text | a command line with `{specs}` | `npx playwright test -c playwright.teststack.config.ts --project scenarios --no-deps --timeout 900000 {specs}` | none |
| `prVideo.slotWaitSec` | How long the demo video step waits for a free test-stack slot. | whole number | whole number of 0 or more seconds | `3600` | none |
| `prVideo.localTimeoutSec` | How long the whole local demo video step may take. | whole number | whole number of 1 or more seconds | `5400` | none |
| `prVideo.testTimeoutSec` | The shortest timeout a test gets in demo mode, so a spec's own timeout cannot cut a recording short. | whole number | whole number of 1 or more seconds | `900` | none |

### `recovery`

| Setting | What it does | Type | Allowed values | Default | Environment variable |
| --- | --- | --- | --- | --- | --- |
| `recovery.startingGraceSec` | How long a background run may take to start before it counts as dead. | whole number | whole number of 1 or more seconds | `120` | none |
| `recovery.maxRetries` | How many times a background run that died (test writing, PR check, review) is restarted. | whole number | whole number of 0 or more | `3` | none |
| `recovery.retryDelaySec` | How long to wait before the first restart of a dead background run; the wait doubles each time. | whole number | whole number of 0 or more seconds | `60` | none |

### `resources`

| Setting | What it does | Type | Allowed values | Default | Environment variable |
| --- | --- | --- | --- | --- | --- |
| `resources.reserveGb` | Memory kept free for the rest of the machine when sizing parallel runs. | number | number of 0 or more GB | `6` | none |
| `resources.worktreeGb` | Memory one ticket's worktree is counted at. | number | number of 0 or more GB | `3` | none |
| `resources.agentGb` | Memory one agent is counted at. | number | number of 0 or more GB | `0.5` | none |
| `resources.lspServerGb` | Memory one language server is counted at. | number | number of 0 or more GB | `0.8` | none |
| `resources.stackGb` | Memory one app stack copy is counted at. | number | number of 0 or more GB | `1.6` | none |
| `resources.dockerOverheadGb` | Memory Docker itself is counted at. | number | number of 0 or more GB | `1` | none |
| `resources.waitPollSec` | How often a run waiting for memory checks again. | whole number | whole number of 1 or more seconds | `15` | none |
| `resources.maxWaitSec` | How long a run waits for memory before it starts anyway. | whole number | whole number of 0 or more seconds | `1800` | none |

### `retro`

| Setting | What it does | Type | Allowed values | Default | Environment variable |
| --- | --- | --- | --- | --- | --- |
| `retro.factory.enabled` | Lets the retro propose changes to the factory itself, as a branch pushed to `source`. | on/off | `true`, `false` | `true` | none |
| `retro.factory.source` | The repository the retro's factory proposal branch is pushed to. | text | text, or `null` | the pin's `source`, else the install's `origin` | none |
| `retro.factory.allowedPaths` | The factory folders a retro proposal may touch. | list | list of folder | `["agents/","docs/","templates/","skills/"]` | none |
| `retro.factory.evidence` | How much of this repository's run data the factory proposal quotes. | choice | `summary`, `none` | `summary` | none |
| `retro.enabled` | Runs the retro that reviews the agents' recorded decisions and proposes fixes. | on/off | `true`, `false` | `true` | none |
| `retro.allowedPaths` | Which repository folders the retro may propose changes to. | list | list of folder | `[".factory/agents/",".factory/policy/"]` | none |
| `retro.windowDays` | How far back the retro looks when it has never run before. | whole number | whole number of 1 or more days | `7` | none |
| `retro.intervalDays` | How often the lessons and the retro run when started as "if due". | whole number | whole number of 1 or more days | `7` | none |
| `retro.lessons.storyThreshold` | A rule is added when a denial category recurs in this many tickets and no rule covers it. | whole number | whole number of 1 or more | `3` | none |
| `retro.lessons.maxRules` | The most rules a lessons file keeps. | whole number | whole number of 1 or more | `15` | none |
| `retro.lessons.retireAfterStories` | A rule is retired when its category has not recurred for this many tickets. | whole number | whole number of 1 or more | `10` | none |
| `retro.lessons.revertMinRounds` | A rule is reverted when, after this many verifier rounds, its category's denial rate did not drop. | whole number | whole number of 1 or more rounds | `6` | none |
| `retro.lessons.examplesPerCategory` | Examples per category in the digest the retro agent reads. | whole number | whole number of 0 or more | `5` | none |

### `stack`

| Setting | What it does | Type | Allowed values | Default | Environment variable |
| --- | --- | --- | --- | --- | --- |
| `stack.poolSize` | How many copies of the app stack (slots) may run at once. | whole number | whole number of 1 or more | `2` | `TESTSTACK_SLOTS` |
| `stack.maxSlot` | The highest slot number. | whole number | whole number of 1 or more | `8` | none |
| `stack.slotStride` | How far apart two slots' host ports are. | whole number | whole number of 1 or more | `1000` | none |
| `stack.stackMemoryMb` | Memory one app stack copy is counted at. | whole number | whole number of 1 or more MB | `2000` | none |
| `stack.composeProject` | The compose project name of slot 0 (slot n appends `-n`). | text | text, or `null` | `<project name>-teststack` | none |
| `stack.imageTag` | The tag given to images named through an environment variable (slot n appends `-n`). | text | text, or `null` | `<project name>-teststack` | none |
| `stack.stateDir` | The stack's generated state (env file, build stamps, slots). | text | text | `.factory/state/teststack` | none |
| `stack.composeFile` | The compose file, relative to the repository. | text | text | `.factory/stack/docker-compose.yaml` | none |
| `stack.envTemplate` | An env file listing every variable the compose file needs. | text | text, or `null` | `null` | none |
| `stack.env` | Fixed, test-only values written to the stack's env file. | map | names to string | `{}` | none |
| `stack.ports` | Host ports per name: `base` on slot 0 and the `env` variable the compose file publishes it with. | map | names to object | `{}` | none |
| `stack.urls` | URLs for people, tests and agents, with `{port:<name>}` placeholders. | map | names to string | `{}` | none |
| `stack.baseUrl` | The URL tests start from (`null`: the first). | text | text, or `null` | `null` | none |
| `stack.services` | Compose services whose images are built from the repository, with their inputs. | map | names to `{ inputs, image, project }`, or a list of inputs | `{}` | none |
| `stack.resolver` | A module that computes more inputs per service. | text | text, or `null` | `null` | none |
| `stack.rebuildAll` | Inputs that affect every image. | list | list of glob | `[]` | none |
| `stack.build.all` | The shell command that builds every image (`null`: `docker compose build`). | text | text, or `null` | `null` | none |
| `stack.build.service` | The shell command that builds one image (`{service}`). | text | text, or `null` | `null` | none |
| `stack.build.serviceNext` | The command for the second and later services of one rebuild. | text | text, or `null` | `null` | none |
| `stack.build.env` | The environment of the build and publish commands. | map | names to string | `{}` | none |
| `stack.build.envFile` | The env file `build.all` writes with the image names (or a list of candidates). | any | a file name, or a list of them (`*` allowed) | `null` | none |
| `stack.build.builtTag` | The tag the build gives its images before they are retagged per slot. | text | text | `latest` | none |
| `stack.build.inputs` | What the build hashes to decide whether the images are current. | list | list of glob | `["."]` | none |
| `stack.build.exclude` | What the build's hash leaves out. | list | list of glob | `[]` | none |
| `stack.publish` | A shell command that generates the compose file into `{out}`. | text | text, or `null` | `null` | none |
| `stack.publishCheck` | A shell command for `publish --check`. | text | text, or `null` | `null` | none |
| `stack.publishAppHost` | The application host project the compose file is published from. | text | text | none | none |
| `stack.publishOverrides` | The test-only overrides of a published stack. | object | see the linked page | none | none |
| `stack.leaseTtlSec` | How long a borrowed copy of the app stack stays reserved without a renewal. | whole number | whole number of 1 or more seconds | `14400` | none |

### `stateDir`

| Setting | What it does | Type | Allowed values | Default | Environment variable |
| --- | --- | --- | --- | --- | --- |
| `stateDir` | The folder of the machine's own state: runs, logs, the ticket cache and the metrics spool (ignored by git). | text | a folder relative to the repository | `.factory/state` | none |

### `storyGuard`

| Setting | What it does | Type | Allowed values | Default | Environment variable |
| --- | --- | --- | --- | --- | --- |
| `storyGuard.enabled` | Keeps agents from reading ticket folders other than the ones handed to their run. | on/off | `true`, `false` | `true` | none |
| `storyGuard.folders` | The folders of cached tickets the guard protects. | list | list of folder | `[".factory/state/board"]` | none |
| `storyGuard.denyPaths` | More paths no pipeline agent may read. | list | list of glob | `[]` | none |
| `storyGuard.denyHosts` | Network hosts no pipeline agent may reach (added to `FACTORY_GUARD_DENY_HOSTS`). | list | list of host name | `[]` | none |
| `storyGuard.denyRepos` | Repositories whose tickets no pipeline agent may read (added to `FACTORY_GUARD_DENY_REPOS`). | list | list of `owner/name` | `[]` | none |
| `storyGuard.installReadable` | Lets pipeline agents read the factory's own install. | on/off | `true`, `false` | `false` | none |
| `storyGuard.networkOpen` | Lets pipeline agents reach any network host the deny lists do not name. | on/off | `true`, `false` | `false` | none |

### `testAutomation`

| Setting | What it does | Type | Allowed values | Default | Environment variable |
| --- | --- | --- | --- | --- | --- |
| `testAutomation.maxCouncilRounds` | How many rounds the test automation council gets before the stage escalates to a person (any council size). | whole number | whole number from 1 to 50 rounds | `5` | none |
| `testAutomation.councilPassScore` | The score every blocking member of the test automation council must give, with no blocking finding standing, for it to pass (any council size). | number | number with at most 1 decimal place from 0 to 10 | `9` | none |
| `testAutomation.councilMembers` | How many members sit on the test automation council (`null`: `council.members`). | whole number | whole number from 1 to 10, or `null` | `null` | none |
| `testAutomation.orchestrator.model` | The `models.pool` entry the test automation stage orchestrator runs on (`null`: `orchestrator.model`). | text | a `models.pool` entry name, or `null` | `null` | none |
| `testAutomation.orchestrator.effort` | The test automation stage orchestrator's reasoning effort (`null`: `orchestrator.effort`, else its entry's). | choice | `low`, `medium`, `high`, `xhigh`, `max`, or `null` | `null` | none |
| `testAutomation.councilIntercom` | The test automation council's own discussion settings, over `council.intercom` (a council of one holds no discussion). | object | the keys of `council.intercom` | none | none |

### `testPlan`

| Setting | What it does | Type | Allowed values | Default | Environment variable |
| --- | --- | --- | --- | --- | --- |
| `testPlan.maxCouncilRounds` | How many rounds the test plan council gets before the stage escalates to a person (any council size). | whole number | whole number from 1 to 50 rounds | `5` | none |
| `testPlan.councilPassScore` | The score every blocking member of the test plan council must give, with no blocking finding standing, for it to pass (any council size). | number | number with at most 1 decimal place from 0 to 10 | `9` | none |
| `testPlan.councilMembers` | How many members sit on the test plan council (`null`: `council.members`). | whole number | whole number from 1 to 10, or `null` | `null` | none |
| `testPlan.orchestrator.model` | The `models.pool` entry the test plan stage orchestrator runs on (`null`: `orchestrator.model`). | text | a `models.pool` entry name, or `null` | `null` | none |
| `testPlan.orchestrator.effort` | The test plan stage orchestrator's reasoning effort (`null`: `orchestrator.effort`, else its entry's). | choice | `low`, `medium`, `high`, `xhigh`, `max`, or `null` | `null` | none |
| `testPlan.councilIntercom` | The test plan council's own discussion settings, over `council.intercom` (a council of one holds no discussion). | object | the keys of `council.intercom` | none | none |

### `teststack`

| Setting | What it does | Type | Allowed values | Default | Environment variable |
| --- | --- | --- | --- | --- | --- |
| `teststack.scenariosDir` | The folder where test data scenarios are written and loaded from. | text | a folder relative to the repository | `.factory/stack/scenarios` | none |
| `teststack.baseScenario` | The scenario loaded before every scenario (`null`: none). | text | text, or `null` | `_base` | none |
| `teststack.defaultScenario` | The scenario `teststack up` loads. | text | text | `default` | none |
| `teststack.stores` | The data stores and how a scenario loads into each ([test stack](test-stack.md)). | map | names to object | `{}` | none |
| `teststack.infrastructureServices` | Compose services that must run but are not the application. | list | list of service name | `[]` | none |
| `teststack.services` | The application's compose services, with the URL that proves each is ready. | list | list of object | `[]` | none |
| `teststack.restartAfterLoad` | Services that cache state a scenario load invalidates. | list | list of any (service names, or `{ service, when, sequences }`) | `[]` | none |
| `teststack.commands` | Extra test stack commands: name to module. | map | names to string | `{}` | none |
| `teststack.timeoutSec` | How long a test stack command, such as loading a scenario, may take. | whole number | whole number of 1 or more seconds | `300` | none |
| `teststack.healAfterSec` | How long a service may stay unready while its stores are healthy before it is restarted once (0: never). | whole number | whole number of 0 or more seconds | `60` | none |

### `tickets`

| Setting | What it does | Type | Allowed values | Default | Environment variable |
| --- | --- | --- | --- | --- | --- |
| `tickets.dir` | The folder, inside the repository, where the story board's tickets are cached for the run. | text | a folder relative to the repository | `.factory/state/board` | none |
| `tickets.repo` | The GitHub repository (`owner/name`) that holds the tickets. | text | `owner/name`, or `null` | the GitHub `origin` of the checkout | none |
| `tickets.assetsBranch` | The branch the board publishes ticket assets (mockups, screenshots) to. | text | text | `board-assets` | none |
| `tickets.legacyDir` | A folder of tickets in the older file format that `board migrate` reads. | text | a folder relative to the repository, or `null` | none | none |
| `tickets.spikeEpic` | The epic `board migrate` files legacy research spikes under (`key`, `title`). | object | see the linked page | `{"key":"epic-research-spikes","title":"Research spikes"}` | none |

### `tracker`

| Setting | What it does | Type | Allowed values | Default | Environment variable |
| --- | --- | --- | --- | --- | --- |
| `tracker` | The ticket tracker the factory acts on; [providers](providers/README.md) lists each one's keys. | object | see the linked page | the code host's own tracker | none |
| `tracker.type` | Which ticket tracker holds the tickets. | choice | `github`, `jira`, `azure-boards`, `gitlab`, `linear`, `custom` | the code host's own (`github`, `azure-boards`, `gitlab`) | none |
| `tracker.url` | The tracker's site or server. | text | a URL | none | none |
| `tracker.project` | The tracker's project (Jira key, Azure DevOps project, GitLab path, Linear team key). | text | text | none | none |
| `tracker.auth` | The tracker's credentials as `${NAME}` references (`user` and `token`, or `token`). | object | see the linked page | none | none |
| `tracker.board` | The tracker's board the pipeline moves tickets on. | object | see the linked page | none | none |
| `tracker.lanes` | The pipeline's lanes mapped to the tracker's statuses or columns. | map | names to string | none | none |
| `tracker.types` | The pipeline's ticket types mapped to the tracker's types. | map | names to string | none | none |
| `tracker.fields` | The pipeline's fields (severity, impact, ...) mapped to the tracker's field ids or names. | map | names to string | none | none |
| `tracker.command` | The command of a `custom` tracker adapter. | text | text | none | none |
| `tracker.env` | Variables for a `custom` adapter's process (`${NAME}` references). | map | names to string | none | none |
| `tracker.timeoutSec` | How long one call of a `custom` adapter may take. | whole number | whole number of 1 or more seconds | `60` | none |
| `tracker.capabilities` | What a `custom` tracker adapter can do. | object | see the linked page | none | none |

### `video`

| Setting | What it does | Type | Allowed values | Default | Environment variable |
| --- | --- | --- | --- | --- | --- |
| `video.narration.enabled` | Speaks each step of a demo video (`false`: silent videos with subtitles). | on/off | `true`, `false` | `true` | none |
| `video.narration.voice` | The Kokoro voice of the narration. | text | text | `af_heart` | none |
| `video.narration.speed` | The narration's speaking speed. | number | number from 0.5 to 2 | `1` | none |
| `video.narration.lang` | The narration's language. | text | text | `en-us` | none |
| `video.narration.model` | The narration model (only the quantized one is pinned). | choice | `int8` | `int8` | none |
| `video.size.width` | The recording width and viewport in demo mode. | whole number | whole number of 1 or more pixels | `1280` | none |
| `video.size.height` | The recording height and viewport in demo mode. | whole number | whole number of 1 or more pixels | `720` | none |
| `video.ffmpeg` | A path to the team's own ffmpeg build (`null`: the pinned one). | text | text, or `null` | `null` | none |
| `video.licenceReview` | `strict` turns narration off while any of its licence items is pending review. | choice | `default`, `strict` | `default` | none |
| `video.script.scope` | Which videos the demo-narrator agent writes a script for. | choice | `headline`, `all`, `none` | `headline` | none |
| `video.script.timeoutSec` | The normal time the narrator may take. | whole number | whole number of 1 or more seconds | `600` | none |
| `video.script.maxSegmentChars` | The longest narrated line. | whole number | whole number of 1 or more characters | `280` | none |
| `video.script.maxOpeningChars` | The longest opening line. | whole number | whole number of 1 or more characters | `240` | none |
| `video.script.maxCloseChars` | The longest closing line. | whole number | whole number of 1 or more characters | `200` | none |
| `video.script.maxTotalChars` | The longest whole script. | whole number | whole number of 1 or more characters | `2400` | none |
| `video.script.maxSegments` | The most narrated lines in a script. | whole number | whole number of 1 or more | `16` | none |
| `video.script.minWordsPerAction` | The words a line needs per user action it covers. | whole number | whole number of 0 or more | `5` | none |
| `video.script.speakEvidence` | Narrates evidence videos aloud too (`false`: subtitled and silent). | on/off | `true`, `false` | `false` | none |
| `video.bugPair.enabled` | Records a before-the-fix video for UI bugs. | on/off | `true`, `false` | `true` | none |
| `video.bugPair.requireBefore` | A bug whose reproduction cannot be shown before the fix opens no PR (the delivery escalates). | on/off | `true`, `false` | `false` | none |
| `video.apiEvidence.enabled` | Shows a backend bug's requests before and after the fix. | on/off | `true`, `false` | `true` | none |
| `video.apiEvidence.headers` | The request and response headers shown (credentials are masked by name whatever this says). | list | list of header name | `["content-type","location","allow","retry-after","accept","x-requestid","x-request-id","idempotency-key","x-idempotency-key","x-correlation-id","if-match","if-none-match"]` | none |
| `video.apiEvidence.maxBodyBytes` | A body is cut at this size. | whole number | whole number of 0 or more bytes | `1500` | none |
| `video.apiEvidence.maxPairs` | Request pairs shown per bug in the PR; the rest are collapsed. | whole number | whole number of 0 or more | `3` | none |
| `video.apiEvidence.paymentBodies` | A payment exchange shows only its method, path and status (`withhold`), or its headers and bodies with card data masked (`mask`). | choice | `withhold`, `mask` | `withhold` | none |
| `video.pacing.stepDelaySec` | While recording: the pause before each step. | number | number with at most 3 decimal places of 0 or more seconds | `0.7` | none |
| `video.pacing.holdSec` | While recording: the hold after each visible change. | number | number with at most 3 decimal places of 0 or more seconds | `1.5` | none |
| `video.pacing.typeDelaySec` | While recording: the delay between typed characters. | number | number with at most 3 decimal places of 0 or more seconds | `0.09` | none |
| `video.pacing.cursorSec` | While recording: the time a cursor move takes. | number | number with at most 3 decimal places of 0 or more seconds | `0.6` | none |
| `video.pacing.pauseSec` | In the rendered video: the pause after each narrated line. | number | number with at most 3 decimal places of 0 or more seconds | `0.6` | none |
<!-- /generated:settings -->
