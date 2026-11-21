# Code hosts, trackers and CI systems

**Who reads this:** B and C on a code host, tracker or CI system other than the GitHub defaults. The factory works with any combination of a code host, a ticket tracker and a CI system that can build that host's repositories. For example: Azure DevOps for the code, Jira for the tickets and Azure Pipelines for CI; or Bitbucket Cloud, Jira and Jenkins. Each is chosen separately in `.factory/config.json`, or through the setup interview ([providers/setup.md](providers/setup.md)):

| Dimension | Key | Types | Default |
| --- | --- | --- | --- |
| Code host: repository, pull requests, reviews, merges, status checks, the PR identity | `host.type` | `github`, `gitlab`, `azure-devops`, `bitbucket`, `custom` | detected from the `origin` remote; `github` when there is none |
| Ticket tracker: stories, epics, bugs, board lanes, fields, comments, attachments | `tracker.type` | `github` (issues and a GitHub Project), `jira`, `azure-boards`, `gitlab`, `linear`, `custom` | the legacy GitHub keys when set; otherwise the host's own: `github`, `gitlab`, `azure-boards`; Bitbucket has none, so name one |
| CI system: the generated pipelines and the head's evidence | `ci.provider` | `github-actions`, `gitlab-ci`, `azure-pipelines`, `jenkins`, `circleci`, `bitbucket-pipelines`, `custom` | the host's own CI system |

Each product has its own page under [providers/](providers/README.md): settings, tokens and scopes, what to create by hand, its capabilities (what the harness does where the product cannot), the vendor documentation it was written from, and whether it was verified live or only against fakes. The sections below add setup detail for GitHub, GitLab, Azure DevOps, Jira and Azure Boards; the other products are covered on their own pages: [Bitbucket Cloud](providers/hosts/bitbucket.md), [GitLab Issues](providers/trackers/gitlab.md), [Linear](providers/trackers/linear.md), [Jenkins](providers/ci/jenkins.md), [CircleCI](providers/ci/circleci.md), [Bitbucket Pipelines](providers/ci/bitbucket-pipelines.md).

`factory doctor` checks every configured product: the token variable is set, the API answers, the token reaches the repository or project, and the default branch requires the `review-quorum` check. `factory adapter check <tracker|host|ci|scanner>` runs each operation of the configured adapter. A repository with a GitHub remote and none of these keys works exactly as before. The host layer, the tracker layer and `factory init`/`render`/`doctor` read the defaults from one module (`scripts/pipeline/lib/products.mjs`), so they always agree.

## What works in each combination

The host and the CI system decide whether the pipelines can run; the tracker changes only how the tracker
automations start (on issue events for GitHub issues on GitHub Actions, on a 15-minute schedule otherwise).
"Full" means pull request jobs (gate, lint, feature verification, review quorum, PR check) and scheduled jobs
(retro, tracker automations, cache prune). `factory doctor` refuses a combination marked "not possible"
(`CI_SUPPORT` in `scripts/factory/lib/hosting.mjs`, the authority for this table).

| Host | GitHub Actions | GitLab CI | Azure Pipelines | Jenkins | CircleCI | Bitbucket Pipelines |
| --- | --- | --- | --- | --- | --- | --- |
| GitHub | full | scheduled jobs only (2) | full, with limits (1) | full | full | not possible |
| GitLab | not possible | full, with limits (3) | not possible | full | full | not possible |
| Azure DevOps | not possible | scheduled jobs only (2) | full, with limits (4) | with limits | not possible | not possible |
| Bitbucket Cloud | not possible | not possible | full | full | full | full |

A `custom` CI system is whatever the team runs. Every non-GitHub combination is verified against fakes only
([status per adapter](providers/README.md#verified-live-or-only-against-fakes)); `npm test` runs the pipeline-level
flow for each host and tracker pair against fake servers (`scripts/pipeline/test/combinations.test.mjs`) and checks
each CI system's generated files.

1. Azure Pipelines building a GitHub repository: the `ai-pr-check` label cannot be read (the label check uses the Azure Repos API), so run the PR check pipeline by hand with its `pr` parameter. The cache prune pipeline opens its pull request only on Azure Repos. The review quorum runs again only when the pull request changes or the build is re-queued.
2. GitLab CI for an external repository (a GitHub repository connected through "CI/CD for external repositories", or a pull mirror of an Azure Repos repository) runs pipelines for pushes, not for pull requests. Only the retro, the tracker automations and the cache prune run, from pipeline schedules.
3. GitLab starts no pipeline when a label is added or someone approves: the PR check starts on the merge request's next pipeline after the `ai-pr-check` label is added (push, or **Run pipeline**), and the review quorum must be re-run after an approval. A merge request's own `.gitlab-ci.yml` defines its pipeline, so a merge request could change the review-quorum job (the job counts approvals with the factory pinned on the target branch, but its definition is the merge request's). Protect against it with GitLab approval rules (Premium) or a protected `.gitlab-ci.yml` through CODEOWNERS and "Code owner approval".
4. Azure DevOps starts no build when someone approves or a label is added: re-queue the review-quorum build after approving, or set "Minimum number of reviewers" for a fixed count; queue the PR check after adding the `ai-pr-check` label. Pipelines are created once by hand from the generated files (below).

Methods a product cannot support throw `UnsupportedError` (`scripts/pipeline/lib/hosts/errors.mjs`, shared by both layers) with the fallback in its message: Azure DevOps `pr.diff` (run `git diff` locally) and `repo.permissions` (doctor warns and checks that the repository is readable instead), Jira `tickets.history` (the local history folder is used). GitHub's optional `pr.uploadAttachment` is not implemented; videos go to the storage branch as before.

## Before you trust GitLab, Azure DevOps or Jira: verified only against fakes

Nothing below has been run against a real GitLab, Azure DevOps or Jira; every request was built from the products' REST documentation and checked against fake servers written the same way. The combination tests prove the factory's side is consistent; it cannot prove the products answer as the fakes do. Run `factory doctor` first: it calls each configured product with your token. Then try one story with `implement` on a test project before relying on the pipeline. These are the details most likely to differ:

### GitLab (code host)

- Reviews: approvals carry no commit, so each approval is dated to the merge request's head; stale approvals after a push rely on the project's "Reset approvals on push" setting. "Changes requested" comes from the reviewers API (GitLab 17 and later); `submittedAt` is often empty.
- Auto-merge: the adapter sends both `merge_when_pipeline_succeeds` and `auto_merge`; on 405, 406 or 422 it merges at once. Which status a project with no pipeline returns is not verified.
- Required checks: "Pipelines must succeed" is reported as the check `pipeline`; external status checks need Ultimate; required approvals are the largest of the approval rules and `approvals_before_merge`.
- `factory review-gate enforce`: `PUT /projects/:id` with `only_allow_merge_if_pipeline_succeeds`, then `POST /protected_branches` (an unprotected default branch) or `PATCH /protected_branches/:name?code_owner_approval_required=true`; on a tier without code owner approval it reads the branch back and reports that it is not set. Whether a lower tier answers 403 or silently ignores the parameter is not verified.
- The PR identity: the merge request's author is assumed to be the project access token's bot user. `host.bot.setup()` prints the steps; it creates nothing.
- Upload links use `full_path`, which older versions may not return. `repo.permissions` reads `permissions.project_access` / `group_access` from the project.
- The generated `.gitlab-ci.yml` files: the regex rule on `$CI_MERGE_REQUEST_LABELS`, hidden keys holding anchor strings, `apt-get install gh` on `node:20-bookworm`, and Docker-in-Docker with the compose plugin downloaded at run time.

### Azure DevOps (code host)

- Reviews: votes carry no time or commit, so each vote is dated to the pull request's head commit.
- API versions: labels, PR statuses, attachments and policy evaluations use `-preview.1`; `connectionData` uses `-preview`. The default `7.1` may be too new for Azure DevOps Server 2020/2022: set `host.apiVersion`.
- Identities are looked up on `vssps.dev.azure.com` (Services) or the server itself, with `searchFilter=General`.
- Auto-merge sets auto-complete to the caller's identity from `connectionData` and cancels it with the empty GUID.
- `branchProtection` filters policy configurations by `repositoryId` and `refName` and matches the policy display names ("Minimum number of reviewers", "Status", "Build", "Required reviewers").
- `setStatus` posts a commit status, and also a PR status when it is given the pull request (branch policies read PR statuses).
- `factory review-gate enforce` creates a Status policy (type id `cbdc66da-9728-4af8-aada-9a5a32e4a226`) with `statusGenre: factory`, `statusName: review-quorum`, `invalidateOnSourceUpdate`, scoped to the default branch; the settings shape is from the policy documentation and checked only against the fake.
- The generated pipelines: `System.PullRequest.TargetBranch` and `Build.SourceBranch` as the base, whether `[skip ci]` is honoured, the loop guard that reads the merge commit's second parent, and the 7.1 REST call for PR labels.

### Jira (tracker)

- Search paging on Cloud (`/rest/api/3/search/jql`: the `nextPageToken` and `isLast` fields); Data Center uses `/search` with `startAt`.
- Hidden markers are kept in comment properties: whether `expand=properties` on the comment list returns them, and the `/comment/{id}/properties/{key}` path.
- The direction of "Blocks" links (which of `outwardIssue` and `inwardIssue` is the blocker).
- Data Center: the Epic Link JQL (`"Epic Link" = X`) and the `serverInfo.deploymentType` values used to tell it from Cloud.
- Moving a card is a transition: a workflow without a transition to the target status is an error that asks for "Any status" transitions.
- ADF: whether Jira normalises a stored description in a way that breaks the hash check (the adapter then converts it back, which is safe), and whether `mediaSingle` with external media is accepted.

### Azure Boards (tracker)

- Comments use `7.1-preview.4` with `continuationToken` paging.
- `workitemsbatch` with `$expand: 'Relations'` and `errorPolicy`; whether reciprocal Hierarchy links are added automatically (the fake adds them).
- Attachment downloads with `download=true`; whether `connectionData` needs `-preview` and `7.1` works on older servers (`tracker.apiVersion` overrides it).
- Whether the description sanitiser keeps the metadata `<pre>` block and code blocks that carry hidden HTML comments. Hidden markers show as small `factory-html` code blocks; a description a person edited comes back in a canonical Markdown form, not byte for byte.

### Every product

- `factory doctor`'s rows were checked against fake adapters and the fakes above, not against real permission models.
- `board migrate --apply` to Jira or Azure Boards is implemented but has no test.
- Pipeline schedules, scheduled triggers, comment-triggered PR checks and re-running `review-quorum` after an approval are manual on GitLab CI and Azure Pipelines (see the footnotes above).

The jobs call `factory` commands; those reach the host and tracker through the adapters (`scripts/pipeline/lib/hosts/`, `scripts/board/lib/trackers/`). The generated GitLab CI and Azure Pipelines files are checked by the factory's tests for structure (they parse, every include and template resolves to a generated file, every job has a trigger, a stage and a script); they have not been run on GitLab or Azure DevOps by the factory's own CI.

## Code hosts

A merge is bound to the head the gate assessed where the host can bind it (GitHub, GitLab, Azure DevOps). Bitbucket Cloud cannot: the harness re-reads the head just before merging and refuses if it moved, which leaves a short window between the read and the merge ([Bitbucket](providers/hosts/bitbucket.md)).

### GitHub

Nothing new: the `gh` CLI, signed in, with the scopes `repo` and `project`; the [PR bot](ai-pipeline/setup.md#the-pipelines-pr-bot) for the pipeline's pull requests. GitHub Enterprise Server: set `host.url` to the server (`https://ghe.example.com`) and sign `gh` in to it (`gh auth login --hostname`).

### GitLab (gitlab.com and self-managed)

```json
"host": { "type": "gitlab", "url": "https://gitlab.com", "repo": "group/subgroup/project", "token": "${GITLAB_TOKEN}" }
```

Token: a **project access token** (Settings → Access tokens) with the role **Developer** and the scope `api` (merge requests, comments, approvals, pipelines, commit statuses); add `write_repository` when the pipeline pushes branches with it (the PR check's records, the cache prune). The token's bot user is the PR identity: the pipeline's merge requests are opened by it, so you can approve them yourself. Reading branch protection and approval rules for `factory doctor` needs **Maintainer**. A personal access token with the same scopes works but makes you the author of the pipeline's merge requests, and GitLab does not let an author approve by default.

By hand, once:

| What | Where | Why |
| --- | --- | --- |
| The CI/CD variables `GITLAB_TOKEN`, `FACTORY_TOKEN` (private factory), the agent credential (`ANTHROPIC_API_KEY`, ...) and the tracker's | Settings → CI/CD → Variables, masked | the jobs read them from the environment; the agent jobs never run for a fork's merge request in this project (`factory check` fails on a job that would) |
| **Pipelines must succeed**, and code owner approval on the default branch (Premium) | Settings → Merge requests; Settings → Repository → Protected branches | makes the gate, lint, feature verification and review-quorum jobs required, and an owner's review of `.factory/` and the generated files; `factory review-gate enforce` sets both (`--dry-run` first) |
| **Approval rules** (Premium) | Settings → Merge requests | a fixed number of approvals; `review-quorum` enforces each merge request's `approvals:N` |
| Pipeline schedules with `FACTORY_JOB=retro`, `FACTORY_JOB=tracker` (every 15 minutes) and `FACTORY_JOB=graphify-cache-prune` (weekly) | Build → Pipeline schedules | GitLab CI has no schedule in the file |
| **Auto-merge** ("merge when pipeline succeeds") | allowed by default | the review gate's auto-merge |

Self-managed: set `url` to the instance (with its path when GitLab is served under one, such as `https://code.example.com/gitlab`). The API is `<url>/api/v4`.

Known limits: comments do not start pipelines (no comment-triggered PR check; use the label or a pipeline trigger token with `FACTORY_PR_CHECK_MR=<iid>`).

### Azure DevOps (Services and Server)

```json
"host": { "type": "azure-devops", "url": "https://dev.azure.com", "repo": "organization/project/repository", "token": "${AZURE_DEVOPS_TOKEN}" }
```

Token: on a developer machine, a **personal access token** with **Code (Read & write)**, **Code (Status)**, **Pull Request Threads (Read & write)** and, with Azure Boards, **Work Items (Read & write)**. In Azure Pipelines the generated pipelines map `AZURE_DEVOPS_TOKEN` to the job's `$(System.AccessToken)`: give **`<project> Build Service (<organization>)`** the repository permissions **Contribute**, **Contribute to pull requests** and **Create branch** (Project settings → Repositories → Security). Reading branch policies for `factory doctor` needs **Edit policies** or project administrator rights. PR identity: Azure DevOps lets an author's vote count unless the policy "Allow requestors to approve their own changes" is off; to approve the pipeline's pull requests yourself, open them with a separate identity (a service principal or a dedicated user's PAT in `host.token`): see the [`setup-host`](../skills/setup-host/SKILL.md) skill.

By hand, once:

| What | Where | Why |
| --- | --- | --- |
| One pipeline per `.azure-pipelines/factory-*.yml` (`factory-pr`, `factory-review-quorum`, `factory-pr-check`, `factory-retro`, `factory-tracker`, `factory-graphify-cache-prune` with the feature) | Pipelines → New pipeline → Azure Repos Git → Existing YAML file | Azure DevOps runs only pipelines someone created |
| Build validation: `factory-pr` and `review-quorum` required, `factory-pr-check` optional | Repos → Branches → the target branch → Branch policies | the pull request triggers on Azure Repos |
| A Status policy requiring `factory/review-quorum`, and a Required reviewers policy for `.factory/` and the generated files | Repos → Branches → the target branch → Branch policies | `factory review-gate enforce` adds the Status policy (`--dry-run` first) and lists the Required reviewers policy, whose reviewers a person chooses; keep "Make secrets available to builds of forks" off |
| Scheduled triggers: `factory-tracker` every 15 minutes, `factory-graphify-cache-prune` weekly, `factory-retro` as you like | the pipeline → Edit → Triggers | no schedule is set in the files, so they never depend on a branch name |
| Pipeline variables: `FACTORY_TOKEN` (private factory), `PIPELINE_AGENT_CLI`, the agent credential and the tracker's, as secrets | the pipeline → Edit → Variables | secrets reach a step only when mapped; the generated steps map every name the config uses |

Self-hosted (Azure DevOps Server): `url` is the server with its virtual directory (`https://ado.example.com/tfs`) and `repo` is `collection/project/repository`. Known limits: approving or labelling a pull request starts no build; an abandoned pull request's demo videos are not cleaned up automatically; an undefined pipeline variable reaches a step as the text `$(NAME)`, so define every variable the config names (the steps drop such values before running `factory`).

## Trackers

### GitHub issues and Projects

Unchanged: `tickets.repo`, `board.owner`, `board.repo`, `board.projectNumber` (or `tracker: { "type": "github", "project": "owner/name", "board": { ... } }`). The `gh` login needs the `project` scope. In GitLab CI or Azure Pipelines, add a `GH_TOKEN` variable (a token with Issues read and write and Projects read and write); the jobs install `gh` when it is missing.

### Jira (Cloud and Data Center)

```json
"tracker": {
  "type": "jira",
  "url": "https://acme.atlassian.net",
  "project": "SHOP",
  "auth": { "user": "${JIRA_EMAIL}", "token": "${JIRA_API_TOKEN}" },
  "board": { "id": 12 },
  "lanes": { "backlog": "Backlog", "ready": "Selected for Development", "inProgress": "In Progress", "review": "In Review", "done": "Done", "blocked": "Blocked" },
  "types": { "epic": "Epic", "story": "Story", "bug": "Bug", "spike": "Task" }
}
```

Token: Cloud, an **API token** (id.atlassian.com → Security → API tokens) of a user who can browse, create, edit, transition and comment on issues and add attachments in the project; `auth.user` is that user's email. Data Center, a **personal access token** of such a user (`auth.token` only; sent as a bearer token).

By hand, once: the workflow statuses the lanes map to, and the transitions between them (Jira workflows are a project administrator's); custom fields for the review gate's ratings (Severity, Impact, Complexity, Fix risk, Confidence), on the project's screens, mapped in `tracker.fields`. `factory doctor` lists what `factory board setup` would create and what is left for a person (a dry run through the tracker adapter). Known limit: the pipeline's tracker automations run on a schedule (a Jira automation rule or webhook can call a CI trigger instead).

### Azure Boards

```json
"tracker": {
  "type": "azure-boards",
  "url": "https://dev.azure.com/acme",
  "project": "Shop",
  "auth": { "token": "${AZURE_DEVOPS_TOKEN}" },
  "board": { "team": "Shop Team", "board": "Stories" },
  "lanes": { "backlog": "New", "ready": "Approved", "inProgress": "Committed", "review": "In Review", "done": "Done", "blocked": "Blocked" },
  "types": { "epic": "Epic", "story": "User Story", "bug": "Bug", "spike": "Task" }
}
```

Token: a PAT with **Work Items (Read & write)** (or the build service's token in Azure Pipelines, with the area path's "Edit work items in this node"). By hand, once: board columns for the lanes (Boards → Board → Configure), the work item process's custom fields for the ratings (an inherited process is needed to add fields), mapped in `tracker.fields`. The work item types depend on the process (Agile: User Story; Scrum: Product Backlog Item; Basic: Issue): set `types`.

## CI systems

The same jobs are generated for each CI system. `factory render` writes them, `factory check` (the gate job) fails when they drift, and `factory uninstall` removes them. None of them replaces a team's own pipeline file.

| Job | GitHub Actions | GitLab CI | Azure Pipelines |
| --- | --- | --- | --- |
| Install the pinned factory | `.github/actions/setup-factory` | `.factory-base` in `.gitlab/ci/factory-setup.yml` | `.azure-pipelines/templates/factory-setup.yml` |
| Install the agent CLI | `.github/actions/setup-agent-cli` | `.factory-agent` | `templates/factory-agent-cli.yml` |
| Gate, lint, feature verification | `factory-gate.yml`, `factory-feature-verification-check.yml` | `factory-gate`, `factory-lint`, `factory-feature-verification` | `factory-pr.yml` |
| Review quorum | `factory-review-quorum.yml` | `review-quorum` | `factory-review-quorum.yml` |
| PR check | `factory-pr-check.yml` (label) | `factory-pr-check` (label, Run pipeline, trigger token) | `factory-pr-check.yml` (label, `pr` parameter) |
| Retro | `factory-retro.yml` | `factory-retro` (schedule, `FACTORY_JOB=retro`) | `factory-retro.yml` |
| Tracker automations | `factory-board-*.yml` (GitHub issues) or `factory-tracker-sweep.yml` | `factory-tracker` (schedule) | `factory-tracker.yml` (schedule) |
| Cache prune (feature `graphify`) | `factory-graphify-cache-prune.yml` | `factory-graphify-cache-prune` (schedule) | `factory-graphify-cache-prune.yml` |
| Your toolchain | `.github/actions/factory-toolchain` | `.factory/ci/toolchain.sh` | `.factory/ci/toolchain.sh` |

**GitLab CI** files are `.gitlab/ci/factory-*.yml`, included by `.gitlab/ci/factory.yml`. `factory render` adds one managed block to `.gitlab-ci.yml` (creating the file when there is none):

```yaml
# >>> factory (generated by `factory render`; edit outside this block)
include:
  - local: .gitlab/ci/factory.yml
# <<< factory
```

When `.gitlab-ci.yml` already has its own `include:` list, a second one would be invalid: the block then only holds a comment, and `factory check` fails until the list names `.gitlab/ci/factory.yml`. The jobs use the `test` stage; `factory check` also fails when the file's own `stages:` list lacks it. To change a factory job for your runners (image, tags, timeout), define a job of the same name in `.gitlab-ci.yml`: GitLab merges your keys over the included ones, and `factory check` does not look at that file outside the block.

**Azure Pipelines** files are separate pipelines under `.azure-pipelines/`; the team's `azure-pipelines.yml` is never touched. A pipeline is created once per file (above).

The private factory: every provider clones the pinned version with `FACTORY_TOKEN` as HTTP basic credentials, with the user name `FACTORY_TOKEN_USER` (default `x-access-token`, which GitHub expects; GitLab and Azure Repos accept any user name with a token). A GitHub fine-grained token needs Contents: read on the factory repository; a GitLab token `read_repository`; an Azure DevOps PAT Code (Read).

The agent CLI: the variable `PIPELINE_AGENT_CLI` (`claude`, `copilot`, `codex`) or `PIPELINE_AGENT_CMD` with `PIPELINE_AGENT_INSTALL`, and the credential `ANTHROPIC_API_KEY`, `COPILOT_GITHUB_TOKEN`, `OPENAI_API_KEY` or `PIPELINE_AGENT_API_KEY`, as in [setup.md](ai-pipeline/setup.md#ci). When the credential is missing, the agent jobs skip instead of failing.
