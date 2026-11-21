# Jenkins (CI system)

`ci.provider: "jenkins"`. Jenkins builds any git host. The adapter is `scripts/pipeline/lib/ci/jenkins.mjs`. A Multibranch Pipeline job builds the repository's branches and pull requests: `PR-<n>` from the GitHub and Bitbucket branch sources, `MR-<n>` from GitLab's. The head's run is the build of the PR's job whose revision is the head: `SCMRevisionAction.pullHash`, else the git plugin's `lastBuiltRevision`.

```json
"ci": { "provider": "jenkins", "url": "https://jenkins.acme.io", "job": "team/shop", "user": "${JENKINS_USER}", "token": "${JENKINS_API_TOKEN}" }
```

**Generated files:**

- `ci/jenkins/Jenkinsfile.factory`: declarative, for the Multibranch job. Its stages are gate, lint, feature verification, review-quorum, the analysis jobs and the PR check. Demo videos are made on the machine that runs the pipeline, not in CI.
- `ci/jenkins/Jenkinsfile.factory-scheduled`: a Pipeline job on the default branch for the tracker sweep, the weekly retro and the cache prune.
- `.factory/ci/factory-ci.sh`: the script every stage calls.

The secrets are secret-text credentials whose IDs are the variable names in lower case with dashes (`JIRA_API_TOKEN` → `jira-api-token`), bound with `credentials()`.

**Token:** a Jenkins user's API token (Basic auth with `ci.user`) with Overall/Read and Job/Read, plus Job/Build for reruns. No CSRF crumb is needed with token auth.

**Expected pipelines:** the Multibranch job itself (`expectedFromDefinition: partial`). Set `ci.expected` to wait for more jobs.

**Review events:** no. `board sync` posts the `review-quorum` status.

## Capabilities

<!-- generated:capabilities-jenkins -->
| Capability | This adapter | Without it, the harness |
| --- | --- | --- |
| `logs` | yes | nothing to change |
| `expectedFromDefinition` | partial | the expected pipelines come from `ci.expected` in .factory/config.json; without it no head is ever green (the gate fails closed) |
| `runsByCommit` | yes | nothing to change |
| `reviewEvents` | no | review-quorum is posted as a commit status by `board sync` (needs the host's commitStatus) |
| `schedules` | yes | nothing to change |
| `rerun` | yes | nothing to change |
| `branchPipelines` | yes | nothing to change |
<!-- /generated:capabilities-jenkins -->

**Verified:** against fakes only. Docs, read 2026-11-17: <https://www.jenkins.io/doc/book/using/remote-access-api/>, <https://www.jenkins.io/doc/book/pipeline/multibranch/>, <https://www.jenkins.io/doc/book/pipeline/syntax/>.
