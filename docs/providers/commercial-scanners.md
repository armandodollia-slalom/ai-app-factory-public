# A client's commercial scanner

Many clients already license a SAST or SCA product and want its findings to count. The factory takes such a scanner into its static analysis ([../ai-pipeline/analysis.md](../ai-pipeline/analysis.md)) as a first-class tool. Its findings go through the same baseline (only what the change introduces), the same fix loop, the same report and the same merge gate as the open-source tools'. It can replace those tools or run beside them, separately for each CI job.

The factory bundles no vendor binary, rule or token. The client's licence, the client's CLI or service, and the client's token do the scanning.

## Turning one on

```json
"analysis": {
  "commercial": {
    "scanner": "snyk-code",
    "mode": "local",
    "token": "${ACME_SNYK_TOKEN}",
    "replaces": ["sast"],
    "severity": { "medium": "blocking" }
  },
  "acceptLicence": [{ "tool": "snyk-code", "licence": "LicenseRef-Snyk-Terms", "by": "Pat Doe (client security lead), 2026-11-17" }]
}
```

Or answer the interview's *Commercial scanner* questions (`factory init --interview`). Nothing secret is asked: only the name of the variable that holds the token.

| Key | Meaning | Default |
| --- | --- | --- |
| `scanner` | a definition below, or your own (see the end of this page) | |
| `mode` | `local` or `server` (below) | the definition's first mode |
| `token` | the variable holding the token, as `${NAME}`. It reaches the vendor's own variable (`SNYK_TOKEN`, `SEMGREP_APP_TOKEN`, ...) only when the tool runs. A literal token fails validation. | required |
| `env` | more vendor variables, each a `${NAME}` reference (Checkmarx: `CX_CLIENT_ID`, `CX_BASE_URI`, `CX_TENANT`; Veracode: `VERACODE_API_KEY_ID`) | |
| `replaces` | CI job ids whose open-source tools it replaces: `sast`, `dependencies` (alias `sca`), `secrets`. Those tools also leave the fix-loop stages. With an empty list it runs **beside** them, and findings at the same file, line and CWE are reported once, at the higher severity, naming the other tools. | `[]` |
| `severity` | client overrides of the definition's map, from the vendor severities `critical`, `high`, `medium`, `low` and `info` to `blocking`, `major` and `minor` | the definition's |
| `check` | server mode: the name of the check the scanner reports on a pull request's head | the definition's |
| `url`, `project`, `deployment` | the server or tenant, and the project, application or deployment name the vendor uses | |
| `timeoutMin` | server mode: how long the gate waits for the result of a head before failing it | `60` |
| `stages` | local mode: the fix-loop slots it runs in | `["story", "prCheck"]` |

A list of such objects turns on more than one scanner.

**Licence.** Every definition is off and stays off until a named person accepts its licence in `analysis.acceptLicence`. A scanner whose licence nobody accepted never runs, and never silently passes either. In server mode its evidence is a failure that names the missing acceptance, and `factory doctor` fails on it. CodeQL is on the factory's rejected list: its terms need paid GitHub Advanced Security for closed-source code. The person accepting it also adds `"rejected": true`, which records that they made the decision. Agents cannot change `.factory/config.json`.

## Two modes

**Local.** The vendor's CLI runs on the developer's machine in the fix loop (the slots in `stages`) and in CI as its own required job (`commercial-<scanner>`). It is rendered for every CI system from the same provider-neutral job data. The token comes from that CI system's secret store:

| CI system | How the token reaches the job |
| --- | --- |
| GitHub Actions | repository or organisation secret, mapped in the job's `env` (GitHub withholds it from fork pull requests) |
| GitLab CI | masked CI/CD variable (every job sees it) |
| Azure Pipelines | secret pipeline variable, mapped in the step's `env` |
| Jenkins | secret-text credential (`acme-snyk-token` for `ACME_SNYK_TOKEN`), bound with `credentials()` |
| CircleCI | the `factory` context |
| Bitbucket Pipelines | secured repository variable |

Without the variable the tool does not run. The CI job fails closed with the message "ACME_SNYK_TOKEN not set (add it to the CI system's secret store)". The value itself is never printed, and is never on a command line.

**Server.** The scan runs in the vendor's service or in the client's own CI integration. The factory's CI job only uploads, when the definition has an upload command. The review gate then reads the result for the pull request's head. Merge safety:

- The scanner's check (`check`) joins the head's expected evidence and the branch's required checks. If the check is not on the head yet, or is still running, the head is **pending**: an asynchronous result never lets a merge through early.
- When the check is green, the gate reads the result: the vendor's quality gate, then the findings with the severity map and the vendor's triage. A failed gate, or an open finding mapped to `blocking`, is a **failure**.
- With no result after `timeoutMin` minutes, the head is a **failure** that says so (fail closed).
- If the result cannot be read, the head is **unknown**, which is never green.
- A result the vendor does not bind to a commit (SonarQube Server, Semgrep, code scanning's merge-ref analyses) counts only together with the scanner's check on the head. Without a check name the head is never green, and doctor says to set one.

## Findings

- **Vendor rule ids are kept** (`javascript/Sqli`, `java:S2076`, `js/sql-injection`), and so is the vendor's own fingerprint. The factory adds its stable fingerprint (tool, rule, file and line text, not the line number), which baselines a finding against the merge-base.
- **Severity mapping is data.** Each definition maps the vendor's severities to `blocking`, `major` and `minor`, and the client overrides any of them. The map reads SARIF `security-severity` scores (CVSS bands), the vendor's words (BLOCKER…INFO, Very High…Informational) and Veracode's 0–5 scale.
  - `blocking` fails the CI job and must be fixed in the fix loop.
  - `major` is handed to the fix loop and shown to the reviewers, but does not fail CI on its own.
  - `minor` is reported.
- **Triage is the vendor's, and a person's.** A finding someone accepted, marked a false positive or ignored in the vendor's system is reported (in the PR body's *Static analysis* section and the members' evidence) and never blocks. The factory reads these states:
  - SARIF `suppressions` with status accepted
  - SonarQube resolutions and issue statuses
  - GitHub code scanning dismissals
  - Semgrep `triage_state`
- **No agent triages.** The factory guard refuses any pipeline agent's command that changes a finding's state in a vendor's system: a `PATCH` of a code scanning alert, SonarQube `do_transition`, `snyk ignore`, `cx triage update`, Semgrep's triage API, Veracode mitigations. While a scanner is on, the vendor's suppression files (`.snyk`, `.semgrepignore`, `sonar-project.properties`, `.github/codeql`) are protected too. An agent fixes the finding, or suppresses it inline with a justification the reviewers see.

## Definitions

<!-- generated:commercial-definitions -->
| Definition | Product | Modes | Token variable the CLI reads | Licence to accept | Server adapter | Verified | Docs (read) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `semgrep` | Semgrep AppSec Platform (Code, Supply Chain, Secrets) | local, server | `SEMGREP_APP_TOKEN` | `LicenseRef-Semgrep-AppSec-Platform` | `semgrep`, check `semgrep-cloud-platform/scan` | no | [1](https://semgrep.dev/docs/cli-reference) [2](https://semgrep.dev/docs/semgrep-ci/configuring-blocking-and-errors-in-ci) [3](https://semgrep.dev/api/v1/docs/#tag/Finding) (2026-11-17) |
| `codeql` | GitHub code scanning with CodeQL | local, server | `GITHUB_TOKEN` | `LicenseRef-GitHub-CodeQL-Terms` | `github-code-scanning`, check `CodeQL` | no | [1](https://docs.github.com/en/rest/code-scanning/code-scanning) [2](https://docs.github.com/en/code-security/codeql-cli/codeql-cli-manual/database-analyze) (2026-11-17) |
| `snyk-code` | Snyk Code | local, server | `SNYK_TOKEN` | `LicenseRef-Snyk-Terms` | `check-only`, check `code/snyk` | no | [1](https://docs.snyk.io/snyk-cli/commands/code-test) [2](https://unpkg.com/snyk@1.1308.4/help/cli-commands/code-test.md) (2026-11-17) |
| `snyk-open-source` | Snyk Open Source | local, server | `SNYK_TOKEN` | `LicenseRef-Snyk-Terms` | `check-only`, check `security/snyk` | no | [1](https://docs.snyk.io/snyk-cli/commands/test) [2](https://unpkg.com/snyk@1.1308.4/help/cli-commands/test.md) (2026-11-17) |
| `sonarqube` | SonarQube Server (Developer edition or higher for pull request analysis) / SonarQube Cloud | server | `SONAR_TOKEN` | `LicenseRef-SonarSource-Commercial` | `sonarqube`, check `SonarQube Code Analysis` | no | [1](https://docs.sonarsource.com/sonarqube-server/latest/extension-guide/web-api/) [2](https://next.sonarqube.com/sonarqube/web_api/api/qualitygates/project_status) [3](https://next.sonarqube.com/sonarqube/web_api/api/issues/search) (2026-11-17) |
| `checkmarx` | Checkmarx One | local, server | `CX_CLIENT_SECRET` (and `CX_CLIENT_ID`, `CX_BASE_URI`, `CX_TENANT`, `CX_BASE_AUTH_URI`) | `LicenseRef-Checkmarx-One` | `check-only`, check `Checkmarx One Scan` | no | [1](https://docs.checkmarx.com/en/34965-68643-scan.html) [2](https://docs.checkmarx.com/en/34965-112039-sarif-output-for-checkmarx-one--example-for-github-action-.html) [3](https://docs.checkmarx.com/en/34965-350124-running-scans-via-the-cli.html) (2026-11-17) |
| `veracode` | Veracode Pipeline Scan | local, server | `VERACODE_API_KEY_SECRET` (and `VERACODE_API_KEY_ID`) | `LicenseRef-Veracode` | `check-only`, check `Veracode` | no | [1](https://docs.veracode.com/r/r_pipeline_scan_commands) [2](https://docs.veracode.com/r/t_run_pipeline_scan) [3](https://hub.docker.com/r/veracode/pipeline-scan) [4](https://github.com/veracode/veracode-pipeline-scan-results-to-sarif) (2026-11-17) |

Notes on each definition, as the pack records them:

- `semgrep`: Checked against the documentation and a fake findings API; not run against a Semgrep deployment.
- `codeql`: The REST endpoints were read from the documentation and run against a fake. One live read-only call on 2026-11-17 to the public test repository (no code scanning set up there): analyses and alerts both answer 404 "no analysis found", which the adapter reads as a pending result (the head waits, then fails closed at the timeout). No alert was read live. The CodeQL CLI is on the factory's rejected licence list (closed-source use needs paid GitHub Advanced Security): the person accepting it adds "rejected": true.
- `snyk-code`: Exit codes and flags from the CLI's own help (snyk@1.1308.4). Server mode waits for Snyk's check on the head; Snyk's findings API is not read (findings come from the local CLI run).
- `snyk-open-source`: Exit codes and flags from the CLI's own help (snyk@1.1308.4).
- `sonarqube`: Web API paths from SonarSource's web API reference (api/qualitygates/project_status with pullRequest, api/issues/search with pullRequest). SonarQube Server does not return the analysed commit of a pull request (a SonarSource community answer), so the head binding comes from the scanner's check on the host, which is required.
- `checkmarx`: Flags from the scan create reference (--report-format sarif, --output-path, --output-name, default name cx_result); the exit code on findings is not documented, so the definition reads findings from the SARIF report and a non-zero exit without a report fails closed.
- `veracode`: Unverified. Parameters (--file, --json_output_file, default results.json) from the Pipeline Scan parameters page; credentials go in a credentials file the definition writes from the environment for the scan's own HOME and deletes afterwards (printf is a shell builtin, so the values never appear on a command line). No public schema of results.json was found: the parser reads the 0-5 severity scale Veracode's SARIF converter documents and the fields findings[].severity, cwe_id, files.source_file.file/line. Pipeline Scan's exit code counts flaws, so a missing report, not the exit code, is the failure signal.
<!-- /generated:commercial-definitions -->

### Verification

None of these definitions was run against the real product: the build machine has no licence or login for any of them. Each one was written from the vendor's current public documentation (the links and dates above), and tested against fakes:

- `scripts/pipeline/test/fakes/fake-scanner-cli.mjs` stands in for a vendor CLI writing SARIF, for local mode in the fix loop and in the generated CI script.
- `scripts/pipeline/test/fakes/providers-fake-server.mjs` serves SonarQube's web API, GitHub code scanning's REST API and Semgrep's findings API, for server mode.

GitHub code scanning had one live read-only call against the public test repository on 2026-11-17. It answered 404 "no analysis found", which the adapter reads as pending. Before relying on a definition, run it once against the client's service: `factory adapter check scanner` in server mode, or a local `factory analysis run` in local mode.

Gaps stated plainly:

- **Snyk, Checkmarx One and Veracode in server mode** wait for the vendor's check on the head. Their findings APIs are not read, so in server mode severities and triage stay in the vendor's UI. For findings in the fix loop, use local mode as well.
- **Veracode Pipeline Scan's** `results.json` has no public schema. The parser reads the fields Veracode's own SARIF converter documents.
- **Checkmarx's** exit code on findings is not documented. The definition trusts the SARIF report, and fails closed without one.
- **The default check names** (`SonarQube Code Analysis`, `code/snyk`, `semgrep-cloud-platform/scan`, ...) depend on how the client installed the integration. Set `check` to the exact name the client's pull requests show.

## Your own scanner service

A scanner that has no definition here takes two parts:

1. A tool in `analysis.tools` with a `commercial` block. For local mode, also a `run` command and a parser (`sarif`, or `module:<path>`).
2. For server mode, a [custom adapter](custom.md#worked-example-a-scanner-service) script that answers `checkName` and `result`.

The worked example in [custom.md](custom.md) is tested end to end.

## Server-mode adapters

The capability tables of the server-mode adapters (`scripts/pipeline/lib/analysis/scanners/`), generated from their code.

### SonarQube

<!-- generated:capabilities-sonarqube -->
| Capability | This adapter | Without it, the harness |
| --- | --- | --- |
| `serverSide` | yes | nothing to change |
| `prAnalysis` | yes | nothing to change |
| `triageStates` | yes | nothing to change |
| `sarif` | no | the vendor JSON is mapped by the definition's parser |
| `shaBound` | no | the scanner's check on the head binds the result to the head (analysis.commercial.check, required); without a check name the head is never green |
<!-- /generated:capabilities-sonarqube -->

### GitHub code scanning

<!-- generated:capabilities-github-code-scanning -->
| Capability | This adapter | Without it, the harness |
| --- | --- | --- |
| `serverSide` | yes | nothing to change |
| `prAnalysis` | yes | nothing to change |
| `triageStates` | yes | nothing to change |
| `sarif` | yes | nothing to change |
| `shaBound` | no | the scanner's check on the head binds the result to the head (analysis.commercial.check, required); without a check name the head is never green |
<!-- /generated:capabilities-github-code-scanning -->

### Semgrep

<!-- generated:capabilities-semgrep -->
| Capability | This adapter | Without it, the harness |
| --- | --- | --- |
| `serverSide` | yes | nothing to change |
| `prAnalysis` | yes | nothing to change |
| `triageStates` | yes | nothing to change |
| `sarif` | yes | nothing to change |
| `shaBound` | no | the scanner's check on the head binds the result to the head (analysis.commercial.check, required); without a check name the head is never green |
<!-- /generated:capabilities-semgrep -->

### Check only

<!-- generated:capabilities-check-only -->
| Capability | This adapter | Without it, the harness |
| --- | --- | --- |
| `serverSide` | partial | only local CLI mode |
| `prAnalysis` | yes | nothing to change |
| `triageStates` | no | every finding is open unless the factory baseline says pre-existing |
| `sarif` | no | the vendor JSON is mapped by the definition's parser |
| `shaBound` | no | the scanner's check on the head binds the result to the head (analysis.commercial.check, required); without a check name the head is never green |
<!-- /generated:capabilities-check-only -->
