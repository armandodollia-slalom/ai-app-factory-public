# Providers: ticket boards, code hosts, CI systems and scanners

**Who reads this:** B and C choosing or checking an outside service, D writing an adapter. The factory talks to four kinds of outside service, each through an adapter behind a written contract:

| Kind | What the factory needs from it | Config key | Built-ins |
| --- | --- | --- | --- |
| Ticket board (tracker) | stories, epics, bugs, lanes, comments, triage fields | `tracker.type` | `github`, `jira`, `azure-boards`, `gitlab`, `linear`, `custom` |
| Code host | pull requests, reviews, checks, merges bound to a head | `host.type` | `github`, `gitlab`, `azure-devops`, `bitbucket`, `custom` |
| CI system | which pipelines a head must run, their runs, logs, reruns; the generated pipeline files | `ci.provider` | `github-actions`, `gitlab-ci`, `azure-pipelines`, `jenkins`, `circleci`, `bitbucket-pipelines`, `custom` |
| Commercial scanner (optional) | a client's licensed SAST or SCA tool, locally or as a server-side result per head | `analysis.commercial` | Semgrep, CodeQL, Snyk Code, Snyk Open Source, SonarQube, Checkmarx One, Veracode, `custom` |

The tracker, the host and the CI system are chosen independently. When you name only the host, the factory proposes that host's own board and CI system:

| Host | Default tracker | Default CI system |
| --- | --- | --- |
| GitHub | GitHub Issues and Projects | GitHub Actions |
| GitLab | GitLab Issues | GitLab CI |
| Azure DevOps | Azure Boards | Azure Pipelines |
| Bitbucket Cloud | none: name one (Jira is the usual choice) | Bitbucket Pipelines |

Any other combination works as long as the CI system can build the host's repositories. `factory doctor` rejects the ones that cannot: for example GitHub Actions only builds GitHub repositories.

## Pages

- [contracts.md](contracts.md): every operation of each kind, its arguments and results, and each capability with what the harness does without it.
- One page per built-in, linked from the [table below](#verified-live-or-only-against-fakes). Each has the settings, the token and its scopes, what a person creates by hand, the capability table and the vendor documentation the adapter was written from.
- [custom.md](custom.md): the `custom` adapter for an in-house tracker, host, CI system or scanner, with two worked examples.
- [commercial-scanners.md](commercial-scanners.md): a client's licensed scanner as part of static analysis.
- [setup.md](setup.md): the setup interview (`factory init`), headless answers and re-runs.
- [migration.md](migration.md): for a repository set up before the adapters existed (v0.2.68).
- [../configuration.md](../configuration.md#code-host-tracker-and-ci): the configuration keys.

## Credentials

A credential is only ever a reference, `${NAME}`, to a variable that is read from the environment, or in CI from that CI system's secret store. A token's value never goes in `.factory/config.json`, a log, a URL or a command line, and the setup interview only asks for the names of the variables. `factory doctor` checks that every referenced variable is set, and `factory adapter check <kind>` shows that the adapter can reach the service with it.

## Capabilities, not assumptions

Products differ. Bitbucket Cloud has no labels on pull requests and cannot bind a merge to a commit. Jenkins starts no build when someone approves. Linear has no custom fields. Each adapter declares what it can do (`capabilities`), and where a capability is missing the harness degrades in a stated way. Three safety properties are never skipped silently:

- **A merge happens only on a green head, bound to its SHA.** A host that can bind the merge does it (GitHub `--match-head-commit`, GitLab `sha`, Azure DevOps `lastMergeSourceCommit`). A host that cannot (Bitbucket Cloud) re-reads the head right before merging and refuses if it moved.
- **No merge before CI registers.** A head is green only when every pipeline the CI system expects for it has a run for that SHA that completed green. A pipeline that has not started yet counts as pending, as does a commercial scanner's check that is not on the head yet. A read that fails counts as unknown, never as green.
- **Host auto-merge is disarmed on a new head.** It is armed only where the host can bind it to a head and disarm it. Elsewhere it is never armed, and `board sync` merges a cleared pull request itself.

`factory adapter check <kind>` prints the capability table of the configured adapter, and `factory doctor` lists what each missing capability means for this repository.

## Verified live or only against fakes

No test calls a real service. Every built-in passes the conformance suite (`scripts/pipeline/lib/providers/conformance.mjs`) against an in-memory fake. Each fake was built from the vendor's current API documentation, which the adapter's header names along with the date it was read. Live checks were possible only where a login already existed on the build machine: `gh`, read-only, against the public test repository. So the GitHub adapters are the only ones checked against the real service, and those checks were read-only (write checks skipped); the pipeline's own live runs on GitHub did write (pushes, PRs, cards, merges). Treat every other adapter as unverified until `factory adapter check <kind>` passes against your service, first read-only, then with `--write` on a test project.

<!-- generated:builtins -->
| Kind | Service | Verified | Page |
| --- | --- | --- | --- |
| host | GitHub | live (read-only) and fakes: read-only `factory adapter check host` against the public test repository, 2026-11-17: 20 pass, 4 skipped (write checks); the v0.2.68 suites unchanged | [hosts/github.md](hosts/github.md) |
| host | GitLab | fakes only | [hosts/gitlab.md](hosts/gitlab.md) |
| host | Azure Repos | fakes only | [hosts/azure-repos.md](hosts/azure-repos.md) |
| host | Bitbucket Cloud (alpha) | fakes only | [hosts/bitbucket.md](hosts/bitbucket.md) |
| tracker | GitHub Issues and Projects | live (read-only) and fakes: read-only `factory adapter check tracker` against the public test repository and its project, 2026-11-17: 20 pass, 16 skipped (write checks); the v0.2.68 suites unchanged | [trackers/github.md](trackers/github.md) |
| tracker | Jira (Cloud and Data Center) | fakes only | [trackers/jira.md](trackers/jira.md) |
| tracker | Azure Boards | fakes only | [trackers/azure-boards.md](trackers/azure-boards.md) |
| tracker | GitLab Issues | fakes only | [trackers/gitlab.md](trackers/gitlab.md) |
| tracker | Linear | fakes only | [trackers/linear.md](trackers/linear.md) |
| ci | GitHub Actions | live (read-only) and fakes: read-only `factory adapter check ci` against the public test repository, 2026-11-17: 4 pass, 1 skipped (rerun); the v0.2.68 suites unchanged | [ci/github-actions.md](ci/github-actions.md) |
| ci | GitLab CI | fakes only | [ci/gitlab-ci.md](ci/gitlab-ci.md) |
| ci | Azure Pipelines | fakes only | [ci/azure-pipelines.md](ci/azure-pipelines.md) |
| ci | Jenkins | fakes only | [ci/jenkins.md](ci/jenkins.md) |
| ci | CircleCI | fakes only | [ci/circleci.md](ci/circleci.md) |
| ci | Bitbucket Pipelines (alpha) | fakes only | [ci/bitbucket-pipelines.md](ci/bitbucket-pipelines.md) |
| scanner | SonarQube (server mode) | fakes only | [commercial-scanners.md](commercial-scanners.md) |
| scanner | GitHub code scanning (server mode) | fakes only: fakes; one live read-only call (2026-11-17) to the public test repository answered 404 "no analysis found" (read as pending) | [commercial-scanners.md](commercial-scanners.md) |
| scanner | Semgrep (server mode) | fakes only | [commercial-scanners.md](commercial-scanners.md) |
| scanner | Snyk, Checkmarx One, Veracode (server mode: their check on the head) | fakes only | [commercial-scanners.md](commercial-scanners.md) |
<!-- /generated:builtins -->

The commercial scanner definitions were not run against any real product (no licence on the build machine): [commercial-scanners.md](commercial-scanners.md#verification) lists each one with its documentation links.

## Checking an adapter

```sh
factory adapter check tracker              # read-only: every read operation, against the configured tracker
factory adapter check host --json          # the same, machine-readable
factory adapter check ci                   # reads the head of the latest pull request
factory adapter check scanner              # the server-mode scanner's result for that head
factory adapter check tracker --write      # also creates, edits and removes one test item (asks first; --yes skips)
```

A check reports each operation as `pass`, `fail`, `unsupported` (the adapter says it cannot, and the harness degrades) or `skipped` (a write operation without `--write`, or no fixture to read).
