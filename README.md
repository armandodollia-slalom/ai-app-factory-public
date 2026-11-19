# AI app factory

A generator for an AI development pipeline. Point it at a codebase in any language and it sets up agents
that implement stories, review the architecture, write and verify tests, check pull requests, and learn
from their own mistakes. The engine stays outside the codebase; what it generates there is kept apart from
the application code and can be removed again. The code can live on GitHub, GitLab, Azure DevOps or Bitbucket
Cloud, the tickets on GitHub issues, Jira, Azure Boards, GitLab Issues or Linear, and CI run on GitHub Actions,
GitLab CI, Azure Pipelines, Jenkins, CircleCI or Bitbucket Pipelines, in any combination the CI system supports.
An in-house product is a `custom` adapter, and a client's licensed scanner (Semgrep, CodeQL, Snyk, SonarQube,
Checkmarx, Veracode) joins the static analysis ([docs/providers/](docs/providers/README.md)).

It was extracted from the pipeline built in the eShop reference application (`examples/eshop/` holds that
application's settings as a worked example).

## What it generates

| Component | What it is | Set up by |
| --- | --- | --- |
| Pipeline stages | implement, review, feature verification, PR check, review gate, board, retro: [docs/ai-pipeline/README.md](docs/ai-pipeline/README.md) | `factory init`, then the `onboard-codebase` skill |
| Agents | 22 stack-neutral definitions in `agents/`, plus what each repository adds: [docs/ai-pipeline/agents.md](docs/ai-pipeline/agents.md) | `write-agent-addenda` skill |
| Code intelligence | language servers over one MCP server: [docs/code-intelligence.md](docs/code-intelligence.md) | `setup-lsp` skill |
| Test stack | a scenario-seeded Docker Compose deployment for tests: [docs/test-stack.md](docs/test-stack.md) | `setup-teststack` skill |
| Architecture policy | rules checked before the LLM reviewer: [docs/architecture-policy.md](docs/architecture-policy.md) | `author-architecture-policy` skill |
| Code host and PR identity | GitHub, GitLab, Azure DevOps, Bitbucket Cloud or custom: pull requests opened by an identity you can approve, branch policies: [docs/providers/](docs/providers/README.md) | `setup-host` skill |
| Board | tickets on GitHub issues and Projects, Jira, Azure Boards, GitLab Issues, Linear or custom | `setup-board` skill |
| CI | the factory's jobs for GitHub Actions, GitLab CI, Azure Pipelines, Jenkins, CircleCI or Bitbucket Pipelines, next to the team's own pipelines | `factory init` (the setup interview) |
| Observability | where the agents' decisions, verdicts and costs are stored: [docs/observability.md](docs/observability.md) | `setup-observability` skill |
| Retro | lessons for the repository and pull requests against this factory: [docs/ai-pipeline/retro.md](docs/ai-pipeline/retro.md) | `setup-retro` skill |

Language knowledge lives in `packs/<language>/` (dotnet, typescript, rust, java, python, go): how to detect
it, its language servers, test runners and default commands. A language without a pack still works; its
commands are written into the repository's config by hand or by the skills.

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
draft against the real build and hands over to the component skills.

## What ends up in the app repository

| Where | What | Owner |
| --- | --- | --- |
| `.factory/config.json` | the project model and every setting: [docs/configuration.md](docs/configuration.md) | the team, through the skills |
| `.factory/factory.json` | the engine version this repository pins, the agent tools and features in use | the team |
| `.factory/agents/`, `lessons/`, `policy/` | agent addenda, learned rules, architecture rules | the team and the retro |
| `.factory/stack/`, `plans/` | compose file, scenarios, test plans | the pipeline's agents |
| `.factory/metrics/` | the agents' observability records (the local spool) | the pipeline |
| `.factory/state/` | runs, logs, ticket cache (ignored by git) | the machine |
| `.factory/bin/`, `githooks/`, `manifest.json` | the shim that finds the engine, git hooks, the list of generated files | generated |
| `.claude/`, `.codex/`, `.gemini/`, `.cursor/`, `.mcp.json`, the CI files (`.github/workflows/factory-*.yml`, `.gitlab/ci/factory-*.yml` with an include block in `.gitlab-ci.yml`, or `.azure-pipelines/factory-*.yml`), blocks in `AGENTS.md` and `.gitattributes` | what the agent tools and CI require at fixed paths | generated; only the factory's entries |

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
