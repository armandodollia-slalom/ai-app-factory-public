// The written contract of every external service the harness uses, as data. Four kinds:
//
//   tracker  the ticket board: tickets, epics and their children, lanes, triage fields, comments, attachments
//   host     the code host: pull requests, reviews, checks, merge, labels, branch rules, the PR identity
//   ci       the CI system: which pipelines a head must run, their runs and logs (rendering is the generator's)
//   scanner  a commercial scanner in server-side mode: the result of the scan of one head, and its findings
//
// Each operation was found by reading the engine's call sites (docs/providers/contracts.md lists them), not
// guessed. An adapter (built in, or `custom`: a command the repository declares) implements every operation
// that is not marked with a capability; an operation with a capability may throw UnsupportedError, and the
// harness then degrades as the capability's `degrade` says. A capability with `safety: true` guards a
// property the review gate never gives up (merge only on a green head bound to its SHA, no merge before CI
// registers, auto-merge disarmed on a new head): without it the feature that needs it is off, with a message.
//
// This module is data only: the conformance suite (conformance.mjs, `factory adapter check`), the custom
// adapter (custom.mjs), the docs (docs/providers/) and the audit test all read it.

const op = (id, mode, summary, { args = '', returns = 'nothing', capability = null, check = null } = {}) => ({ id, mode, summary, args, returns, capability, check });

export const KINDS = ['tracker', 'host', 'ci', 'scanner'];

// ---- capabilities ---------------------------------------------------------------------------------------
export const CAPABILITIES = {
  host: {
    requiredChecks: { summary: 'the host can require named checks before a merge (rulesets, protected branches, branch policies)', degrade: 'the review gate refuses to merge until every expected pipeline of the head is green and bound to that SHA; doctor says the host cannot enforce it', safety: false },
    codeOwners: { summary: 'the host can require a code owner\'s review for paths', degrade: 'the gate keeps its own approvals:N label and requests the owners as reviewers; doctor says owner review is advisory', safety: false },
    autoMerge: { summary: 'the host merges a PR by itself once its requirements are met', degrade: 'the gate never arms host auto-merge; `board sync` merges a cleared PR itself when its head is green', safety: false },
    mergeHeadGuard: { summary: 'a merge can be bound to the head SHA the gate assessed (refused if the branch moved)', degrade: 'the gate re-reads the head right before merging and refuses if it moved; with no way to bind the merge itself, auto-merge stays off on this host', safety: true },
    cancelAutoMerge: { summary: 'an armed auto-merge can be disarmed', degrade: 'host auto-merge is never armed (no way to disarm it on a new head)', safety: true },
    drafts: { summary: 'draft pull requests', degrade: 'the PR opens ready for review, with "Draft" in its title', safety: false },
    labels: { summary: 'labels on pull requests', degrade: 'approvals:N and the gate\'s labels live in the gate notice comment only', safety: false },
    checkAnnotations: { summary: 'per-line check annotations', degrade: 'findings are listed in the PR comment and the PR body', safety: false },
    commitStatus: { summary: 'the harness can post a named status on a commit (review-quorum from a CI system without review events)', degrade: 'review-quorum runs only where the CI system has review events; the gate itself stays the merge authority', safety: false },
    attachments: { summary: 'files (videos, screenshots) can be uploaded to a PR', degrade: 'videos go to the storage branch and are linked', safety: false },
    botIdentity: { summary: 'a separate PR identity (an App, a project access token, a service principal)', degrade: 'PRs open as the developer\'s own identity; doctor says so', safety: false },
    diff: { summary: 'the PR\'s unified diff from the API', degrade: 'git diff of the base and head locally', safety: false },
    reviewCommentThreads: { summary: 'line review comments', degrade: 'reopens are counted from review states only', safety: false },
    stateEvents: { summary: 'the close, reopen and merge events of a pull request', degrade: 'a person\'s close or reopen of a PR cannot be told from the pipeline\'s holds, so a bug fix on this host never merges itself (the review gate asks a person)', safety: true },
  },
  tracker: {
    boardLanes: { summary: 'a board whose columns or statuses the pipeline moves tickets through', degrade: 'lanes are labels (`lane:<name>`) on the ticket', safety: false },
    customFields: { summary: 'custom fields for the triage values (Severity, Impact, ...)', degrade: 'the triage values live in the ticket\'s triage section only', safety: false },
    parentChild: { summary: 'epics with child tickets', degrade: 'an epic lists its children in its body; children name the epic in a label', safety: false },
    attachments: { summary: 'files on a ticket (mockups, evidence)', degrade: 'files are linked from the repository\'s storage branch', safety: false },
    commentEdit: { summary: 'a comment can be edited in place (the rolling evidence comment)', degrade: 'a new comment per update', safety: false },
    bodyHistory: { summary: 'earlier versions of a ticket\'s description', degrade: 'a ticket edited after it was verified is fetched as it is now, and the plan is verified again', safety: false },
    archive: { summary: 'a card can be taken off the board without deleting the ticket', degrade: 'an abandoned ticket stays in its lane, closed', safety: false },
    labels: { summary: 'labels or tags on tickets', degrade: 'the factory\'s markers live in its metadata block', safety: false },
    assignees: { summary: 'tickets have assignees', degrade: 'epic assignees are not copied to children', safety: false },
  },
  ci: {
    logs: { summary: 'a run\'s log can be read (failed jobs\' logs, retried tests)', degrade: 'a red run becomes a finding with its link only; retry-only passes cannot be detected, so a green run is not called flaky-free in the PR body', safety: false },
    expectedFromDefinition: { summary: 'which pipelines a head must run can be derived from the CI definition at that head', degrade: 'the expected pipelines come from `ci.expected` in .factory/config.json; without it no head is ever green (the gate fails closed)', safety: true },
    runsByCommit: { summary: 'runs can be listed for one commit SHA', degrade: 'without it the CI system cannot give evidence for a head: the CI adapter is unusable for the gate (doctor fails)', safety: true },
    reviewEvents: { summary: 'a pipeline can start on review events (review-quorum)', degrade: 'review-quorum is posted as a commit status by `board sync` (needs the host\'s commitStatus)', safety: false },
    schedules: { summary: 'scheduled pipelines in the definition (retro, tracker sweep, cache prune)', degrade: 'the schedules are created by hand in the CI system; docs list them', safety: false },
    rerun: { summary: 'a failed run can be started again', degrade: 'a person reruns it; the gate waits', safety: false },
    branchPipelines: { summary: 'a push of a story branch runs the pipelines before any pull request exists, so a head is proven green before its PR opens (implement.preOpen)', degrade: 'the PR opens as a draft (or held by the work-in-progress label on a host without drafts) and is marked ready only when its pipelines are green on its head', safety: false },
  },
  scanner: {
    serverSide: { summary: 'the scan runs in the vendor\'s service or the client\'s CI, and its result is fetched for a head SHA', degrade: 'only local CLI mode', safety: false },
    prAnalysis: { summary: 'results for a pull request / diff, not only a branch', degrade: 'branch results for the head SHA, baselined against the merge-base by fingerprint', safety: false },
    triageStates: { summary: 'the vendor\'s own suppression or triage state per finding', degrade: 'every finding is open unless the factory baseline says pre-existing', safety: false },
    sarif: { summary: 'SARIF output', degrade: 'the vendor JSON is mapped by the definition\'s parser', safety: false },
    shaBound: { summary: 'a result names the commit it is of', degrade: 'the scanner\'s check on the head binds the result to the head (analysis.commercial.check, required); without a check name the head is never green', safety: true },
  },
};

// ---- operations -----------------------------------------------------------------------------------------
export const CONTRACTS = {
  host: [
    op('identity', 'read', 'who the token acts as', { returns: '{ login, id }', check: 'read' }),
    op('repo.defaultBranch', 'read', 'the repository\'s default branch', { returns: 'string', check: 'read' }),
    op('repo.file', 'read', 'a file\'s text at a ref, or null', { args: 'path, ref', returns: 'string | null', check: 'read' }),
    op('repo.list', 'read', 'the files of a folder at a ref (CI definitions)', { args: 'dir, ref', returns: '[path]', check: 'read' }),
    op('repo.permissions', 'read', 'what the token may do', { returns: '{ push, pullRequests, admin }', check: 'read' }),
    op('repo.branchProtection', 'read', 'the rules on a branch', { args: 'branch?', returns: '{ enforced, requiredChecks, requiredApprovals, codeOwnerReview, via } | { unavailable, reason } | null', capability: 'requiredChecks', check: 'read' }),
    op('repo.settings', 'read', 'repository settings the gate reports', { returns: '{ autoMergeAllowed: bool|null }', check: 'read' }),
    op('repo.enforceReviewGate', 'admin', 'require review-quorum, the CI checks and code-owner review (`factory review-gate enforce`, a person runs it)', { args: '{ codeOwners, review, requiredChecks, dryRun }', returns: '{ action, summary, manual, warnings }', capability: 'requiredChecks', check: 'dry-run' }),
    op('repo.ensureLabel', 'write', 'a label exists (GitHub needs it before use)', { args: 'name, { color, description }', capability: 'labels', check: 'write' }),
    op('pr.open', 'write', 'opens a pull request', { args: '{ head, base, title, body, draft, labels, reviewers }', returns: 'pr', check: 'write' }),
    op('pr.get', 'read', 'one pull request by number, URL or head branch', { args: 'pr', returns: 'pr | null (normalised: number, url, title, body, state open|merged|closed, draft, head, base, headSha, author, labels, mergeable, mergeState, autoMerge, createdAt, updatedAt, mergedAt, closedAt, mergeCommit)', check: 'read' }),
    op('pr.list', 'read', 'pull requests by state, head, base, label or words in the title', { args: '{ state, head, base, label, search, limit }', returns: '[pr]', check: 'read' }),
    op('pr.update', 'write', 'title, body, labels { add, remove }, state, draft', { args: 'pr, changes', check: 'write' }),
    op('pr.close', 'write', 'closes a pull request (the retro self-test)', { args: 'pr', check: 'write' }),
    op('pr.comment', 'write', 'adds or edits in place the comment carrying a marker', { args: 'pr, body, { marker }', returns: '{ id, url }', check: 'write' }),
    op('pr.comments', 'read', 'the conversation comments', { args: 'pr', returns: '[{ id, author, body, createdAt, url }]', check: 'read' }),
    op('pr.reviews', 'read', 'reviews with their state and commit', { args: 'pr', returns: '[{ id, author, bot, state approved|changes_requested|commented|dismissed, submittedAt, commit, body }]', check: 'read' }),
    op('pr.reviewComments', 'read', 'line review comments', { args: 'pr', returns: '[{ id, author, body, path, line, reviewId, createdAt }]', capability: 'reviewCommentThreads', check: 'read' }),
    op('pr.stateEvents', 'read', 'the PR\'s close, reopen and merge events', { args: 'pr', returns: '[{ id, type closed|reopened|merged, at, actor }]', capability: 'stateEvents', check: 'read' }),
    op('pr.commits', 'read', 'the PR\'s commits', { args: 'pr', returns: '[{ sha, author, committedAt, parents, message }]', check: 'read' }),
    op('pr.files', 'read', 'the changed files', { args: 'pr', returns: '[{ path, status, additions, deletions }]', check: 'read' }),
    op('pr.diff', 'read', 'the unified diff', { args: 'pr', returns: 'string', capability: 'diff', check: 'read' }),
    op('pr.checks', 'read', 'the checks and statuses the host shows for the PR\'s head', { args: 'pr', returns: '[{ name, status pending|completed, conclusion success|failure|cancelled|skipped|neutral|null, url }] | null when none are reported', check: 'read' }),
    op('pr.mergeState', 'read', 'whether the host would merge now (asked again while it is still computing)', { args: 'pr', returns: '{ state open|merged|closed, mergeState clean|dirty|blocked|behind|unstable|unknown, mergedAt, autoMerge }', check: 'read' }),
    op('pr.merge', 'write', 'merges, bound to the head SHA the gate assessed; `auto` hands the merge to the host (only with implement.autoMerge.hostAutoMerge.enabled)', { args: 'pr, { method, headSha, auto }', returns: '{ merged, mergedAt, autoMerge }', check: 'write' }),
    op('pr.cancelAutoMerge', 'write', 'disarms the host\'s auto-merge', { args: 'pr', capability: 'cancelAutoMerge', check: 'write' }),
    op('pr.requestReviewers', 'write', 'asks people for a review; unknown logins are skipped', { args: 'pr, logins', returns: '[login]', check: 'write' }),
    op('pr.setStatus', 'write', 'posts a named status on a commit', { args: 'sha, { name, state, description, url }', capability: 'commitStatus', check: 'write' }),
    op('pr.uploadAttachment', 'write', 'uploads a file and returns its URL', { args: 'pr, file', returns: 'url', capability: 'attachments', check: 'write' }),
    op('issues.search', 'read', 'open issues on the host by title (factory feedback issues of the retro)', { args: '{ text, state }', returns: '[{ number, title, url }]', check: 'read' }),
    op('issues.create', 'write', 'an issue on the host (the retro\'s factory issues)', { args: '{ title, body, labels }', returns: '{ number, url }', check: 'write' }),
  ],
  tracker: [
    op('reachable', 'read', 'the API answers with these credentials', { returns: '{ ok, reason }', check: 'read' }),
    op('identity', 'read', 'who the credentials act as', { returns: '{ login, id }', check: 'read' }),
    op('active', 'read', 'the board is configured for this checkout (not a fork, not switched off)', { returns: 'bool', check: 'read' }),
    op('available', 'read', 'tickets are readable from this checkout', { returns: 'bool', check: 'read' }),
    op('tickets.get', 'read', 'a ticket by id or key', { args: 'id', returns: 'ticket | null (normalised: id, key, type epic|story|bug|spike, title, body, state open|closed, stateReason, labels, assignees, parent, url, updatedAt)', check: 'read' }),
    op('tickets.find', 'read', 'the ticket of a factory key (PROJ-12), remembered in .factory/state/board.json', { args: 'key', returns: 'ticket | null', check: 'read' }),
    op('tickets.list', 'read', 'tickets by type, state, parent, label, update time', { args: '{ type, state, parent, label, updatedSince }', returns: '[ticket]', check: 'read' }),
    op('tickets.search', 'read', 'open tickets whose title holds a text (follow-ups are filed once)', { args: '{ text, state }', returns: '[ticket]', check: 'read' }),
    op('tickets.create', 'write', 'a ticket (story, bug, epic, spike, follow-up)', { args: '{ type, key, title, body, parent, labels, fields }', returns: 'ticket', check: 'write' }),
    op('tickets.update', 'write', 'title, body, labels { add, remove }, state, assignees, fields', { args: 'id, changes', check: 'write' }),
    op('tickets.children', 'read', 'an epic\'s children', { args: 'id', returns: '[ticket]', capability: 'parentChild', check: 'read' }),
    op('tickets.parent', 'read', 'a ticket\'s epic', { args: 'id', returns: 'ticket | null', capability: 'parentChild', check: 'read' }),
    op('tickets.setParent', 'write', 'makes a ticket a child of an epic', { args: 'child, parent', capability: 'parentChild', check: 'write' }),
    op('tickets.comment', 'write', 'adds or edits in place the comment carrying a marker (owner questions, escalations, evidence)', { args: 'id, body, { marker }', returns: '{ id, url }', check: 'write' }),
    op('tickets.comments', 'read', 'a ticket\'s comments', { args: 'id', returns: '[{ id, author, body, createdAt, url }]', check: 'read' }),
    op('tickets.editComment', 'write', 'edits a comment', { args: 'id, commentId, body', capability: 'commentEdit', check: 'write' }),
    op('tickets.attach', 'write', 'attaches a file (a mockup)', { args: 'id, { name, data }', returns: '{ url, name }', capability: 'attachments', check: 'write' }),
    op('tickets.attachments', 'read', 'a ticket\'s files', { args: 'id', returns: '[{ name, url, size, sha256? }]', capability: 'attachments', check: 'read' }),
    op('tickets.download', 'read', 'one attachment to a local file', { args: 'attachment, dest', capability: 'attachments' }),
    op('tickets.link', 'write', 'links a pull request (which may live on another product) to the ticket', { args: 'id, { url, title }', check: 'write' }),
    op('tickets.history', 'read', 'earlier versions of the description, newest first', { args: 'id', returns: '[body]', capability: 'bodyHistory', check: 'read' }),
    op('labels.ensure', 'write', 'a label or tag exists', { args: 'name, { color, description }', capability: 'labels', check: 'write' }),
    op('format.render', 'read', 'the stored description for a ticket (the factory\'s metadata block survives a person\'s edit)', { args: 'ticketInfo, markdown', returns: '{ body, meta }' }),
    op('format.parse', 'read', 'the factory\'s Markdown and metadata out of a stored description', { args: 'ticket', returns: '{ content, meta }' }),
    op('board.lanes', 'read', 'the pipeline\'s lanes and this tracker\'s statuses or columns for them', { returns: '[{ lane, name, id }]', check: 'read' }),
    op('board.lane', 'read', 'a ticket\'s lane', { args: 'id', returns: 'lane | null', capability: 'boardLanes', check: 'read' }),
    op('board.item', 'read', 'a ticket\'s card (added to the board when missing)', { args: 'ticket', returns: '{ id, column }', check: 'read' }),
    op('board.move', 'write', 'moves a ticket to a lane', { args: 'id, lane', check: 'write' }),
    op('board.moveItem', 'write', 'moves a card to a lane', { args: 'itemId, lane', check: 'write' }),
    op('board.archiveItem', 'write', 'takes a card off the board (abandoned tickets)', { args: 'itemId', capability: 'archive', check: 'write' }),
    op('board.items', 'read', 'the cards of this repository (a shared board\'s other cards only with repoScoped: false)', { args: '{ lane, repoScoped }', returns: '[{ itemId, column, status, number, key, title, url, state, repo, labels, assignees, parent, stateReason, severity }]', check: 'read' }),
    op('board.fields.get', 'read', 'the triage fields of a ticket', { args: 'id', returns: '{ severity, impact, complexity, fixRisk, confidence, reopens }', capability: 'customFields', check: 'read' }),
    op('board.fields.set', 'write', 'sets triage fields', { args: 'id, values', capability: 'customFields', check: 'write' }),
    op('board.fields.ensure', 'admin', 'creates missing triage fields (or lists them for a person)', { args: '{ log, dryRun }', returns: '[name]', capability: 'customFields', check: 'dry-run' }),
    op('board.setup', 'admin', 'creates or verifies lanes, labels and fields without changing anything that exists; a shared board is never rewritten', { args: '{ dryRun, log }', returns: '{ url, done, manual }', check: 'dry-run' }),
    op('board.syncAssignees', 'write', 'gives an epic\'s open children the epic\'s assignees', { args: 'id', returns: '[changed]', capability: 'assignees', check: 'write' }),
  ],
  ci: [
    op('expected', 'read', 'the pipelines a head must run before anything may call it green, from the CI definition at that head (fail closed: unreadable definitions are expected and missing)', { args: '{ head, base, changed, pr, branch, mode pr|push, activities }', returns: '[{ id, name, required, unreadable?, prOnly? }] (mode pr: required for the activities the head went through, opened|synchronize|reopened|ready_for_review|labeled, every one of opened, synchronize and reopened when unknown; mode push: the pipelines a push of the branch runs, plus prOnly entries for those only a pull request runs)', capability: 'expectedFromDefinition', check: 'read' }),
    op('runs', 'read', 'the runs of one head (the newest run that executed wins per pipeline; a skipped run never supersedes one that ran)', { args: '{ head, branch, pr }', returns: '[{ id, pipeline, name, status queued|running|completed, conclusion success|failure|cancelled|skipped|neutral|null, event, url, sha }]', capability: 'runsByCommit', check: 'read' }),
    op('log', 'read', 'a run\'s log text (failed jobs only with failedOnly)', { args: 'runId, { failedOnly }', returns: 'string', capability: 'logs', check: 'read' }),
    op('uncoveredChecks', 'read', 'the jobs of the repository\'s own pipelines that no host rule requires, and why (doctor and `review-gate enforce` name them)', { args: 'root', returns: '[{ workflow, job, name, reason }]', check: 'read' }),
    op('rerun', 'write', 'starts a failed run again', { args: 'runId', capability: 'rerun', check: 'write' }),
    op('requiredChecks', 'read', 'the check names a host should require for every PR, from the definitions in the checkout', { args: 'root', returns: '[name]' }),
  ],
  scanner: [
    op('result', 'read', 'the scan of one head: pending, complete or failed, with its findings (vendor rule ids, severities, triage states)', { args: '{ head, pr, branch, base }', returns: '{ status pending|complete|failed, url, analysisId, findings: [{ rule, severity, level, path, line, message, cwe, fingerprint, triage open|suppressed|accepted|false-positive|fixed }] }', capability: 'serverSide', check: 'read' }),
    op('checkName', 'read', 'the check the scan reports on the head (joins the expected checks)', { returns: 'string | null' }),
  ],
};

// Every operation of a kind, by id.
export const operations = (kind) => CONTRACTS[kind] ?? [];
export const operation = (kind, id) => operations(kind).find((o) => o.id === id) ?? null;

// The function at a dotted path of an adapter ("pr.get"), with its owner, or null.
export function resolveOp(adapter, id) {
  const parts = id.split('.');
  const owner = parts.slice(0, -1).reduce((o, k) => o?.[k], adapter);
  const fn = owner?.[parts.at(-1)];
  return typeof fn === 'function' ? { owner, fn } : null;
}

// Operations of the contract an adapter does not have at all (a missing function, not an UnsupportedError):
// [{ id, capability }]. An operation without a capability is required.
export function missingOperations(kind, adapter) {
  return operations(kind).filter((o) => !resolveOp(adapter, o.id)).map((o) => ({ id: o.id, capability: o.capability, required: !o.capability }));
}

// The capability table of an adapter: its own `capabilities` ({ name: true|false|'partial' }), every
// capability of the kind listed (unknown = false).
export function capabilityTable(kind, adapter) {
  const own = adapter?.capabilities ?? {};
  return Object.fromEntries(Object.keys(CAPABILITIES[kind] ?? {}).map((c) => [c, own[c] ?? false]));
}

// The capabilities an adapter lacks, with what the harness does instead.
export function degradations(kind, adapter) {
  const table = capabilityTable(kind, adapter);
  return Object.entries(table).filter(([, v]) => v !== true).map(([c, v]) => ({ capability: c, level: v === 'partial' ? 'partial' : 'missing', ...CAPABILITIES[kind][c] }));
}
