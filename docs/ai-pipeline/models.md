# Model allowlist

The pipeline only calls the models its policy allows. The policy is `agent.allowedModels` and `agent.modelIds`: the engine's defaults are in `scripts/pipeline/config.json` of the factory install, and a repository overrides them in the `agent` section of its `.factory/config.json`. Every agent run checks its model through one function, `resolveModel` in `scripts/pipeline/lib/agents.mjs`, against the merged config before its CLI starts. `factory models` shows the engine's default policy per agent CLI and what the CLIs on your machine can serve, resolves model names and checks every model the engine's own configs name. It resolves through the same function, but it reads only the engine's defaults, not a repository's `.factory/config.json`: see [Changing the list](#changing-the-list).

Default policy: **Claude Opus 5.5 and Claude Sonnet 5.5 on every CLI, plus Sol 6.1 on Copilot**, Sonnet 5.5 by default.

```json
"agent": {
  "allowedModels": ["opus", "sonnet", "sol"],
  "modelIds": {
    "claude": { "opus": "claude-opus-5-5", "sonnet": "claude-sonnet-5-5" },
    "copilot": { "opus": "claude-opus-5.5", "sonnet": "claude-sonnet-5.5", "sol": "gpt-6.1-sol" }
  },
  "strictModels": true,
  "models": { "default": "sonnet" }
}
```

| Agent CLI | Allowed ids | Default |
| --- | --- | --- |
| `claude` (Claude Code) | `claude-opus-5-5`, `claude-sonnet-5-5` | `claude-sonnet-5-5` |
| `copilot` (GitHub Copilot CLI) | `claude-opus-5.5`, `claude-sonnet-5.5`, `gpt-6.1-sol` | `claude-sonnet-5.5` |
| `codex` (OpenAI Codex CLI) | `gpt-6.1-sol` | none (`sonnet` has no Codex id: a Codex run must ask for `sol`) |

- **Aliases.** Configs and stages name models by alias (`opus`, `sonnet`, `sol`); `sol` (Sol 6.1) has ids for Copilot and Codex, so a Claude Code run asked for `sol` is refused under `strictModels`; `modelIds` maps each alias to each CLI's own id. Claude Code spells versions with dashes, Copilot CLI with dots. The ids pin the version: Claude Code's own `opus` alias would follow the newest Opus, so the policy names `claude-opus-5-5`.
- **Strict.** With `strictModels`, a run with no model gets `agent.models.default`, and an alias with no id for the run's CLI is refused instead of falling back to the CLI's default model, so nothing outside the list ever runs. Without it (what the unit tests of other stages use), no model means the CLI's default model, and so does a missing id (logged).
- **Codex serves Sol only.** Codex only serves OpenAI models, so `modelIds.codex` maps `sol` to `gpt-6.1-sol` and nothing else: a Codex run on `sol` (a council member, an implement role with `"cli": "codex"` and `"model": "sol"`) starts, and any other alias on Codex (the `sonnet` default included) is refused before the CLI starts. A second Codex login is selected per member or role with `env.CODEX_HOME` ([council.md](council.md)).
- `PIPELINE_MODEL_OVERRIDE=<alias>` forces one allowed alias for every agent, for experiments; it is checked like any other choice.

## Commands

```bash
factory models list [--provider claude] [--json] [--refresh]   # policy, discovery and availability per CLI
factory models discover --refresh                       # re-run discovery, ignoring the 24h cache
factory models check [--json]                           # exit 1 if a model in the engine's configs is not allowed
factory models resolve --provider claude --model opus   # -> claude-opus-5-5
factory models resolve --provider copilot               # -> claude-sonnet-5.5 (the default)
```

`resolve` accepts an allowed alias, a CLI id an allowed alias maps to for that CLI, or nothing/`default` for the default. Anything else (another CLI's spelling, a family the policy does not allow, Copilot's `auto`, which lets Copilot pick any model) fails with the allowed list.

## Changing the list

- **For one repository:** set `agent.allowedModels`, `agent.modelIds` and `agent.models` in its `.factory/config.json`, in a pull request. Objects merge key by key and lists are replaced, so give `allowedModels` whole and only the `modelIds` entries you add or change. Every run of that repository then resolves against the merged policy, and loading the config fails when an `agent.models.<role>` alias is not in `allowedModels`. `factory models list`, `resolve` and `check` do not read the repository's file, so they keep showing the engine's defaults; `factory models discover` is still the way to see which ids the installed CLIs offer.
- **For the engine's defaults:** edit `scripts/pipeline/config.json` in the factory, then run `factory models check` there (`npm test` covers the model library) so model settings in the other engine configs still pass, and `factory models list` to confirm the installed CLIs offer the new ids.

Use ids that `discover` prints; never guess one. An id mapped for an alias that is not in `allowedModels` is ignored with a warning.

There is no machine-local override: the allowlist is project policy (cost, data handling and reproducibility of agent output are agreed for the team). `scripts/models/config.json` only holds discovery settings (`cacheTtlHours`).

## Discovery per CLI

Discovery tells you what the CLIs installed here can serve. It is cached per CLI in `models-cache.json` under the git common dir of the factory install (the system temp folder when the install is not a git checkout) for `cacheTtlHours` (24); `--refresh` bypasses it. A CLI that is not installed is never cached, so installing one shows up immediately. `MODELS_CACHE_FILE` overrides the cache path.

| CLI | Mechanism | `source` | Limits |
| --- | --- | --- | --- |
| Claude Code | No list command (`claude --help` only documents `--model <alias or full name>`). With `ANTHROPIC_API_KEY` set (and no Bedrock/Vertex), `GET /v1/models` on `ANTHROPIC_BASE_URL` or api.anthropic.com. Otherwise a static list of ids known to Claude Code 2.1.318. | `api` or `static` | A claude.ai subscription login cannot call the models API, so most developers get `static`: not verified against their account. Bedrock and Vertex use other ids. |
| Copilot CLI | `copilot help config` lists the ids the `model` setting accepts. | `cli` | That is the list this CLI version knows, not your entitlement: organisation or enterprise policy can still refuse a model. Only the interactive `/model` picker shows the per-account list. |
| Codex CLI | `codex debug models` (refreshes the catalog for the signed-in account), falling back to `codex debug models --bundled` (catalog shipped with the binary). | `cli` or `bundled` | Hidden entries (`visibility: hide`) are marked `hidden`. The fallback is not verified against your account. |

`available` = allowed ∩ discovered. When discovery cannot be trusted (CLI missing, discovery failed, or a `static`/`bundled` list) `list` shows the allowed list marked `*` and a warning, rather than an empty list. An allowed model the installed CLI does not offer is listed in a warning (usually: update the CLI).

## Enforcement

- **Every run.** `runAgent` and `runAgentAsync` resolve the model through `resolveModel(config, alias, cli)` before building the CLI command and pass the CLI's id with `--model`/`-m`. A model outside the policy, or a CLI without allowed ids (Codex), fails the run with that error. A custom `PIPELINE_AGENT_CMD` gets the alias unchecked against a CLI: it is a command you wrote, and the pipeline cannot see which model it calls.
- **Config load.** `loadConfig` rejects an `agent.models.<role>` alias outside `allowedModels`, for the engine's defaults and the repository's `.factory/config.json` alike.
- **Implement model classes.** `modelClasses` (defaults in the engine's `scripts/implement/config.json`) map small/medium/large to aliases (`sonnet`, `sonnet`, `opus`). The implement harness checks every class a plan needs for the role's CLI when the plan is accepted, so a disallowed model fails the plan, not a pair halfway through.
- **PR check.** `prCheck.models.<cli>.<role>` (defaults in the engine's `scripts/pr-check/config.json`) are checked the same way (a CLI's own ids are accepted when an allowed alias maps to them).
- **Library.** `scripts/models/lib/models.mjs` exports `loadPolicy()` (the per-CLI view of the engine's pipeline config), `allowedModels(cli)`, `resolveModel(cli, requested)` (throws `ModelNotAllowedError` with `.allowed`, `ProviderDisabledError` for a CLI with no allowed ids), `assertProviderUsable(cli)`, and the async `discoverModels(cli, {refresh})` and `availableModels(cli)`.
- **Check.** `factory models check` scans, in the factory install, `agent.models`, `modelClasses`, `implement.roles` and `prCheck.models` in `scripts/*/config.json` (and a `config.local.json` beside one, which the pipeline itself no longer reads), the `model:` front matter of `agents/*.agent.md` (must be allowed for both Claude Code and Copilot), of `.claude/agents/*.md` when the install has that folder, and `scripts/agents-claude.json`. `inherit` is always fine. It does not scan a repository's `.factory/config.json` or its generated `.claude/agents/`.
- **Interactive sessions.** The allowlist binds the pipeline. Claude Code has an `availableModels` setting that restricts the `/model` picker and `--model`, but in a test with version 2.1.318 it had no effect from the project `.claude/settings.json` (`claude -p --model claude-haiku-5-5` still ran Haiku); it did apply through `--settings` (and is documented for managed and user settings), where a disallowed `--model` silently switches to an allowed default instead of failing. So it is not a substitute for the pipeline check. Copilot CLI and Codex have no model allowlist setting; their repository config (`.github/copilot/settings.json`, `.codex/config.toml`) can only set a default `model`. Organisation-wide restrictions belong in Claude Code managed settings and in the GitHub Copilot model policy.
