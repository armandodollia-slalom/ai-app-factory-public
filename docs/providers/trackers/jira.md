# Jira (tracker)

**Who reads this:** B and C using this product. Verified against fakes only unless the [status table](../README.md#verified-live-or-only-against-fakes) says otherwise.

`tracker.type: "jira"`, for Jira Cloud (REST v3, bodies in Atlassian Document Format) and Jira Data Center / Server (REST v2, wiki markup). `tracker.deployment` (`"cloud"` or `"datacenter"`) picks one. Without it the host name decides, and a self-hosted URL is checked with `/rest/api/2/serverInfo`. The adapter is `scripts/board/lib/trackers/jira.mjs`.

```json
"tracker": {
  "type": "jira",
  "url": "https://acme.atlassian.net",
  "project": "SHOP",
  "auth": { "user": "${JIRA_EMAIL}", "token": "${JIRA_API_TOKEN}" },
  "lanes": { "backlog": "Backlog", "ready": "Selected for Development", "inProgress": "In Progress", "review": "In Review", "done": "Done", "blocked": "Blocked" },
  "types": { "epic": "Epic", "story": "Story", "bug": "Bug", "spike": "Task" },
  "fields": { "severity": "customfield_10050" }
}
```

**Credentials:**

- **Cloud:** an API token of a user who can browse, create, edit, transition and comment on issues and add attachments in the project. `auth.user` is that user's email.
- **Data Center:** a personal access token (`auth.token` only, sent as a bearer token).

**By hand:** a project administrator owns the workflow statuses the lanes map to and the transitions between them. Custom fields for the triage values must be on the project's screens and mapped in `tracker.fields`. `factory board setup --dry-run` (also run by doctor) lists what is missing.

**Mapping:**

- **Keys and epics:** the key is the Jira key. A ticket the factory created is found by its `factory-key-<KEY>` label. Epics use `parent` (Cloud) or the Epic Link field (`tracker.fields.epicLink`, Data Center).
- **Metadata:** kept in the issue property `factory.ticket`, so a person editing the description never loses it.
- **Pull requests:** a pull request is a remote link.

## Capabilities

<!-- generated:capabilities-jira -->
| Capability | This adapter | Without it, the harness |
| --- | --- | --- |
| `boardLanes` | yes | nothing to change |
| `customFields` | yes | nothing to change |
| `parentChild` | yes | nothing to change |
| `attachments` | yes | nothing to change |
| `commentEdit` | yes | nothing to change |
| `bodyHistory` | yes | nothing to change |
| `archive` | no | an abandoned ticket stays in its lane, closed |
| `labels` | yes | nothing to change |
| `assignees` | yes | nothing to change |
<!-- /generated:capabilities-jira -->

**Verified:** against fakes only (`scripts/board/test/fixtures/fake-tracker-server.mjs`). API docs: <https://developer.atlassian.com/cloud/jira/platform/rest/v3/intro/>, <https://docs.atlassian.com/software/jira/docs/api/REST/9.12.0/>.
