# GitHub (code host)

**Who reads this:** B and C using this product. Verified against fakes only unless the [status table](../README.md#verified-live-or-only-against-fakes) says otherwise.

`host.type: "github"`, the default for a `github.com` remote and for GitHub Enterprise Server when `host.url` names the server. The adapter (`scripts/pipeline/lib/hosts/github.mjs`) makes exactly the `gh` calls the factory made before adapters existed (v0.2.68). `gh` owns authentication, and `GH_TOKEN` in the environment selects another identity, such as the PR bot's installation token.

```json
"host": { "type": "github", "repo": "acme/shop" }
```

**Credentials:** `gh auth login` with the scopes `repo` and `project` (the project scope is for the GitHub tracker). The pipeline's own pull requests open as the [PR bot](../../ai-pipeline/setup.md#the-pipelines-pr-bot), a GitHub App, so that you can approve them. In CI the generated workflows use `GITHUB_TOKEN` or the App's token. GitHub Enterprise Server: `host.url: "https://ghe.example.com"` and `gh auth login --hostname ghe.example.com`.

**By hand:** `factory review-gate enforce` (run `--dry-run` first) creates the ruleset that requires `review-quorum`, the CI checks and code-owner review. Allow auto-merge in the repository settings if you use `implement.autoMerge.native`.

**Merge safety:** `gh pr merge --match-head-commit <sha>` binds every merge to the head the gate assessed. Auto-merge is armed only with `implement.autoMerge.native`, and disarmed when a new head arrives.

## Capabilities

<!-- generated:capabilities-github -->
| Capability | This adapter | Without it, the harness |
| --- | --- | --- |
| `requiredChecks` | yes | nothing to change |
| `codeOwners` | yes | nothing to change |
| `autoMerge` | yes | nothing to change |
| `mergeHeadGuard` | yes | nothing to change |
| `cancelAutoMerge` | yes | nothing to change |
| `drafts` | yes | nothing to change |
| `labels` | yes | nothing to change |
| `checkAnnotations` | yes | nothing to change |
| `commitStatus` | yes | nothing to change |
| `attachments` | no | videos go to the storage branch and are linked |
| `botIdentity` | yes | nothing to change |
| `diff` | yes | nothing to change |
| `reviewCommentThreads` | yes | nothing to change |
<!-- /generated:capabilities-github -->

**Verified:** read-only `factory adapter check host` against the public test repository on 2026-11-17 (20 pass, 4 skipped write checks), and the v0.2.68 test suites, which run unchanged.
