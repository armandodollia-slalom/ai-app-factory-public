# Token usage and cost

Every agent run the pipeline starts (implement, including the orchestrator and each verifier pair, review, feature verification plan and automation with their verifiers, PR check, the review gate's triage, the retro) records the tokens it used, which models it used, whether it hit the prompt cache, and what it cost at the API list price on the day it ran. The records are kept long term and roll up per ticket (itemized by stage, with a ticket total) and per epic (itemized by ticket and stage, with an epic total).

## Reports

```bash
factory costs                      # overview: by epic, ticket, stage, model and month
factory costs SHOP-12              # one ticket, itemized by stage, with the total
factory costs --epic checkout      # one epic: per ticket, per stage, and each ticket by stage
factory costs --since 2026-07-01   # any view, limited to runs on or after a date
factory costs SHOP-12 --markdown   # Markdown tables, for a PR body or a report
factory costs --worktrees          # include every git worktree: live spend of a running implement run
factory costs --epic checkout --json
```

Each row shows the runs, input tokens (uncached), output tokens, cache reads, cache writes, the cache hit rate (cached prompt tokens over all prompt tokens, and how many runs read from the cache), the models used, and the cost. `--epic` takes the epic's key (`epic-<key>` on the board, with or without the prefix) or part of its key or title; epics come from the ticket cache (`factory board fetch --all`).

The notes under a report list the runs that reported no usage (timed out, crashed, or a custom agent command that wrote none), the tokens on models that have no price, and a reconciliation against the cost the agent CLI itself reported for the same runs (Claude Code reports one).

## Where the data lives

`.factory/metrics/token-usage.jsonl` in the app repository, committed with the story's other metrics. `merge=union` keeps every record across branches, and a configured [metrics sink](../observability.md) ships the records to a remote store as well. There is one row per model per agent run:

| Field | Meaning |
| --- | --- |
| `ts`, `run_id` | when the run finished; one id per agent run (a run can have several rows, one per model) |
| `story`, `epic` | the ticket and its epic at the time (reports fill a missing epic from the ticket cache) |
| `stage`, `round`, `step` | pipeline stage (`implement` for the orchestrator or single implementer, `implement-epic-plan` for the epic plan of [epic delivery](implement.md#epic-delivery), `implement-pair`, `implement-verify` and `implement-ui-verify` for the verifier pairs, `review`, `plan`, `plan-verify`, `automation`, `automation-verify`, `pr-check`, `lessons` for the [retro](retro.md), `bug-triage` for the [review gate](review-gate.md)'s triage agent), the round within it, and the step: `plan`, `merge <subtask>` or the subtask id for the orchestrator and pairs, the critic or fixer for the PR check |
| `agent`, `agent_ver`, `mode`, `cli`, `requested_model` | the agent definition and its prompt version, its access mode (`read`, `write`, `implement` or `verify`), the CLI (`custom` for `PIPELINE_AGENT_CMD`) and the model alias asked for |
| `model`, `measured` | the model that served the tokens; `measured: false` (and null tokens) when the run reported no usage |
| `tokens` | `input` (uncached), `output`, `cache_read`, `cache_write_5m`, `cache_write_1h` |
| `requests`, `cache_hit`, `cache_hit_rate` | model requests (Copilot and Codex), whether the run read from the cache, and the share of prompt tokens served from it |
| `cost_usd`, `pricing` | the cost, and the rates used (model, the price entry's effective date, standard or long-context tier) so the figure never changes when prices do |
| `cli_cost_usd`, `premium_requests`, `nano_aiu` | what the CLI reported: Claude Code's cost, Copilot's premium requests and AI units |
| `seconds`, `ok`, `timed_out` | how long the run took, whether it succeeded, whether it was killed on its timeout |
| `delivery` | how the run delivered its stories: `epic` (one epic branch and PR) or `story` (a branch and PR per story); set by `implement run` |
| `experiment_id`, `experiment_arm` | only inside a [delivery experiment](experiments.md): the experiment and its arm (`<mode>-<n>`) |

## How usage is captured

All runs go through `runAgent` and `runAgentAsync` in `scripts/pipeline/lib/agents.mjs`, and `scripts/pipeline/lib/usage.mjs` parses and prices what each CLI reports:

- **Claude Code:** `-p --output-format json`. The answer is taken from `.result` and the usage from `.modelUsage`, which splits 5-minute and 1-hour cache writes.
- **Copilot CLI:** `--usage-output-file`. The token details give input, cache reads, cache writes and output. Copilot does not split cache writes by lifetime, so they are priced as 5-minute writes.
- **Codex:** `exec --json`. Usage comes from the `turn.completed` events, where `input_tokens` includes the cached tokens.
- **A custom command (`PIPELINE_AGENT_CMD`):** it can write its usage to the file named in `PIPELINE_USAGE_FILE`, in Claude's or Copilot's format or as `{ "models": [{ "model", "input", "output", "cacheRead", "cacheWrite5m", "cacheWrite1h" }] }`.

Recording usage never fails a run. A model with no price is recorded with `cost_usd: null`, and a warning names it.

Every run's result also carries a summary of what it recorded (`usage`: tokens, `costUsd`, `premiumRequests`, `nanoAiu`; `summarizeUsage` in `usage.mjs`). The implement harness adds these up per subtask and per story, so `subtask-runs.jsonl` and `decision-outcomes.jsonl` carry `tokens`, `cost` and `premiumRequests` next to the decisions they paid for, and `implement-runs.jsonl` carries the story total (`tokens`, `cost_usd`, `premium_requests`).

The same `delivery`, `experiment_id` and `experiment_arm` fields are on every record of `decisions.jsonl`, `implement-runs.jsonl`, `subtask-runs.jsonl` and `decision-outcomes.jsonl`, so an experiment's report can attribute every token, decision and outcome to its arm. Records outside an experiment carry only `delivery` (and older records neither).

## Copilot billing

Copilot plans bill **premium requests** (a per-model multiplier per request), and Copilot meters usage in AI credits (`totalNanoAiu` in its usage file; 1e11 nano AIU is $1). Both are recorded on every Copilot run (`premium_requests`, `nano_aiu`). The cost reports add a note with the premium requests, and the AI-credit dollars next to the cost computed from `pricing.json` for the same runs, so you can see whether the list-price cost matches what Copilot metered.

## Prices

The prices are in `scripts/pipeline/pricing.json` in the factory install (they are the engine's; a repository cannot override them), in USD per million tokens. Each model has a list of entries, and each run is priced with the last entry whose `effective` date is on or before the day it ran (`null` means since launch). When a price changes, **append** a new entry with its `effective` date and never edit past ones, so older runs keep the price they were charged at. Model ids are normalized, so `claude-haiku-5-5` and `claude-haiku-4-5-20251001` match `claude-haiku-5.5` and `claude-haiku-4.5`. A model with a `longContext` tier is charged that tier when the average prompt per request is above `aboveInputTokens`. Claude Code doesn't report request counts, so a Claude run is treated as one request, which overestimates the tier on long multi-turn runs.

## Not covered

- Interactive sessions where a developer implements a story in their own Claude Code or Copilot session are not recorded; only the runs the pipeline starts are. A follow-up could read the session transcript from the Stop hook.
- The default model policy refuses Codex (it has no allowed model ids), so its usage parser runs only once a repository adds ids for it ([models](models.md)).
- A run killed on timeout usually has no usage to read, so it shows as unmeasured.
