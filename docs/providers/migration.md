# Migrating from v0.2.68

**A repository on GitHub, with GitHub Issues and Projects and GitHub Actions, needs no change.** Its keys (`tickets`, `board`, `implement.reviewGate`, `analysis`) mean what they meant. The factory makes the same `gh` calls as before, now through the GitHub adapters, and `factory render` writes the same workflow files byte for byte. The v0.2.68 test suites run unchanged against the adapters, and the GitHub adapters were checked read-only against a live repository.

What is new, and opt-in:

- **Choosing the board, host and CI separately:** `tracker`, `host` and `ci` in `.factory/config.json` ([../configuration.md](../configuration.md#code-host-tracker-and-ci)), or `factory init --interview`.
  - Hosts: GitLab, Azure Repos, Bitbucket Cloud.
  - Trackers: Jira, Azure Boards, GitLab Issues, Linear.
  - CI systems: GitLab CI, Azure Pipelines, Jenkins, CircleCI, Bitbucket Pipelines.
  - And a `custom` adapter of each kind.
- **Defaults that changed for non-GitHub hosts:**
  - A GitLab host now defaults to GitLab Issues as its tracker (before: none, and setup stopped).
  - A Bitbucket Cloud remote is recognised (`host.type: bitbucket`, CI `bitbucket-pipelines`). Bitbucket has no default tracker: name one.
- **`factory adapter check <kind>`:** the conformance suite against the configured service, read-only by default.
- **Commercial scanners:** `analysis.commercial` ([commercial-scanners.md](commercial-scanners.md)).
  - All off.
  - A repository whose `analysis.tools` declared its own scanner by hand (the v0.2.68 docs' "a client's own commercial scanner" example) keeps working.
  - Moving to a definition adds the severity map, vendor triage, server mode and the per-CI secret mapping.
- **`setup-board` skill:** provider-neutral, with each tracker's steps from its adapter (`factory board guide`). Every safety note it had for GitHub Projects remains.

Behaviour that changed for every repository, deliberately:

- **The factory guard** now also refuses any pipeline agent's command that changes a finding's state in a scanner vendor's system (accept, dismiss, ignore, mark false positive).
- **The SARIF parser** keeps a finding's CWE, vendor severity, vendor fingerprint and suppression state. Open-source tools' findings gain those fields when their SARIF has them. Nothing about what blocks changes for a tool without a severity map.
- **Static analysis findings** have a third severity, `major`, used by severity maps. Existing tools still report `blocking` or `minor` only.

For a GitHub repository, nothing to do. For a repository that already used GitLab, Azure DevOps or Jira through the 0.3.0 adapters (`next`): the keys are unchanged. Run `factory doctor` and `factory adapter check` once, because the CI layer now derives the head's expected pipelines from the CI system (`ci.expected` overrides it).
