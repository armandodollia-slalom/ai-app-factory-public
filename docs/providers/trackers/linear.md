# Linear (tracker)

`tracker.type: "linear"`. Tickets are issues of the team `tracker.project` (the team key), and the ticket id is the identifier (`ENG-123`). Epics are parent issues, lanes are the team's workflow states, and types are labels. The adapter is `scripts/board/lib/trackers/linear.mjs` (GraphQL, `https://api.linear.app/graphql`).

```json
"tracker": { "type": "linear", "project": "ENG", "auth": { "token": "${LINEAR_API_KEY}" },
             "lanes": { "backlog": "Backlog", "ready": "Todo", "inProgress": "In Progress", "review": "In Review", "done": "Done" } }
```

**Credentials:** a personal API key (Linear → Settings → Security & access → Personal API keys) with read and write access to the team's issues. It is sent in `Authorization` without "Bearer". An OAuth app token goes in as `"Bearer ${LINEAR_OAUTH_TOKEN}"`.

**What Linear cannot do, and what the harness does instead:**

- No custom fields. The triage values stay in the ticket's triage section.
- No description history (see GitLab).
- File uploads use Linear's signed upload flow, which is not used. Files are linked instead (`attachments: partial`).
- The factory's ticket metadata lives in an attachment on the issue (`<issue url>#factory-ticket`), so a person editing the description never loses it.

**By hand:** a team admin adds any missing workflow states (Settings → Teams → Workflow). Setup creates the missing labels.

## Capabilities

<!-- generated:capabilities-linear -->
| Capability | This adapter | Without it, the harness |
| --- | --- | --- |
| `boardLanes` | yes | nothing to change |
| `customFields` | no | the triage values live in the ticket's triage section only |
| `parentChild` | yes | nothing to change |
| `attachments` | partial | files are linked from the repository's storage branch |
| `commentEdit` | yes | nothing to change |
| `bodyHistory` | no | a ticket edited after it was verified is fetched as it is now, and the plan is verified again |
| `archive` | yes | nothing to change |
| `labels` | yes | nothing to change |
| `assignees` | partial | epic assignees are not copied to children |
<!-- /generated:capabilities-linear -->

**Verified:** against fakes only. API docs, read 2026-11-17: <https://linear.app/developers/graphql> and Linear's public GraphQL schema.
