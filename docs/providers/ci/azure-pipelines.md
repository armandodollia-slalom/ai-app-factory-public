# Azure Pipelines (CI system)

**Who reads this:** B and C using this product. Verified against fakes only unless the [status table](../README.md#verified-live-or-only-against-fakes) says otherwise.

`ci.provider: "azure-pipelines"`, the default with an Azure DevOps host. The adapter is `scripts/pipeline/lib/ci/azure-pipelines.mjs`. The pipelines a pull request's head must run are the target branch's **Build validation** policies (each policy's build definition). The head's runs are the builds of the PR's merge ref whose `triggerInfo` names the head as `pr.sourceSha`: Azure builds the merge commit, so `sourceVersion` is not the head. Logs come from the build timeline.

**Generated files:** one pipeline per `.azure-pipelines/factory-*.yml`, created once by hand, plus `.azure-pipelines/factory-analysis.yml` with analysis on. Secret variables reach a step only when mapped, and the generated steps map every name the config uses (a commercial scanner's token included). Keep "Make secrets available to builds of forks" off.

**Token:** `ci.token` (by default the host's) with **Build (Read & execute)**, for runs, logs and retries. Reading the branch policies needs Code (Read).

**Review events:** no. `board sync` posts the `review-quorum` status.

## Capabilities

<!-- generated:capabilities-azure-pipelines -->
| Capability | This adapter | Without it, the harness |
| --- | --- | --- |
| `logs` | yes | nothing to change |
| `expectedFromDefinition` | yes | nothing to change |
| `runsByCommit` | yes | nothing to change |
| `reviewEvents` | no | review-quorum is posted as a commit status by `board sync` (needs the host's commitStatus) |
| `schedules` | yes | nothing to change |
| `rerun` | yes | nothing to change |
| `branchPipelines` | no | the PR opens as a draft (or held by the work-in-progress label on a host without drafts) and is marked ready only when its pipelines are green on its head |
<!-- /generated:capabilities-azure-pipelines -->

**Verified:** against fakes only. API docs, read 2026-11-17: <https://learn.microsoft.com/rest/api/azure/devops/build/builds/list>, <https://learn.microsoft.com/rest/api/azure/devops/build/timeline/get>, <https://learn.microsoft.com/rest/api/azure/devops/build/builds/get-build-log>, <https://learn.microsoft.com/rest/api/azure/devops/policy/configurations/list>.
