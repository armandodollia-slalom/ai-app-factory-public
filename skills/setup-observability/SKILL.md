---
name: setup-observability
description: "Choose and connect the remote service that stores this repository's agent observability data (decisions, verifier runs, review findings, token usage and cost: the .factory/metrics streams): a shared folder or bucket mount, object storage (S3, GCS, Azure Blob), a database (Postgres, BigQuery), an HTTP collector, or an OpenTelemetry backend (Datadog, Honeycomb, Grafana). USE FOR: \"where should agent metrics go\", \"send the factory's logs to <service>\", \"set up observability for the agents\", \"store agent metrics outside the repo\", or a `factory sink status` that says no sink is configured."
---

# Connect the agents' observability data to a store

Every stage appends its records to JSONL files under `.factory/metrics/`. Those files stay the local spool:
a stage never waits on, or fails because of, a remote service. This skill configures the **sink** that ships
them and, when the service can be read, brings them back for the retro.

```bash
factory sink status     # what is configured, what is waiting
factory sink test       # one test record out (and back, when the service can be read)
factory sink push       # ship what is new (also runs in the background after each agent turn)
```

## 1. Let the person choose, with the one trade-off that matters

Ask which service they want. Before they answer, tell them this:

| Service | Type | Retro can read it back |
| --- | --- | --- |
| Shared folder, NFS, mounted bucket | `directory` | yes |
| S3, GCS, Azure Blob through their CLI | `command` | yes, with a pull command |
| Postgres, BigQuery, ClickHouse through their CLI | `command` | yes, with a pull command |
| A collector you run that takes and returns NDJSON | `http` | yes |
| Datadog, Honeycomb, Grafana, any OTLP endpoint | `otlp` | **no** |

An OTLP backend is good for dashboards and alerts, but the factory cannot query it, so the retro would see
only the records of the machine it runs on. If they want retros that cover CI and every developer, they
need a store from the first four rows. One sink is configured at a time; when they want dashboards **and**
retros, use a readable store here and point the backend's own collector at it.

Also ask whether the store is shared with other repositories. If yes, `"scope": "all"` lets the retro read
every project's records (each record carries `_project`); if the store is shared across organizations or
clients, leave it off.

## 2. Write `metrics.sink` in `.factory/config.json`

Secrets never go in the file. Write `${ENV_VAR}`; it is read from the environment when used. Tell the
person which variables to set, locally and as CI secrets.

```jsonc
// a shared folder or a mounted bucket
"metrics": { "sink": { "type": "directory", "path": "~/shared/factory-metrics" } }

// S3 through the aws CLI: push appends one object per batch, pull concatenates the stream's objects
"metrics": { "sink": { "type": "command",
  "push": "aws s3 cp - \"s3://${FACTORY_METRICS_BUCKET}/$FACTORY_PROJECT/$FACTORY_STREAM/$FACTORY_HOST-$(date +%s%N).jsonl\"",
  "pull": "aws s3 cp --recursive \"s3://${FACTORY_METRICS_BUCKET}/$FACTORY_PROJECT/$FACTORY_STREAM/\" /tmp/factory-pull-$$ >/dev/null && cat /tmp/factory-pull-$$/*.jsonl; rm -rf /tmp/factory-pull-$$" } }

// Postgres: one table, the record as jsonb
"metrics": { "sink": { "type": "command",
  "push": "psql \"${FACTORY_METRICS_DSN}\" -qc \"\\copy factory_metrics(record) from stdin\"",
  "pull": "psql \"${FACTORY_METRICS_DSN}\" -Atqc \"select record from factory_metrics where record->>'_stream' = '$FACTORY_STREAM' and record->>'_project' = '$FACTORY_PROJECT' and record->>'ts' > '$FACTORY_SINCE'\"" } }

// an HTTP collector: POST <url>/<stream> takes NDJSON, GET <url>/<stream>?since=&project= returns it
"metrics": { "sink": { "type": "http", "url": "https://metrics.example.com/factory", "headers": { "authorization": "Bearer ${FACTORY_METRICS_TOKEN}" } } }

// OpenTelemetry logs (export only)
"metrics": { "sink": { "type": "otlp", "endpoint": "https://otlp.example.com", "headers": { "x-api-key": "${OTLP_API_KEY}" } } }
```

A command sink gets NDJSON on stdin (push) or prints NDJSON (pull), with `FACTORY_STREAM`,
`FACTORY_PROJECT`, `FACTORY_HOST` and `FACTORY_SINCE` in its environment. Adapt the examples to the CLI
the person already uses; create the bucket or table with them, not for them, when it needs permissions you
do not have. For Postgres the table is `create table factory_metrics (record jsonb not null)`; the `\copy`
line needs each record as one JSON line, which is what it receives.

Every record is shipped with `_id` (a hash of the original line), `_project`, `_stream` and `_host`. The
same record shipped twice has the same `_id`; readers drop duplicates, so a store need not.

## 3. Prove it

```bash
factory sink test      # must end with "Read it back" for a store the retro will use
factory sink push
factory sink status    # nothing waiting
```

If `test` cannot read the record back, fix the pull side before going on. Do not report the sink as working
on the strength of a push alone.

## 4. Metrics stay in git for now

`.factory/metrics/` is committed, with a union merge, so records travel with their branch and the review
gate can read them in any checkout. The sink adds a copy outside the repository; it does not replace the
committed files. Do not add `.factory/metrics/` to `.gitignore`: the implement run commits it, and
`factory experiment` compares its arms by reading each branch's committed metrics. If the person asks to
stop committing metrics, tell them it is not supported yet.

## 5. Privacy, before the first push

Decision records contain story text and file locations, clipped to 1,000 characters. Tell the person what
leaves the machine, and confirm the store's access matches who may read the repository. Do not point a
sink at a service shared beyond the repository's audience without their explicit yes.
