# GitLab (code host)

**Who reads this:** B and C using this product. Verified against fakes only unless the [status table](../README.md#verified-live-or-only-against-fakes) says otherwise.

`host.type: "gitlab"`, for gitlab.com or a self-managed instance (set `host.url`, including its path when GitLab is served under one). The adapter is `scripts/pipeline/lib/hosts/gitlab.mjs` (REST API v4). A pull request is a merge request, and its number is the MR's iid.

```json
"host": { "type": "gitlab", "url": "https://gitlab.com", "repo": "group/subgroup/project", "token": "${GITLAB_TOKEN}" }
```

**Token:** a project access token (Settings → Access tokens) with role **Developer** and scope `api`. Add `write_repository` if the pipeline pushes branches with it. The token's bot user is the PR identity, so you can approve the pipeline's merge requests yourself. Reading branch protection and approval rules (doctor) needs **Maintainer**.

**By hand, and what each CI system needs:** [../../hosts-and-trackers.md](../../hosts-and-trackers.md#gitlab-gitlabcom-and-self-managed). `factory review-gate enforce` turns on **Pipelines must succeed** and code-owner approval.

**Merge safety:** the merge API's `sha` parameter binds the merge to the assessed head. "Merge when pipeline succeeds" is the auto-merge, and it is cancelled on a new head.

## Capabilities

<!-- generated:capabilities-gitlab -->
| Capability | This adapter | Without it, the harness |
| --- | --- | --- |
| `requiredChecks` | yes | nothing to change |
| `codeOwners` | partial | the gate keeps its own approvals:N label and requests the owners as reviewers; doctor says owner review is advisory |
| `autoMerge` | yes | nothing to change |
| `mergeHeadGuard` | yes | nothing to change |
| `cancelAutoMerge` | yes | nothing to change |
| `drafts` | yes | nothing to change |
| `labels` | yes | nothing to change |
| `checkAnnotations` | partial | findings are listed in the PR comment and the PR body |
| `commitStatus` | yes | nothing to change |
| `attachments` | yes | nothing to change |
| `botIdentity` | yes | nothing to change |
| `diff` | yes | nothing to change |
| `reviewCommentThreads` | yes | nothing to change |
<!-- /generated:capabilities-gitlab -->

**Verified:** against fakes only (`scripts/pipeline/test/hosts-fakes.mjs`, `fakes/providers-fake-server.mjs`). API docs: <https://docs.gitlab.com/api/merge_requests/>, <https://docs.gitlab.com/api/merge_request_approvals/>, <https://docs.gitlab.com/api/commits/#set-the-pipeline-status-of-a-commit>, <https://docs.gitlab.com/api/protected_branches/>.
