# GitHub Actions (CI system)

`ci.provider: "github-actions"`, the default with a GitHub host. The adapter is `scripts/pipeline/lib/ci/github-actions.mjs`. The pipelines a head must run are the workflows that a `pull_request` (or `pull_request_target`) event for that pull request triggers. They are read from the repository's workflow files at that head, after their `types`, `branches` and `paths` filters. Runs and logs come from the Actions API through `gh`.

**Generated files:** `.github/workflows/factory-*.yml` and `.github/actions/setup-factory`, `setup-agent-cli` and `factory-toolchain`. They are the same files v0.2.68 generated, byte for byte (a test compares them), plus `factory-analysis.yml` when `analysis` is on. Secrets are repository or organisation secrets. GitHub withholds them from fork pull requests, and no workflow uses `pull_request_target` or `workflow_run` with secrets.

**Settings:** `ci.expected` (a list instead of the derived one), `ci.ignore`, and `allowNoWorkflows` (default false: a repository with no pull-request workflow is never green).

**Review events:** yes. `review-quorum` is a workflow that runs on reviews.

## Capabilities

<!-- generated:capabilities-github-actions -->
| Capability | This adapter | Without it, the harness |
| --- | --- | --- |
| `logs` | yes | nothing to change |
| `expectedFromDefinition` | yes | nothing to change |
| `runsByCommit` | yes | nothing to change |
| `reviewEvents` | yes | nothing to change |
| `schedules` | yes | nothing to change |
| `rerun` | yes | nothing to change |
| `branchPipelines` | yes | nothing to change |
<!-- /generated:capabilities-github-actions -->

**Verified:** read-only `factory adapter check ci` against the public test repository on 2026-11-17 (4 pass, 1 skipped: rerun), and the v0.2.68 suites.
