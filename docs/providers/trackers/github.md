# GitHub Issues and Projects (tracker)

**Who reads this:** B and C using this product. Verified against fakes only unless the [status table](../README.md#verified-live-or-only-against-fakes) says otherwise.

`tracker.type: "github"`, the default with a GitHub host. Tickets are issues, epics have sub-issues, the lanes are the Status field of a Projects (v2) board, the triage values are project fields, and attachments go to the `board-assets` branch. The adapter (`scripts/board/lib/trackers/github.mjs`) is the board stage's v0.2.68 code moved behind the tracker contract, and it makes the same `gh` calls.

```json
"tickets": { "repo": "acme/shop" },
"board": { "owner": "acme", "repo": "acme/shop", "projectNumber": 3 }
```

(or `"tracker": { "type": "github", "project": "acme/shop", "board": { ... } }`). The legacy keys keep working unchanged.

**Credentials:** the `gh` login with the `project` scope. In GitLab CI or Azure Pipelines, a `GH_TOKEN` variable with Issues (read and write) and Projects (read and write).

**Setup:** `factory board setup` creates the lanes, labels and fields and changes nothing that already exists. `factory board guide` prints these steps, and the [`setup-board`](../../../skills/setup-board/SKILL.md) skill walks through them.

## Capabilities

<!-- generated:capabilities-github -->
| Capability | This adapter | Without it, the harness |
| --- | --- | --- |
| `boardLanes` | yes | nothing to change |
| `customFields` | yes | nothing to change |
| `parentChild` | yes | nothing to change |
| `attachments` | partial | files are linked from the repository's storage branch |
| `commentEdit` | yes | nothing to change |
| `bodyHistory` | yes | nothing to change |
| `archive` | yes | nothing to change |
| `labels` | yes | nothing to change |
| `assignees` | yes | nothing to change |
<!-- /generated:capabilities-github -->

**Verified:** read-only `factory adapter check tracker` against the public test repository and its project on 2026-11-17 (20 pass, 16 skipped write checks), and the v0.2.68 board suites, which run unchanged.
