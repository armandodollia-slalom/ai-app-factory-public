# Provider contracts

**Who reads this:** D, writing or changing an adapter.

Every adapter implements the contract of its kind. The contracts were derived from the factory's own call sites: each operation below is something the engine actually does. They live in `scripts/pipeline/lib/providers/contracts.mjs`, and the tables on this page are generated from that file, so they always match the code.

Rules every adapter follows:

- **Synchronous or blocking.** The review gate and the CI wait are synchronous. REST adapters therefore run their requests through one blocking bridge (`scripts/pipeline/lib/blocking.mjs`), each with a timeout, with retries on 429 and 5xx that honour `Retry-After`.
- **Normalised values.** Pull requests, tickets, runs and findings have the shapes listed under *Returns*, whatever the product calls them.
- **`UnsupportedError` for a missing capability.** An operation the product cannot do throws `UnsupportedError` with the fallback in its message. The harness then degrades as the capability table says; it never guesses.
- **Errors without secrets.** A message names the operation and the HTTP status, never a token, and a URL never carries one.
- **A refused text is its own error.** A call that sends text (a pull request, a ticket, a comment) and is refused for that text (a content filter: a 4xx naming spam or content, or a 403 with no reason) throws an error with code `refused` (`HostRefusedError` for a host, `TrackerError('refused')` for a tracker), never the permission (`auth`) or rate-limit error. The engine then sends the same call again with a shorter body in a fixed order, with no agent ([a host that refuses the PR's text](../ai-pipeline/implement-reference.md#a-host-that-refuses-the-prs-text)); a custom adapter that throws an error whose message carries such a 403 is classed the same way.
- **No product names in the engine.** Engine code reaches products only through these contracts. `scripts/pipeline/test/providers-audit.test.mjs` fails when engine code calls `gh` directly or names a provider outside the adapters, packs and templates.

The mode column says what an operation does: `read` changes nothing, `write` changes one item the pipeline owns, and `admin` changes a board's or repository's settings (run by a person, with a dry run first). `factory adapter check` runs only `read` operations unless you pass `--write`.

## Operations and capabilities

<!-- generated:contracts -->
### tracker

| Operation | Mode | Needs capability | What it does | Arguments | Returns |
| --- | --- | --- | --- | --- | --- |
| `reachable` | read | required | the API answers with these credentials | none | `{ ok, reason }` |
| `identity` | read | required | who the credentials act as | none | `{ login, id }` |
| `active` | read | required | the board is configured for this checkout (not a fork, not switched off) | none | `bool` |
| `available` | read | required | tickets are readable from this checkout | none | `bool` |
| `tickets.get` | read | required | a ticket by id or key | `id` | `ticket \| null (normalised: id, key, type epic\|story\|bug\|spike, title, body, state open\|closed, stateReason, labels, assignees, parent, url, updatedAt)` |
| `tickets.find` | read | required | the ticket of a factory key (PROJ-12), remembered in .factory/state/board.json | `key` | `ticket \| null` |
| `tickets.list` | read | required | tickets by type, state, parent, label, update time | `{ type, state, parent, label, updatedSince }` | `[ticket]` |
| `tickets.search` | read | required | open tickets whose title holds a text (follow-ups are filed once) | `{ text, state }` | `[ticket]` |
| `tickets.create` | write | required | a ticket (story, bug, epic, spike, follow-up) | `{ type, key, title, body, parent, labels, fields }` | `ticket` |
| `tickets.update` | write | required | title, body, labels { add, remove }, state, assignees, fields | `id, changes` | `nothing` |
| `tickets.children` | read | `parentChild` | an epic's children | `id` | `[ticket]` |
| `tickets.parent` | read | `parentChild` | a ticket's epic | `id` | `ticket \| null` |
| `tickets.setParent` | write | `parentChild` | makes a ticket a child of an epic | `child, parent` | `nothing` |
| `tickets.comment` | write | required | adds or edits in place the comment carrying a marker (owner questions, escalations, evidence) | `id, body, { marker }` | `{ id, url }` |
| `tickets.comments` | read | required | a ticket's comments | `id` | `[{ id, author, body, createdAt, url }]` |
| `tickets.editComment` | write | `commentEdit` | edits a comment | `id, commentId, body` | `nothing` |
| `tickets.attach` | write | `attachments` | attaches a file (a mockup) | `id, { name, data }` | `{ url, name }` |
| `tickets.attachments` | read | `attachments` | a ticket's files | `id` | `[{ name, url, size, sha256? }]` |
| `tickets.download` | read | `attachments` | one attachment to a local file | `attachment, dest` | `nothing` |
| `tickets.link` | write | required | links a pull request (which may live on another product) to the ticket | `id, { url, title }` | `nothing` |
| `tickets.history` | read | `bodyHistory` | earlier versions of the description, newest first | `id` | `[body]` |
| `labels.ensure` | write | `labels` | a label or tag exists | `name, { color, description }` | `nothing` |
| `format.render` | read | required | the stored description for a ticket (the factory's metadata block survives a person's edit) | `ticketInfo, markdown` | `{ body, meta }` |
| `format.parse` | read | required | the factory's Markdown and metadata out of a stored description | `ticket` | `{ content, meta }` |
| `board.lanes` | read | required | the pipeline's lanes and this tracker's statuses or columns for them | none | `[{ lane, name, id }]` |
| `board.lane` | read | `boardLanes` | a ticket's lane | `id` | `lane \| null` |
| `board.item` | read | required | a ticket's card (added to the board when missing) | `ticket` | `{ id, column }` |
| `board.move` | write | required | moves a ticket to a lane | `id, lane` | `nothing` |
| `board.moveItem` | write | required | moves a card to a lane | `itemId, lane` | `nothing` |
| `board.archiveItem` | write | `archive` | takes a card off the board (abandoned tickets) | `itemId` | `nothing` |
| `board.items` | read | required | the cards of this repository (a shared board's other cards only with repoScoped: false) | `{ lane, repoScoped }` | `[{ itemId, column, status, number, key, title, url, state, repo, labels, assignees, parent, stateReason, severity }]` |
| `board.fields.get` | read | `customFields` | the triage fields of a ticket | `id` | `{ severity, impact, complexity, fixRisk, confidence, reopens }` |
| `board.fields.set` | write | `customFields` | sets triage fields | `id, values` | `nothing` |
| `board.fields.ensure` | admin | `customFields` | creates missing triage fields (or lists them for a person) | `{ log, dryRun }` | `[name]` |
| `board.setup` | admin | required | creates or verifies lanes, labels and fields without changing anything that exists; a shared board is never rewritten | `{ dryRun, log }` | `{ url, done, manual }` |
| `board.syncAssignees` | write | `assignees` | gives an epic's open children the epic's assignees | `id` | `[changed]` |

Capabilities of a tracker adapter (`safety`: the harness keeps the safety property another way, never by skipping it):

| Capability | Safety | Means | Without it |
| --- | --- | --- | --- |
| `boardLanes` | no | a board whose columns or statuses the pipeline moves tickets through | lanes are labels (`lane:<name>`) on the ticket |
| `customFields` | no | custom fields for the triage values (Severity, Impact, ...) | the triage values live in the ticket's triage section only |
| `parentChild` | no | epics with child tickets | an epic lists its children in its body; children name the epic in a label |
| `attachments` | no | files on a ticket (mockups, evidence) | files are linked from the repository's storage branch |
| `commentEdit` | no | a comment can be edited in place (the rolling evidence comment) | a new comment per update |
| `bodyHistory` | no | earlier versions of a ticket's description | a ticket edited after it was verified is fetched as it is now, and the plan is verified again |
| `archive` | no | a card can be taken off the board without deleting the ticket | an abandoned ticket stays in its lane, closed |
| `labels` | no | labels or tags on tickets | the factory's markers live in its metadata block |
| `assignees` | no | tickets have assignees | epic assignees are not copied to children |

### host

| Operation | Mode | Needs capability | What it does | Arguments | Returns |
| --- | --- | --- | --- | --- | --- |
| `identity` | read | required | who the token acts as | none | `{ login, id }` |
| `repo.defaultBranch` | read | required | the repository's default branch | none | `string` |
| `repo.file` | read | required | a file's text at a ref, or null | `path, ref` | `string \| null` |
| `repo.list` | read | required | the files of a folder at a ref (CI definitions) | `dir, ref` | `[path]` |
| `repo.permissions` | read | required | what the token may do | none | `{ push, pullRequests, admin }` |
| `repo.branchProtection` | read | `requiredChecks` | the rules on a branch | `branch?` | `{ enforced, requiredChecks, requiredApprovals, codeOwnerReview, via } \| { unavailable, reason } \| null` |
| `repo.settings` | read | required | repository settings the gate reports | none | `{ autoMergeAllowed: bool\|null }` |
| `repo.enforceReviewGate` | admin | `requiredChecks` | require review-quorum, the CI checks and code-owner review (`factory review-gate enforce`, a person runs it) | `{ codeOwners, review, requiredChecks, dryRun }` | `{ action, summary, manual, warnings }` |
| `repo.ensureLabel` | write | `labels` | a label exists (GitHub needs it before use) | `name, { color, description }` | `nothing` |
| `pr.open` | write | required | opens a pull request | `{ head, base, title, body, draft, labels, reviewers }` | `pr` |
| `pr.get` | read | required | one pull request by number, URL or head branch | `pr` | `pr \| null (normalised: number, url, title, body, state open\|merged\|closed, draft, head, base, headSha, author, labels, mergeable, mergeState, autoMerge, createdAt, updatedAt, mergedAt, closedAt, mergeCommit)` |
| `pr.list` | read | required | pull requests by state, head, base, label or words in the title | `{ state, head, base, label, search, limit }` | `[pr]` |
| `pr.update` | write | required | title, body, labels { add, remove }, state, draft | `pr, changes` | `nothing` |
| `pr.close` | write | required | closes a pull request (the retro self-test) | `pr` | `nothing` |
| `pr.comment` | write | required | adds or edits in place the comment carrying a marker | `pr, body, { marker }` | `{ id, url }` |
| `pr.comments` | read | required | the conversation comments | `pr` | `[{ id, author, body, createdAt, url }]` |
| `pr.reviews` | read | required | reviews with their state and commit | `pr` | `[{ id, author, bot, state approved\|changes_requested\|commented\|dismissed, submittedAt, commit, body }]` |
| `pr.reviewComments` | read | `reviewCommentThreads` | line review comments | `pr` | `[{ id, author, body, path, line, reviewId, createdAt }]` |
| `pr.stateEvents` | read | `stateEvents` | the PR's close, reopen and merge events | `pr` | `[{ id, type closed\|reopened\|merged, at, actor }]` |
| `pr.commits` | read | required | the PR's commits | `pr` | `[{ sha, author, committedAt, parents, message }]` |
| `pr.files` | read | required | the changed files | `pr` | `[{ path, status, additions, deletions }]` |
| `pr.diff` | read | `diff` | the unified diff | `pr` | `string` |
| `pr.checks` | read | required | the checks and statuses the host shows for the PR's head | `pr` | `[{ name, status pending\|completed, conclusion success\|failure\|cancelled\|skipped\|neutral\|null, url }] \| null when none are reported` |
| `pr.mergeState` | read | required | whether the host would merge now (asked again while it is still computing) | `pr` | `{ state open\|merged\|closed, mergeState clean\|dirty\|blocked\|behind\|unstable\|unknown, mergedAt, autoMerge }` |
| `pr.merge` | write | required | merges, bound to the head SHA the gate assessed; `auto` hands the merge to the host (only with implement.autoMerge.native) | `pr, { method, headSha, auto }` | `{ merged, mergedAt, autoMerge }` |
| `pr.cancelAutoMerge` | write | `cancelAutoMerge` | disarms the host's auto-merge | `pr` | `nothing` |
| `pr.requestReviewers` | write | required | asks people for a review; unknown logins are skipped | `pr, logins` | `[login]` |
| `pr.setStatus` | write | `commitStatus` | posts a named status on a commit | `sha, { name, state, description, url }` | `nothing` |
| `pr.uploadAttachment` | write | `attachments` | uploads a file and returns its URL | `pr, file` | `url` |
| `issues.search` | read | required | open issues on the host by title (factory feedback issues of the retro) | `{ text, state }` | `[{ number, title, url }]` |
| `issues.create` | write | required | an issue on the host (the retro's factory issues) | `{ title, body, labels }` | `{ number, url }` |

Capabilities of a host adapter (`safety`: the harness keeps the safety property another way, never by skipping it):

| Capability | Safety | Means | Without it |
| --- | --- | --- | --- |
| `requiredChecks` | no | the host can require named checks before a merge (rulesets, protected branches, branch policies) | the review gate refuses to merge until every expected pipeline of the head is green and bound to that SHA; doctor says the host cannot enforce it |
| `codeOwners` | no | the host can require a code owner's review for paths | the gate keeps its own approvals:N label and requests the owners as reviewers; doctor says owner review is advisory |
| `autoMerge` | no | the host merges a PR by itself once its requirements are met | the gate never arms host auto-merge; `board sync` merges a cleared PR itself when its head is green |
| `mergeHeadGuard` | yes | a merge can be bound to the head SHA the gate assessed (refused if the branch moved) | the gate re-reads the head right before merging and refuses if it moved; with no way to bind the merge itself, auto-merge stays off on this host |
| `cancelAutoMerge` | yes | an armed auto-merge can be disarmed | host auto-merge is never armed (no way to disarm it on a new head) |
| `drafts` | no | draft pull requests | the PR opens ready for review, with "Draft" in its title |
| `labels` | no | labels on pull requests | approvals:N and the gate's labels live in the gate notice comment only |
| `checkAnnotations` | no | per-line check annotations | findings are listed in the PR comment and the PR body |
| `commitStatus` | no | the harness can post a named status on a commit (review-quorum from a CI system without review events) | review-quorum runs only where the CI system has review events; the gate itself stays the merge authority |
| `attachments` | no | files (videos, screenshots) can be uploaded to a PR | videos go to the storage branch and are linked |
| `botIdentity` | no | a separate PR identity (an App, a project access token, a service principal) | PRs open as the developer's own identity; doctor says so |
| `diff` | no | the PR's unified diff from the API | git diff of the base and head locally |
| `reviewCommentThreads` | no | line review comments | reopens are counted from review states only |
| `stateEvents` | yes | the close, reopen and merge events of a pull request | a person's close or reopen of a PR cannot be told from the pipeline's holds, so a bug fix on this host never merges itself (the review gate asks a person) |

### ci

| Operation | Mode | Needs capability | What it does | Arguments | Returns |
| --- | --- | --- | --- | --- | --- |
| `expected` | read | `expectedFromDefinition` | the pipelines a head must run before anything may call it green, from the CI definition at that head (fail closed: unreadable definitions are expected and missing) | `{ head, base, changed, pr, branch, mode pr\|push, activities }` | `[{ id, name, required, unreadable?, prOnly? }] (mode pr: required for the activities the head went through, opened\|synchronize\|reopened\|ready_for_review\|labeled, every one of opened, synchronize and reopened when unknown; mode push: the pipelines a push of `branch` runs, plus prOnly entries for those only a pull request runs)` |
| `runs` | read | `runsByCommit` | the runs of one head (the newest run that executed wins per pipeline; a skipped run never supersedes one that ran) | `{ head, branch, pr }` | `[{ id, pipeline, name, status queued\|running\|completed, conclusion success\|failure\|cancelled\|skipped\|neutral\|null, event, url, sha }]` |
| `log` | read | `logs` | a run's log text (failed jobs only with failedOnly) | `runId, { failedOnly }` | `string` |
| `uncoveredChecks` | read | required | the jobs of the repository's own pipelines that no host rule requires, and why (doctor and `review-gate enforce` name them) | `root` | `[{ workflow, job, name, reason }]` |
| `rerun` | write | `rerun` | starts a failed run again | `runId` | `nothing` |
| `requiredChecks` | read | required | the check names a host should require for every PR, from the definitions in the checkout | `root` | `[name]` |

Capabilities of a ci adapter (`safety`: the harness keeps the safety property another way, never by skipping it):

| Capability | Safety | Means | Without it |
| --- | --- | --- | --- |
| `logs` | no | a run's log can be read (failed jobs' logs, retried tests) | a red run becomes a finding with its link only; retry-only passes cannot be detected, so a green run is not called flaky-free in the PR body |
| `expectedFromDefinition` | yes | which pipelines a head must run can be derived from the CI definition at that head | the expected pipelines come from `ci.expected` in .factory/config.json; without it no head is ever green (the gate fails closed) |
| `runsByCommit` | yes | runs can be listed for one commit SHA | without it the CI system cannot give evidence for a head: the CI adapter is unusable for the gate (doctor fails) |
| `reviewEvents` | no | a pipeline can start on review events (review-quorum) | review-quorum is posted as a commit status by `board sync` (needs the host's commitStatus) |
| `schedules` | no | scheduled pipelines in the definition (retro, tracker sweep, cache prune) | the schedules are created by hand in the CI system; docs list them |
| `rerun` | no | a failed run can be started again | a person reruns it; the gate waits |
| `branchPipelines` | no | a push of a story branch runs the pipelines before any pull request exists, so a head is proven green before its PR opens (implement.preOpen) | the PR opens as a draft (or held by the work-in-progress label on a host without drafts) and is marked ready only when its pipelines are green on its head |

### scanner

| Operation | Mode | Needs capability | What it does | Arguments | Returns |
| --- | --- | --- | --- | --- | --- |
| `result` | read | `serverSide` | the scan of one head: pending, complete or failed, with its findings (vendor rule ids, severities, triage states) | `{ head, pr, branch, base }` | `{ status pending\|complete\|failed, url, analysisId, findings: [{ rule, severity, level, path, line, message, cwe, fingerprint, triage open\|suppressed\|accepted\|false-positive\|fixed }] }` |
| `checkName` | read | required | the check the scan reports on the head (joins the expected checks) | none | `string \| null` |

Capabilities of a scanner adapter (`safety`: the harness keeps the safety property another way, never by skipping it):

| Capability | Safety | Means | Without it |
| --- | --- | --- | --- |
| `serverSide` | no | the scan runs in the vendor's service or the client's CI, and its result is fetched for a head SHA | only local CLI mode |
| `prAnalysis` | no | results for a pull request / diff, not only a branch | branch results for the head SHA, baselined against the merge-base by fingerprint |
| `triageStates` | no | the vendor's own suppression or triage state per finding | every finding is open unless the factory baseline says pre-existing |
| `sarif` | no | SARIF output | the vendor JSON is mapped by the definition's parser |
| `shaBound` | yes | a result names the commit it is of | the scanner's check on the head binds the result to the head (analysis.commercial.check, required); without a check name the head is never green |
<!-- /generated:contracts -->

**Holding a PR.** The harness re-reads a PR with `pr.get` to confirm every hold and release, and reads its `state` at plan time to find an open PR before any agent runs (a failed read counts as open). A host adapter must return `draft`, `labels` and `state` (`open` or `closed`), or every hold ends `hold-failed`. An adapter that cannot reopen a closed PR sets `reopenPr: false` beside its capabilities (not yet a contract capability; Bitbucket does) and throws `UnsupportedError` from `pr.update` on `state: 'open'`. Its PRs are held as drafts, else with a label, never closed; a host that can do none of the three cannot hold a PR, and every hold ends `hold-failed`.

## Adding a product

Either write a `custom` adapter script ([custom.md](custom.md)), which needs no change to the factory, or add a built-in:

1. A module under `scripts/pipeline/lib/hosts/`, `scripts/board/lib/trackers/`, `scripts/pipeline/lib/ci/` or `scripts/pipeline/lib/analysis/scanners/`, exporting its `CAPABILITIES` and a create function. Its header names the vendor documentation it was written from and the date it was read.
2. Its type in `scripts/pipeline/lib/products.mjs` (and its URL detection, if any).
3. A fake under `scripts/pipeline/test/fakes/` built from the same documentation, and a conformance test in `scripts/pipeline/test/adapters-conformance.test.mjs`.
4. A page under `docs/providers/`, and an entry in `BUILTINS` in `scripts/pipeline/lib/providers/docs.mjs`. Run `node scripts/pipeline/lib/providers/docs.mjs --write` to fill in its capability table.
