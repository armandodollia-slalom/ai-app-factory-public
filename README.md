# AI app factory

A generator for an AI delivery pipeline. Point it at a codebase in any language and it installs a pipeline
that takes a ticket from the board to a pull request: agents implement it, review the architecture, write
and verify tests and check the change against its ticket, and a deterministic harness proves CI on the
branch, opens the pull request once, rates bug fixes and merges the low-risk ones. The engine stays outside
the codebase; what it generates there is kept apart from the application code and can be removed again.

It was extracted from the pipeline built in the eShop reference application (`examples/eshop/` holds that
application's settings as a worked example).

## The pipeline it installs

One ticket, in brief:

1. A person moves the ticket to Ready and starts `factory implement run <KEY> --pr` (or `--epic <EPIC>`).
2. The orchestrator plans it; verifier pairs implement it, each change checked by the harness (language
   servers, lint, optional static analysis with a fix loop) and by a fresh verifier.
3. The architecture review (a policy engine, then a reviewer) and feature verification (a verified test plan
   and verified automated tests) run on the change.
4. The PR check (critics, a defender and a judge) scores the change against the ticket; what it upholds goes
   back to implementation, to test planning and automation, or to its fixer, depending on what would fix it.
5. Before any pull request exists: CI's analysis jobs run locally, the branch is pushed, CI must be green on
   that exact head, a bug fix is rated by the review gate, and a narrated demo video is recorded on this machine.
6. The pull request opens once, finished. A bug fix that is Low risk with high confidence auto-merges;
   everything else waits for a person's approval.

Any verifier seat can be a council of members from several agent CLIs and models. When a stage stops, the
ticket goes to Failed with its findings and up to three questions for a person, and no pull request opens.
The diagrams and the details of each step are in [docs/ai-pipeline/README.md](docs/ai-pipeline/README.md#the-generated-pipeline).

## Supported services

Each outside service is reached through an adapter, chosen per repository in `.factory/config.json`
([docs/providers/](docs/providers/README.md)):

| Kind | Built in |
| --- | --- |
| Code host | GitHub, GitLab, Azure DevOps (Azure Repos), Bitbucket Cloud |
| Ticket board | GitHub Issues and Projects, Jira, Azure Boards, GitLab Issues, Linear |
| CI system | GitHub Actions, GitLab CI, Azure Pipelines, Jenkins, CircleCI, Bitbucket Pipelines |
| Static analysis | the factory's packs (secrets, dependencies, SAST, workflow and IaC checks, and a pack per language), plus a client's licensed scanner: Semgrep, CodeQL, Snyk, SonarQube, Checkmarx or Veracode ([commercial-scanners.md](docs/providers/commercial-scanners.md)) |
| Agent CLIs | Claude Code (default), GitHub Copilot CLI, OpenAI Codex, or any command that reads a prompt on stdin; models are allowed per repository ([models.md](docs/ai-pipeline/models.md)) |
| Observability sink | none (default), a directory, an HTTP collector, a command, or OpenTelemetry logs ([observability.md](docs/observability.md)) |

An in-house product of any kind is a `custom` adapter ([custom.md](docs/providers/custom.md)).

## What has been proven, and what has not

- Only the GitHub adapters (code host, GitHub Issues and Projects, GitHub Actions) have run against a live
  service. Every other host, tracker and CI adapter, and the commercial scanners, are verified against fakes
  built from the vendors' documentation ([status per adapter](docs/providers/README.md#verified-live-or-only-against-fakes)).
- Delivering a feature epic as one PR per story (`--pr-split story`), and epics delivered as several PR
  groups, are proven by fixture tests only.
- Some third-party items (the demo-video toolchain's ffmpeg build and narration dependencies, some analysis
  rule sets and data) are marked `licenceReview: "pending"`: they run by default with a warning until legal
  review, and `licenceReview: "strict"` turns them off ([analysis.md](docs/ai-pipeline/analysis.md),
  [pr-demo-video.md](docs/ai-pipeline/pr-demo-video.md#toolchain-and-licences)).

## What it generates

| Component | What it is | Set up by |
| --- | --- | --- |
| Pipeline stages | implement, review, feature verification, PR check, review gate, board, retro: [docs/ai-pipeline/README.md](docs/ai-pipeline/README.md) | `factory init`, then the `onboard-codebase` skill |
| Agents | 23 stack-neutral definitions in `agents/`, plus what each repository adds: [docs/ai-pipeline/agents.md](docs/ai-pipeline/agents.md) | `write-agent-addenda` skill |
| Council | optional verifiers from several CLIs and models at any verification stage: [docs/ai-pipeline/council.md](docs/ai-pipeline/council.md) | the `council` section of the config |
| Static analysis | optional scanners in the pair rounds, the PR check, before the push and in CI: [docs/ai-pipeline/analysis.md](docs/ai-pipeline/analysis.md) | the `analysis` section of the config |
| Code intelligence | language servers over one MCP server: [docs/code-intelligence.md](docs/code-intelligence.md) | `setup-lsp` skill |
| Test stack | a scenario-seeded Docker Compose deployment for tests: [docs/test-stack.md](docs/test-stack.md) | `setup-teststack` skill |
| Demo videos | narrated, subtitled videos of the changed e2e specs, made locally before the PR opens: [docs/ai-pipeline/pr-demo-video.md](docs/ai-pipeline/pr-demo-video.md) | feature `demoVideo`, `factory video install` |
| Architecture policy | rules checked before the LLM reviewer: [docs/architecture-policy.md](docs/architecture-policy.md) | `author-architecture-policy` skill |
| Code host and PR identity | pull requests opened by an identity you can approve, branch policies: [docs/providers/](docs/providers/README.md) | `setup-host` skill |
| Board | the ticket board and its lanes | `setup-board` skill |
| CI | the factory's jobs for the repository's CI system, next to the team's own pipelines | `factory init` (the setup interview) |
| Observability | where the agents' decisions, verdicts and costs are stored: [docs/observability.md](docs/observability.md) | `setup-observability` skill |
| Retro | lessons for the repository, and proposed changes to this factory pushed as a branch: [docs/ai-pipeline/retro.md](docs/ai-pipeline/retro.md) | `setup-retro` skill |

Language knowledge lives in `packs/<language>/` (dotnet, typescript, rust, java, python, go): how to detect
it, its language servers, test runners, default commands and analysis tools. Other packs hold the security
scanners, the commercial scanner definitions, Playwright and the demo-video toolchain. A language without a
pack still works; its commands are written into the repository's config by hand or by the skills.

## Use it on a codebase

```bash
git clone <this repository> ~/code/ai-app-factory && cd ~/code/ai-app-factory && npm ci
export PATH="$HOME/code/ai-app-factory/bin:$PATH"

cd ~/code/your-app
factory detect      # what it sees: languages, buildable units, tests, compose files, CI
factory init        # .factory/ with a draft config (code host, tracker and CI from the remote), plus the generated files
factory doctor      # what this machine and repository still need
```

`init` drafts the config from file names. An agent session in the app repository then runs the
`onboard-codebase` skill (this repository is also a Claude Code plugin: `skills/`), which corrects the
draft against the real build and hands over to the component skills. [docs/ai-pipeline/setup.md](docs/ai-pipeline/setup.md)
lists the prerequisites; then write a ticket ([writing-stories.md](docs/ai-pipeline/writing-stories.md)) and
run `factory implement run <KEY> --pr`.

## What ends up in the app repository

| Where | What | Owner |
| --- | --- | --- |
| `.factory/config.json` | the project model and every setting: [docs/configuration.md](docs/configuration.md) | the team, through the skills |
| `.factory/app.json` | the application's topology (services, ports, test roots) | the team and the agents that add services |
| `.factory/factory.json` | the engine version this repository pins, the agent tools and features in use | the team |
| `.factory/agents/`, `lessons/`, `policy/` | agent addenda, learned rules, architecture rules | the team and the retro |
| `.factory/stack/`, `plans/` | compose file, scenarios, test plans | the pipeline's agents |
| `.factory/metrics/` | the agents' observability records, one file per branch and stream | the pipeline |
| `.factory/state/` | runs, logs, ticket cache, the main checkout's metrics spool (ignored by git) | the machine |
| `.factory/bin/`, `githooks/`, `manifest.json` | the shim that finds the engine, git hooks, the list of generated files | generated |
| `.claude/`, `.codex/`, `.gemini/`, `.cursor/`, `.mcp.json`, the CI files (`.github/workflows/factory-*.yml`, `.gitlab/ci/factory-*.yml` with an include block in `.gitlab-ci.yml`, `.azure-pipelines/factory-*.yml`, or the factory's file for Jenkins, CircleCI or Bitbucket Pipelines with `.factory/ci/factory-ci.sh`), the e2e fixtures with the `demoVideo` feature, blocks in `AGENTS.md` and `.gitattributes` | what the agent tools and CI require at fixed paths | generated; only the factory's entries |

Generated files are never edited by hand: `factory check` (run in CI) fails when one was, and
`factory render` writes them again. `factory uninstall` removes everything in the manifest, which is how
you prove the application does not depend on the factory. Pipeline agents are blocked from editing the
factory's files (the factory guard); only the retro may.

Tests the pipeline writes are the exception: they live in the application's own test tree, tagged with
their story, and belong to the team.

## Work on the factory itself

```bash
npm ci
npm test                                        # every stage and tool, with a fake agent (no LLM)
python3 -m unittest discover architecture-policy/tests    # the policy engine
```

Layout: `bin/factory.mjs` (the one entry point), `scripts/<stage>/` (stages and tools, each with its own
tests and default config), `scripts/factory/` (detect, init, render, check, the metrics sink CLI),
`agents/`, `packs/`, `templates/` (what `render` and `init` copy), `skills/`, `architecture-policy/`
(the policy engine, Python), `examples/eshop/` (a complete example overlay).

Engine code holds no stack knowledge; [docs/contributing.md](docs/contributing.md) has the rules and the
grep that checks it.
