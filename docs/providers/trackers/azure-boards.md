# Azure Boards (tracker)

`tracker.type: "azure-boards"`, the default with an Azure DevOps host. Tickets are work items, epics are parents (Hierarchy links), lanes are `System.State` values, fields are field reference names, labels are tags, and pull requests are Hyperlinks. The adapter is `scripts/board/lib/trackers/azure-boards.mjs`.

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

**Credentials:** a PAT with **Work Items (Read & write)**. In Azure Pipelines, the build service's token works too, with "Edit work items in this node" on the area path.

**By hand:**

- Board columns for the lanes.
- An inherited process with the custom fields for the triage values, mapped in `tracker.fields`.
- `types` set to match the process: Agile uses User Story, Scrum uses Product Backlog Item, Basic uses Issue.

The key is `AB-<id>`; `tracker.keyPrefix` changes the prefix.

## Capabilities

<!-- generated:capabilities-azure-boards -->
| Capability | This adapter | Without it, the harness |
| --- | --- | --- |
| `boardLanes` | yes | nothing to change |
| `customFields` | yes | nothing to change |
| `parentChild` | yes | nothing to change |
| `attachments` | yes | nothing to change |
| `commentEdit` | yes | nothing to change |
| `bodyHistory` | yes | nothing to change |
| `archive` | no | an abandoned ticket stays in its lane, closed |
| `labels` | partial | the factory's markers live in its metadata block |
| `assignees` | yes | nothing to change |
<!-- /generated:capabilities-azure-boards -->

**Verified:** against fakes only. API docs: <https://learn.microsoft.com/rest/api/azure/devops/wit/work-items>, <https://learn.microsoft.com/rest/api/azure/devops/wit/wiql>.
