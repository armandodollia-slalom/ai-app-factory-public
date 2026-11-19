# Observability: where the agents' data goes

Every stage records what its agents did and why, as JSON lines under `.factory/metrics/` in the app
repository:

| Stream | One record per |
| --- | --- |
| `decisions.jsonl` | agent decision with its reasons (plans, verdicts, review findings, product bugs, triage) |
| `decision-outcomes.jsonl` | what happened to a decision later (escaped findings, human reopens, PR reviews, reverts) |
| `verifier-runs.jsonl`, `verifier-denials.jsonl`, `precheck-failures.jsonl`, `calibration.jsonl` | feature verification rounds, gaps, failed deterministic checks, audits |
| `arch-reviews.jsonl`, `pr-checks.jsonl` | architecture review rounds, PR check runs |
| `implement-runs.jsonl`, `subtask-runs.jsonl` | implement runs and their subtasks |
| `token-usage.jsonl` | every agent run's tokens, models, cache hits and cost |

These files are the **local spool**. A stage appends to them and never waits on a remote service.

## The sink

`metrics.sink` in `.factory/config.json` names the service the records are shipped to. The
`setup-observability` skill chooses and configures it with you.

| Type | Service | Push | Read back |
| --- | --- | --- | --- |
| `none` | nothing leaves the machine (default) | | |
| `directory` | a shared folder or mounted bucket | yes | yes |
| `http` | a collector that takes and returns NDJSON | yes | yes |
| `command` | any CLI: `aws s3`, `gsutil`, `az`, `psql`, `bq` | yes | with a `pull` command |
| `otlp` | OpenTelemetry logs: Datadog, Honeycomb, Grafana | yes | no |

```bash
factory sink status | test | push | pull [--since <iso>]
```

- **Push** ships what each stream gained since the last push (a byte offset per stream in
  `.factory/state/sink/`). It runs in the background after each agent turn (the Stop hook) and at the start
  of a retro. A failed push keeps its place and is retried by the next one.
- **Pull** brings a time window back into `.factory/state/sink/cache/`. The retro does this itself, then
  reads local and pulled records together without duplicates.
- Each shipped record carries `_id` (a hash of the original line), `_project`, `_stream` and `_host`.
- Secrets are written as `${ENV_VAR}` in the config and read from the environment when used.
- `"scope": "all"` on a readable sink lets the retro read every project in the store.

A sink that cannot be read back (OTLP) is for dashboards. The retro then covers only the checkout it runs
in; `factory sink status` and `factory retro status` both say so.

## Metrics and git

`.factory/metrics/*.jsonl` is committed by default, with a union merge (`.gitattributes`), so records
travel with their branch and the review gate reads them in any checkout. `pipeline experiment` compares
its arms by reading each branch's committed metrics, so experiments rely on this default.

## Reports

```bash
factory metrics [--json] [--since <date>]    # every stage's own metrics
factory costs [KEY] [--epic <epic>]          # tokens, cache hits and cost per stage, ticket and epic
```
