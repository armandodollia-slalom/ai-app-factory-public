# Observability: where the agents' data goes

**Who reads this:** B setting up a metrics sink, C reading the records. Every stage records what its agents did and why, as JSON lines under `.factory/metrics/` in the app
repository. Each stream is one file per branch, `<stream>.jsonl.d/<branch>.jsonl`, so two open pipeline
branches never conflict on a metrics file; readers take the stream's own `<stream>.jsonl` (older records),
every branch file and, on the main checkout, the spool together. The main streams:

| Stream | One record per |
| --- | --- |
| `decisions.jsonl` | agent decision with its reasons (plans, verdicts, review findings, product bugs, triage) |
| `decision-outcomes.jsonl` | what happened to a decision later (escaped findings, human reopens, PR reviews, reverts) |
| `verifier-runs.jsonl`, `verifier-denials.jsonl`, `precheck-failures.jsonl`, `calibration.jsonl` | feature verification rounds, gaps, failed deterministic checks, audits |
| `arch-reviews.jsonl`, `pr-checks.jsonl` | architecture review rounds, PR check runs |
| `implement-runs.jsonl`, `subtask-runs.jsonl` | implement runs and their subtasks |
| `pr-check-returns.jsonl` | PR check findings sent back to implementation or to feature verification |
| `council-rounds.jsonl` | council sittings: members, executions, verdicts, adjudications ([council](ai-pipeline/council.md)) |
| `analysis-runs.jsonl`, `analysis-findings.jsonl`, `analysis-gate.jsonl`, `secret-decisions.jsonl`, `history-rewrites.jsonl` | static analysis runs and findings, the pre-push gate, secret decisions and folded commits ([analysis](ai-pipeline/analysis.md)) |
| `run-conditions.jsonl` | what a run met: the delivery's push, open and ready times, holds, host refusals, flaky tests, agents after ready |
| `escalations.jsonl`, `full-project-runs.jsonl`, `retro-observations.jsonl`, `retro-selftests.jsonl` | escalations, whole-project checks, the retro's observations and self-tests |
| `token-usage.jsonl` | every agent run's tokens, models, cache hits and cost ([costs](ai-pipeline/costs.md)) |

These files are the **local spool**. A stage appends to them and never waits on a remote service. Pipeline
branches commit them with their work; the main checkout never writes the tracked files and spools its own
commands' records to `.factory/state/metrics-spool/` instead ([configuration](configuration.md#where-metrics-are-written)).

Other records stay on the machine (`.factory/state/`, ignored by git): each run's record
(`implement/<KEY>.json` with its phase, `<KEY>.result.json` with its outcome, push, open and ready times,
holds and ready audit), its logs (`logs/`), and the escalation notes. The evidence a person reads is on the
ticket (findings, questions, Pending Review evidence, the epic's evidence comment) and in the PR body and the
review gate's notice.

## The sink

`metrics.sink` in `.factory/config.json` names the service the records are shipped to. The
[`setup-observability`](../skills/setup-observability/SKILL.md) skill chooses and configures it with you.

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

## Redaction

Everything the harness writes or publishes, agents' results included, passes the redaction boundary
(`scripts/pipeline/lib/redact.mjs`): metrics, run records, decisions, usage rows, logs, lessons, PR bodies and
comments, ticket text, board evidence and every export to the sink. It replaces what the secret scanner's
rules detect, the values of token environment variables, and any value detected earlier in the run, with
`[redacted:<rule>]`; redaction itself never blocks a write. Values with the factory's placeholder marker are test data and stay. A guard test fails
when a writer or poster goes around the boundary.

Records that leave the machine are checked again by a scan gate: staged records are redacted in place and
scanned before the harness commits, the records a push carries are scanned before the push, and a sink
adapter's write operation is wrapped by `guardAdapter`. A value still detected after redaction blocks the
commit, push or export (`SecretGateError`). `redact-seen.jsonl` (hashes of seen values) is local only and never shipped. Details: [analysis.md, Secrets in records and posts](ai-pipeline/analysis.md#secrets-in-records-and-posts-redaction).

## Metrics and git

`.factory/metrics/` is committed by default, one file per branch and stream, with a union merge
(`.gitattributes`) for the older shared files, so records travel with their branch and the review gate reads
them in any checkout. `factory experiment` compares
its arms by reading each branch's committed metrics, so experiments rely on this default.

## Reports

```bash
factory metrics [--json] [--since <date>]    # every stage's own metrics
factory costs [KEY] [--epic <epic>]          # tokens, cache hits and cost per stage, ticket and epic
```
