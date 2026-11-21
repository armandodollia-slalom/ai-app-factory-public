# Bitbucket Pipelines (CI system)

**Who reads this:** B and C using this product. Verified against fakes only unless the [status table](../README.md#verified-live-or-only-against-fakes) says otherwise.

`ci.provider: "bitbucket-pipelines"`, the default with a Bitbucket Cloud host. The adapter is `scripts/pipeline/lib/ci/bitbucket-pipelines.mjs`. The head's run is the pipeline whose target commit is the head, either a pull request pipeline or a branch pipeline. Logs are its steps' logs.

**Generated files:** `bitbucket-pipelines.yml`, with a pull-request pipeline (gate, lint, feature verification, review-quorum, the analysis steps) and custom pipelines for the schedules and the PR check. A repository that already has its own file gets `bitbucket-pipelines.factory.yml`: that file is never overwritten, and `factory check` says what to merge. Secrets are secured repository variables, which are never passed to pull requests from forks. Schedules are added by hand (Repository settings → Pipelines → Schedules). Hourly is the shortest schedule Bitbucket offers, so the tracker sweep runs at most hourly.

**Token:** the host's token with `pipeline:read` (or `ci.token`).

**What it cannot do:**

- No API to re-run a pipeline (`rerun: false`). A person reruns it, and the gate waits.
- The list endpoint's commit filter is unreliable for pull request pipelines, which record a short hash (Atlassian BCLOUD-23160). The adapter lists the latest pipelines and matches the head by hash prefix.

**Review events:** no. `board sync` posts the `review-quorum` status.

## Capabilities

<!-- generated:capabilities-bitbucket-pipelines -->
| Capability | This adapter | Without it, the harness |
| --- | --- | --- |
| `logs` | yes | nothing to change |
| `expectedFromDefinition` | yes | nothing to change |
| `runsByCommit` | yes | nothing to change |
| `reviewEvents` | no | review-quorum is posted as a commit status by `board sync` (needs the host's commitStatus) |
| `schedules` | partial | the schedules are created by hand in the CI system; docs list them |
| `rerun` | no | a person reruns it; the gate waits |
| `branchPipelines` | yes | nothing to change |
<!-- /generated:capabilities-bitbucket-pipelines -->

**Verified:** against fakes only. API docs, read 2026-11-17: <https://developer.atlassian.com/cloud/bitbucket/rest/api-group-pipelines/>.
