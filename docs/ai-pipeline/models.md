# Model pool

**Who reads this:** B and C, when choosing models or a CLI. The pipeline only runs the models listed once in its pool, `models.pool`: every agent, every council member and every subtask's pair implementer runs on one of its entries. The engine's defaults are in `scripts/models/config.json` of the factory install, and a repository replaces the pool in the `models` section of its `.factory/config.json`. Every agent run resolves its entry through one function, `entryFor` in `scripts/pipeline/lib/pool.mjs`, before its CLI starts. `factory models` shows the pool per agent CLI and what the CLIs on your machine can serve, resolves entry names and checks that every agent names an entry; it reads the engine's defaults, not a repository's `.factory/config.json` (see [Changing the pool](#changing-the-pool)).

Default pool: **Claude Opus 5.5 and Claude Sonnet 5.5 on Claude Code, Sol 6.1 on Codex**, Sonnet 5.5 for every agent with no entry of its own.

```json
"models": {
  "pool": [
    { "name": "opus",   "cli": "claude", "model": "claude-opus-5-5",   "effort": "high" },
    { "name": "sonnet", "cli": "claude", "model": "claude-sonnet-5-5", "effort": "medium" },
    { "name": "sol",    "cli": "codex",  "model": "gpt-6.1-sol",       "effort": "high" }
  ],
  "agents": { "default": "sonnet", "pr-check-judge": "opus" }
},
"orchestrator": { "model": "opus" }
```

| Entry key | Meaning |
| --- | --- |
| `name` | unique short name (letters, digits, `.`, `-`, `_`); every setting that names a model names an entry by it |
| `cli` | `claude`, `codex`, `copilot` or `custom` |
| `model` | the CLI's own model id: Claude Code spells versions with dashes (`claude-opus-5-5`), Copilot CLI with dots (`claude-opus-5.5`), Codex serves OpenAI models (`gpt-6.1-sol`). Optional for `custom` |
| `effort` | `low`, `medium`, `high`, `xhigh` or `max`: Claude Code's `--effort`, Codex's `model_reasoning_effort` (`max` becomes `xhigh`). Copilot's CLI documents no effort option, so a Copilot entry runs at its model's default; a custom command gets `PIPELINE_AGENT_EFFORT` |
| `env` | optional variables for the entry's CLI process, such as a second login's home folder (`{ "CODEX_HOME": "~/.codex-personal" }`); `~` and `${NAME}` are expanded when the agent starts. Never secrets: a variable whose name looks like a token, key or password must be a `${NAME}` reference, a value that looks like a credential is refused, and `PIPELINE_*`, `FACTORY_*` and `NODE_OPTIONS` cannot be set |
| `cmd` | `custom` only: the command, which reads the prompt on stdin (like `PIPELINE_AGENT_CMD`; it gets `PIPELINE_AGENT_MODEL` too) |
| `timeoutSec` | optional; an entry's normal run time as a council member, else the stage's verifier time limit |

- **Family.** An entry's family is derived from its model id, never set by hand: `claude-*` (and `opus`, `sonnet`, `haiku`, `fable`) is Anthropic, `gpt-*` and `o<n>` OpenAI, `gemini-*` Google. A model in no known family, and a custom command, is a family of its own, named after its entry. Councils seat one entry per family first ([council.md](council.md)); a pool with one family loads, with a warning that councils cannot be diverse.
- **Which entry an agent runs on.** Every stage's orchestrator runs on `orchestrator.model` (or the stage's `<section>.orchestrator.model`; [orchestrators](orchestrators.md)); for every other agent `models.agents.<agent>` names it, by agent name as in `agents/` (`pr-check-judge`, `test-automation`); `models.agents.default` is the entry of every agent with none of its own ([agents.md](agents.md#models)). The planner names one entry per subtask for its pair implementer, from `implement.subtaskModels` (every entry when `null`); a plan naming another entry is refused.
- `PIPELINE_MODEL_OVERRIDE=<entry>` runs every agent on one pool entry, for experiments; it is checked like any other name.
- **`PIPELINE_AGENT_CMD`** (the test fake agent) replaces every entry's CLI and gets the entry's model id and effort as `PIPELINE_AGENT_MODEL` and `PIPELINE_AGENT_EFFORT`.

## Commands

```bash
factory models list [--provider claude] [--json] [--refresh]   # the pool per CLI, discovery and availability
factory models discover --refresh                       # re-run discovery, ignoring the 24h cache
factory models check [--json]                           # exit 1 if an agent names no pool entry, or the pool breaks a rule
factory models resolve --provider claude --model opus   # -> claude-opus-5-5
factory models resolve --provider claude                # -> claude-sonnet-5-5 (the default entry's model)
```

`resolve` accepts an entry's name or one of that CLI's entry ids exactly, or nothing/`default` for the default entry's model on that CLI. Anything else (another CLI's spelling, an id no entry has, Copilot's `auto`, which lets Copilot pick any model) fails with the CLI's entries.

## Changing the pool

- **For one repository:** set `models.pool` and, when an agent should run on another entry, `models.agents` in its `.factory/config.json`, in a pull request. Lists are replaced, so give `pool` whole; `agents` merges key by key, so name only the agents you change. Every name must be an entry of the pool: loading fails otherwise and lists the entries (an agent whose default entry is not in your pool must be named too). `factory init` writes the pool from the CLIs and models you answer with. `factory models list`, `resolve` and `check` read the engine's defaults; `factory council check` and `factory doctor` read the repository's settings and list its pool with each entry's family and login check.
- **For the engine's defaults:** edit `scripts/models/config.json` in the factory, then run `factory models check` there (`npm test` covers the model library) and `factory models list` to confirm the installed CLIs offer the new ids.

Use ids that `discover` prints; never guess one.

There is no machine-local override: the pool is project policy (cost, data handling and reproducibility of agent output are agreed for the team). Discovery settings (`models.cacheTtlSec`) are in the same section.

## Discovery per CLI

Discovery tells you what the CLIs installed here can serve. It is cached per CLI in `models-cache.json` under the git common dir of the factory install (the system temp folder when the install is not a git checkout) for `models.cacheTtlSec` (24); `--refresh` bypasses it. A CLI that is not installed is never cached, so installing one shows up immediately. `MODELS_CACHE_FILE` overrides the cache path.

| CLI | Mechanism | `source` | Limits |
| --- | --- | --- | --- |
| Claude Code | No list command (`claude --help` only documents `--model <alias or full name>`). With `ANTHROPIC_API_KEY` set (and no Bedrock/Vertex), `GET /v1/models` on `ANTHROPIC_BASE_URL` or api.anthropic.com. Otherwise a static list of ids known to Claude Code 2.1.318. | `api` or `static` | A claude.ai subscription login cannot call the models API, so most developers get `static`: not verified against their account. Bedrock and Vertex use other ids. |
| Copilot CLI | `copilot help config` lists the ids the `model` setting accepts. | `cli` | That is the list this CLI version knows, not your entitlement: organisation or enterprise policy can still refuse a model. Only the interactive `/model` picker shows the per-account list. |
| Codex CLI | `codex debug models` (refreshes the catalog for the signed-in account), falling back to `codex debug models --bundled` (catalog shipped with the binary). | `cli` or `bundled` | Hidden entries (`visibility: hide`) are marked `hidden`. The fallback is not verified against your account. |

`available` = the pool's ids for that CLI ∩ discovered. When discovery cannot be trusted (CLI missing, discovery failed, or a `static`/`bundled` list) `list` shows the pool's ids marked `*` and a warning, rather than an empty list. A pool id the installed CLI does not offer is listed in a warning (usually: update the CLI).

## Enforcement

- **Every run.** `runAgent` and `runAgentAsync` resolve the run's pool entry through `entryFor` (a council seat's or a subtask's entry, else the agent's own) before building the CLI command, and pass the entry's model id with `--model`/`-m`. A name that is not in the pool fails the run before the CLI starts. Each usage row names the entry and its family (`token-usage.jsonl`, [costs](costs.md)).
- **Config load.** `loadConfig` rejects a pool that breaks a rule (a duplicate name, an unknown CLI or effort, a custom entry without its command, an entry without a model id, a secret in `env`) and any setting that names an entry not in the pool (`models.agents.<agent>`, `implement.subtaskModels`), for the engine's defaults and the repository's `.factory/config.json` alike; it logs a warning for a one-family pool.
- **Plans.** The implement harness checks every entry a plan needs when the plan is accepted, so a missing entry fails the plan, not a pair halfway through.
- **Library.** `scripts/models/lib/models.mjs` exports `loadPolicy()` (the per-CLI view of the pool), `allowedModels(cli)`, `resolveModel(cli, requested)` (throws `ModelNotAllowedError` with `.allowed`, `ProviderDisabledError` for a CLI with no entry), `assertProviderUsable(cli)`, and the async `discoverModels(cli, {refresh})` and `availableModels(cli)`.
- **Check.** `factory models check` checks, in the factory install, the pool and every `models.agents` entry in `scripts/models/config.json`, the `model:` front matter of `agents/*.agent.md` (must be in the pool for both Claude Code and Copilot), of `.claude/agents/*.md` when the install has that folder, and `scripts/agents-claude.json`. `inherit` is always fine. It does not scan a repository's `.factory/config.json` or its generated `.claude/agents/`.
- **Interactive sessions.** The pool binds the pipeline. Claude Code has an `availableModels` setting that restricts the `/model` picker and `--model`, but in a test with version 2.1.318 it had no effect from the project `.claude/settings.json` (`claude -p --model claude-haiku-5-5` still ran Haiku); it did apply through `--settings` (and is documented for managed and user settings), where a disallowed `--model` silently switches to an allowed default instead of failing. So it is not a substitute for the pipeline check. Copilot CLI and Codex have no model allowlist setting; their repository config (`.github/copilot/settings.json`, `.codex/config.toml`) can only set a default `model`. Organisation-wide restrictions belong in Claude Code managed settings and in the GitHub Copilot model policy.
