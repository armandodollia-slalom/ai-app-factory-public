# CircleCI (CI system)

`ci.provider: "circleci"`. CircleCI builds GitHub, GitLab and Bitbucket Cloud repositories. The adapter is `scripts/pipeline/lib/ci/circleci.mjs`. The head's pipeline is the CircleCI pipeline whose `vcs.revision` is the head. The expected pipelines are its workflows, as `.circleci/config.yml` at that head declares them.

```json
"ci": { "provider": "circleci", "project": "gh/acme/shop", "token": "${CIRCLECI_TOKEN}" }
```

`ci.project` is the project slug: `gh/org/repo`, `bb/workspace/repo`, or `circleci/<org id>/<project id>` for GitLab and GitHub App projects. `ci.url` names a CircleCI server installation (`https://<server>/api`).

**Generated files:** `.circleci/config.yml` with the factory's jobs, its `factory` workflow and the analysis jobs. A repository that already has its own config gets `.circleci/factory.yml` instead: that file is never overwritten, and `factory check` says which jobs and workflows to merge in. Secrets come from the `factory` context. Keep "Pass secrets to builds from forked pull requests" off. The scheduled jobs are scheduled pipelines with the parameter `factory-job`.

**Token:** a personal API token (`Circle-Token` header) of a user with access to the project.

**Logs:** partial. API v2 has no job log endpoint, so a failed job's output is read through API v1.1. That path has not been checked live.

**Review events:** no. `board sync` posts the `review-quorum` status.

## Capabilities

<!-- generated:capabilities-circleci -->
| Capability | This adapter | Without it, the harness |
| --- | --- | --- |
| `logs` | partial | a red run becomes a finding with its link only; retry-only passes cannot be detected, so a green run is not called flaky-free in the PR body |
| `expectedFromDefinition` | yes | nothing to change |
| `runsByCommit` | yes | nothing to change |
| `reviewEvents` | no | review-quorum is posted as a commit status by `board sync` (needs the host's commitStatus) |
| `schedules` | partial | the schedules are created by hand in the CI system; docs list them |
| `rerun` | yes | nothing to change |
| `branchPipelines` | yes | nothing to change |
<!-- /generated:capabilities-circleci -->

**Verified:** against fakes only. API docs, read 2026-11-17: <https://circleci.com/docs/api/v2/>, <https://circleci.com/docs/configuration-reference/>.
