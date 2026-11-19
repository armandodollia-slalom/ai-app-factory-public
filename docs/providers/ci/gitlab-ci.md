# GitLab CI (CI system)

`ci.provider: "gitlab-ci"`, the default with a GitLab host. The adapter is `scripts/pipeline/lib/ci/gitlab-ci.mjs`. The expected pipeline of a head is GitLab's own pipeline for it (the merge request pipeline, or the branch pipeline), as "Pipelines must succeed" sees it. Runs, failed jobs' logs and retries come from the REST API v4.

**Generated files:** `.gitlab/ci/factory-*.yml`, included from a managed block in `.gitlab-ci.yml` ([../../hosts-and-trackers.md](../../hosts-and-trackers.md#ci-systems)). Secrets are masked CI/CD variables, which every job sees as environment variables. The agent jobs skip merge requests from forks.

**Token:** `ci.token` (by default the host's) with scope `api`. `read_api` is enough without reruns.

**Review events:** no. GitLab starts no pipeline when someone approves, so `board sync` posts the `review-quorum` status on the head itself.

## Capabilities

<!-- generated:capabilities-gitlab-ci -->
| Capability | This adapter | Without it, the harness |
| --- | --- | --- |
| `logs` | yes | nothing to change |
| `expectedFromDefinition` | yes | nothing to change |
| `runsByCommit` | yes | nothing to change |
| `reviewEvents` | no | review-quorum is posted as a commit status by `board sync` (needs the host's commitStatus) |
| `schedules` | partial | the schedules are created by hand in the CI system; docs list them |
| `rerun` | yes | nothing to change |
| `branchPipelines` | yes | nothing to change |
<!-- /generated:capabilities-gitlab-ci -->

**Verified:** against fakes only. API docs, read 2026-11-17: <https://docs.gitlab.com/api/pipelines/>, <https://docs.gitlab.com/api/jobs/>.
