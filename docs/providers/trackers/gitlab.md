# GitLab Issues (tracker)

**Who reads this:** B and C using this product. Verified against fakes only unless the [status table](../README.md#verified-live-or-only-against-fakes) says otherwise.

`tracker.type: "gitlab"`, the default with a GitLab host. Tickets are issues of `tracker.project`, the ticket id is the issue's iid, types and lanes are labels (a board list is a label), and `done` also closes the issue. The adapter is `scripts/board/lib/trackers/gitlab.mjs` (REST API v4).

```json
"tracker": { "type": "gitlab", "url": "https://gitlab.com", "project": "group/app", "auth": { "token": "${GITLAB_TOKEN}" },
             "board": { "id": 7 }, "lanes": { "backlog": "", "ready": "Ready", "inProgress": "In Progress", "review": "In Review", "done": "Done" } }
```

**Credentials:** a project, group or personal access token with scope `api`. Role **Reporter** can read; **Developer** can label, move and close issues. When the issues live in the host's own project, the host token is used.

**What GitLab Issues cannot do, and what the harness does instead:**

- No custom fields the API can write on every tier. The triage values stay in the ticket's triage section.
- GitLab's own epics are group-level and need Premium. An epic is an issue with the epic label: its children carry `factory-parent-<iid>` and a "relates to" link (`parentChild: partial`).
- No description history. A ticket edited after it was verified is re-read as it is now, and the plan is verified again.

**By hand:** the board's lists, one per lane label (setup creates the missing labels). With issues and merge requests in the same project, the pull request body says `Closes #N`, so merging closes the issue.

## Capabilities

<!-- generated:capabilities-gitlab -->
| Capability | This adapter | Without it, the harness |
| --- | --- | --- |
| `boardLanes` | yes | nothing to change |
| `customFields` | no | the triage values live in the ticket's triage section only |
| `parentChild` | partial | an epic lists its children in its body; children name the epic in a label |
| `attachments` | partial | files are linked from the repository's storage branch |
| `commentEdit` | yes | nothing to change |
| `bodyHistory` | no | a ticket edited after it was verified is fetched as it is now, and the plan is verified again |
| `archive` | no | an abandoned ticket stays in its lane, closed |
| `labels` | yes | nothing to change |
| `assignees` | yes | nothing to change |
<!-- /generated:capabilities-gitlab -->

**Verified:** against fakes only. API docs, read 2026-11-17: <https://docs.gitlab.com/api/issues/>, <https://docs.gitlab.com/api/notes/>, <https://docs.gitlab.com/api/issue_links/>, <https://docs.gitlab.com/api/boards/>, <https://docs.gitlab.com/api/labels/>, <https://docs.gitlab.com/api/project_markdown_uploads/>.
