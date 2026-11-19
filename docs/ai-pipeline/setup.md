# Setting up the pipeline

Part of the [AI development pipeline](README.md). What a machine needs to run the factory against a codebase, locally or on a CI runner. The factory is installed once, outside the application repository; each repository gets a `.factory/` folder and a few generated files.

## Prerequisites

| Tool | Needed for | Notes |
| --- | --- | --- |
| Git | worktrees, branches, git hooks | on Windows, Git for Windows also provides Git Bash, which git hooks need |
| Node.js 20 or later | every stage and the hooks | the git hooks skip silently when `node` is missing |
| An agent CLI, signed in | every agent the pipeline starts | Claude Code (`claude`, default), GitHub Copilot CLI (`copilot`) or OpenAI Codex (`codex`) |
| Python 3 (`factory python setup` adds `pyyaml` and `jsonschema` in a virtualenv inside the install) | the architecture policy step of the review | doctor, `factory policy` and the review use the same interpreter (`$FACTORY_PYTHON`, the install's `.venv`, then `python3`/`python` on PATH, the first with the modules). With a policy configured and no such interpreter, the review blocks with a finding that says so |
| `gh`, signed in | GitHub as the code host or the tracker: the story board, opening PRs, the PR check | the pipeline's PRs are opened by your [PR bot](#the-pipelines-pr-bot) once it is set up |
| A token for each other product | GitLab, Azure DevOps, Jira or Azure Boards as the code host or tracker | an environment variable the config names (`"token": "${GITLAB_TOKEN}"`); scopes per product in [hosts-and-trackers.md](../hosts-and-trackers.md). No other CLI is needed: the factory calls their REST APIs |
| Docker | the test stack (feature verification, UI verifiers) | only when the repository configures a `stack` |
| The codebase's own toolchain | building and testing the code | whatever its CI installs: a JDK, `cargo`, the .NET SDK, ... The language packs name the language servers and test runners they expect |
| graphify | optional: agents' code lookups | feature `graphify` in `.factory/factory.json`; see [copilot-setup.md](../copilot-setup.md#3-enable-graphify-for-copilot) |
| Playwright, `ffmpeg` | optional: e2e tests, demo videos, frame extraction in the PR check | feature `demoVideo` |

`factory doctor`, run in the repository, checks each of these and says what is missing.

## Install the factory

```bash
git clone <factory repository> ~/ai-app-factory
cd ~/ai-app-factory && npm ci
npm link                               # puts `factory` on PATH
export FACTORY_HOME=~/ai-app-factory   # in your shell profile: where repositories find the engine
factory python setup                   # a virtualenv in the install with the policy engine's modules
```

**The engine a repository runs is the version it pins** (`.factory/factory.json`). The repository's `.factory/bin/factory.mjs` looks for it in this order: `$FACTORY_HOME`, a dev dependency, `~/.ai-app-factory/versions/<pin>` (`factory upgrade <version> --install` clones that tag, installs all of its packages, the language servers included, sets up the policy engine's Python and checks code intelligence), then an `npm link`ed `factory` on `PATH`. If the engine it finds is at another version than the pin:
- an explicit `FACTORY_HOME` is used, with a warning;
- an implicit one (a dev dependency or a link) is refused for commands, with the install command in the message (`FACTORY_ALLOW_UNPINNED=1` runs it anyway);
- hooks still run, with a warning.

Install the pinned version on a machine that runs the pipeline for a repository; the pin is what CI and every other machine run.

On Windows, run the same commands in PowerShell (`python` instead of `python3`). Prefer a native install of the agent CLI that puts an `.exe` on `PATH`: some pipeline calls start the CLI without a shell and cannot run an npm `.cmd` shim.

## Add it to a repository

```bash
cd /path/to/your/repo
factory detect      # what the factory sees: languages, build units, tests, compose files, CI
factory init        # writes .factory/ (a draft config.json, the pin, addendum skeletons, starter policy) and renders
factory doctor
```

`factory init` drafts `.factory/config.json` from file names and the language packs. In a terminal (or with `--interview`, `--answers <file>` or `--set id=value`) it then asks about every stage: the code host, ticket board and CI system (any combination: [../providers/](../providers/README.md)), merging, agents and models, UI verification, observability, static analysis and a commercial scanner. What detection found is offered as the default ([../providers/setup.md](../providers/setup.md)). Run it again later to change an answer: it edits the config, never overwrites it. Review it, or let an agent do the reading for you with the skills in `skills/` (start with `onboard-codebase`; it calls the others: `setup-lsp`, `setup-teststack`, `author-architecture-policy`, `write-agent-addenda`, `setup-host`, `setup-board`, `setup-observability`, `setup-retro`). [configuration.md](../configuration.md) lists the settings.

After any change to `.factory/config.json`, `.factory/factory.json` or `.factory/agents/`, run `factory render`. `factory check` (also a CI job) fails when generated files are out of step. `factory uninstall` removes everything the factory wrote outside `.factory/`.

Then:

1. Turn on the git hooks: `git config core.hooksPath .factory/githooks` (`factory init` does this unless the repository already has a hooks path; then call `.factory/bin/factory git-hook <event>` from your own hooks).
2. Trust the repository's hooks in your interactive agent tool, so `factory done` triggers the stages. See [Agent tool coverage](README.md#agent-tool-coverage) for each tool's trust step (for Copilot CLI: add the repository to `trustedFolders` in `~/.copilot/config.json`).
3. Choose the agent CLI: `export PIPELINE_AGENT_CLI=copilot` (or `claude`, the default, or `codex`), or set `agent.cli` in `.factory/config.json`. `PIPELINE_AGENT_CMD` runs any other command, with the prompt on stdin; it runs with `sh -c`, so on Windows Git's `usr\bin` folder must be on `PATH`.
4. Check the pipeline without any LLM calls:

   ```bash
   factory stages
   factory implement run <KEY> --dry-run
   ```

A teammate who clones the repository only needs the factory on their machine. The committed launcher `.factory/bin/factory` looks for it in `$FACTORY_HOME`, then `node_modules/ai-app-factory` (a dev dependency), then `~/.ai-app-factory/versions/<pinned version>`, and prints the install command when it finds none. Hooks never fail because the engine is missing.

## The pipeline's PR bot

This section is for GitHub. On GitLab the PR identity is a project access token's bot user, on Azure DevOps a service principal or a dedicated user's PAT: see the `setup-host` skill and [hosts-and-trackers.md](../hosts-and-trackers.md#code-hosts).

GitHub never lets a PR's author approve it. So the pipeline does not open its PRs with your `gh` login: it pushes their branches and opens them as **`dev-bot-<your gh login>`**, a GitHub App each developer creates once. You then approve the pipeline's PRs with GitHub's normal review flow, like your teammates, and `review-quorum` counts your approval. Only the PR's author changes: commits keep their authors, and every other `gh` call (board, labels, reviews, review requests) stays yours. The code is `scripts/pipeline/lib/bot.mjs`.

It covers every PR the pipeline opens: single-ticket PRs (`implement run --pr`), bug-epic group PRs and epic PRs, the push of a reopened bug fix onto its open group PR, and the lessons PR. With `implement.autoMerge.identity: "bot"` the [review gate](review-gate.md#auto-merge) also merges with it.

### One-time setup (per developer)

```bash
factory bot setup
```

It needs your `gh` login and two clicks in the browser; GitHub does not let a script do either:

1. **Create.** The command starts a local page on `127.0.0.1` that sends GitHub the App's manifest: the name `dev-bot-<login>`, private, no webhook, the permissions Contents, Pull requests and Issues (read and write) and Metadata (read), no events. Click **Create GitHub App**. GitHub sends you back to the local page, which saves the App's credentials.
2. **Install.** The command then opens the App's install page: choose **Only select repositories**, pick this repository and click **Install**. The command waits (up to 10 minutes) until the installation works, mints a test token and says so.

Then check it at any time (exit code 0 when it is configured, installed and can mint a token, 1 otherwise):

```bash
factory bot status
```

Until the bot is set up, every PR the pipeline opens logs a warning naming `pipeline bot setup` and uses your own `gh` login, as before. The same happens, with a warning, when the bot cannot get a token (for example it is not installed on the repository).

Notes:

- **Name.** `bot.namePattern` (`dev-bot-{login}`), lowercased. GitHub App names are global and at most 34 characters: a longer name keeps its first 27 characters (without a trailing hyphen) and ends with `-` and 6 characters of a hash of the full name. If GitHub says the name is taken, change it on the Create page; the pipeline uses the App it gets back.
- **Owner.** A private App can be installed only on the account that owns it. When the repository belongs to an organization or another user, run `bot setup --org <org>` (an organization admin creates the App there) or `bot setup --public` (anyone may install it; it still acts only where it is installed).
- `bot setup --force` creates a new App even when credentials exist.

### Where the credentials live

Outside the repository, in `bot.credentialsDir` (`~/.config/ai-app-factory`; `%USERPROFILE%\.config\ai-app-factory` on Windows): `dev-bot-<login>.json` (`appId`, `slug`, `owner`, `privateKeyFile`) and the App's private key `dev-bot-<login>.private-key.pem`, both readable only by you (0600). Nothing else is kept: the App's client secret is not saved. The pipeline signs a short-lived JWT with the key, asks GitHub for an installation token limited to this repository (valid for an hour, kept in memory and renewed 5 minutes before it expires), and gives it to `gh` as `GH_TOKEN` and to `git push` as an HTTP header from the environment, so the token never appears on a command line, in a URL, in a log or in an error.

### Settings

| Setting | Effect |
| --- | --- |
| `bot.enabled` (default `true`), or `PIPELINE_BOT=0` | off: the pipeline's PRs are opened with your `gh` login, without a warning |
| `bot.namePattern` (`dev-bot-{login}`) | the App's name |
| `bot.credentialsDir` (`~/.config/ai-app-factory`), or `PIPELINE_BOT_CREDENTIALS_DIR` | where the credentials are read and written |
| `PIPELINE_BOT_APP_ID` with `PIPELINE_BOT_PRIVATE_KEY` (the PEM text; `\n` escapes are accepted) or `PIPELINE_BOT_PRIVATE_KEY_FILE` | CI or a scheduled runner: the App's id and key from the environment instead of the credentials file (store the key as a secret) |
| `PIPELINE_BOT_LOGIN` | the login used for the name instead of asking `gh` |

### Rotate or revoke

- **Rotate the key:** on GitHub, Settings → Developer settings → GitHub Apps → `dev-bot-<login>` → Private keys → **Generate a private key**. Replace the `.pem` file in the credentials folder with the downloaded one (keep its name, `chmod 600` it), then delete the old key on the same page. `bot status` confirms it.
- **Stop using it on one machine:** delete the two files; the pipeline falls back to your `gh` login (with the warning), or set `PIPELINE_BOT=0`.
- **Revoke:** uninstall the App from the repository (Settings → Integrations → GitHub Apps, or the App's Install page), or delete the App (its settings → Advanced → **Delete GitHub App**), which revokes its keys and tokens at once. PRs it already opened keep it as their author.

## Optional settings

| Setting | Effect |
| --- | --- |
| `git config fv.autoPlan true` | write test plans in the background for stories added or changed by a commit or merge |
| `git config retro.auto true` | run the retro after merges |
| `PIPELINE_BASE_REF` | base branch for diffs and new stories (default `origin/main`) |
| `PIPELINE_DISABLE=1` | turn off every hook, including the story guard |
| `FV_SKIP=1`, `PR_CHECK_SKIP=1` | skip one stage's gate |

Setting a variable for one command:

| macOS (zsh, bash) | Windows (PowerShell) |
| --- | --- |
| `FV_SKIP=1 git push` | `$env:FV_SKIP = '1'; git push; Remove-Item Env:FV_SKIP` |
| `export PIPELINE_DISABLE=1` (rest of the session) | `$env:PIPELINE_DISABLE = '1'` (rest of the session) |

Per-stage limits, timeouts and models: the defaults are in the factory's `scripts/<stage>/config.json`, and a repository overrides them in `.factory/config.json` ([configuration.md](../configuration.md)). See the stage pages and the [agent catalog](agents.md).

## Review gate for bug-fix PRs

The [review gate](review-gate.md) needs nothing extra to assess PRs and request reviews (the pipeline machine's `gh` login with the `project` scope; run `board setup` once to create its board fields). Repository settings it relies on are the owner's call, and the gate never changes them:

| Setting | Where | Why |
| --- | --- | --- |
| `review-quorum` as a required status check on `main` | Settings → Rules → Rulesets → `main` → Require status checks to pass | enforces each PR's `approvals:N`; until then it is a visible check only |
| Allow auto-merge | Settings → General → Pull Requests (or `gh api -X PATCH repos/<owner>/<repo> -F allow_auto_merge=true`) | GitHub merges a PR the review gate cleared the moment its checks pass; without it the gate merges one `board sync` later. `factory doctor` and `factory review-gate enforce` check it |
| A GitHub App with a ruleset bypass, its token in `REVIEW_GATE_APP_TOKEN`, and `implement.autoMerge.identity: "app"` (or the [PR bot](#the-pipelines-pr-bot) on the bypass list and `identity: "bot"`) | the App's settings; the ruleset's bypass list | only once `main` requires approvals from people: a Low PR that needs none can then merge only through a bypass |

Auto-merge is on by default (`implement.autoMerge.enabled`); set it to `false` in `.factory/config.json` to stop it.

## CI

With the `ci` feature on, `factory render` writes the jobs for `ci.provider` (the host's own CI system by default; GitLab CI, Azure Pipelines, Jenkins, CircleCI and Bitbucket Pipelines get the same jobs: [../providers/](../providers/README.md#pages)). For GitHub Actions it writes `.github/workflows/factory-*.yml` and the `setup-factory` action, which installs the pinned factory on the runner. It clones the factory from the pin's `source` at the tag `v<version>`; when that repository is private, add a `FACTORY_TOKEN` secret (a fine-grained token with Contents: read on the factory repository), which every factory workflow passes to the action. `factory-gate.yml` runs on pull requests without any LLM calls: generated files in step, allowed models, test stack scenarios and drift, the repository's linters on the changed lines (`factory lint`, the same check the pre-commit hook runs), then each stage's gate. Two workflows call agents: `factory-pr-check.yml` (the `ai-pr-check` label) and `factory-retro.yml` (weekly). Both use the `setup-agent-cli` action, so they work with any provider. Pick it with repository variables (**Settings → Secrets and variables → Actions → Variables**) and add its credential as a secret:

| Provider | Variable | Secret |
| --- | --- | --- |
| Claude Code (default) | none, or `PIPELINE_AGENT_CLI` = `claude` | `ANTHROPIC_API_KEY` |
| GitHub Copilot CLI | `PIPELINE_AGENT_CLI` = `copilot` | none: the workflow's `GITHUB_TOKEN` is used (the workflows grant `copilot-requests: write`; your organization must allow Copilot CLI). Or set `COPILOT_GITHUB_TOKEN` to a fine-grained token with the Copilot Requests permission |
| OpenAI Codex | `PIPELINE_AGENT_CLI` = `codex` | `OPENAI_API_KEY` |
| Any other CLI | `PIPELINE_AGENT_CMD` = the command, which reads the prompt on stdin; optionally `PIPELINE_AGENT_INSTALL` = a shell command that installs it | `PIPELINE_AGENT_API_KEY`, available to the command as `$PIPELINE_AGENT_API_KEY` |

On GitLab CI these are CI/CD variables; on Azure Pipelines, pipeline variables (secrets marked secret). When the chosen provider's secret is missing, the workflow logs a notice and skips instead of failing. Per-role PR check models have defaults for `claude` and `copilot`; other providers use their CLI's default model unless you add a `prCheck.models.<cli>` entry.

To run `implement run` from a scheduled job, the runner needs everything above, including a signed-in agent CLI.
