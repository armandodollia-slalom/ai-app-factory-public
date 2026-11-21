# Azure Repos (code host)

**Who reads this:** B and C using this product. Verified against fakes only unless the [status table](../README.md#verified-live-or-only-against-fakes) says otherwise.

`host.type: "azure-devops"`, for Azure DevOps Services or Server. The adapter is `scripts/pipeline/lib/hosts/azure-devops.mjs` (Git REST API 7.1). A pull request's number is its `pullRequestId`. Labels are PR labels (tags), approvals are reviewer votes, auto-merge is autoComplete, and checks are the PR's statuses plus its policy evaluations.

```json
"host": { "type": "azure-devops", "url": "https://dev.azure.com", "repo": "organization/project/repository", "token": "${AZURE_DEVOPS_TOKEN}" }
```

**Token:** a PAT with **Code (Read & write)**, **Code (Status)** and **Pull Request Threads (Read & write)**. Reading branch policies (doctor's check) needs a user with **Edit policies** or project administrator rights. In Azure Pipelines, map the job's `$(System.AccessToken)` and give the project's Build Service identity **Contribute**, **Contribute to pull requests** and **Create branch**. A service principal's Entra ID token (a JWT) is sent as a bearer token.

**By hand:** [../../hosts-and-trackers.md](../../hosts-and-trackers.md#azure-devops-services-and-server). Create a pipeline per generated file, the build validation policies, and the Status policy for `factory/review-quorum`. `factory review-gate enforce` adds the Status policy.

**Merge safety:** the completion sets `lastMergeSourceCommit` to the assessed head, so Azure DevOps refuses the merge if the branch moved. autoComplete is cleared on a new head.

## Capabilities

<!-- generated:capabilities-azure-devops -->
| Capability | This adapter | Without it, the harness |
| --- | --- | --- |
| `requiredChecks` | yes | nothing to change |
| `codeOwners` | partial | the gate keeps its own approvals:N label and requests the owners as reviewers; doctor says owner review is advisory |
| `autoMerge` | yes | nothing to change |
| `mergeHeadGuard` | yes | nothing to change |
| `cancelAutoMerge` | yes | nothing to change |
| `drafts` | yes | nothing to change |
| `labels` | partial | approvals:N and the gate's labels live in the gate notice comment only |
| `checkAnnotations` | no | findings are listed in the PR comment and the PR body |
| `commitStatus` | yes | nothing to change |
| `attachments` | yes | nothing to change |
| `botIdentity` | yes | nothing to change |
| `diff` | no | git diff of the base and head locally |
| `reviewCommentThreads` | yes | nothing to change |
<!-- /generated:capabilities-azure-devops -->

**Verified:** against fakes only. API docs: <https://learn.microsoft.com/rest/api/azure/devops/git/pull-requests>, <https://learn.microsoft.com/rest/api/azure/devops/git/pull-request-statuses>, <https://learn.microsoft.com/rest/api/azure/devops/policy/configurations>. Azure DevOps has no unified diff API: `pr.diff` is unsupported, and the pipeline diffs locally.
