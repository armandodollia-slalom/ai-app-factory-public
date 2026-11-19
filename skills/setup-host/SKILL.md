---
name: setup-host
description: "Set up the code host the factory works with in this repository (GitHub, GitLab or Azure DevOps, cloud or self-hosted): the token and identity the pipeline opens pull requests with, so people can approve them; the branch policies the gate and review-quorum rely on; and the one-time CI setup (variables, schedules, Azure pipelines). USE FOR: \"set up GitLab for the factory\", \"the pipeline should open merge requests as a bot\", \"why can't I approve the pipeline's PRs\", \"create the factory's Azure pipelines\", \"make review-quorum required\", or `factory doctor` reporting a host token, permission or required check as missing."
---

# Set up the code host

Result: the pipeline's pull requests are opened by an identity other than the developer's (so the developer
can approve them), the default branch requires the factory's gate and `review-quorum`, the CI system runs the
factory's jobs, and `factory doctor` shows every host row `ok`.

Everything here is a setting of the person's repository, organization or server. Explain each step, let the
person do the ones that need their rights, and never change a branch policy, a protection rule or a
repository's visibility yourself. Never ask for or write a token's value: the config holds `${NAME}`
references, and the person sets the variables.

## 1. Confirm the host

Read `host` and `ci.provider` in `.factory/config.json` (`factory init` drafted them from the remote; they are
governance, so they stay in config.json, never in `app.json`) and
`factory doctor`'s first rows. For a self-hosted server set `host.url` (GitHub Enterprise Server,
`https://gitlab.example.com` or with its path, Azure DevOps Server with its virtual directory such as
`https://ado.example.com/tfs`). `docs/hosts-and-trackers.md` in the factory says which CI systems can build
which host; `factory doctor` fails on a combination that cannot work.

## 2. The PR identity and its token

| Host | Identity | Token the config names | Needs |
| --- | --- | --- | --- |
| GitHub | the PR bot `dev-bot-<login>`, a GitHub App per developer | none: `factory bot setup` keeps the App's key outside the repository | two clicks: Create, then Install (`docs/ai-pipeline/setup.md#the-pipelines-pr-bot`) |
| GitLab | a project access token's bot user | `"token": "${GITLAB_TOKEN}"` | Settings → Access tokens: role Developer (Maintainer for `factory doctor` to read protections), scopes `api` and `write_repository` |
| Azure DevOps | a service principal, or a dedicated user with its own PAT | `"token": "${AZURE_DEVOPS_TOKEN}"` | Code (Read & write), Code (Status), Pull Request Threads (Read & write); Work Items (Read & write) with Azure Boards |

GitLab: the token's bot user authors the pipeline's merge requests, so a developer approves them like any
other. Check that "Prevent approval by author" does not also block approvals by the person who started the
run (it does not: the author is the bot).

Azure DevOps: a pull request created with a developer's own PAT has that developer as its creator, and the
policy "Allow requestors to approve their own changes" is off by default, so their vote would not count.
Create a service principal (Microsoft Entra application added to the organization) or a dedicated user,
give it Contribute and Contribute to pull requests on the repository, and put its PAT or token in the
variable the config names on the developer's machine. In Azure Pipelines the generated pipelines use the
build service's token instead; give `<project> Build Service (<organization>)` Contribute, Contribute to
pull requests and Create branch.

Then `factory doctor`: the host rows show the token set, the API reachable as the identity you created, and the
repository readable.

## 3. Branch policies (the owner's call)

| Host | The gate and review-quorum required | Approvals | Auto-merge |
| --- | --- | --- | --- |
| GitHub | Settings → Rules → Rulesets → the default branch → Require status checks: `review-quorum` (and the gate jobs) | the same ruleset; code-owner review for `.factory/` | Settings → General → Allow auto-merge |
| GitLab | Settings → Merge requests → **Pipelines must succeed** (the factory's jobs are in the merge request pipeline) | approval rules (Premium); CODEOWNERS at `.gitlab/CODEOWNERS` with "Code owner approval" on the protected branch | "Merge when pipeline succeeds" is on by default |
| Azure DevOps | Repos → Branches → the default branch → Branch policies → Build validation: `factory-pr` and `review-quorum`, required | "Minimum number of reviewers"; "Automatically included reviewers" on `.factory/*` (Azure DevOps has no CODEOWNERS) | auto-complete is per pull request; the review gate sets it |

`factory doctor` warns while `review-quorum` is not required on the default branch.

## 4. The CI system, once

- **GitHub Actions**: repository secrets `FACTORY_TOKEN` (private factory) and the agent's credential;
  variables `PIPELINE_AGENT_CLI` (`docs/ai-pipeline/setup.md#ci`).
- **GitLab CI**: check that `.gitlab-ci.yml` includes `.gitlab/ci/factory.yml` (`factory check` says so when
  the file has its own `include:` list). CI/CD variables (masked): `GITLAB_TOKEN`, `FACTORY_TOKEN`, the agent
  credential, the tracker's variables. Pipeline schedules with `FACTORY_JOB=retro`, `FACTORY_JOB=tracker`
  (every 15 minutes) and, with graphify, `FACTORY_JOB=graphify-cache-prune` (weekly). A runner that allows
  Docker-in-Docker for the demo video job.
- **Azure Pipelines**: one pipeline per `.azure-pipelines/factory-*.yml` (Pipelines → New pipeline →
  Existing YAML file), named after the file (`review-quorum` for `factory-review-quorum.yml`); the build
  validations of step 3; scheduled triggers for `factory-tracker` and, with graphify,
  `factory-graphify-cache-prune`; pipeline variables `FACTORY_TOKEN`, `PIPELINE_AGENT_CLI`, the agent
  credential and the tracker's variables, as secrets.

## 5. Verify

```bash
factory doctor
factory check
```

Open a small pull request (a typo fix) and confirm that the gate and `review-quorum` run on it and that the
branch policy lists them as required.
