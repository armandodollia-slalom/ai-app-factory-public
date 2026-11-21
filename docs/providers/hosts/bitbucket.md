# Bitbucket Cloud (code host)

**Who reads this:** B and C using this product. Verified against fakes only unless the [status table](../README.md#verified-live-or-only-against-fakes) says otherwise.

**Alpha.** The Bitbucket adapters were written from the vendor's documentation and are covered by tests against fakes only: no delivery has run against a real Bitbucket workspace. Expect gaps ([what is missing](https://github.com/armandodollia-slalom/ai-app-factory-public/issues/13)).

`host.type: "bitbucket"`, the default for a `bitbucket.org` remote. The adapter is `scripts/pipeline/lib/hosts/bitbucket.mjs` (REST API 2.0). A pull request's number is its id.

```json
"host": { "type": "bitbucket", "repo": "workspace/repository", "token": "${BITBUCKET_TOKEN}" },
"tracker": { "type": "jira", "url": "https://acme.atlassian.net", "project": "SHOP", "auth": { "user": "${JIRA_EMAIL}", "token": "${JIRA_API_TOKEN}" } },
"ci": { "provider": "bitbucket-pipelines" }
```

**Token:** a repository or workspace access token with the scopes `pullrequest:write`, `repository:write` and `pipeline:read`, sent as a bearer token. Its bot user is the PR identity. To use an Atlassian API token or app password instead, also set `host.user` to `${BITBUCKET_USER}` (basic auth).

**There is no default board:** Bitbucket has no issue tracker the factory uses, so name one. Jira is the usual choice, but any tracker works.

**What Bitbucket Cloud cannot do, and what the harness does instead:**

- No labels on pull requests. The gate keeps `approvals:N` in its notice comment, and `review-quorum` reads it from there.
- No merge bound to a head SHA. The gate re-reads the head right before merging and refuses if it moved. Host auto-merge is never used: `board sync` merges a cleared pull request itself when its head is green.
- Required checks are partial: "Require passing builds" counts builds, and merge checks block only on the Premium plan (`enforce_merge_checks`). The gate refuses to merge until every expected pipeline of the head is green, whatever the branch settings say.
- No uploads to a pull request. Demo videos stay on the storage branch and are linked.
- No reopening a declined pull request. A PR is held as a draft, never closed: `implement.preOpen.afterOpen: "close-reopen"` uses `draft` here, and `factory doctor` flags the setting. A PR declined by a hold from 0.2.92 cannot be released; its run ends `release-unconfirmed`.

**By hand:** the branch restrictions on the default branch (`factory review-gate enforce --dry-run` lists them), the merge check that resets approvals when the source branch changes (so that an approval of an earlier head does not count: Bitbucket records no commit per approval), and the repository variables for the pipelines.

**Bitbucket Data Center / Server is not covered.** Its REST API (1.0, projects and repos, different shapes) differs too much from Cloud's to share an adapter. Use a [custom adapter](../custom.md) for it.

## Capabilities

<!-- generated:capabilities-bitbucket -->
| Capability | This adapter | Without it, the harness |
| --- | --- | --- |
| `requiredChecks` | partial | the review gate refuses to merge until every expected pipeline of the head is green and bound to that SHA; doctor says the host cannot enforce it |
| `codeOwners` | no | the gate keeps its own approvals:N label and requests the owners as reviewers; doctor says owner review is advisory |
| `autoMerge` | no | the gate never arms host auto-merge; `board sync` merges a cleared PR itself when its head is green |
| `mergeHeadGuard` | no | the gate re-reads the head right before merging and refuses if it moved; with no way to bind the merge itself, auto-merge stays off on this host |
| `cancelAutoMerge` | no | host auto-merge is never armed (no way to disarm it on a new head) |
| `drafts` | yes | nothing to change |
| `labels` | no | approvals:N and the gate's labels live in the gate notice comment only |
| `checkAnnotations` | no | findings are listed in the PR comment and the PR body |
| `commitStatus` | yes | nothing to change |
| `attachments` | no | videos go to the storage branch and are linked |
| `botIdentity` | yes | nothing to change |
| `diff` | yes | nothing to change |
| `reviewCommentThreads` | yes | nothing to change |
<!-- /generated:capabilities-bitbucket -->

**Verified:** against fakes only. API docs, read 2026-11-17: <https://developer.atlassian.com/cloud/bitbucket/rest/api-group-pullrequests/>, <https://developer.atlassian.com/cloud/bitbucket/rest/api-group-commit-statuses/>, <https://developer.atlassian.com/cloud/bitbucket/rest/api-group-branch-restrictions/>, <https://developer.atlassian.com/cloud/bitbucket/rest/api-group-source/>.
