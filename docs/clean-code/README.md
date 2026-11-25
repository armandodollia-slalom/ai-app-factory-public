# Clean-code report of the generator

The clean-code measurements of the factory itself (GEN-19): `jscpd` clones in code and in the agent and skill
instructions, `lizard` functions over `analysis.complexity.maxCyclomatic` or `analysis.complexity.maxFunctionLines`,
literals and fallbacks that repeat a value with one source (the GEN-6 and GEN-18 checks), and dead code (exports
nothing names, modules nothing imports), over `scripts/`, `agents/`, `skills/`, `packs/`, `templates/` and `bin/`
(test code and fixtures aside), with the analysis gate's own tools. `baseline.json` measures the branch's base,
`triage.json` holds the decision on each item, `closing.json` measures the head, and `functions.json` lists the
functions of the files the branch changed that are over a limit at the base or the head. Regenerate them with
`--json docs/clean-code/baseline.json --at BASE`, `--json docs/clean-code/closing.json` and
`--functions docs/clean-code/functions.json --at BASE`, then render this page with `--markdown`.

## Totals

| Kind | Baseline | Closing |
| --- | --- | --- |
| clone | 56 | 27 |
| instruction-clone | 11 | 4 |
| complexity | 412 | 408 |
| repeat | 144 | 114 |
| dead-export | 23 | 1 |
| dead-file | 9 | 9 |

## By area

| Area | clone | instruction-clone | complexity | repeat | dead-export | dead-file |
| --- | --- | --- | --- | --- | --- | --- |
| PR check | 3 / 1 | 0 / 0 | 18 / 18 | 5 / 5 | 1 / 0 | 0 / 0 |
| agents | 0 / 0 | 8 / 0 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 |
| analysis | 3 / 1 | 0 / 0 | 23 / 23 | 11 / 8 | 2 / 0 | 0 / 0 |
| board | 12 / 10 | 0 / 0 | 55 / 54 | 7 / 9 | 5 / 0 | 0 / 0 |
| council | 0 / 0 | 0 / 0 | 31 / 30 | 16 / 7 | 1 / 0 | 0 / 0 |
| docs build | 0 / 0 | 0 / 0 | 4 / 4 | 0 / 1 | 0 / 0 | 0 / 0 |
| factory | 1 / 0 | 0 / 0 | 20 / 20 | 14 / 13 | 2 / 0 | 0 / 0 |
| feature-verification | 4 / 1 | 0 / 0 | 11 / 11 | 6 / 4 | 1 / 0 | 0 / 0 |
| implement | 6 / 0 | 0 / 0 | 75 / 75 | 24 / 18 | 3 / 0 | 0 / 0 |
| lsp | 0 / 0 | 0 / 0 | 7 / 7 | 5 / 5 | 0 / 0 | 0 / 0 |
| models | 0 / 0 | 0 / 0 | 3 / 3 | 1 / 1 | 1 / 0 | 0 / 0 |
| packs | 6 / 1 | 0 / 0 | 5 / 5 | 0 / 0 | 0 / 0 | 9 / 9 |
| pipeline | 13 / 8 | 0 / 0 | 74 / 72 | 34 / 29 | 2 / 0 | 0 / 0 |
| pr-video | 2 / 0 | 0 / 0 | 26 / 26 | 4 / 4 | 1 / 0 | 0 / 0 |
| retro | 0 / 0 | 0 / 0 | 3 / 3 | 2 / 1 | 0 / 0 | 0 / 0 |
| review | 0 / 0 | 0 / 0 | 4 / 4 | 0 / 0 | 0 / 0 | 0 / 0 |
| review-gate | 0 / 0 | 0 / 0 | 27 / 27 | 10 / 2 | 1 / 0 | 0 / 0 |
| settings | 1 / 0 | 0 / 0 | 18 / 18 | 2 / 1 | 3 / 1 | 0 / 0 |
| skills | 0 / 0 | 3 / 4 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 |
| stack | 0 / 0 | 0 / 0 | 1 / 1 | 2 / 2 | 0 / 0 | 0 / 0 |
| templates | 0 / 0 | 0 / 0 | 2 / 2 | 0 / 3 | 0 / 0 | 0 / 0 |
| teststack | 5 / 5 | 0 / 0 | 5 / 5 | 1 / 1 | 0 / 0 | 0 / 0 |

Each cell is baseline / closing.

## Triage: fixed

| Item | Batch | How | Status |
| --- | --- | --- | --- |
| `instruction-clone agents/pair-ui-verifier.agent.md ~ agents/pair-verifier.agent.md (13 lines)` | instructions | the pair verifiers' shared rules live in one shared file both definitions include | fixed |
| `instruction-clone agents/pr-check-acceptance.agent.md ~ agents/pr-check-design.agent.md (7 lines)` | instructions | the PR check critics' debate and output rules live in one shared file their definitions include | fixed |
| `instruction-clone agents/pr-check-acceptance.agent.md ~ agents/pr-check-flow.agent.md (7 lines)` | instructions | as above | fixed |
| `instruction-clone agents/pr-check-acceptance.agent.md ~ agents/pr-check-style.agent.md (7 lines)` | instructions | as above | fixed |
| `instruction-clone agents/pr-check-design.agent.md ~ agents/pr-check-flow.agent.md (9 lines)` | instructions | the PR check critics' debate and output rules live in one shared file their definitions include | fixed |
| `instruction-clone agents/pr-check-design.agent.md ~ agents/pr-check-style.agent.md (11 lines)` | instructions | the PR check critics' debate and output rules live in one shared file their definitions include | fixed |
| `instruction-clone agents/pr-check-design.agent.md ~ agents/pr-check-video.agent.md (11 lines)` | instructions | the PR check critics' debate and output rules live in one shared file their definitions include | fixed |
| `instruction-clone agents/test-automation-verifier.agent.md ~ agents/test-plan-verifier.agent.md (7 lines)` | instructions | the feature verification verifiers' shared rules live in one shared file both definitions include | fixed |
| `clone scripts/pipeline/lib/analysis/parsers.mjs ~ scripts/pipeline/lib/analysis/parsers.mjs (6 lines)` | council r1 | the two one-line formats are one list (LINE_FORMATS) read by one branch | fixed |
| `clone scripts/pipeline/lib/analysis/report.mjs ~ scripts/pipeline/lib/council.mjs (8 lines)` | duplication | one helper places a marked section in a PR body (before the trailer and the demo video block) | fixed |
| `dead-export scripts/pipeline/lib/analysis/baseline.mjs sameFindingId` | dead code | removed | fixed |
| `dead-export scripts/pipeline/lib/analysis/licences.mjs licenceProblems` | dead code | removed | fixed |
| `repeat scripts/pipeline/lib/analysis/ci.mjs repeated-constant '.factory/bin/analysis/ci.mjs' repeats the constant JOBS_SCRIPT, which scripts/implement/lib/analysis-gate.mjs` | council r1 | reads the one definition (analysis/ci.mjs CI_SCRIPT and CI_DATA) | fixed |
| `repeat scripts/pipeline/lib/analysis/ci.mjs repeated-constant '.factory/bin/analysis/jobs.json' repeats the constant JOBS_DATA, which scripts/implement/lib/analysis-gate.mjs` | council r1 | reads the one definition (analysis/ci.mjs CI_SCRIPT and CI_DATA) | fixed |
| `repeat scripts/pipeline/lib/analysis/fixloop.mjs repeated-constant 'analysis-gate.jsonl' repeats the constant GATE_METRICS, which scripts/implement/lib/analysis-gate.mjs` | council r1 | reads the one definition (GATE_METRICS, now in analysis/fixloop.mjs) | fixed |
| `repeat scripts/pipeline/lib/analysis/scanners/github-code-scanning.mjs repeated-constant 'https://api.github.com' repeats the constant API, which scripts/pipeline/lib/bot.mjs` | council r2 | reads API (bot.mjs) | fixed |
| `clone scripts/board/lib/migrate.mjs ~ scripts/board/lib/migrate.mjs (6 lines)` | council r1 | migrationOrder gives both migrations the issue numbers and the ticket order | fixed |
| `clone scripts/board/lib/trackers/gitlab.mjs ~ scripts/pipeline/lib/hosts/gitlab.mjs (8 lines)` | council r2 | hosts/gitlab.mjs gitlabLabelsAndState, used by the tracker too | fixed |
| `complexity scripts/board/lib/trackers/gitlab.mjs update` | council r2 | the update encoding is gitlabLabelsAndState | fixed |
| `dead-export scripts/board/lib/board.mjs storyKeyOf` | dead code | removed | fixed |
| `dead-export scripts/board/lib/flow.mjs resetOwner` | dead code | removed | fixed |
| `dead-export scripts/board/lib/source.mjs copyTicket` | dead code | removed | fixed |
| `dead-export scripts/board/lib/trackers/index.mjs isGithub` | dead code | removed | fixed |
| `dead-export scripts/board/lib/trackers/shared.mjs applyLabelChange` | dead code | removed | fixed |
| `repeat scripts/board/lib/trackers/gitlab.mjs repeated-constant 'https://gitlab.com' repeats the constant DEFAULT_URL, which scripts/pipeline/lib/hosts/gitlab.mjs` | council r2 | reads the host DEFAULT_URL, now one definition (products.mjs DEFAULT_URLS) | fixed |
| `complexity scripts/pipeline/lib/council.mjs memberTask` | council r1 | memberRole and memberWho | fixed |
| `dead-export scripts/pipeline/lib/council-config.mjs COUNCIL_DEFAULTS` | dead code | removed | fixed |
| `repeat scripts/pipeline/lib/findings.mjs repeated-constant 'all' repeats the constant SOLE_LENS, which scripts/pipeline/lib/council-config.mjs` | council r1 | reads the one definition (SOLE_LENS,) | fixed |
| `repeat scripts/pipeline/lib/findings.mjs repeated-constant 'council-findings.jsonl' repeats the constant FINDINGS_FILE, which scripts/pipeline/lib/scorecard.mjs` | council r1 | one FINDINGS_FILE (findings.mjs), which scorecard.mjs imports; found when the repeated-values check stopped hiding a same-name redeclaration (council r3, sol-12) | fixed |
| `repeat scripts/pipeline/lib/scorecard.mjs repeated-constant 'all' repeats the constant SOLE_LENS, which scripts/pipeline/lib/council-config.mjs` | council r1 | reads the one definition (SOLE_LENS,) | fixed |
| `repeat scripts/pipeline/lib/scorecard.mjs repeated-constant 'council-findings.jsonl' repeats the constant FINDINGS_FILE, which scripts/pipeline/lib/findings.mjs` | council r1 | one FINDINGS_FILE (findings.mjs), which scorecard.mjs imports; found when the repeated-values check stopped hiding a same-name redeclaration (council r3, sol-12) | fixed |
| `repeat scripts/pipeline/lib/scorecard.mjs repeated-constant 'implement-verify' repeats the constant VERIFY_STAGE, which scripts/implement/lib/decisions.mjs` | council r2 | reads the stage constant, now in pipeline/lib/decisions.mjs | fixed |
| `repeat scripts/pipeline/lib/selection.mjs repeated-constant 'all' repeats the constant SOLE_LENS, which scripts/pipeline/lib/council-config.mjs` | council r1 | reads the one definition (SOLE_LENS,) | fixed |
| `clone scripts/factory/install-setup.mjs ~ scripts/pr-check/pr-check.mjs (12 lines)` | council r1 | pr-check.mjs uses util.mjs isMain (moved there from the lsp module, for every script); install-setup.mjs keeps its own, as it runs on bare Node before the factory's packages are installed | fixed |
| `dead-export scripts/factory/lib/github.mjs githubRepo` | dead code | removed | fixed |
| `dead-export scripts/factory/lib/github.mjs hostEnforcement` | dead code | removed | fixed |
| `repeat scripts/factory/factory.mjs repeated-constant '.factory/config.json' repeats the constant OVERLAY, which scripts/retro/lib/lessons.mjs` | council r2 | reads OVERLAY_FILE (config.mjs) | fixed |
| `repeat scripts/factory/lib/init.mjs repeated-constant 'https://gitlab.com' repeats the constant DEFAULT_URL, which scripts/pipeline/lib/hosts/gitlab.mjs` | council r2 | reads the host DEFAULT_URL, now one definition (products.mjs DEFAULT_URLS) | fixed |
| `repeat scripts/factory/lib/interview.mjs repeated-constant 'https://gitlab.com' repeats the constant DEFAULT_URL, which scripts/pipeline/lib/hosts/gitlab.mjs` | council r2 | reads the host DEFAULT_URL, now one definition (products.mjs DEFAULT_URLS) | fixed |
| `repeat scripts/factory/lib/workflow-safety.mjs repeated-constant '.gitlab-ci.yml' repeats the constant GITLAB_ROOT, which scripts/factory/lib/render.mjs` | council r2 | uses GITLAB_ROOT | fixed |
| `clone scripts/feature-verification/lib/verify.mjs ~ scripts/review/lib/review.mjs (7 lines)` | duplication | one helper gives a council's read-only check of the checkout (councilReadOnly), used by every stage | partly fixed (1 of 3 left, 1 kept: the copy left is the merge-then-adjudicate call shape every stage adapter writes; removing it changes adjudicate's interface in four adapters, a follow-up) |
| `clone scripts/feature-verification/lib/workflows.mjs ~ scripts/feature-verification/lib/workflows.mjs (9 lines)` | council r1 | markAutomationVerified stamps the plan index and clears the escalation | fixed |
| `dead-export scripts/feature-verification/lib/slots.mjs heldSlot` | dead code | removed | fixed |
| `repeat scripts/feature-verification/lib/metrics.mjs repeated-constant 'arch-reviews.jsonl' repeats the constant REVIEWS_FILE, which scripts/review/lib/review.mjs` | council r1 | reads the one definition (REVIEWS_FILE,) | fixed |
| `repeat scripts/feature-verification/lib/metrics.mjs repeated-constant 'decision-outcomes.jsonl' repeats the constant OUTCOMES_FILE, which scripts/implement/lib/decisions.mjs` | council r1 | reads the one definition (OUTCOMES_FILE,) | fixed |
| `repeat scripts/feature-verification/lib/metrics.mjs repeated-constant 'pr-checks.jsonl' repeats the constant PR_CHECKS_FILE, which scripts/implement/lib/decisions.mjs` | council r1 | reads the one definition (PR_CHECKS_FILE) | fixed |
| `clone scripts/implement/lib/ci-wait.mjs ~ scripts/implement/lib/ci-wait.mjs (10 lines)` | council r1 | flakyIn reads the retried tests of the successful runs | fixed |
| `clone scripts/implement/lib/mockups.mjs ~ scripts/pr-check/lib/video.mjs (11 lines)` | council r1 | video.mjs uses mockups.mjs loadChromium, with its own message for a missing Playwright | fixed |
| `clone scripts/implement/lib/orchestrate.mjs ~ scripts/implement/lib/orchestrate.mjs (10 lines)` | council r1 | implementerRun: the pair implementer's run options (its entry rule) written once | fixed |
| `clone scripts/implement/lib/orchestrate.mjs ~ scripts/implement/lib/orchestrate.mjs (8 lines)` | council r1 | as above | fixed |
| `clone scripts/implement/lib/tasks.mjs ~ scripts/implement/lib/tasks.mjs (18 lines)` | duplication | the code and UI verifier tasks share one block of the harness's evidence (subtask, checks, diagnostics, diff) | fixed |
| `dead-export scripts/implement/lib/ci-parity.mjs gitHead` | dead code | removed | fixed |
| `dead-export scripts/implement/lib/pr-check-return.mjs sameAsLast` | dead code | removed | fixed |
| `dead-export scripts/implement/lib/project.mjs packCommands` | dead code | removed | fixed |
| `repeat scripts/implement/lib/analysis-gate.mjs repeated-constant '.factory/bin/analysis/ci.mjs' repeats the constant CI_SCRIPT, which scripts/pipeline/lib/analysis/ci.mjs` | council r1 | reads the one definition (analysis/ci.mjs CI_SCRIPT and CI_DATA) | fixed |
| `repeat scripts/implement/lib/analysis-gate.mjs repeated-constant '.factory/bin/analysis/jobs.json' repeats the constant CI_DATA, which scripts/pipeline/lib/analysis/ci.mjs` | council r1 | reads the one definition (analysis/ci.mjs CI_SCRIPT and CI_DATA) | fixed |
| `repeat scripts/implement/lib/decisions.mjs repeated-constant 'pr-checks.jsonl' repeats the constant CHECKS_FILE, which scripts/pr-check/lib/loop.mjs` | council r1 | reads the one definition (PR_CHECKS_FILE) | fixed |
| `repeat scripts/implement/lib/implement.mjs repeated-constant 'implementer' repeats the constant IMPLEMENTER, which scripts/retro/lib/lessons.mjs` | council r2 | reads IMPLEMENTER (agents.mjs) | fixed |
| `repeat scripts/implement/lib/implement.mjs repeated-constant 'lsp' repeats the constant LSP_SERVER, which scripts/pipeline/lib/agents.mjs` | council r2 | the run-conditions record kind: uses LSP_RECORD | fixed |
| `repeat scripts/implement/lib/implement.mjs repeated-constant 'token-usage.jsonl' repeats the constant USAGE_FILE, which scripts/pipeline/lib/usage.mjs` | council r1 | reads the one definition (USAGE_FILE,) | fixed |
| `repeat scripts/implement/lib/orchestrate.mjs repeated-constant 'implement-plan' repeats the constant PLAN_STAGE, which scripts/implement/lib/decisions.mjs` | council r2 | reads the stage constant, now in pipeline/lib/decisions.mjs | fixed |
| `repeat scripts/implement/lib/orchestrate.mjs repeated-constant 'implement-verify' repeats the constant VERIFY_STAGE, which scripts/implement/lib/decisions.mjs` | council r2 | reads the stage constant, now in pipeline/lib/decisions.mjs | fixed |
| `repeat scripts/implement/lib/orchestrate.mjs repeated-constant 'implementer' repeats the constant IMPLEMENTER, which scripts/retro/lib/lessons.mjs` | council r2 | reads IMPLEMENTER (agents.mjs) | fixed |
| `dead-export scripts/models/lib/models.mjs defaultModel` | dead code | removed | fixed |
| `clone packs/dotnet/lsp/prepare.mjs ~ packs/dotnet/lsp/scope.mjs (12 lines)` | duplication | the .NET pack's scripts use the lsp module's isMain instead of four copies | fixed |
| `clone packs/dotnet/lsp/prepare.mjs ~ packs/dotnet/stack/aspire-publish.mjs (12 lines)` | duplication | as above | fixed |
| `clone packs/dotnet/lsp/prepare.mjs ~ packs/dotnet/stack/publish-container.mjs (12 lines)` | duplication | as above | fixed |
| `clone packs/dotnet/lsp/scope.mjs ~ packs/dotnet/stack/aspire-publish.mjs (9 lines)` | duplication | as above | fixed |
| `clone packs/dotnet/lsp/scope.mjs ~ packs/dotnet/stack/publish-container.mjs (9 lines)` | duplication | as above | fixed |
| `clone scripts/pipeline/lib/ci/evidence.mjs ~ scripts/pipeline/lib/ci/evidence.mjs (6 lines)` | council r1 | notIgnored drops the pipelines the settings ignore | fixed |
| `clone scripts/pipeline/lib/ci/github-actions.mjs ~ scripts/pipeline/lib/ci/github-actions.mjs (14 lines)` | council r1 | workflowDocs and pullRequestWorkflows read the workflows once | fixed |
| `clone scripts/pipeline/lib/ci/github-actions.mjs ~ scripts/pipeline/lib/ci/github-actions.mjs (7 lines)` | council r1 | as above | fixed |
| `clone scripts/pipeline/lib/hosts/azure-devops.mjs ~ scripts/pipeline/lib/hosts/gitlab.mjs (7 lines)` | council r2 | the GitLab host update encoding is one helper (gitlabLabelsAndState) | fixed |
| `clone scripts/pipeline/lib/sink.mjs ~ scripts/pipeline/lib/sink.mjs (7 lines)` | council r1 | util.mjs parseJsonl (readJsonl uses it too) | fixed |
| `complexity scripts/pipeline/lib/ci/github-actions.mjs providedChecks` | council r1 | workflowDocs | fixed |
| `complexity scripts/pipeline/lib/orchestrator.mjs decide` | council r2 | askOrchestrator and recordAnswer, shared with guide | fixed |
| `dead-export scripts/pipeline/lib/decisions.mjs loadDecisions` | dead code | removed | fixed |
| `dead-export scripts/pipeline/lib/state.mjs allStates` | dead code | removed | fixed |
| `repeat scripts/pipeline/lib/ci/azure-pipelines.mjs repeated-constant 'https://dev.azure.com' repeats the constant DEFAULT_URL, which scripts/pipeline/lib/hosts/azure-devops.mjs` | council r3 | imports DEFAULT_URL from hosts/azure-devops.mjs, as gitlab-ci.mjs does from hosts/gitlab.mjs (council r3, F13: the item had left the measurement while the file was unchanged) | fixed |
| `repeat scripts/pipeline/lib/ci/gitlab-ci.mjs repeated-constant 'https://gitlab.com' repeats the constant DEFAULT_URL, which scripts/pipeline/lib/hosts/gitlab.mjs` | council r2 | reads the host DEFAULT_URL, now one definition (products.mjs DEFAULT_URLS) | fixed |
| `repeat scripts/pipeline/lib/costs.mjs repeated-constant 'implement-verify' repeats the constant VERIFY_STAGE, which scripts/implement/lib/decisions.mjs` | council r2 | reads the stage constant, now in pipeline/lib/decisions.mjs | fixed |
| `repeat scripts/pipeline/lib/experiment.mjs repeated-constant 'decision-outcomes.jsonl' repeats the constant OUTCOMES_FILE, which scripts/implement/lib/decisions.mjs` | council r1 | reads the one definition (OUTCOMES_FILE,) | fixed |
| `repeat scripts/pipeline/lib/experiment.mjs repeated-constant 'decisions.jsonl' repeats the constant DECISIONS_FILE, which scripts/pipeline/lib/decisions.mjs` | council r1 | reads the one definition (DECISIONS_FILE,) | fixed |
| `repeat scripts/pipeline/lib/experiment.mjs repeated-constant 'implement-verify' repeats the constant VERIFY_STAGE, which scripts/implement/lib/decisions.mjs` | council r2 | reads the stage constant, now in pipeline/lib/decisions.mjs | fixed |
| `repeat scripts/pipeline/lib/experiment.mjs repeated-constant 'subtask-runs.jsonl' repeats the constant SUBTASK_RUNS_FILE, which scripts/implement/lib/decisions.mjs` | council r1 | reads the one definition (SUBTASK_RUNS_FILE,) | fixed |
| `repeat scripts/pipeline/lib/experiment.mjs repeated-constant 'token-usage.jsonl' repeats the constant USAGE_FILE, which scripts/pipeline/lib/usage.mjs` | council r1 | reads the one definition (USAGE_FILE,) | fixed |
| `repeat scripts/pipeline/lib/factory-guard.mjs repeated-constant '.factory/manifest.json' repeats the constant MANIFEST, which scripts/factory/lib/render.mjs` | council r2 | reads MANIFEST_FILE (config.mjs; render re-exports it) | fixed |
| `repeat scripts/pipeline/lib/hosts/bitbucket.mjs repeated-default the fallback 'squash' repeats the default of implement:autoMerge:method, which scripts/implement/config.json` | council r3 | every host's merge() defaults to defaultMergeMethod() (products.mjs), the implement.autoMerge.method setting's default, instead of writing 'squash' | fixed |
| `repeat scripts/pipeline/lib/hosts/github.mjs repeated-constant 'https://api.github.com' repeats the constant API, which scripts/pipeline/lib/bot.mjs` | council r2 | reads API (bot.mjs) | fixed |
| `repeat scripts/pipeline/lib/redact.mjs repeated-constant 'factoryfake' repeats the constant FAKE_SECRET_MARKER, which scripts/pipeline/lib/analysis/config.mjs` | council r1 | reads the one definition (PLACEHOLDER_MARKER) | fixed |
| `clone scripts/pr-check/lib/hooks.mjs ~ scripts/review/lib/review.mjs (6 lines)` | council r1 | isCodeAgentStop lives in cli.mjs beside the other hook-payload helpers; the architecture review and the PR check hook import it | fixed |
| `clone scripts/pr-check/lib/loop.mjs ~ scripts/pr-check/lib/loop.mjs (6 lines)` | council r1 | checkRecordOf gives both round records their target and story | fixed |
| `dead-export scripts/pr-check/lib/github.mjs repoSlug` | dead code | removed | fixed |
| `repeat scripts/pr-check/lib/loop.mjs repeated-constant 'pr-checks.jsonl' repeats the constant PR_CHECKS_FILE, which scripts/implement/lib/decisions.mjs` | council r1 | reads the one definition (PR_CHECKS_FILE) | fixed |
| `clone scripts/pr-video/lib/api-evidence.mjs ~ scripts/pr-video/lib/api-evidence.mjs (17 lines)` | council r1 | the JSON masking applies its edits with splice | fixed |
| `clone scripts/pr-video/lib/api-summary.mjs ~ scripts/pr-video/lib/pr-video.mjs (7 lines)` | council r1 | pr-video.mjs latestAttempts, used by both | fixed |
| `dead-export scripts/pr-video/lib/local.mjs DEFAULT_RECORD_CMD` | dead code | removed | fixed |
| `repeat scripts/retro/lib/lessons.mjs repeated-constant '.factory/factory.json' repeats the constant PIN, which scripts/factory/lib/render.mjs` | council r2 | reads PIN (render.mjs, from config.mjs PIN_FILE) | fixed |
| `repeat scripts/retro/retro.mjs repeated-constant 'lessons' repeats the constant LESSONS_KEY, which scripts/retro/lib/lessons.mjs` | council r2 | the retro's stage: uses LESSONS_STAGE (decisions.mjs), as its token usage, log and cost rows now do | fixed |
| `dead-export scripts/review-gate/lib/gate.mjs labelReopened` | dead code | removed | fixed |
| `repeat scripts/review-gate/lib/assess.mjs repeated-constant 'bug-triage' repeats the constant TRIAGE_STAGE, which scripts/review-gate/lib/assessment.mjs` | council r2 | uses TRIAGE_STAGE, now defined beside TRIAGE_AGENT | fixed |
| `repeat scripts/review-gate/lib/assessment.mjs repeated-constant 'bug-triage' repeats the constant TRIAGE_AGENT, which scripts/review-gate/lib/assess.mjs` | council r2 | uses TRIAGE_AGENT | fixed |
| `repeat scripts/review-gate/lib/assessment.mjs repeated-constant 'decision-outcomes.jsonl' repeats the constant OUTCOMES_FILE, which scripts/implement/lib/decisions.mjs` | council r1 | reads the one definition (OUTCOMES_FILE,) | fixed |
| `repeat scripts/review-gate/lib/assessment.mjs repeated-constant 'pr-checks.jsonl' repeats the constant PR_CHECKS_FILE, which scripts/implement/lib/decisions.mjs` | council r1 | reads the one definition (PR_CHECKS_FILE) | fixed |
| `repeat scripts/review-gate/lib/assessment.mjs repeated-constant 'subtask-runs.jsonl' repeats the constant SUBTASK_RUNS_FILE, which scripts/implement/lib/decisions.mjs` | council r1 | reads the one definition (SUBTASK_RUNS_FILE,) | fixed |
| `repeat scripts/review-gate/lib/github.mjs repeated-default the fallback 'REVIEW_GATE_APP_TOKEN' repeats the default of implement:autoMerge:appTokenEnv, which scripts/implement/config.json` | duplication | read the default from the auto-merge defaults (AUTO_MERGE.appTokenEnv) | fixed |
| `repeat scripts/review-gate/lib/sync.mjs repeated-constant 'pr-checks.jsonl' repeats the constant PR_CHECKS_FILE, which scripts/implement/lib/decisions.mjs` | council r1 | reads the one definition (PR_CHECKS_FILE) | fixed |
| `clone scripts/pipeline/lib/settings.mjs ~ scripts/pipeline/lib/settings.mjs (6 lines)` | council r1 | jsFiles lists the code files with their tool | fixed |
| `dead-export scripts/pipeline/lib/config.mjs apiEvidenceProblems` | dead code | removed | fixed |
| `dead-export scripts/pipeline/lib/config.mjs PAYMENT_BODIES` | dead code | removed | fixed |
| `repeat scripts/pipeline/lib/analysis/config.mjs repeated-constant 'factoryfake' repeats the constant PLACEHOLDER_MARKER, which scripts/pipeline/lib/redact.mjs` | council r1 | reads the one definition (PLACEHOLDER_MARKER) | fixed |

## Triage: kept

- **2 item(s)**: templates/analysis/ci.mjs is copied into an application's repository and runs there without the factory, so it cannot import the factory's copy.

<details>

- `scripts/pipeline/lib/analysis/runner.mjs:123-128 and templates/analysis/ci.mjs:89-94` (clone)
- `scripts/pipeline/lib/ci/github-actions.mjs:36-44 and templates/analysis/ci.mjs:52-60` (clone)

</details>

- **408 item(s)**: a long or branching function that works and is tested; splitting it is a behaviour-preserving refactor of its own, with its own review, so it is a follow-up rather than part of these batches.

<details>

- `scripts/pipeline/lib/analysis/ci.mjs:133-161` (complexity, CCN 16, 29 lines)
- `scripts/pipeline/lib/analysis/commercial.mjs:19-34` (complexity, CCN 23, 16 lines)
- `scripts/pipeline/lib/analysis/commit-gate.mjs:91-127` (complexity, CCN 26, 37 lines)
- `scripts/pipeline/lib/analysis/commit-gate.mjs:60-86` (complexity, CCN 18, 27 lines)
- `scripts/pipeline/lib/analysis/doctor.mjs:27-82` (complexity, CCN 47, 56 lines)
- `scripts/pipeline/lib/analysis/fetch.mjs:76-131` (complexity, CCN 28, 56 lines)
- `scripts/pipeline/lib/analysis/fixloop.mjs:20-52` (complexity, CCN 20, 33 lines)
- `scripts/pipeline/lib/analysis/fixloop.mjs:117-159` (complexity, CCN 26, 43 lines)
- `scripts/pipeline/lib/analysis/history.mjs:38-96` (complexity, CCN 34, 59 lines)
- `scripts/pipeline/lib/analysis/licences.mjs:54-75` (complexity, CCN 22, 22 lines)
- `scripts/pipeline/lib/analysis/parsers.mjs:187-205` (complexity, CCN 25, 19 lines)
- `scripts/pipeline/lib/analysis/parsers.mjs:36-72` (complexity, CCN 30, 37 lines)
- `scripts/pipeline/lib/analysis/report.mjs:84-109` (complexity, CCN 20, 26 lines)
- `scripts/pipeline/lib/analysis/report.mjs:142-190` (complexity, CCN 54, 49 lines)
- `scripts/pipeline/lib/analysis/runner.mjs:211-238` (complexity, CCN 18, 28 lines)
- `scripts/pipeline/lib/analysis/runner.mjs:345-428` (complexity, CCN 41, 84 lines)
- `scripts/pipeline/lib/analysis/runner.mjs:145-207` (complexity, CCN 60, 63 lines)
- `scripts/pipeline/lib/analysis/scanners/github-code-scanning.mjs:37-57` (complexity, CCN 32, 21 lines)
- `scripts/pipeline/lib/analysis/scanners/index.mjs:92-132` (complexity, CCN 38, 41 lines)
- `scripts/pipeline/lib/analysis/scanners/index.mjs:39-59` (complexity, CCN 27, 21 lines)
- `scripts/pipeline/lib/analysis/scanners/semgrep.mjs:25-37` (complexity, CCN 26, 13 lines)
- `scripts/pipeline/lib/analysis/scanners/sonarqube.mjs:27-48` (complexity, CCN 29, 22 lines)
- `scripts/pipeline/lib/analysis/suppressions.mjs:9-45` (complexity, CCN 16, 37 lines)
- `scripts/board/board.mjs:92-401` (complexity, CCN 122, 310 lines)
- `scripts/board/board.mjs:515-551` (complexity, CCN 24, 37 lines)
- `scripts/board/lib/assets.mjs:14-35` (complexity, CCN 22, 22 lines)
- `scripts/board/lib/epics.mjs:115-140` (complexity, CCN 18, 26 lines)
- `scripts/board/lib/escalation.mjs:203-230` (complexity, CCN 30, 28 lines)
- `scripts/board/lib/escalation.mjs:412-444` (complexity, CCN 31, 33 lines)
- `scripts/board/lib/evidence.mjs:143-170` (complexity, CCN 17, 28 lines)
- `scripts/board/lib/flow.mjs:125-167` (complexity, CCN 32, 43 lines)
- `scripts/board/lib/legacy.mjs:67-163` (complexity, CCN 33, 97 lines)
- `scripts/board/lib/migrate.mjs:165-245` (complexity, CCN 32, 81 lines)
- `scripts/board/lib/migrate.mjs:374-404` (complexity, CCN 19, 31 lines)
- `scripts/board/lib/migrate.mjs:115-137` (complexity, CCN 17, 23 lines)
- `scripts/board/lib/migrate.mjs:291-364` (complexity, CCN 32, 74 lines)
- `scripts/board/lib/outcomes.mjs:14-53` (complexity, CCN 20, 40 lines)
- `scripts/board/lib/refresh.mjs:41-89` (complexity, CCN 20, 49 lines)
- `scripts/board/lib/source.mjs:206-273` (complexity, CCN 39, 68 lines)
- `scripts/board/lib/source.mjs:167-190` (complexity, CCN 17, 24 lines)
- `scripts/board/lib/sync.mjs:54-92` (complexity, CCN 19, 39 lines)
- `scripts/board/lib/ticket-commands.mjs:31-69` (complexity, CCN 22, 39 lines)
- `scripts/board/lib/ticket-commands.mjs:227-260` (complexity, CCN 17, 34 lines)
- `scripts/board/lib/ticket-commands.mjs:140-224` (complexity, CCN 50, 85 lines)
- `scripts/board/lib/ticket-commands.mjs:73-136` (complexity, CCN 23, 64 lines)
- `scripts/board/lib/trackers/azure-boards.mjs:56-474` (complexity, CCN 7, 419 lines)
- `scripts/board/lib/trackers/azure-boards.mjs:194-210` (complexity, CCN 18, 17 lines)
- `scripts/board/lib/trackers/azure-boards.mjs:98-123` (complexity, CCN 19, 26 lines)
- `scripts/board/lib/trackers/azure-boards.mjs:357-400` (complexity, CCN 21, 44 lines)
- `scripts/board/lib/trackers/azure-boards.mjs:212-235` (complexity, CCN 19, 24 lines)
- `scripts/board/lib/trackers/github.mjs:153-180` (complexity, CCN 16, 28 lines)
- `scripts/board/lib/trackers/github.mjs:43-682` (complexity, CCN 3, 640 lines)
- `scripts/board/lib/trackers/github.mjs:488-576` (complexity, CCN 30, 89 lines)
- `scripts/board/lib/trackers/github.mjs:218-237` (complexity, CCN 20, 20 lines)
- `scripts/board/lib/trackers/gitlab.mjs:42-319` (complexity, CCN 8, 278 lines)
- `scripts/board/lib/trackers/http.mjs:42-77` (complexity, CCN 31, 36 lines)
- `scripts/board/lib/trackers/jira.mjs:209-219` (complexity, CCN 18, 11 lines)
- `scripts/board/lib/trackers/jira.mjs:87-113` (complexity, CCN 25, 27 lines)
- `scripts/board/lib/trackers/jira.mjs:40-491` (complexity, CCN 8, 452 lines)
- `scripts/board/lib/trackers/jira.mjs:119-139` (complexity, CCN 17, 21 lines)
- `scripts/board/lib/trackers/jira.mjs:367-414` (complexity, CCN 24, 48 lines)
- `scripts/board/lib/trackers/jira.mjs:221-240` (complexity, CCN 25, 20 lines)
- `scripts/board/lib/trackers/linear.mjs:25-308` (complexity, CCN 5, 284 lines)
- `scripts/board/lib/trackers/linear.mjs:144-162` (complexity, CCN 20, 19 lines)
- `scripts/board/lib/trackers/markdown.mjs:404-437` (complexity, CCN 17, 34 lines)
- `scripts/board/lib/trackers/markdown.mjs:467-503` (complexity, CCN 32, 37 lines)
- `scripts/board/lib/trackers/markdown.mjs:446-465` (complexity, CCN 26, 20 lines)
- `scripts/board/lib/trackers/markdown.mjs:937-985` (complexity, CCN 21, 49 lines)
- `scripts/board/lib/trackers/markdown.mjs:884-924` (complexity, CCN 22, 41 lines)
- `scripts/board/lib/trackers/markdown.mjs:817-841` (complexity, CCN 16, 25 lines)
- `scripts/board/lib/trackers/markdown.mjs:277-288` (complexity, CCN 19, 12 lines)
- `scripts/board/lib/trackers/markdown.mjs:41-109` (complexity, CCN 33, 69 lines)
- `scripts/board/lib/trackers/markdown.mjs:848-875` (complexity, CCN 17, 28 lines)
- `scripts/board/lib/trackers/markdown.mjs:167-248` (complexity, CCN 32, 82 lines)
- `scripts/board/lib/trackers/markdown.mjs:130-164` (complexity, CCN 20, 35 lines)
- `scripts/board/lib/trackers/markdown.mjs:583-657` (complexity, CCN 34, 75 lines)
- `scripts/board/lib/trackers/markdown.mjs:706-780` (complexity, CCN 24, 75 lines)
- `scripts/pipeline/lib/council-config.mjs:76-110` (complexity, CCN 39, 35 lines)
- `scripts/pipeline/lib/council.mjs:653-750` (complexity, CCN 50, 98 lines)
- `scripts/pipeline/lib/council.mjs:979-1000` (complexity, CCN 24, 22 lines)
- `scripts/pipeline/lib/council.mjs:1564-1598` (complexity, CCN 27, 35 lines)
- `scripts/pipeline/lib/council.mjs:1221-1296` (complexity, CCN 24, 76 lines)
- `scripts/pipeline/lib/council.mjs:1446-1502` (complexity, CCN 36, 57 lines)
- `scripts/pipeline/lib/council.mjs:1629-1655` (complexity, CCN 18, 27 lines)
- `scripts/pipeline/lib/council.mjs:559-582` (complexity, CCN 23, 24 lines)
- `scripts/pipeline/lib/council.mjs:589-854` (complexity, CCN 96, 266 lines)
- `scripts/pipeline/lib/council.mjs:1391-1442` (complexity, CCN 30, 52 lines)
- `scripts/pipeline/lib/council.mjs:351-404` (complexity, CCN 17, 54 lines)
- `scripts/pipeline/lib/council.mjs:480-493` (complexity, CCN 20, 14 lines)
- `scripts/pipeline/lib/council.mjs:1132-1172` (complexity, CCN 27, 41 lines)
- `scripts/pipeline/lib/finding-route.mjs:137-165` (complexity, CCN 18, 29 lines)
- `scripts/pipeline/lib/finding-route.mjs:78-98` (complexity, CCN 23, 21 lines)
- `scripts/pipeline/lib/finding-route.mjs:114-130` (complexity, CCN 18, 17 lines)
- `scripts/pipeline/lib/findings.mjs:68-75` (complexity, CCN 16, 8 lines)
- `scripts/pipeline/lib/findings.mjs:128-140` (complexity, CCN 26, 13 lines)
- `scripts/pipeline/lib/findings.mjs:99-112` (complexity, CCN 22, 14 lines)
- `scripts/pipeline/lib/findings.mjs:60-92` (complexity, CCN 18, 33 lines)
- `scripts/pipeline/lib/intercom-room.mjs:375-400` (complexity, CCN 31, 26 lines)
- `scripts/pipeline/lib/intercom-room.mjs:213-237` (complexity, CCN 19, 25 lines)
- `scripts/pipeline/lib/intercom-server.mjs:152-214` (complexity, CCN 42, 63 lines)
- `scripts/pipeline/lib/intercom-server.mjs:71-81` (complexity, CCN 16, 11 lines)
- `scripts/pipeline/lib/intercom.mjs:276-317` (complexity, CCN 23, 42 lines)
- `scripts/pipeline/lib/intercom.mjs:184-268` (complexity, CCN 39, 85 lines)
- `scripts/pipeline/lib/scorecard.mjs:70-165` (complexity, CCN 42, 96 lines)
- `scripts/pipeline/lib/selection.mjs:127-183` (complexity, CCN 26, 57 lines)
- `scripts/pipeline/lib/selection.mjs:87-117` (complexity, CCN 26, 31 lines)
- `scripts/pipeline/lib/selection.mjs:237-332` (complexity, CCN 23, 96 lines)
- `scripts/docs/lib/flow-eval.mjs:28-45` (complexity, CCN 17, 18 lines)
- `scripts/docs/lib/flow-eval.mjs:142-201` (complexity, CCN 16, 60 lines)
- `scripts/docs/lib/flow-eval.mjs:206-260` (complexity, CCN 32, 55 lines)
- `scripts/docs/lib/spine.mjs:57-81` (complexity, CCN 17, 25 lines)
- `scripts/factory/analysis.mjs:21-100` (complexity, CCN 47, 80 lines)
- `scripts/factory/factory.mjs:126-309` (complexity, CCN 101, 184 lines)
- `scripts/factory/factory.mjs:311-564` (complexity, CCN 132, 254 lines)
- `scripts/factory/lib/adapters.mjs:48-135` (complexity, CCN 62, 88 lines)
- `scripts/factory/lib/code-host.mjs:25-58` (complexity, CCN 33, 34 lines)
- `scripts/factory/lib/detect.mjs:64-143` (complexity, CCN 47, 80 lines)
- `scripts/factory/lib/init.mjs:21-74` (complexity, CCN 19, 54 lines)
- `scripts/factory/lib/interview.mjs:210-247` (complexity, CCN 24, 38 lines)
- `scripts/factory/lib/pre-open-ci.mjs:53-81` (complexity, CCN 20, 29 lines)
- `scripts/factory/lib/prune.mjs:221-250` (complexity, CCN 23, 30 lines)
- `scripts/factory/lib/prune.mjs:374-421` (complexity, CCN 22, 48 lines)
- `scripts/factory/lib/prune.mjs:280-344` (complexity, CCN 32, 65 lines)
- `scripts/factory/lib/prune.mjs:725-764` (complexity, CCN 27, 40 lines)
- `scripts/factory/lib/prune.mjs:687-719` (complexity, CCN 30, 33 lines)
- `scripts/factory/lib/prune.mjs:826-846` (complexity, CCN 18, 21 lines)
- `scripts/factory/lib/render.mjs:561-579` (complexity, CCN 17, 19 lines)
- `scripts/factory/lib/render.mjs:347-463` (complexity, CCN 34, 117 lines)
- `scripts/factory/lib/render.mjs:531-558` (complexity, CCN 16, 28 lines)
- `scripts/factory/policy-library.mjs:90-200` (complexity, CCN 49, 111 lines)
- `scripts/factory/sink.mjs:16-66` (complexity, CCN 28, 51 lines)
- `scripts/feature-verification/feature-verification.mjs:120-308` (complexity, CCN 72, 189 lines)
- `scripts/feature-verification/lib/plans.mjs:61-108` (complexity, CCN 38, 48 lines)
- `scripts/feature-verification/lib/runners.mjs:261-294` (complexity, CCN 17, 34 lines)
- `scripts/feature-verification/lib/verify.mjs:38-50` (complexity, CCN 16, 13 lines)
- `scripts/feature-verification/lib/verify.mjs:241-249` (complexity, CCN 16, 9 lines)
- `scripts/feature-verification/lib/verify.mjs:192-275` (complexity, CCN 23, 84 lines)
- `scripts/feature-verification/lib/verify.mjs:31-74` (complexity, CCN 25, 44 lines)
- `scripts/feature-verification/lib/workflows.mjs:711-744` (complexity, CCN 17, 34 lines)
- `scripts/feature-verification/lib/workflows.mjs:746-940` (complexity, CCN 62, 195 lines)
- `scripts/feature-verification/lib/workflows.mjs:254-396` (complexity, CCN 50, 143 lines)
- `scripts/feature-verification/lib/workflows.mjs:451-622` (complexity, CCN 66, 172 lines)
- `scripts/implement/implement.mjs:227-504` (complexity, CCN 134, 278 lines)
- `scripts/implement/implement.mjs:104-206` (complexity, CCN 59, 103 lines)
- `scripts/implement/lib/analysis-gate.mjs:174-222` (complexity, CCN 30, 49 lines)
- `scripts/implement/lib/analysis-gate.mjs:40-81` (complexity, CCN 21, 42 lines)
- `scripts/implement/lib/batch.mjs:29-71` (complexity, CCN 25, 43 lines)
- `scripts/implement/lib/ci-parity.mjs:98-139` (complexity, CCN 20, 42 lines)
- `scripts/implement/lib/ci-wait.mjs:344-373` (complexity, CCN 26, 30 lines)
- `scripts/implement/lib/ci-wait.mjs:203-245` (complexity, CCN 47, 43 lines)
- `scripts/implement/lib/ci-wait.mjs:31-48` (complexity, CCN 20, 18 lines)
- `scripts/implement/lib/ci-wait.mjs:250-266` (complexity, CCN 21, 17 lines)
- `scripts/implement/lib/ci-wait.mjs:75-115` (complexity, CCN 33, 41 lines)
- `scripts/implement/lib/decisions.mjs:50-72` (complexity, CCN 25, 23 lines)
- `scripts/implement/lib/decisions.mjs:230-280` (complexity, CCN 49, 51 lines)
- `scripts/implement/lib/decisions.mjs:294-310` (complexity, CCN 17, 17 lines)
- `scripts/implement/lib/decisions.mjs:155-184` (complexity, CCN 28, 30 lines)
- `scripts/implement/lib/disputes.mjs:58-82` (complexity, CCN 17, 25 lines)
- `scripts/implement/lib/epic-plan.mjs:378-395` (complexity, CCN 16, 18 lines)
- `scripts/implement/lib/epic-plan.mjs:205-255` (complexity, CCN 21, 51 lines)
- `scripts/implement/lib/epic-plan.mjs:465-492` (complexity, CCN 42, 28 lines)
- `scripts/implement/lib/epic-plan.mjs:262-325` (complexity, CCN 35, 64 lines)
- `scripts/implement/lib/epic.mjs:713-1006` (complexity, CCN 162, 294 lines)
- `scripts/implement/lib/epic.mjs:504-710` (complexity, CCN 98, 207 lines)
- `scripts/implement/lib/epic.mjs:83-94` (complexity, CCN 19, 12 lines)
- `scripts/implement/lib/epic.mjs:1162-1174` (complexity, CCN 19, 13 lines)
- `scripts/implement/lib/epic.mjs:375-393` (complexity, CCN 21, 19 lines)
- `scripts/implement/lib/epic.mjs:161-200` (complexity, CCN 24, 40 lines)
- `scripts/implement/lib/epic.mjs:102-133` (complexity, CCN 16, 32 lines)
- `scripts/implement/lib/epic.mjs:464-502` (complexity, CCN 19, 39 lines)
- `scripts/implement/lib/epic.mjs:1074-1159` (complexity, CCN 23, 86 lines)
- `scripts/implement/lib/gitops.mjs:142-168` (complexity, CCN 16, 27 lines)
- `scripts/implement/lib/implement.mjs:1839-1977` (complexity, CCN 68, 139 lines)
- `scripts/implement/lib/implement.mjs:1465-1667` (complexity, CCN 107, 203 lines)
- `scripts/implement/lib/implement.mjs:2263-2291` (complexity, CCN 27, 29 lines)
- `scripts/implement/lib/implement.mjs:785-1378` (complexity, CCN 278, 594 lines)
- `scripts/implement/lib/implement.mjs:230-322` (complexity, CCN 72, 93 lines)
- `scripts/implement/lib/implement.mjs:2099-2110` (complexity, CCN 18, 12 lines)
- `scripts/implement/lib/implement.mjs:2071-2077` (complexity, CCN 17, 7 lines)
- `scripts/implement/lib/implement.mjs:473-548` (complexity, CCN 34, 76 lines)
- `scripts/implement/lib/implement.mjs:1682-1715` (complexity, CCN 28, 34 lines)
- `scripts/implement/lib/implement.mjs:714-742` (complexity, CCN 26, 29 lines)
- `scripts/implement/lib/implement.mjs:341-395` (complexity, CCN 29, 55 lines)
- `scripts/implement/lib/implement.mjs:2133-2153` (complexity, CCN 21, 21 lines)
- `scripts/implement/lib/implement.mjs:192-221` (complexity, CCN 17, 30 lines)
- `scripts/implement/lib/implement.mjs:410-467` (complexity, CCN 27, 58 lines)
- `scripts/implement/lib/implement.mjs:2008-2045` (complexity, CCN 33, 38 lines)
- `scripts/implement/lib/lsp.mjs:164-183` (complexity, CCN 17, 20 lines)
- `scripts/implement/lib/lsp.mjs:63-191` (complexity, CCN 7, 129 lines)
- `scripts/implement/lib/lsp.mjs:93-131` (complexity, CCN 24, 39 lines)
- `scripts/implement/lib/mockups.mjs:153-254` (complexity, CCN 1, 102 lines)
- `scripts/implement/lib/mockups.mjs:110-120` (complexity, CCN 19, 11 lines)
- `scripts/implement/lib/mockups.mjs:210-246` (complexity, CCN 16, 37 lines)
- `scripts/implement/lib/mockups.mjs:287-344` (complexity, CCN 17, 58 lines)
- `scripts/implement/lib/mockups.mjs:169-209` (complexity, CCN 23, 41 lines)
- `scripts/implement/lib/orchestrate.mjs:130-159` (complexity, CCN 25, 30 lines)
- `scripts/implement/lib/orchestrate.mjs:535-750` (complexity, CCN 64, 216 lines)
- `scripts/implement/lib/orchestrate.mjs:236-292` (complexity, CCN 22, 57 lines)
- `scripts/implement/lib/orchestrate.mjs:1050-1125` (complexity, CCN 32, 76 lines)
- `scripts/implement/lib/orchestrate.mjs:843-902` (complexity, CCN 19, 60 lines)
- `scripts/implement/lib/orchestrate.mjs:356-405` (complexity, CCN 18, 50 lines)
- `scripts/implement/lib/plan.mjs:54-62` (complexity, CCN 17, 9 lines)
- `scripts/implement/lib/plan.mjs:277-313` (complexity, CCN 40, 37 lines)
- `scripts/implement/lib/plan.mjs:329-345` (complexity, CCN 18, 17 lines)
- `scripts/implement/lib/plan.mjs:117-141` (complexity, CCN 20, 25 lines)
- `scripts/implement/lib/plan.mjs:36-50` (complexity, CCN 20, 15 lines)
- `scripts/implement/lib/plan.mjs:235-325` (complexity, CCN 43, 91 lines)
- `scripts/implement/lib/pr-check-return.mjs:53-77` (complexity, CCN 25, 25 lines)
- `scripts/implement/lib/pr-check-return.mjs:101-125` (complexity, CCN 20, 25 lines)
- `scripts/implement/lib/pre-open.mjs:289-306` (complexity, CCN 18, 18 lines)
- `scripts/implement/lib/pre-open.mjs:120-143` (complexity, CCN 23, 24 lines)
- `scripts/implement/lib/pre-open.mjs:229-266` (complexity, CCN 23, 38 lines)
- `scripts/implement/lib/requeue.mjs:73-124` (complexity, CCN 36, 52 lines)
- `scripts/implement/lib/resources.mjs:53-79` (complexity, CCN 19, 27 lines)
- `scripts/implement/lib/resources.mjs:92-113` (complexity, CCN 20, 22 lines)
- `scripts/implement/lib/stop.mjs:53-85` (complexity, CCN 26, 33 lines)
- `scripts/implement/requeue-schedule.mjs:77-136` (complexity, CCN 25, 60 lines)
- `scripts/lsp/check.mjs:39-164` (complexity, CCN 26, 126 lines)
- `scripts/lsp/lib/common.mjs:238-267` (complexity, CCN 21, 30 lines)
- `scripts/lsp/lib/common.mjs:29-48` (complexity, CCN 17, 20 lines)
- `scripts/lsp/lib/daemon.mjs:52-76` (complexity, CCN 16, 25 lines)
- `scripts/lsp/lib/daemon.mjs:110-608` (complexity, CCN 12, 499 lines)
- `scripts/lsp/lspd.mjs:179-250` (complexity, CCN 40, 72 lines)
- `scripts/lsp/setup.mjs:55-82` (complexity, CCN 17, 28 lines)
- `scripts/models/lib/models.mjs:365-413` (complexity, CCN 21, 49 lines)
- `scripts/models/lib/models.mjs:288-317` (complexity, CCN 17, 30 lines)
- `scripts/models/models.mjs:41-105` (complexity, CCN 47, 65 lines)
- `packs/commercial/parsers/veracode-pipeline.mjs:11-27` (complexity, CCN 19, 17 lines)
- `packs/dotnet/analysis/nuget-audit.mjs:12-34` (complexity, CCN 20, 23 lines)
- `packs/dotnet/pr-video/aspnet-minimal-api.mjs:30-44` (complexity, CCN 18, 15 lines)
- `packs/dotnet/stack/aspire-publish.mjs:80-155` (complexity, CCN 44, 76 lines)
- `packs/rust/analysis/cargo-deny.mjs:4-23` (complexity, CCN 18, 20 lines)
- `scripts/pipeline/lib/agents.mjs:147-244` (complexity, CCN 42, 98 lines)
- `scripts/pipeline/lib/agents.mjs:248-310` (complexity, CCN 22, 63 lines)
- `scripts/pipeline/lib/agents.mjs:334-360` (complexity, CCN 16, 27 lines)
- `scripts/pipeline/lib/agents.mjs:433-451` (complexity, CCN 22, 19 lines)
- `scripts/pipeline/lib/agents.mjs:456-517` (complexity, CCN 20, 62 lines)
- `scripts/pipeline/lib/bot-setup.mjs:156-203` (complexity, CCN 21, 48 lines)
- `scripts/pipeline/lib/bot-setup.mjs:206-239` (complexity, CCN 26, 34 lines)
- `scripts/pipeline/lib/bot.mjs:178-194` (complexity, CCN 19, 17 lines)
- `scripts/pipeline/lib/bot.mjs:83-100` (complexity, CCN 19, 18 lines)
- `scripts/pipeline/lib/bot.mjs:389-439` (complexity, CCN 26, 51 lines)
- `scripts/pipeline/lib/ci/circleci.mjs:56-75` (complexity, CCN 17, 20 lines)
- `scripts/pipeline/lib/ci/evidence.mjs:22-52` (complexity, CCN 27, 31 lines)
- `scripts/pipeline/lib/ci/evidence.mjs:75-120` (complexity, CCN 24, 46 lines)
- `scripts/pipeline/lib/ci/github-actions.mjs:130-163` (complexity, CCN 31, 34 lines)
- `scripts/pipeline/lib/ci/github-actions.mjs:98-118` (complexity, CCN 18, 21 lines)
- `scripts/pipeline/lib/ci/github-actions.mjs:200-241` (complexity, CCN 26, 42 lines)
- `scripts/pipeline/lib/ci/github-actions.mjs:72-95` (complexity, CCN 25, 24 lines)
- `scripts/pipeline/lib/ci/jenkins.mjs:54-69` (complexity, CCN 20, 16 lines)
- `scripts/pipeline/lib/costs.mjs:17-85` (complexity, CCN 19, 69 lines)
- `scripts/pipeline/lib/decisions.mjs:50-58` (complexity, CCN 16, 9 lines)
- `scripts/pipeline/lib/experiment.mjs:140-174` (complexity, CCN 20, 35 lines)
- `scripts/pipeline/lib/experiment.mjs:279-314` (complexity, CCN 20, 36 lines)
- `scripts/pipeline/lib/external.mjs:24-41` (complexity, CCN 29, 18 lines)
- `scripts/pipeline/lib/external.mjs:115-151` (complexity, CCN 20, 37 lines)
- `scripts/pipeline/lib/factory-guard.mjs:408-459` (complexity, CCN 19, 52 lines)
- `scripts/pipeline/lib/factory-guard.mjs:478-534` (complexity, CCN 36, 57 lines)
- `scripts/pipeline/lib/factory-guard.mjs:80-107` (complexity, CCN 19, 28 lines)
- `scripts/pipeline/lib/factory-guard.mjs:43-71` (complexity, CCN 19, 29 lines)
- `scripts/pipeline/lib/factory-guard.mjs:211-300` (complexity, CCN 65, 90 lines)
- `scripts/pipeline/lib/git.mjs:13-33` (complexity, CCN 17, 21 lines)
- `scripts/pipeline/lib/hosts/azure-devops.mjs:52-344` (complexity, CCN 12, 293 lines)
- `scripts/pipeline/lib/hosts/azure-devops.mjs:252-263` (complexity, CCN 17, 12 lines)
- `scripts/pipeline/lib/hosts/azure-devops.mjs:74-97` (complexity, CCN 16, 24 lines)
- `scripts/pipeline/lib/hosts/bitbucket.mjs:62-321` (complexity, CCN 12, 260 lines)
- `scripts/pipeline/lib/hosts/bitbucket.mjs:34-60` (complexity, CCN 21, 27 lines)
- `scripts/pipeline/lib/hosts/github.mjs:115-461` (complexity, CCN 17, 347 lines)
- `scripts/pipeline/lib/hosts/github.mjs:433-455` (complexity, CCN 19, 23 lines)
- `scripts/pipeline/lib/hosts/github.mjs:130-144` (complexity, CCN 18, 15 lines)
- `scripts/pipeline/lib/hosts/github.mjs:34-60` (complexity, CCN 24, 27 lines)
- `scripts/pipeline/lib/hosts/github.mjs:224-241` (complexity, CCN 17, 18 lines)
- `scripts/pipeline/lib/hosts/gitlab.mjs:83-396` (complexity, CCN 8, 314 lines)
- `scripts/pipeline/lib/hosts/gitlab.mjs:367-389` (complexity, CCN 21, 23 lines)
- `scripts/pipeline/lib/hosts/gitlab.mjs:18-43` (complexity, CCN 28, 26 lines)
- `scripts/pipeline/lib/hosts/gitlab.mjs:195-216` (complexity, CCN 27, 22 lines)
- `scripts/pipeline/lib/hosts/http.mjs:35-93` (complexity, CCN 50, 59 lines)
- `scripts/pipeline/lib/hosts/index.mjs:194-236` (complexity, CCN 20, 43 lines)
- `scripts/pipeline/lib/hosts/index.mjs:54-65` (complexity, CCN 33, 12 lines)
- `scripts/pipeline/lib/hosts/refusal.mjs:64-107` (complexity, CCN 17, 44 lines)
- `scripts/pipeline/lib/instruction-check.mjs:219-255` (complexity, CCN 17, 37 lines)
- `scripts/pipeline/lib/instruction-check.mjs:133-178` (complexity, CCN 38, 46 lines)
- `scripts/pipeline/lib/lint.mjs:89-129` (complexity, CCN 26, 41 lines)
- `scripts/pipeline/lib/policy-topology.mjs:98-135` (complexity, CCN 27, 38 lines)
- `scripts/pipeline/lib/policy-topology.mjs:78-137` (complexity, CCN 20, 60 lines)
- `scripts/pipeline/lib/pool.mjs:63-83` (complexity, CCN 19, 21 lines)
- `scripts/pipeline/lib/pool.mjs:87-127` (complexity, CCN 35, 41 lines)
- `scripts/pipeline/lib/products.mjs:68-114` (complexity, CCN 47, 47 lines)
- `scripts/pipeline/lib/products.mjs:142-154` (complexity, CCN 34, 13 lines)
- `scripts/pipeline/lib/providers/conformance.mjs:30-181` (complexity, CCN 63, 152 lines)
- `scripts/pipeline/lib/providers/conformance.mjs:39-56` (complexity, CCN 19, 18 lines)
- `scripts/pipeline/lib/providers/custom.mjs:41-63` (complexity, CCN 34, 23 lines)
- `scripts/pipeline/lib/story-guard.mjs:341-373` (complexity, CCN 22, 33 lines)
- `scripts/pipeline/lib/story-guard.mjs:113-173` (complexity, CCN 25, 61 lines)
- `scripts/pipeline/lib/story-guard.mjs:247-301` (complexity, CCN 45, 55 lines)
- `scripts/pipeline/lib/story-guard.mjs:380-389` (complexity, CCN 17, 10 lines)
- `scripts/pipeline/lib/story-guard.mjs:312-331` (complexity, CCN 20, 20 lines)
- `scripts/pipeline/lib/story-guard.mjs:64-78` (complexity, CCN 16, 15 lines)
- `scripts/pipeline/lib/tickets.mjs:81-94` (complexity, CCN 16, 14 lines)
- `scripts/pipeline/lib/usage.mjs:182-241` (complexity, CCN 27, 60 lines)
- `scripts/pipeline/lib/util.mjs:53-76` (complexity, CCN 28, 24 lines)
- `scripts/pipeline/lib/util.mjs:140-155` (complexity, CCN 21, 16 lines)
- `scripts/pipeline/lib/util.mjs:334-346` (complexity, CCN 16, 13 lines)
- `scripts/pipeline/pipeline.mjs:77-257` (complexity, CCN 82, 181 lines)
- `scripts/pr-check/lib/context.mjs:95-146` (complexity, CCN 39, 52 lines)
- `scripts/pr-check/lib/decision-body.mjs:36-59` (complexity, CCN 17, 24 lines)
- `scripts/pr-check/lib/decision-body.mjs:9-31` (complexity, CCN 16, 23 lines)
- `scripts/pr-check/lib/loop.mjs:925-945` (complexity, CCN 19, 21 lines)
- `scripts/pr-check/lib/loop.mjs:366-389` (complexity, CCN 25, 24 lines)
- `scripts/pr-check/lib/loop.mjs:646-686` (complexity, CCN 32, 41 lines)
- `scripts/pr-check/lib/loop.mjs:719-799` (complexity, CCN 33, 81 lines)
- `scripts/pr-check/lib/loop.mjs:290-312` (complexity, CCN 24, 23 lines)
- `scripts/pr-check/lib/loop.mjs:549-612` (complexity, CCN 21, 64 lines)
- `scripts/pr-check/lib/loop.mjs:332-364` (complexity, CCN 17, 33 lines)
- `scripts/pr-check/lib/loop.mjs:1027-1218` (complexity, CCN 82, 192 lines)
- `scripts/pr-check/lib/loop.mjs:888-991` (complexity, CCN 44, 104 lines)
- `scripts/pr-check/lib/loop.mjs:191-279` (complexity, CCN 67, 89 lines)
- `scripts/pr-check/lib/report.mjs:6-63` (complexity, CCN 41, 58 lines)
- `scripts/pr-check/lib/video.mjs:24-59` (complexity, CCN 16, 36 lines)
- `scripts/pr-check/pr-check.mjs:75-345` (complexity, CCN 132, 271 lines)
- `scripts/pr-check/pr-check.mjs:538-652` (complexity, CCN 58, 115 lines)
- `scripts/pr-check/pr-check.mjs:665-707` (complexity, CCN 22, 43 lines)
- `scripts/pr-video/lib/api-evidence.mjs:949-1032` (complexity, CCN 28, 84 lines)
- `scripts/pr-video/lib/api-evidence.mjs:740-817` (complexity, CCN 22, 78 lines)
- `scripts/pr-video/lib/api-evidence.mjs:236-293` (complexity, CCN 44, 58 lines)
- `scripts/pr-video/lib/api-evidence.mjs:218-390` (complexity, CCN 40, 173 lines)
- `scripts/pr-video/lib/api-evidence.mjs:554-676` (complexity, CCN 79, 123 lines)
- `scripts/pr-video/lib/api-evidence.mjs:1100-1121` (complexity, CCN 23, 22 lines)
- `scripts/pr-video/lib/api-evidence.mjs:1057-1089` (complexity, CCN 17, 33 lines)
- `scripts/pr-video/lib/api-evidence.mjs:1145-1182` (complexity, CCN 23, 38 lines)
- `scripts/pr-video/lib/api-summary.mjs:113-137` (complexity, CCN 23, 25 lines)
- `scripts/pr-video/lib/api-summary.mjs:423-459` (complexity, CCN 20, 37 lines)
- `scripts/pr-video/lib/api-summary.mjs:373-393` (complexity, CCN 19, 21 lines)
- `scripts/pr-video/lib/bugpair.mjs:92-129` (complexity, CCN 17, 38 lines)
- `scripts/pr-video/lib/local.mjs:183-247` (complexity, CCN 28, 65 lines)
- `scripts/pr-video/lib/local.mjs:250-360` (complexity, CCN 52, 111 lines)
- `scripts/pr-video/lib/local.mjs:85-163` (complexity, CCN 65, 79 lines)
- `scripts/pr-video/lib/pr-video.mjs:70-124` (complexity, CCN 24, 55 lines)
- `scripts/pr-video/lib/render.mjs:69-103` (complexity, CCN 18, 35 lines)
- `scripts/pr-video/lib/render.mjs:207-228` (complexity, CCN 16, 22 lines)
- `scripts/pr-video/lib/render.mjs:270-327` (complexity, CCN 39, 58 lines)
- `scripts/pr-video/lib/script.mjs:231-276` (complexity, CCN 41, 46 lines)
- `scripts/pr-video/lib/script.mjs:116-135` (complexity, CCN 17, 20 lines)
- `scripts/pr-video/lib/script.mjs:30-77` (complexity, CCN 17, 48 lines)
- `scripts/pr-video/lib/script.mjs:354-413` (complexity, CCN 36, 60 lines)
- `scripts/pr-video/lib/script.mjs:219-290` (complexity, CCN 23, 72 lines)
- `scripts/pr-video/lib/tools.mjs:86-125` (complexity, CCN 22, 40 lines)
- `scripts/pr-video/pr-video.mjs:89-265` (complexity, CCN 87, 177 lines)
- `scripts/retro/lib/lessons.mjs:460-497` (complexity, CCN 17, 38 lines)
- `scripts/retro/lib/lessons.mjs:614-818` (complexity, CCN 117, 205 lines)
- `scripts/retro/retro.mjs:47-124` (complexity, CCN 44, 78 lines)
- `scripts/review/lib/review.mjs:144-229` (complexity, CCN 30, 86 lines)
- `scripts/review/lib/review.mjs:476-577` (complexity, CCN 30, 102 lines)
- `scripts/review/lib/review.mjs:333-400` (complexity, CCN 32, 68 lines)
- `scripts/review/review.mjs:23-94` (complexity, CCN 26, 72 lines)
- `scripts/review-gate/lib/assessment.mjs:163-192` (complexity, CCN 16, 30 lines)
- `scripts/review-gate/lib/confidence.mjs:22-48` (complexity, CCN 23, 27 lines)
- `scripts/review-gate/lib/gate.mjs:66-112` (complexity, CCN 41, 47 lines)
- `scripts/review-gate/lib/gate.mjs:120-147` (complexity, CCN 16, 28 lines)
- `scripts/review-gate/lib/gate.mjs:149-194` (complexity, CCN 49, 46 lines)
- `scripts/review-gate/lib/github.mjs:168-200` (complexity, CCN 33, 33 lines)
- `scripts/review-gate/lib/github.mjs:40-60` (complexity, CCN 17, 21 lines)
- `scripts/review-gate/lib/pr-review.mjs:62-108` (complexity, CCN 24, 47 lines)
- `scripts/review-gate/lib/pr-review.mjs:19-58` (complexity, CCN 17, 40 lines)
- `scripts/review-gate/lib/publish.mjs:48-77` (complexity, CCN 17, 30 lines)
- `scripts/review-gate/lib/publish.mjs:127-170` (complexity, CCN 34, 44 lines)
- `scripts/review-gate/lib/quorum.mjs:21-37` (complexity, CCN 16, 17 lines)
- `scripts/review-gate/lib/rejections.mjs:170-219` (complexity, CCN 36, 50 lines)
- `scripts/review-gate/lib/rejections.mjs:88-124` (complexity, CCN 24, 37 lines)
- `scripts/review-gate/lib/review-retro.mjs:68-89` (complexity, CCN 24, 22 lines)
- `scripts/review-gate/lib/severity.mjs:16-28` (complexity, CCN 17, 13 lines)
- `scripts/review-gate/lib/sync.mjs:86-97` (complexity, CCN 24, 12 lines)
- `scripts/review-gate/lib/sync.mjs:263-310` (complexity, CCN 28, 48 lines)
- `scripts/review-gate/lib/sync.mjs:346-411` (complexity, CCN 24, 66 lines)
- `scripts/review-gate/lib/sync.mjs:168-182` (complexity, CCN 17, 15 lines)
- `scripts/review-gate/lib/sync.mjs:75-137` (complexity, CCN 44, 63 lines)
- `scripts/review-gate/lib/sync.mjs:52-71` (complexity, CCN 20, 20 lines)
- `scripts/review-gate/lib/sync.mjs:184-216` (complexity, CCN 18, 33 lines)
- `scripts/review-gate/lib/sync.mjs:228-332` (complexity, CCN 11, 105 lines)
- `scripts/review-gate/lib/systems.mjs:18-52` (complexity, CCN 24, 35 lines)
- `scripts/review-gate/lib/triage-section.mjs:13-38` (complexity, CCN 16, 26 lines)
- `scripts/review-gate/review-gate.mjs:56-255` (complexity, CCN 97, 200 lines)
- `scripts/pipeline/lib/analysis/config.mjs:292-306` (complexity, CCN 16, 15 lines)
- `scripts/pipeline/lib/analysis/config.mjs:420-428` (complexity, CCN 19, 9 lines)
- `scripts/pipeline/lib/analysis/config.mjs:499-516` (complexity, CCN 29, 18 lines)
- `scripts/pipeline/lib/analysis/config.mjs:366-489` (complexity, CCN 141, 124 lines)
- `scripts/pipeline/lib/analysis/config.mjs:520-533` (complexity, CCN 20, 14 lines)
- `scripts/pipeline/lib/analysis/config.mjs:238-282` (complexity, CCN 41, 45 lines)
- `scripts/pipeline/lib/analysis/config.mjs:54-75` (complexity, CCN 24, 22 lines)
- `scripts/pipeline/lib/analysis/config.mjs:86-166` (complexity, CCN 55, 81 lines)
- `scripts/pipeline/lib/config.mjs:73-109` (complexity, CCN 34, 37 lines)
- `scripts/pipeline/lib/config.mjs:265-309` (complexity, CCN 20, 45 lines)
- `scripts/pipeline/lib/settings.mjs:667-679` (complexity, CCN 16, 13 lines)
- `scripts/pipeline/lib/settings.mjs:119-145` (complexity, CCN 26, 27 lines)
- `scripts/pipeline/lib/settings.mjs:581-704` (complexity, CCN 54, 124 lines)
- `scripts/pipeline/lib/settings.mjs:750-851` (complexity, CCN 60, 102 lines)
- `scripts/pipeline/lib/settings.mjs:478-507` (complexity, CCN 17, 30 lines)
- `scripts/pipeline/lib/settings.mjs:860-967` (complexity, CCN 44, 108 lines)
- `scripts/pipeline/lib/settings.mjs:152-178` (complexity, CCN 25, 27 lines)
- `scripts/pipeline/lib/settings.mjs:277-301` (complexity, CCN 24, 25 lines)
- `scripts/stack/slots.mjs:66-131` (complexity, CCN 23, 66 lines)
- `templates/analysis/ci.mjs:131-209` (complexity, CCN 35, 79 lines)
- `templates/analysis/ci.mjs:98-129` (complexity, CCN 23, 32 lines)
- `scripts/teststack/lib/images.mjs:215-241` (complexity, CCN 20, 27 lines)
- `scripts/teststack/lib/images.mjs:348-395` (complexity, CCN 20, 48 lines)
- `scripts/teststack/lib/load.mjs:49-111` (complexity, CCN 19, 63 lines)
- `scripts/teststack/lib/stores/mongodb.mjs:34-65` (complexity, CCN 18, 32 lines)
- `scripts/teststack/teststack.mjs:90-183` (complexity, CCN 39, 94 lines)

</details>

- **79 item(s)**: a number repeated for another purpose (a timeout, a limit, a count): different knowledge, so one constant would couple settings that change for different reasons. A string literal that repeats a constant is never kept by this reason: it uses the constant or is kept on an entry of its own.

<details>

- `scripts/pipeline/lib/analysis/ci.mjs:33` (repeat)
- `scripts/pipeline/lib/analysis/ci.mjs:52` (repeat)
- `scripts/pipeline/lib/analysis/ci.mjs:77` (repeat)
- `scripts/pipeline/lib/analysis/ci.mjs:112` (repeat)
- `scripts/pipeline/lib/analysis/ci.mjs:118` (repeat)
- `scripts/pipeline/lib/analysis/doctor.mjs:42` (repeat)
- `scripts/pipeline/lib/analysis/secret-table.mjs:83` (repeat)
- `scripts/board/lib/assets.mjs:19` (repeat)
- `scripts/board/lib/evidence.mjs:143` (repeat)
- `scripts/board/lib/trackers/azure-boards.mjs:267` (repeat)
- `scripts/board/lib/trackers/azure-boards.mjs:325` (repeat)
- `scripts/board/lib/trackers/http.mjs:15` (repeat)
- `scripts/pipeline/lib/council.mjs:364` (repeat)
- `scripts/pipeline/lib/council.mjs:368` (repeat)
- `scripts/pipeline/lib/council.mjs:370` (repeat)
- `scripts/pipeline/lib/council.mjs:380` (repeat)
- `scripts/pipeline/lib/council.mjs:1690` (repeat)
- `scripts/pipeline/lib/intercom-room.mjs:35` (repeat)
- `scripts/factory/lib/adapter-check.mjs:37` (repeat)
- `scripts/factory/lib/detect.mjs:31` (repeat)
- `scripts/factory/lib/prune.mjs:196` (repeat)
- `scripts/factory/lib/prune.mjs:401` (repeat)
- `scripts/factory/lib/prune.mjs:669` (repeat)
- `scripts/factory/lib/prune.mjs:826` (repeat)
- `scripts/factory/lib/render.mjs:576` (repeat)
- `scripts/feature-verification/lib/evidence.mjs:43` (repeat)
- `scripts/feature-verification/lib/runners.mjs:298` (repeat)
- `scripts/feature-verification/lib/workflows.mjs:602` (repeat)
- `scripts/implement/implement.mjs:326` (repeat)
- `scripts/implement/lib/analysis-gate.mjs:55` (repeat)
- `scripts/implement/lib/ci-parity.mjs:116` (repeat)
- `scripts/implement/lib/ci-wait.mjs:75` (repeat)
- `scripts/implement/lib/ci-wait.mjs:229` (repeat)
- `scripts/implement/lib/implement.mjs:1008` (repeat)
- `scripts/implement/lib/implement.mjs:71` (repeat)
- `scripts/implement/lib/implement.mjs:694` (repeat)
- `scripts/implement/lib/implement.mjs:708` (repeat)
- `scripts/implement/lib/implement.mjs:2150` (repeat)
- `scripts/implement/lib/post-publish.mjs:12` (repeat)
- `scripts/implement/lib/post-publish.mjs:26` (repeat)
- `scripts/implement/lib/requeue.mjs:33` (repeat)
- `scripts/lsp/check.mjs:22` (repeat)
- `scripts/lsp/lib/common.mjs:107` (repeat)
- `scripts/lsp/lib/common.mjs:306` (repeat)
- `scripts/lsp/lib/daemon.mjs:259` (repeat)
- `scripts/lsp/lib/daemon.mjs:599` (repeat)
- `scripts/models/lib/models.mjs:204` (repeat)
- `scripts/pipeline/lib/agents.mjs:500` (repeat)
- `scripts/pipeline/lib/bot-setup.mjs:75` (repeat)
- `scripts/pipeline/lib/bot-setup.mjs:126` (repeat)
- `scripts/pipeline/lib/bot-setup.mjs:76` (repeat)
- `scripts/pipeline/lib/bot-setup.mjs:126` (repeat)
- `scripts/pipeline/lib/bot-setup.mjs:75` (repeat)
- `scripts/pipeline/lib/bot-setup.mjs:126` (repeat)
- `scripts/pipeline/lib/bot.mjs:266` (repeat)
- `scripts/pipeline/lib/bot.mjs:74` (repeat)
- `scripts/pipeline/lib/experiment.mjs:30` (repeat)
- `scripts/pipeline/lib/experiment.mjs:342` (repeat)
- `scripts/pipeline/lib/external.mjs:99` (repeat)
- `scripts/pipeline/lib/hosts/http.mjs:32` (repeat)
- `scripts/pipeline/lib/hosts/http.mjs:58` (repeat)
- `scripts/pipeline/lib/provider-health.mjs:85` (repeat)
- `scripts/pipeline/lib/provider-health.mjs:89` (repeat)
- `scripts/pipeline/lib/provider-health.mjs:91` (repeat)
- `scripts/pipeline/lib/recovery.mjs:28` (repeat)
- `scripts/pipeline/lib/util.mjs:185` (repeat)
- `scripts/pipeline/lib/util.mjs:176` (repeat)
- `scripts/pr-check/lib/loop.mjs:1116` (repeat)
- `scripts/pr-check/lib/video.mjs:78` (repeat)
- `scripts/pr-check/lib/video.mjs:77` (repeat)
- `scripts/pr-check/lib/video.mjs:77` (repeat)
- `scripts/pr-video/lib/api-evidence.mjs:400` (repeat)
- `scripts/pr-video/lib/render.mjs:30` (repeat)
- `scripts/pr-video/lib/render.mjs:116` (repeat)
- `scripts/pr-video/lib/render.mjs:122` (repeat)
- `scripts/review-gate/lib/ci-origin.mjs:31` (repeat)
- `scripts/stack/lib/leases.mjs:201` (repeat)
- `scripts/stack/lib/leases.mjs:204` (repeat)
- `scripts/teststack/lib/runner.mjs:15` (repeat)

</details>

- **16 item(s)**: the copies follow each tracker's, code host's, CI provider's or store's own interface and change for different reasons; extracting them would couple adapters that must stay apart.

<details>

- `scripts/board/lib/trackers/azure-boards.mjs:414-419 and scripts/board/lib/trackers/gitlab.mjs:250-255` (clone)
- `scripts/board/lib/trackers/azure-boards.mjs:303-314 and scripts/board/lib/trackers/jira.mjs:319-330` (clone)
- `scripts/board/lib/trackers/azure-boards.mjs:354-368 and scripts/board/lib/trackers/jira.mjs:364-378` (clone)
- `scripts/board/lib/trackers/azure-boards.mjs:455-474 and scripts/board/lib/trackers/jira.mjs:472-491` (clone)
- `scripts/board/lib/trackers/azure-boards.mjs:414-419 and scripts/board/lib/trackers/jira.mjs:431-436` (clone)
- `scripts/board/lib/trackers/azure-boards.mjs:435-441 and scripts/board/lib/trackers/jira.mjs:452-458` (clone)
- `scripts/board/lib/trackers/gitlab.mjs:300-313 and scripts/board/lib/trackers/linear.mjs:289-302` (clone)
- `scripts/board/lib/trackers/gitlab.mjs:201-209 and scripts/board/lib/trackers/linear.mjs:199-206` (clone)
- `scripts/pipeline/lib/ci/circleci.mjs:12-18 and scripts/pipeline/lib/ci/github-actions.mjs:15-23` (clone)
- `scripts/pipeline/lib/hosts/azure-devops.mjs:383-402 and scripts/pipeline/lib/hosts/bitbucket.mjs:330-348` (clone)
- `scripts/pipeline/lib/hosts/azure-devops.mjs:383-402 and scripts/pipeline/lib/hosts/gitlab.mjs:408-427` (clone)
- `scripts/teststack/lib/stores/mongodb.mjs:31-40 and scripts/teststack/lib/stores/postgres.mjs:84-94` (clone)
- `scripts/teststack/lib/stores/mysql.mjs:52-61 and scripts/teststack/lib/stores/postgres.mjs:194-204` (clone)
- `scripts/teststack/lib/stores/mysql.mjs:87-93 and scripts/teststack/lib/stores/postgres.mjs:247-254` (clone)
- `scripts/teststack/lib/stores/mysql.mjs:44-51 and scripts/teststack/lib/stores/postgres.mjs:186-193` (clone)
- `scripts/teststack/lib/stores/mysql.mjs:114-121 and scripts/teststack/lib/stores/postgres.mjs:266-274` (clone)

</details>

- **1 item(s)**: parseInline and parseWikiInline parse two grammars (Markdown and Jira wiki markup); the shared lines are each scanner's own text accumulator and step, not a rule of either.

<details>

- `scripts/board/lib/trackers/markdown.mjs:209-215 and scripts/board/lib/trackers/markdown.mjs:742-748` (clone)

</details>

- **1 item(s)**: as above: the two inline parsers' scanner set-up, for two grammars.

<details>

- `scripts/board/lib/trackers/markdown.mjs:167-174 and scripts/board/lib/trackers/markdown.mjs:706-713` (clone)

</details>

- **1 item(s)**: OTHER_ANSWER, the id of an escalation question's free-text answer, not the review gate's catch-all system OTHER: one names a reply option, the other the system of a file no system claims.

<details>

- `scripts/board/lib/escalation.mjs:318` (repeat)

</details>

- **1 item(s)**: the engine command `lsp` (`factory lsp setup`), not the MCP server's name.

<details>

- `scripts/factory/install-setup.mjs:55` (repeat)

</details>

- **1 item(s)**: the doctor's product row text for no tracker (`tracker none`), not the metrics sink type's default.

<details>

- `scripts/factory/lib/adapters.mjs:52` (repeat)

</details>

- **1 item(s)**: the pack part key `lsp` (a pack's lsp folder), not the MCP server's name.

<details>

- `scripts/factory/lib/init.mjs:29` (repeat)

</details>

- **1 item(s)**: each is a language server's process wrapper, started as that server's command; the shared lines pass on its exit and signals, and the .NET proxy (a pack script) does more around them.

<details>

- `packs/dotnet/lsp/roslyn-proxy.mjs:108-113 and scripts/lsp/launch.mjs:37-42` (clone)

</details>

- **9 item(s)**: a fixture of the factory's own opengrep rules: `opengrep test` reads it through its folder, nothing imports it.

<details>

- `packs/security/rules/opengrep/typescript/dynamic-code.ts` (dead-file)
- `packs/security/rules/opengrep/typescript/insecure-random-secret.ts` (dead-file)
- `packs/security/rules/opengrep/typescript/path-from-request.ts` (dead-file)
- `packs/security/rules/opengrep/typescript/process-from-input.ts` (dead-file)
- `packs/security/rules/opengrep/typescript/sql-string-built.ts` (dead-file)
- `packs/security/rules/opengrep/typescript/ssrf-from-request.ts` (dead-file)
- `packs/security/rules/opengrep/typescript/tls-verification-off.ts` (dead-file)
- `packs/security/rules/opengrep/typescript/unsafe-deserialization.ts` (dead-file)
- `packs/security/rules/opengrep/typescript/weak-crypto.ts` (dead-file)

</details>

- **3 item(s)**: a synchronous and an asynchronous copy of one loop (sendWithReduction, postOmitted): one cannot call the other without making every synchronous caller async.

<details>

- `scripts/pipeline/lib/hosts/refusal.mjs:184-197 and scripts/pipeline/lib/hosts/refusal.mjs:203-218` (clone)
- `scripts/pipeline/lib/hosts/refusal.mjs:177-183 and scripts/pipeline/lib/hosts/refusal.mjs:197-203` (clone)
- `scripts/pipeline/lib/hosts/refusal.mjs:222-229 and scripts/pipeline/lib/hosts/refusal.mjs:235-242` (clone)

</details>

- **1 item(s)**: a display label of an instruction source (addendum, lessons, …), not the retro's background run key.

<details>

- `scripts/pipeline/lib/instruction-check.mjs:201` (repeat)

</details>

- **1 item(s)**: redact.mjs is the redaction boundary every module loads first and imports no factory module: config.mjs, which defines FACTORY_DIR, imports it.

<details>

- `scripts/pipeline/lib/redact.mjs:141` (repeat)

</details>

- **1 item(s)**: each stage's command dispatches its own hook events (reset, stop) to its own stage; the lines are the dispatch, not shared knowledge.

<details>

- `scripts/pr-check/pr-check.mjs:618-625 and scripts/review/review.mjs:71-78` (clone)

</details>

- **1 item(s)**: named by the pipeline flow's checks (docs/pipeline-flow.json), which test it against the settings.

<details>

- `scripts/pipeline/lib/config.mjs` (dead-export)

</details>

- **1 item(s)**: the `lsp` settings section's folder (SECTION_DIRS), not the MCP server's name.

<details>

- `scripts/pipeline/lib/settings.mjs:24` (repeat)

</details>

- **3 item(s)**: the graphify skill is upstream's text, kept as published.

<details>

- `skills/graphify/references/exports.md:23-31 and skills/graphify/references/exports.md:41-43` (instruction-clone)
- `skills/graphify/references/query.md:205-212 and skills/graphify/references/query.md:273-280` (instruction-clone)
- `skills/graphify/SKILL.md:484-491 and skills/graphify/SKILL.md:576-583` (instruction-clone)

</details>

- **12 item(s)**: another 600-second limit (a command, a fetch, a CI step) that happens to equal TOOL_TIMEOUT_SEC, the analysis tools' limit the epic named; tying them would couple limits that change apart.

<details>

- `scripts/pipeline/lib/analysis/fetch.mjs:12` (repeat)
- `scripts/factory/lib/prune.mjs:490` (repeat)
- `scripts/factory/lib/prune.mjs:708` (repeat)
- `scripts/factory/lib/prune.mjs:842` (repeat)
- `scripts/feature-verification/lib/workflows.mjs:508` (repeat)
- `scripts/implement/lib/board-events.mjs:19` (repeat)
- `scripts/implement/lib/implement.mjs:703` (repeat)
- `scripts/implement/lib/implement.mjs:707` (repeat)
- `scripts/implement/lib/implement.mjs:1770` (repeat)
- `scripts/pipeline/lib/lint.mjs:105` (repeat)
- `scripts/pipeline/lib/sink.mjs:134` (repeat)
- `scripts/pr-check/lib/github.mjs:35` (repeat)

</details>

- **4 item(s)**: a retry count or a code length that happens to equal CHARS_PER_TOKEN, the writer-rule ledger's estimate of characters per token.

<details>

- `scripts/board/lib/trackers/azure-boards.mjs:76` (repeat)
- `scripts/board/lib/trackers/gitlab.mjs:55` (repeat)
- `scripts/board/lib/trackers/linear.mjs:37` (repeat)
- `scripts/pipeline/lib/ci/rest.mjs:17` (repeat)

</details>

- **3 item(s)**: the `clean-code` front-matter key, the skill's folder or the seat's default name, which equal the lens id by choice and may differ from it.

<details>

- `scripts/pipeline/lib/council-config.mjs:38` (repeat)
- `scripts/pipeline/lib/agents.mjs:55` (repeat)
- `scripts/pipeline/lib/clean-code.mjs:22` (repeat)

</details>

- **1 item(s)**: the report's own limit on a git call, not the test stack's image-build git limit.

<details>

- `scripts/docs/clean-code-report.mjs:30` (repeat)

</details>

- **1 item(s)**: the engine command `lsp` (`factory lsp setup`), not the run-conditions record kind.

<details>

- `scripts/factory/install-setup.mjs:55` (repeat)

</details>

- **1 item(s)**: the pack part key `lsp` (a pack's lsp folder), not the run-conditions record kind.

<details>

- `scripts/factory/lib/init.mjs:30` (repeat)

</details>

- **1 item(s)**: the language-server state folder's name, not the MCP server's name.

<details>

- `scripts/implement/lib/lsp.mjs:31` (repeat)

</details>

- **1 item(s)**: each code host's update method of the same adapter interface: the shared lines are its signature and the title and description fields, the state encodings differ (Azure's status, GitLab's state_event); it took this size when the GitLab encoding moved into gitlabLabelsAndState.

<details>

- `scripts/pipeline/lib/hosts/azure-devops.mjs:152-157 and scripts/pipeline/lib/hosts/gitlab.mjs:170-176` (clone)

</details>

- **1 item(s)**: LSP_SERVER, the MCP server's name, its own constant: not the run-conditions record kind.

<details>

- `scripts/pipeline/lib/agents.mjs:118` (repeat)

</details>

- **1 item(s)**: LESSONS_STAGE, the retro's stage in token usage and logs, not LESSONS_KEY, the lessons run's state key.

<details>

- `scripts/pipeline/lib/decisions.mjs:15` (repeat)

</details>

- **1 item(s)**: the label of an agent's lessons file among its instruction sources, not the retro's stage.

<details>

- `scripts/pipeline/lib/instruction-check.mjs:201` (repeat)

</details>

- **1 item(s)**: LESSONS_KEY, the lessons run's state key, not LESSONS_STAGE, the retro's stage in token usage and logs.

<details>

- `scripts/retro/lib/lessons.mjs:519` (repeat)

</details>

- **1 item(s)**: OTHER, the review gate's catch-all system of a file no system claims, not the escalation's free-text answer id.

<details>

- `scripts/review-gate/lib/systems.mjs:14` (repeat)

</details>

- **1 item(s)**: the `lsp` settings section's folder (SECTION_DIRS), not the run-conditions record kind.

<details>

- `scripts/pipeline/lib/settings.mjs:26` (repeat)

</details>

- **1 item(s)**: the plugin serves skills/ as they are, so the clean-code skill carries a generated copy of the council skill's useless-tests list; prompts take the council's own, and clean-code.mjs --check and a test fail on a stale copy.

<details>

- `skills/clean-code/SKILL.md:143-148 and skills/council/SKILL.md:88-94` (instruction-clone)

</details>

- **3 item(s)**: the generated CI script (.factory/bin/analysis/ci.mjs) runs on the CI machine with only Node and git, no factory install, so it cannot import analysis/config.mjs: at :106 and :163 the 600 is TOOL_TIMEOUT_SEC's own knowledge (an analysis tool's time limit when its definition names none), written again for that reason, and at :36 it is the sh helper's default for any command it runs.

<details>

- `templates/analysis/ci.mjs:36` (repeat)
- `templates/analysis/ci.mjs:106` (repeat)
- `templates/analysis/ci.mjs:163` (repeat)

</details>

## Notes

- Baseline: the branch's base (ee8328f), measured with the same tools as the closing report (the analysis gate's own jscpd and lizard scripts) and the same settings, so the report shows the epic's own effect.
- Intended wording change (batch 3): the six PR check critics share the acceptance critic's debate wording, the same in meaning; no other output, setting, record or command changes.
- Partly fixed: the third verify.mjs ~ review.mjs copy is the merge-then-adjudicate call shape every stage adapter writes (kept on its entry).
- New repeats appear where constants the epic named (TOOL_TIMEOUT_SEC, CHARS_PER_TOKEN, the clean-code lens and seat, LSP_RECORD, LESSONS_STAGE) make other literals of the same value match them; each is kept on its own entry with what it is instead. Since council round 2 the repeated-values check skips whole-line comments (a literal in prose repeats nothing); both measurements were re-taken with it, which took the baseline from 152 to 142 repeats, all ten of them in comments. Since council round 3 it also reports a constant redeclared under the same name in another file (the same-name exclusion hid it); re-measured again, the baseline gained the two FINDINGS_FILE declarations that council round 1 had already made one.
- Complexity: 412 to 408 only. The four gone are council.mjs memberTask (over the limit at the base, and made worse by this branch before council round 1 split it), github-actions.mjs providedChecks (split in council round 1 with the workflow reader), and gitlab.mjs update and orchestrator.mjs decide (split in council round 2, with the GitLab labels-and-state reader the code host and the tracker now share, and with the per-round guidance taken out of decide). No other pre-existing long or branching function was refactored; that is a follow-up, not something this epic delivered. What the branch does guarantee is the function table: no function it changed went over a limit or got worse.
- Process: the batches 1 to 3 were committed after the tests of what they touched, not each after a green full run; the full suite ran green before batch 4 and runs again on the head after council round 1, which the council reviewed as a whole.

## Functions the branch changed

The functions of the files changed since `ee8328f` that are over a limit (cyclomatic complexity 15, 100 lines) at the base or the head. None may end over a limit it was under at the base, and none over a limit may be worse than at the base.

| Function | Base (CCN / lines) | Head (CCN / lines) | Rule |
| --- | --- | --- | --- |
| `packs/dotnet/pr-video/aspnet-minimal-api.mjs` statementEnd | 18 / 15 | 18 / 15 | held |
| `packs/dotnet/stack/aspire-publish.mjs` transform | 44 / 76 | 44 / 76 | held |
| `scripts/board/lib/escalation.mjs` renderEscalationComment | 30 / 28 | 30 / 28 | held |
| `scripts/board/lib/escalation.mjs` resolveCheck | 31 / 33 | 31 / 33 | held |
| `scripts/board/lib/evidence.mjs` renderEvidence | 17 / 28 | 17 / 28 | held |
| `scripts/board/lib/flow.mjs` applyEvent | 32 / 43 | 32 / 43 | held |
| `scripts/board/lib/migrate.mjs` formatPlan | 17 / 23 | 17 / 23 | held |
| `scripts/board/lib/migrate.mjs` applyMigration | 32 / 81 | 32 / 78 | held |
| `scripts/board/lib/migrate.mjs` verifyMigration | 32 / 74 | 32 / 74 | held |
| `scripts/board/lib/migrate.mjs` deleteLocal | 19 / 31 | 19 / 31 | held |
| `scripts/board/lib/outcomes.mjs` recordLateOutcome | 20 / 40 | 20 / 40 | held |
| `scripts/board/lib/source.mjs` sourceOfIssue | 17 / 24 | 17 / 24 | held |
| `scripts/board/lib/source.mjs` fetchTickets | 39 / 68 | 39 / 68 | held |
| `scripts/board/lib/trackers/gitlab.mjs` gitlabTracker | 8 / 278 | 8 / 272 | held |
| `scripts/board/lib/trackers/gitlab.mjs` update | 20 / 19 | 14 / 13 | held |
| `scripts/factory/factory.mjs` doctor | 101 / 184 | 101 / 184 | held |
| `scripts/factory/factory.mjs` main | 132 / 254 | 130 / 252 | held |
| `scripts/factory/lib/detect.mjs` detect | 47 / 80 | 47 / 81 | held |
| `scripts/factory/lib/init.mjs` draftConfig | 19 / 54 | 19 / 54 | held |
| `scripts/factory/lib/interview.mjs` interview | 24 / 38 | 24 / 38 | held |
| `scripts/factory/lib/render.mjs` outputs | 34 / 117 | 34 / 117 | held |
| `scripts/factory/lib/render.mjs` render | 16 / 28 | 16 / 28 | held |
| `scripts/factory/lib/render.mjs` check | 17 / 19 | 17 / 19 | held |
| `scripts/feature-verification/lib/runners.mjs` sharedFixtureErrors | 17 / 34 | 17 / 34 | held |
| `scripts/feature-verification/lib/verify.mjs` normalizeVerdict | 25 / 44 | 25 / 44 | held |
| `scripts/feature-verification/lib/verify.mjs` (anonymous) `const gaps = (Array.isArray(raw?.gaps) ? raw.gaps : []).map(` | 16 / 13 | 16 / 13 | held |
| `scripts/feature-verification/lib/verify.mjs` councilVerifier | 23 / 84 | 21 / 84 | held |
| `scripts/feature-verification/lib/verify.mjs` asGap | 16 / 9 | 16 / 9 | held |
| `scripts/feature-verification/lib/workflows.mjs` planLoop | 50 / 143 | 50 / 143 | held |
| `scripts/feature-verification/lib/workflows.mjs` precheckAutomation | 66 / 172 | 63 / 169 | held |
| `scripts/feature-verification/lib/workflows.mjs` automationLoop | 17 / 34 | 17 / 34 | held |
| `scripts/feature-verification/lib/workflows.mjs` automationPass | 62 / 195 | 61 / 177 | held |
| `scripts/implement/lib/analysis-gate.mjs` runAnalysisJobs | 21 / 42 | 21 / 42 | held |
| `scripts/implement/lib/analysis-gate.mjs` remedyRedBranch | 30 / 49 | 30 / 49 | held |
| `scripts/implement/lib/ci-parity.mjs` parityGate | 20 / 42 | 20 / 42 | held |
| `scripts/implement/lib/ci-wait.mjs` ciState | 20 / 18 | 20 / 18 | held |
| `scripts/implement/lib/ci-wait.mjs` waitForCi | 33 / 41 | 33 / 41 | held |
| `scripts/implement/lib/ci-wait.mjs` ciGate | 47 / 43 | 47 / 43 | held |
| `scripts/implement/lib/ci-wait.mjs` deliveryDecision | 21 / 17 | 21 / 17 | held |
| `scripts/implement/lib/ci-wait.mjs` (anonymous) `return async (target, repo, _label, { timeoutSec = WAIT.time` | 26 / 30 | 26 / 30 | held |
| `scripts/implement/lib/decisions.mjs` decisionRecord | 25 / 23 | 25 / 23 | held |
| `scripts/implement/lib/decisions.mjs` subtaskRunRecord | 28 / 30 | 28 / 30 | held |
| `scripts/implement/lib/decisions.mjs` labelDecisions | 49 / 51 | 49 / 51 | held |
| `scripts/implement/lib/decisions.mjs` prCheckDesignFindings | 17 / 17 | 17 / 17 | held |
| `scripts/implement/lib/epic.mjs` epicToJoin | 19 / 12 | 19 / 12 | held |
| `scripts/implement/lib/epic.mjs` prepareUnitWorktree | 16 / 32 | 16 / 32 | held |
| `scripts/implement/lib/epic.mjs` planEpicOnce | 24 / 40 | 24 / 41 | held |
| `scripts/implement/lib/epic.mjs` openPr | 21 / 19 | 21 / 19 | held |
| `scripts/implement/lib/epic.mjs` runEpic | 19 / 39 | 19 / 39 | held |
| `scripts/implement/lib/epic.mjs` epicFlow | 98 / 207 | 98 / 207 | held |
| `scripts/implement/lib/epic.mjs` deliverUnit | 162 / 294 | 162 / 294 | held |
| `scripts/implement/lib/epic.mjs` runUnitStories | 23 / 86 | 23 / 86 | held |
| `scripts/implement/lib/epic.mjs` formatEpicStatus | 19 / 13 | 19 / 13 | held |
| `scripts/implement/lib/gitops.mjs` formattingOnlyHunks | 16 / 27 | 16 / 27 | held |
| `scripts/implement/lib/implement.mjs` startResolvedReruns | 17 / 30 | 17 / 30 | held |
| `scripts/implement/lib/implement.mjs` plan | 72 / 93 | 72 / 93 | held |
| `scripts/implement/lib/implement.mjs` runBatch | 29 / 55 | 29 / 55 | held |
| `scripts/implement/lib/implement.mjs` startWorker | 27 / 58 | 27 / 58 | held |
| `scripts/implement/lib/implement.mjs` prepareWorktree | 34 / 76 | 34 / 76 | held |
| `scripts/implement/lib/implement.mjs` recoverDeadRun | 26 / 29 | 26 / 29 | held |
| `scripts/implement/lib/implement.mjs` implementStoryInner | 278 / 594 | 278 / 594 | held |
| `scripts/implement/lib/implement.mjs` deliverFinished | 107 / 203 | 107 / 203 | held |
| `scripts/implement/lib/implement.mjs` publishRatingOrHold | 28 / 34 | 28 / 34 | held |
| `scripts/implement/lib/implement.mjs` afterOpen | 68 / 139 | 68 / 139 | held |
| `scripts/implement/lib/implement.mjs` waitForHookPrCheck | 33 / 38 | 33 / 38 | held |
| `scripts/implement/lib/implement.mjs` prCheckHold | 17 / 7 | 17 / 7 | held |
| `scripts/implement/lib/implement.mjs` prCheckFollowUps | 18 / 12 | 18 / 12 | held |
| `scripts/implement/lib/implement.mjs` runConditionsSection | 21 / 21 | 21 / 21 | held |
| `scripts/implement/lib/implement.mjs` fixBeforePr | 27 / 29 | 27 / 29 | held |
| `scripts/implement/lib/lsp.mjs` lspAdapter | 7 / 129 | 7 / 129 | held |
| `scripts/implement/lib/lsp.mjs` start | 24 / 39 | 24 / 39 | held |
| `scripts/implement/lib/lsp.mjs` diagnostics | 17 / 20 | 17 / 20 | held |
| `scripts/implement/lib/mockups.mjs` dcVariants | 19 / 11 | 19 / 11 | held |
| `scripts/implement/lib/mockups.mjs` dcRuntime | 1 / 102 | 1 / 102 | held |
| `scripts/implement/lib/mockups.mjs` walkNode | 23 / 41 | 23 / 41 | held |
| `scripts/implement/lib/mockups.mjs` render | 16 / 37 | 16 / 37 | held |
| `scripts/implement/lib/mockups.mjs` renderScreens | 17 / 58 | 17 / 58 | held |
| `scripts/implement/lib/orchestrate.mjs` callAgent | 25 / 30 | 25 / 30 | held |
| `scripts/implement/lib/orchestrate.mjs` planStory | 22 / 57 | 22 / 62 | held |
| `scripts/implement/lib/orchestrate.mjs` verifyUi | 18 / 50 | 18 / 50 | held |
| `scripts/implement/lib/orchestrate.mjs` pairLoop | 64 / 216 | 60 / 205 | held |
| `scripts/implement/lib/orchestrate.mjs` runSubtask | 19 / 60 | 19 / 60 | held |
| `scripts/implement/lib/orchestrate.mjs` runDelegated | 32 / 76 | 32 / 76 | held |
| `scripts/implement/lib/plan.mjs` parseVerdict | 20 / 15 | 20 / 15 | held |
| `scripts/implement/lib/plan.mjs` (anonymous) `.map((f, i) => {` | 17 / 9 | 17 / 9 | held |
| `scripts/implement/lib/plan.mjs` intersects | 20 / 25 | 20 / 25 | held |
| `scripts/implement/lib/plan.mjs` validatePlan | 43 / 91 | 43 / 94 | held |
| `scripts/implement/lib/plan.mjs` (anonymous) `subtasks.forEach((s, i) => {` | 40 / 37 | 40 / 39 | held |
| `scripts/implement/lib/plan.mjs` decisionFields | 18 / 17 | 18 / 17 | held |
| `scripts/implement/lib/pr-check-return.mjs` routeFinding | 25 / 25 | 25 / 25 | held |
| `scripts/implement/lib/pr-check-return.mjs` unaddressed | 20 / 25 | 20 / 25 | held |
| `scripts/implement/lib/pre-open.mjs` confirmPrState | 23 / 24 | 23 / 24 | held |
| `scripts/implement/lib/pre-open.mjs` holdPr | 23 / 38 | 23 / 38 | held |
| `scripts/implement/lib/pre-open.mjs` agentRunsAfterReady | 18 / 18 | 18 / 18 | held |
| `scripts/lsp/lib/common.mjs` loadConfig | 17 / 20 | 17 / 20 | held |
| `scripts/lsp/lib/common.mjs` acquireLease | 21 / 30 | 21 / 30 | held |
| `scripts/models/lib/models.mjs` discoverModels | 17 / 30 | 17 / 30 | held |
| `scripts/models/lib/models.mjs` checkConfigs | 21 / 49 | 21 / 49 | held |
| `scripts/pipeline/lib/agents.mjs` cliInvocation | 42 / 98 | 41 / 98 | held |
| `scripts/pipeline/lib/agents.mjs` finishRun | 22 / 63 | 22 / 63 | held |
| `scripts/pipeline/lib/agents.mjs` prepare | 16 / 27 | 16 / 27 | held |
| `scripts/pipeline/lib/agents.mjs` runAgent | 22 / 19 | 22 / 19 | held |
| `scripts/pipeline/lib/agents.mjs` runAgentAsync | 20 / 62 | 20 / 62 | held |
| `scripts/pipeline/lib/analysis/config.mjs` packAnalysis | 24 / 22 | 24 / 22 | held |
| `scripts/pipeline/lib/analysis/config.mjs` resolveAnalysis | 55 / 81 | 55 / 81 | held |
| `scripts/pipeline/lib/analysis/config.mjs` normalizeTool | 41 / 45 | 41 / 45 | held |
| `scripts/pipeline/lib/analysis/config.mjs` (anonymous) `return (Array.isArray(c) ? c : [c]).filter((e) => isObject(e` | 16 / 15 | 16 / 15 | held |
| `scripts/pipeline/lib/analysis/config.mjs` analysisProblems | 141 / 124 | 141 / 124 | held |
| `scripts/pipeline/lib/analysis/config.mjs` (anonymous) `list.forEach((r, i) => {` | 19 / 9 | 19 / 9 | held |
| `scripts/pipeline/lib/analysis/config.mjs` (anonymous) `list.forEach((e, i) => {` | 29 / 18 | 29 / 18 | held |
| `scripts/pipeline/lib/analysis/config.mjs` installProblems | 20 / 14 | 20 / 14 | held |
| `scripts/pipeline/lib/analysis/fixloop.mjs` fixLoop | 20 / 33 | 20 / 33 | held |
| `scripts/pipeline/lib/analysis/fixloop.mjs` prAnalysisSection | 26 / 43 | 26 / 43 | held |
| `scripts/pipeline/lib/analysis/licences.mjs` check | 22 / 22 | 22 / 22 | held |
| `scripts/pipeline/lib/analysis/parsers.mjs` parseSarif | 30 / 37 | 30 / 37 | held |
| `scripts/pipeline/lib/analysis/parsers.mjs` parseOsvJson | 25 / 19 | 25 / 19 | held |
| `scripts/pipeline/lib/analysis/report.mjs` evidenceText | 20 / 26 | 20 / 27 | held |
| `scripts/pipeline/lib/analysis/report.mjs` staticAnalysisSection | 54 / 49 | 54 / 49 | held |
| `scripts/pipeline/lib/analysis/runner.mjs` runTool | 60 / 63 | 60 / 63 | held |
| `scripts/pipeline/lib/analysis/runner.mjs` runPrecheck | 18 / 28 | 18 / 28 | held |
| `scripts/pipeline/lib/analysis/runner.mjs` runSlot | 41 / 84 | 41 / 86 | held |
| `scripts/pipeline/lib/analysis/scanners/github-code-scanning.mjs` result | 32 / 21 | 32 / 21 | held |
| `scripts/pipeline/lib/ci/evidence.mjs` evaluateRuns | 27 / 31 | 27 / 31 | held |
| `scripts/pipeline/lib/ci/evidence.mjs` headPipelines | 24 / 46 | 22 / 44 | held |
| `scripts/pipeline/lib/ci/github-actions.mjs` workflowApplies | 25 / 24 | 25 / 24 | held |
| `scripts/pipeline/lib/ci/github-actions.mjs` expectedWorkflows | 18 / 21 | 18 / 21 | held |
| `scripts/pipeline/lib/ci/github-actions.mjs` defaultRequiredChecks | 31 / 34 | 26 / 20 | held |
| `scripts/pipeline/lib/ci/github-actions.mjs` providedChecks | 17 / 28 | 15 / 17 | held |
| `scripts/pipeline/lib/ci/github-actions.mjs` uncoveredChecks | 26 / 42 | 21 / 28 | held |
| `scripts/pipeline/lib/config.mjs` appSettingsProblems | 34 / 37 | 34 / 37 | held |
| `scripts/pipeline/lib/config.mjs` loadConfig | 20 / 45 | 20 / 45 | held |
| `scripts/pipeline/lib/costs.mjs` summarize | 19 / 69 | 19 / 69 | held |
| `scripts/pipeline/lib/council-config.mjs` intercomProblems | 39 / 35 | 39 / 35 | held |
| `scripts/pipeline/lib/council.mjs` memberTask | 17 / 42 | 11 / 30 | held |
| `scripts/pipeline/lib/council.mjs` runCouncil | 17 / 54 | 17 / 55 | held |
| `scripts/pipeline/lib/council.mjs` sameDefect | 20 / 14 | 20 / 14 | held |
| `scripts/pipeline/lib/council.mjs` hasEvidence | 23 / 24 | 23 / 24 | held |
| `scripts/pipeline/lib/council.mjs` mergeCouncil | 96 / 266 | 96 / 250 | held |
| `scripts/pipeline/lib/council.mjs` (anonymous) `const merged = clusters.map((c) => {` | 50 / 98 | 50 / 100 | held |
| `scripts/pipeline/lib/council.mjs` adjudicate | 24 / 22 | 24 / 22 | held |
| `scripts/pipeline/lib/council.mjs` sealFixes | 27 / 41 | 27 / 41 | held |
| `scripts/pipeline/lib/council.mjs` councilMemory | 24 / 76 | 24 / 76 | held |
| `scripts/pipeline/lib/council.mjs` recordCouncilRound | 30 / 52 | 30 / 55 | held |
| `scripts/pipeline/lib/council.mjs` councilReviewSection | 36 / 57 | 36 / 57 | held |
| `scripts/pipeline/lib/council.mjs` councilDoctorRows | 27 / 35 | 27 / 35 | held |
| `scripts/pipeline/lib/council.mjs` guardProtectedTests | 18 / 27 | 18 / 27 | held |
| `scripts/pipeline/lib/decisions.mjs` (anonymous) `return (Array.isArray(bugs) ? bugs : []).map((bug) => {` | 16 / 9 | 16 / 9 | held |
| `scripts/pipeline/lib/experiment.mjs` runExperiment | 20 / 35 | 20 / 35 | held |
| `scripts/pipeline/lib/experiment.mjs` summarizeArm | 20 / 36 | 20 / 36 | held |
| `scripts/pipeline/lib/factory-guard.mjs` shellSegments | 19 / 29 | 19 / 29 | held |
| `scripts/pipeline/lib/factory-guard.mjs` inlineWriteTargets | 19 / 28 | 19 / 28 | held |
| `scripts/pipeline/lib/factory-guard.mjs` shellWriteTargets | 65 / 90 | 65 / 90 | held |
| `scripts/pipeline/lib/factory-guard.mjs` enforceProtected | 19 / 52 | 19 / 52 | held |
| `scripts/pipeline/lib/factory-guard.mjs` factoryGuard | 36 / 57 | 36 / 57 | held |
| `scripts/pipeline/lib/findings.mjs` recordRoundFindings | 18 / 33 | 18 / 33 | held |
| `scripts/pipeline/lib/findings.mjs` (anonymous) `all.forEach(({ f }, i) => {` | 16 / 8 | 16 / 8 | held |
| `scripts/pipeline/lib/findings.mjs` recordPrCheckRound | 22 / 14 | 22 / 14 | held |
| `scripts/pipeline/lib/findings.mjs` recordMisses | 26 / 13 | 26 / 13 | held |
| `scripts/pipeline/lib/hosts/azure-devops.mjs` createAzureDevopsHost | 12 / 293 | 12 / 292 | held |
| `scripts/pipeline/lib/hosts/azure-devops.mjs` normalize | 16 / 24 | 16 / 24 | held |
| `scripts/pipeline/lib/hosts/azure-devops.mjs` mergeState | 17 / 12 | 17 / 12 | held |
| `scripts/pipeline/lib/hosts/bitbucket.mjs` normalizePr | 21 / 27 | 21 / 27 | held |
| `scripts/pipeline/lib/hosts/bitbucket.mjs` createBitbucketHost | 12 / 260 | 12 / 260 | held |
| `scripts/pipeline/lib/hosts/github.mjs` normalizePr | 24 / 27 | 24 / 27 | held |
| `scripts/pipeline/lib/hosts/github.mjs` createGithubHost | 17 / 347 | 17 / 347 | held |
| `scripts/pipeline/lib/hosts/github.mjs` fail | 18 / 15 | 18 / 15 | held |
| `scripts/pipeline/lib/hosts/github.mjs` update | 17 / 18 | 17 / 18 | held |
| `scripts/pipeline/lib/hosts/github.mjs` enforceReviewGate | 19 / 23 | 19 / 23 | held |
| `scripts/pipeline/lib/hosts/gitlab.mjs` normalizeMr | 28 / 26 | 28 / 26 | held |
| `scripts/pipeline/lib/hosts/gitlab.mjs` createGitlabHost | 8 / 314 | 8 / 308 | held |
| `scripts/pipeline/lib/hosts/gitlab.mjs` reviews | 27 / 22 | 27 / 22 | held |
| `scripts/pipeline/lib/hosts/gitlab.mjs` enforceReviewGate | 21 / 23 | 21 / 23 | held |
| `scripts/pipeline/lib/instruction-check.mjs` textProblems | 38 / 46 | 38 / 46 | held |
| `scripts/pipeline/lib/instruction-check.mjs` policyTextProblems | 17 / 37 | 17 / 37 | held |
| `scripts/pipeline/lib/orchestrator.mjs` decide | 16 / 28 | 12 / 9 | held |
| `scripts/pipeline/lib/products.mjs` detectHost | 47 / 47 | 47 / 47 | held |
| `scripts/pipeline/lib/products.mjs` resolveProducts | 34 / 13 | 34 / 13 | held |
| `scripts/pipeline/lib/scorecard.mjs` computeScorecard | 42 / 96 | 42 / 96 | held |
| `scripts/pipeline/lib/selection.mjs` pickProblems | 26 / 31 | 26 / 31 | held |
| `scripts/pipeline/lib/selection.mjs` harnessPick | 26 / 57 | 26 / 57 | held |
| `scripts/pipeline/lib/selection.mjs` selectCouncil | 23 / 96 | 20 / 83 | held |
| `scripts/pipeline/lib/settings.mjs` allowedText | 26 / 27 | 26 / 27 | held |
| `scripts/pipeline/lib/settings.mjs` valueOk | 25 / 27 | 25 / 27 | held |
| `scripts/pipeline/lib/settings.mjs` walk | 24 / 25 | 24 / 25 | held |
| `scripts/pipeline/lib/settings.mjs` settingCalls | 17 / 30 | 17 / 30 | held |
| `scripts/pipeline/lib/settings.mjs` codeReads | 54 / 124 | 53 / 121 | held |
| `scripts/pipeline/lib/settings.mjs` (anonymous) `parts.forEach((arg, i) => {` | 16 / 13 | 16 / 13 | held |
| `scripts/pipeline/lib/settings.mjs` fallbackLiterals | 60 / 102 | 59 / 99 | held |
| `scripts/pipeline/lib/settings.mjs` settingsCheck | 44 / 108 | 44 / 108 | held |
| `scripts/pipeline/lib/story-guard.mjs` touchedPaths | 16 / 15 | 16 / 15 | held |
| `scripts/pipeline/lib/story-guard.mjs` installGuard | 25 / 61 | 25 / 61 | held |
| `scripts/pipeline/lib/story-guard.mjs` networkGuard | 45 / 55 | 45 / 55 | held |
| `scripts/pipeline/lib/story-guard.mjs` ticketWriteGuard | 20 / 20 | 20 / 20 | held |
| `scripts/pipeline/lib/story-guard.mjs` foreignTestGuard | 22 / 33 | 22 / 33 | held |
| `scripts/pipeline/lib/story-guard.mjs` stackGuard | 17 / 10 | 17 / 10 | held |
| `scripts/pipeline/lib/usage.mjs` usageRecords | 27 / 60 | 27 / 60 | held |
| `scripts/pipeline/lib/util.mjs` run | 28 / 24 | 28 / 24 | held |
| `scripts/pipeline/lib/util.mjs` runAsync | 21 / 16 | 21 / 16 | held |
| `scripts/pipeline/lib/util.mjs` stepRecord | 16 / 13 | 16 / 13 | held |
| `scripts/pipeline/pipeline.mjs` main | 82 / 181 | 76 / 181 | held |
| `scripts/pr-check/lib/decision-body.mjs` withDecision | 16 / 23 | 16 / 23 | held |
| `scripts/pr-check/lib/decision-body.mjs` withCheckVerdict | 17 / 24 | 17 / 24 | held |
| `scripts/pr-check/lib/loop.mjs` scoreRound | 67 / 89 | 67 / 91 | held |
| `scripts/pr-check/lib/loop.mjs` decidePass | 24 / 23 | 24 / 25 | held |
| `scripts/pr-check/lib/loop.mjs` header | 17 / 33 | 17 / 33 | held |
| `scripts/pr-check/lib/loop.mjs` callAgent | 25 / 24 | 24 / 24 | held |
| `scripts/pr-check/lib/loop.mjs` fixRound | 21 / 64 | 18 / 56 | held |
| `scripts/pr-check/lib/loop.mjs` carryOver | 32 / 41 | 32 / 41 | held |
| `scripts/pr-check/lib/loop.mjs` councilFindings | 33 / 81 | 31 / 81 | held |
| `scripts/pr-check/lib/loop.mjs` runRound | 44 / 104 | 44 / 104 | held |
| `scripts/pr-check/lib/loop.mjs` (anonymous) `reviews.forEach((review, i) => {` | 19 / 21 | 19 / 21 | held |
| `scripts/pr-check/lib/loop.mjs` runPrCheck | 82 / 192 | 72 / 185 | held |
| `scripts/pr-check/lib/video.mjs` videoSources | 16 / 36 | 16 / 36 | held |
| `scripts/pr-check/pr-check.mjs` executeCheck | 132 / 271 | 132 / 271 | held |
| `scripts/pr-check/pr-check.mjs` main | 58 / 115 | 58 / 115 | held |
| `scripts/pr-check/pr-check.mjs` reverifyAfterFixes | 22 / 43 | 22 / 43 | held |
| `scripts/pr-video/lib/api-evidence.mjs` maskStructured | 40 / 173 | 37 / 165 | held |
| `scripts/pr-video/lib/api-evidence.mjs` finish | 44 / 58 | 44 / 58 | held |
| `scripts/pr-video/lib/api-evidence.mjs` maskXml | 79 / 123 | 79 / 123 | held |
| `scripts/pr-video/lib/api-evidence.mjs` echoMasker | 22 / 78 | 22 / 78 | held |
| `scripts/pr-video/lib/api-evidence.mjs` cleanExchange | 28 / 84 | 28 / 84 | held |
| `scripts/pr-video/lib/api-evidence.mjs` verifyApiBefore | 17 / 33 | 17 / 33 | held |
| `scripts/pr-video/lib/api-evidence.mjs` validateProse | 23 / 22 | 23 / 22 | held |
| `scripts/pr-video/lib/api-evidence.mjs` writeProse | 23 / 38 | 23 / 38 | held |
| `scripts/pr-video/lib/api-summary.mjs` changedEndpoints | 23 / 25 | 23 / 25 | held |
| `scripts/pr-video/lib/api-summary.mjs` renderEndpoint | 19 / 21 | 19 / 21 | held |
| `scripts/pr-video/lib/api-summary.mjs` renderApiSection | 20 / 37 | 20 / 37 | held |
| `scripts/pr-video/lib/local.mjs` renderRecorded | 65 / 79 | 65 / 79 | held |
| `scripts/pr-video/lib/local.mjs` backendEvidence | 28 / 65 | 28 / 65 | held |
| `scripts/pr-video/lib/local.mjs` produceLocal | 52 / 111 | 52 / 111 | held |
| `scripts/pr-video/lib/pr-video.mjs` renderSection | 24 / 55 | 24 / 55 | held |
| `scripts/pr-video/lib/tools.mjs` installTools | 22 / 40 | 22 / 40 | held |
| `scripts/retro/lib/lessons.mjs` fileFactoryIssues | 17 / 38 | 17 / 38 | held |
| `scripts/retro/lib/lessons.mjs` lessonsCommand | 117 / 205 | 112 / 202 | held |
| `scripts/retro/retro.mjs` main | 44 / 78 | 44 / 78 | held |
| `scripts/review-gate/lib/assessment.mjs` assessTicket | 16 / 30 | 16 / 30 | held |
| `scripts/review-gate/lib/gate.mjs` decideGate | 41 / 47 | 41 / 47 | held |
| `scripts/review-gate/lib/gate.mjs` gateState | 16 / 28 | 16 / 28 | held |
| `scripts/review-gate/lib/gate.mjs` renderNotice | 49 / 46 | 49 / 46 | held |
| `scripts/review-gate/lib/github.mjs` toView | 17 / 21 | 17 / 21 | held |
| `scripts/review-gate/lib/github.mjs` mergePr | 33 / 33 | 33 / 33 | held |
| `scripts/review-gate/lib/sync.mjs` recordReopen | 20 / 20 | 20 / 20 | held |
| `scripts/review-gate/lib/sync.mjs` rebuildAssessment | 44 / 63 | 44 / 63 | held |
| `scripts/review-gate/lib/sync.mjs` (anonymous) `const tickets = (state.tickets ?? []).map((t) => {` | 24 / 12 | 24 / 12 | held |
| `scripts/review-gate/lib/sync.mjs` postQuorumStatus | 17 / 15 | 17 / 15 | held |
| `scripts/review-gate/lib/sync.mjs` regate | 18 / 33 | 18 / 33 | held |
| `scripts/review-gate/lib/sync.mjs` syncGate | 11 / 105 | 11 / 105 | held |
| `scripts/review-gate/lib/sync.mjs` (anonymous) `() => {` | 28 / 48 | 28 / 48 | held |
| `scripts/review-gate/lib/sync.mjs` (anonymous) `() => {` | 24 / 66 | 24 / 66 | held |
| `scripts/review/lib/review.mjs` councilArchitectureReview | 30 / 86 | 28 / 86 | held |
| `scripts/review/lib/review.mjs` policyReview | 32 / 68 | 32 / 68 | held |
| `scripts/review/lib/review.mjs` hookStop | 30 / 102 | 26 / 78 | held |

## Closing check

Every baseline item is fixed or kept with a reason, no new item is unlisted, there are fewer clones and fewer functions over the limits, and no function the branch changed went over a limit or got worse.
