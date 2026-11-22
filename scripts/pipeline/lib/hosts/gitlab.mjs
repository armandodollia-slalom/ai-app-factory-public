// The GitLab code host (gitlab.com or self-managed): REST API v4 through fetch. A pull request is a
// merge request; its number is the MR's iid. Approvals come from the approvals and reviewers APIs,
// auto-merge is "merge when pipeline succeeds" (auto_merge on GitLab 17+), checks are the latest MR
// pipeline's jobs plus the head commit's external statuses.
//
// settings: { url, repo ("group/subgroup/project"), resolveToken() }. deps: { fetch, token, sleep }.
import fs from 'node:fs';
import path from 'node:path';
import { HostError } from './errors.mjs';
import { createHttp } from './http.mjs';

export const DEFAULT_URL = 'https://gitlab.com';

const STATE = { opened: 'open', locked: 'open', merged: 'merged', closed: 'closed' };
const DRAFT = /^\s*(\[draft\]|draft:|\(draft\)|wip:|\[wip\])\s*/i;
const numOf = (pr) => Number(/merge_requests\/(\d+)/.exec(String(pr))?.[1] ?? String(pr).replace(/^[!#]/, '')) || null;

export function normalizeMr(m) {
  if (!m) return null;
  return {
    number: m.iid,
    url: m.web_url ?? null,
    title: m.title ?? '',
    body: m.description ?? '',
    state: STATE[m.state] ?? 'open',
    draft: Boolean(m.draft ?? m.work_in_progress),
    head: m.source_branch ?? null,
    base: m.target_branch ?? null,
    headSha: m.sha ?? m.diff_refs?.head_sha ?? null,
    author: m.author?.username ?? null,
    labels: (m.labels ?? []).map((l) => l?.name ?? l),
    mergeable: m.detailed_merge_status === 'mergeable' || m.merge_status === 'can_be_merged' ? true : m.merge_status === 'cannot_be_merged' || m.has_conflicts ? false : null,
    createdAt: m.created_at ?? null,
    updatedAt: m.updated_at ?? null,
    mergedAt: m.merged_at ?? null,
    closedAt: m.closed_at ?? m.merged_at ?? null,
    mergeCommit: m.merge_commit_sha ?? m.squash_commit_sha ?? null,
    additions: null,
    deletions: null,
    changedFiles: m.changes_count != null ? Number(String(m.changes_count).replace(/\D/g, '')) || null : null,
    fromFork: m.source_project_id != null && m.target_project_id != null && m.source_project_id !== m.target_project_id,
  };
}

// GitLab job/pipeline/commit status -> { status, conclusion }.
export function checkState(s, allowFailure = false) {
  switch (s) {
    case 'success':
      return ['completed', 'success'];
    case 'failed':
      return ['completed', allowFailure ? 'neutral' : 'failure'];
    case 'canceled':
    case 'canceling':
      return ['completed', 'cancelled'];
    case 'skipped':
      return ['completed', 'skipped'];
    case 'manual':
      return ['completed', 'neutral'];
    case 'running':
      return ['in_progress', null];
    default:
      return ['queued', null];
  }
}

const STATUS_OUT = { success: 'success', failure: 'failed', error: 'failed', pending: 'pending', running: 'running', cancelled: 'canceled' };

const countDiff = (diff) => {
  let additions = 0;
  let deletions = 0;
  for (const l of String(diff ?? '').split('\n')) {
    if (l.startsWith('+') && !l.startsWith('+++')) additions++;
    else if (l.startsWith('-') && !l.startsWith('---')) deletions++;
  }
  return { additions, deletions };
};

// What GitLab can do for the harness (providers/contracts.mjs CAPABILITIES.host). Required checks: "Pipelines must
// succeed" covers the whole merge request pipeline (and external status checks on Ultimate); code owner approval
// needs Premium (doctor says when the tier refuses it).
export const CAPABILITIES = { requiredChecks: true, codeOwners: 'partial', autoMerge: true, mergeHeadGuard: true, cancelAutoMerge: true, drafts: true, labels: true, checkAnnotations: 'partial', commitStatus: true, attachments: true, botIdentity: true, diff: true, reviewCommentThreads: true, stateEvents: true };

export function createGitlabHost(settings, deps = {}) {
  const url = String(settings.url ?? DEFAULT_URL).replace(/\/+$/, '');
  const repo = settings.repo ?? null;
  const token = deps.token ?? settings.resolveToken?.() ?? null;
  const http = createHttp({ baseUrl: `${url}/api/v4`, headers: token ? { 'PRIVATE-TOKEN': token } : {}, fetch: deps.fetch, sleep: deps.sleep, label: 'GitLab', secrets: [token] });
  const need = () => {
    if (!repo) throw new HostError('the GitLab project is unknown: set host.repo ("group/project") in .factory/config.json', { code: 'config' });
    if (!token) throw new HostError('no GitLab token: set host.token to "${GITLAB_TOKEN}" (a project, group or personal access token with the api scope) and export it', { code: 'auth', status: 401 });
    return encodeURIComponent(repo);
  };
  const P = () => `/projects/${need()}`;
  const MR = (pr) => `${P()}/merge_requests/${numOf(pr)}`;
  const api = (method, p, opts) => http.json(method, p, opts);

  // Every page (per_page 100, the x-next-page header).
  // `strict`: a page that is not a list, or more pages than the limit, throws (a history read in full, or not at all).
  async function all(p, query = {}, { strict = false } = {}) {
    const out = [];
    let page = 1;
    for (let guard = 0; page && guard < 200; guard++) {
      const r = await http.request('GET', p, { query: { ...query, per_page: 100, page } });
      if (strict && !Array.isArray(r.json)) throw new HostError(`GitLab: ${p} did not answer with a list`);
      out.push(...(Array.isArray(r.json) ? r.json : []));
      const next = r.headers.get('x-next-page');
      page = next ? Number(next) : 0;
    }
    if (strict && page) throw new HostError(`GitLab: ${p} has more pages than the factory reads`);
    return out;
  }

  const userIds = async (logins) => {
    const found = [];
    for (const login of logins) {
      const users = await api('GET', '/users', { query: { username: String(login).replace(/^@/, '') } });
      if (users?.[0]?.id) found.push({ login, id: users[0].id });
    }
    return found;
  };

  const notes = async (pr) => (await all(`${MR(pr)}/notes`, { sort: 'asc', order_by: 'created_at' })).filter((n) => !n.system);

  const host = {
    type: 'gitlab',
    label: 'GitLab',
    capabilities: CAPABILITIES,
    hints: { codeOwnersFile: '.gitlab/CODEOWNERS', checked: 'the protected branch and the merge checks', enforce: '"Pipelines must succeed" and code owner approval on the default branch', settings: 'Settings > Merge requests (Pipelines must succeed) and Settings > Repository > Protected branches', planDecision: 'GitLab Premium for code owner approval, or accept advisory review', autoMerge: 'GitLab (auto-merge is always available)' },
    webUrl: repo ? `${url}/${repo}` : url,
    async identity() {
      need();
      const u = await api('GET', '/user');
      return { login: u?.username ?? null, id: u?.id ?? null };
    },
    pr: {
      async open({ head, base, title, body = '', draft = false, labels = [], reviewers = [] }) {
        const target = base ?? (await host.repo.defaultBranch());
        const reviewerIds = reviewers.length ? (await userIds(reviewers)).map((u) => u.id) : [];
        const m = await api('POST', `${P()}/merge_requests`, { body: { source_branch: head, target_branch: target, title: draft && !DRAFT.test(title) ? `Draft: ${title}` : title, description: body, ...(labels.length ? { labels: labels.join(',') } : {}), ...(reviewerIds.length ? { reviewer_ids: reviewerIds } : {}), remove_source_branch: false } });
        return normalizeMr(m);
      },
      async get(numberOrBranch) {
        if (/^[!#]?\d+$/.test(String(numberOrBranch)) || /merge_requests\/\d+/.test(String(numberOrBranch))) {
          const r = await http.request('GET', MR(numberOrBranch), { allow: [404] });
          return r.status === 404 ? null : normalizeMr(r.json);
        }
        const open = await host.pr.list({ state: 'open', head: String(numberOrBranch) });
        if (open.length) return open[0];
        return (await host.pr.list({ state: 'all', head: String(numberOrBranch) }))[0] ?? null;
      },
      async list({ state = 'open', head, base, label, search, limit = 200 } = {}) {
        const glState = { open: 'opened', merged: 'merged', all: 'all', closed: 'all' }[state] ?? 'opened';
        const list = await all(`${P()}/merge_requests`, { state: glState, source_branch: head, target_branch: base, labels: label, ...(search ? { search, in: 'title' } : {}), order_by: 'created_at', sort: 'desc' });
        return list
          .map(normalizeMr)
          .filter((p) => state !== 'closed' || p.state !== 'open')
          .slice(0, limit);
      },
      async update(pr, { title, body, labels, state, draft } = {}) {
        const data = {};
        if (title != null) data.title = title;
        if (body != null) data.description = body;
        if (Array.isArray(labels)) data.labels = labels.join(',');
        else if (labels) {
          if (labels.add?.length) data.add_labels = labels.add.join(',');
          if (labels.remove?.length) data.remove_labels = labels.remove.join(',');
        }
        if (state === 'closed') data.state_event = 'close';
        if (state === 'open') data.state_event = 'reopen';
        if (draft != null) {
          const current = data.title ?? (await host.pr.get(pr))?.title ?? '';
          const bare = current.replace(DRAFT, '');
          data.title = draft ? `Draft: ${bare}` : bare;
        }
        if (Object.keys(data).length) await api('PUT', MR(pr), { body: data });
      },
      async comment(pr, body, { marker } = {}) {
        const existing = marker ? (await notes(pr)).filter((n) => String(n.body ?? '').includes(marker)).at(-1) : null;
        const n = existing ? await api('PUT', `${MR(pr)}/notes/${existing.id}`, { body: { body } }) : await api('POST', `${MR(pr)}/notes`, { body: { body } });
        const web = typeof pr === 'string' && /^https?:/.test(pr) ? pr.replace(/#.*$/, '') : (await host.pr.get(pr))?.url;
        return { id: n?.id ?? existing?.id ?? null, url: web ? `${web}#note_${n?.id ?? existing?.id}` : null };
      },
      async comments(pr) {
        return (await notes(pr)).map((n) => ({ id: n.id, author: n.author?.username ?? null, body: n.body ?? '', createdAt: n.created_at ?? null }));
      },
      // Approvals (approved), and the reviewers API's "requested changes" / "reviewed" states.
      // GitLab gives no commit per approval: approvals it still lists count for the current head (the
      // project's "reset approvals on push" setting removes stale ones), so `commit` is the head sha.
      // Every page, strictly: a page that is not a list or a history longer than the page limit throws (never a short list).
      async stateEvents(pr) {
        return (await all(`${MR(pr)}/resource_state_events`, {}, { strict: true })).filter((e) => ['closed', 'reopened', 'merged'].includes(e.state)).map((e) => ({ id: e.id ?? null, type: e.state, at: e.created_at ?? null, actor: e.user?.username ?? null }));
      },
      // `strict`: a denied or missing approvals or reviewers endpoint throws instead of reading as no reviews (the review
      // gate's rejection check: unknown is review).
      async reviews(pr, { strict = false } = {}) {
        const mr = await api('GET', MR(pr));
        const out = [];
        const allow = strict ? [] : [404, 403];
        const approvals = await http.request('GET', `${MR(pr)}/approvals`, { allow });
        if (strict && !Array.isArray(approvals.json?.approved_by)) throw new HostError('GitLab: the approvals of the merge request could not be read');
        for (const a of approvals.json?.approved_by ?? []) out.push({ id: `approved:${a.user?.username}`, author: a.user?.username ?? null, bot: Boolean(a.user?.bot), state: 'approved', submittedAt: a.approved_at ?? null, commit: mr?.sha ?? null, body: '' });
        // Strict: every page, and every reviewer with its login and state (anything else is unknown, so review).
        const list = strict ? await all(`${MR(pr)}/reviewers`, {}, { strict: true }) : (await http.request('GET', `${MR(pr)}/reviewers`, { allow })).json;
        if (strict && list.some((r) => !r?.user?.username || typeof r.state !== 'string')) throw new HostError('GitLab: a reviewer of the merge request has no login or state');
        // A reviewer's "requested changes" is kept beside their approval (the gate reads both by time); one whose time is
        // not given wins over the approval (unknown is review). A "reviewed" adds nothing to an approval.
        for (const r of Array.isArray(list) ? list : []) {
          const state = { requested_changes: 'changes_requested', reviewed: 'commented' }[r.state];
          const approved = out.findIndex((o) => o.author === r.user?.username && o.state === 'approved');
          if (!state || (state === 'commented' && approved >= 0)) continue;
          const at = r.updated_at ?? r.created_at ?? null;
          if (state === 'changes_requested' && approved >= 0 && (!at || !out[approved].submittedAt)) out.splice(approved, 1);
          out.push({ id: `${r.state}:${r.user?.username}`, author: r.user?.username ?? null, bot: Boolean(r.user?.bot), state, submittedAt: at, commit: mr?.sha ?? null, body: '' });
        }
        return out;
      },
      async reviewComments(pr) {
        const discussions = await all(`${MR(pr)}/discussions`);
        return discussions.flatMap((d) => (d.notes ?? []).filter((n) => n.position && !n.system).map((n) => ({ id: n.id, author: n.author?.username ?? null, body: n.body ?? '', path: n.position?.new_path ?? n.position?.old_path ?? null, line: n.position?.new_line ?? n.position?.old_line ?? null, reviewId: null, createdAt: n.created_at ?? null })));
      },
      async commits(pr) {
        return (await all(`${MR(pr)}/commits`)).map((c) => ({ sha: c.id, author: c.author_name ?? null, committedAt: c.committed_date ?? c.created_at ?? null, parents: c.parent_ids?.length ?? null, message: c.message ?? c.title ?? null }));
      },
      async requestReviewers(pr, logins = []) {
        const users = await userIds(logins);
        if (!users.length) return [];
        const mr = await api('GET', MR(pr));
        const ids = [...new Set([...(mr?.reviewers ?? []).map((r) => r.id), ...users.map((u) => u.id)])];
        await api('PUT', MR(pr), { body: { reviewer_ids: ids } });
        return users.map((u) => u.login);
      },
      async files(pr) {
        const diffs = await host.pr.rawDiffs(pr);
        return diffs.map((d) => ({ path: d.new_path ?? d.old_path, status: d.new_file ? 'added' : d.deleted_file ? 'removed' : d.renamed_file ? 'renamed' : 'modified', ...countDiff(d.diff) }));
      },
      async rawDiffs(pr) {
        const r = await http.request('GET', `${MR(pr)}/diffs`, { query: { per_page: 100, page: 1 }, allow: [404] });
        if (r.status !== 404) return r.headers.get('x-next-page') ? all(`${MR(pr)}/diffs`) : r.json ?? [];
        // GitLab before 15.7: the changes endpoint.
        return (await api('GET', `${MR(pr)}/changes`))?.changes ?? [];
      },
      async diff(pr) {
        const diffs = await host.pr.rawDiffs(pr);
        return diffs.map((d) => `diff --git a/${d.old_path} b/${d.new_path}\n${d.new_file ? 'new file mode 100644\n' : ''}${d.deleted_file ? 'deleted file mode 100644\n' : ''}--- ${d.new_file ? '/dev/null' : `a/${d.old_path}`}\n+++ ${d.deleted_file ? '/dev/null' : `b/${d.new_path}`}\n${String(d.diff ?? '').replace(/\n?$/, '\n')}`).join('');
      },
      async checks(pr) {
        const mr = await api('GET', MR(pr));
        const out = [];
        const pipelines = await http.request('GET', `${MR(pr)}/pipelines`, { allow: [404, 403] });
        const latest = (Array.isArray(pipelines.json) ? pipelines.json : []).sort((a, b) => b.id - a.id)[0];
        if (latest) {
          for (const j of await all(`${P()}/pipelines/${latest.id}/jobs`)) {
            const [status, conclusion] = checkState(j.status, j.allow_failure);
            out.push({ name: j.name, status, conclusion, url: j.web_url ?? null });
          }
        }
        if (mr?.sha) {
          for (const s of await all(`${P()}/repository/commits/${mr.sha}/statuses`)) {
            if (out.some((o) => o.name === s.name)) continue;
            const [status, conclusion] = checkState(s.status, s.allow_failure);
            out.push({ name: s.name, status, conclusion, url: s.target_url ?? null });
          }
        }
        return out;
      },
      async setStatus(sha, { name, state, description = '', url: target } = {}) {
        await api('POST', `${P()}/statuses/${sha}`, { body: { state: STATUS_OUT[state] ?? 'failed', name, description: String(description).slice(0, 255), ...(target ? { target_url: target } : {}) } });
      },
      // The merge state the gate reads, from detailed_merge_status (docs.gitlab.com/api/merge_requests, 2026-11):
      // mergeable -> clean; conflict -> dirty; need_rebase -> behind; checking/unchecked/preparing/approvals_syncing ->
      // unknown (asked again); everything else (CI running or required, approvals, discussions, draft, blocked) -> blocked.
      async mergeState(pr, { tries = 5, waitMs = 3000 } = {}) {
        let mr = null;
        for (let i = 0; i < tries; i++) {
          mr = await api('GET', MR(pr));
          if (!['checking', 'unchecked', 'preparing', 'approvals_syncing'].includes(mr?.detailed_merge_status) || mr?.state !== 'opened') break;
          if (waitMs) await new Promise((r) => setTimeout(r, waitMs));
        }
        const d = mr?.detailed_merge_status ?? 'unchecked';
        const mergeState = d === 'mergeable' ? 'clean' : d === 'conflict' ? 'dirty' : d === 'need_rebase' ? 'behind' : ['checking', 'unchecked', 'preparing', 'approvals_syncing'].includes(d) ? 'unknown' : 'blocked';
        return { state: STATE[mr?.state] ?? 'open', mergeState, raw: d, mergedAt: mr?.merged_at ?? null, autoMerge: Boolean(mr?.merge_when_pipeline_succeeds) };
      },
      // Merges, bound to `headSha` (GitLab answers 409 when the source branch moved). `auto`: GitLab merges when the
      // checks pass (auto_merge, GitLab 17.11+; merge_when_pipeline_succeeds before), still bound to that SHA.
      async merge(pr, { method = 'squash', auto = false, headSha = null, deleteBranch = false } = {}) {
        const body = { squash: method === 'squash', should_remove_source_branch: Boolean(deleteBranch), ...(headSha ? { sha: headSha } : {}), ...(auto ? { auto_merge: true, merge_when_pipeline_succeeds: true } : {}) };
        const m = await api('PUT', `${MR(pr)}/merge`, { body });
        const merged = m?.state === 'merged';
        return { merged, mergedAt: m?.merged_at ?? null, autoMerge: Boolean(auto) && !merged };
      },
      async autoMergeArmed(pr) {
        return Boolean((await api('GET', MR(pr)))?.merge_when_pipeline_succeeds);
      },
      // cancel_auto_merge (GitLab 19.5+), else the older cancel_merge_when_pipeline_succeeds.
      async cancelAutoMerge(pr) {
        const r = await http.request('POST', `${MR(pr)}/cancel_auto_merge`, { allow: [404, 405, 406, 409] });
        if (r.status < 300) return true;
        const old = await http.request('POST', `${MR(pr)}/cancel_merge_when_pipeline_succeeds`, { allow: [404, 405, 406, 409] });
        return old.status < 300;
      },
      async close(pr, { comment = null } = {}) {
        if (comment) await host.pr.comment(pr, comment);
        await api('PUT', MR(pr), { body: { state_event: 'close' } });
        return true;
      },
      async uploadAttachment(pr, file) {
        const form = new FormData();
        form.append('file', new Blob([fs.readFileSync(file)]), path.basename(file));
        const r = await api('POST', `${P()}/uploads`, { form });
        return r?.full_path ? `${url}${r.full_path}` : `${url}/${repo}${r?.url ?? ''}`;
      },
    },
    // Issues of the project (the retro files factory issues where the factory lives).
    issues: {
      async search({ text, state = 'open' } = {}) {
        return (await all(`${P()}/issues`, { search: text, in: 'title', state: state === 'open' ? 'opened' : state })).map((i) => ({ number: i.iid, title: i.title, url: i.web_url }));
      },
      async create({ title, body = '', labels = [] } = {}) {
        const i = await api('POST', `${P()}/issues`, { body: { title, description: body, ...(labels.length ? { labels: labels.join(',') } : {}) } });
        return { number: i?.iid ?? null, url: i?.web_url ?? null };
      },
    },
    repo: {
      slug: repo,
      toString: () => repo ?? '',
      toJSON: () => repo,
      async defaultBranch() {
        return (await api('GET', P()))?.default_branch ?? null;
      },
      // GitLab merges automatically once the pipeline succeeds on every tier.
      async settings() {
        return { autoMergeAllowed: true };
      },
      async list(dir, ref) {
        const r = await http.request('GET', `${P()}/repository/tree`, { query: { path: dir, ref: ref ?? (await host.repo.defaultBranch()), per_page: 100 }, allow: [404] });
        return r.status === 404 ? null : (r.json ?? []).filter((e) => e.type === 'blob').map((e) => e.path);
      },
      async file(p, ref) {
        const r = await http.request('GET', `${P()}/repository/files/${encodeURIComponent(p)}/raw`, { query: { ref: ref ?? (await host.repo.defaultBranch()) }, accept: '*/*', allow: [404] });
        return r.status === 404 ? null : r.text;
      },
      // What the token may do here: { push, pullRequests, readPolicies, accessLevel } from the project's
      // `permissions` (the higher of project and group access; 30 Developer, 40 Maintainer).
      async permissions() {
        const p = (await api('GET', P()))?.permissions ?? {};
        const level = Math.max(p.project_access?.access_level ?? 0, p.group_access?.access_level ?? 0);
        return { push: level >= 30, pullRequests: level >= 30, readPolicies: level >= 40, accessLevel: level };
      },
      // { enforced, requiredChecks, requiredApprovals, codeOwnerReview } for a protected branch; enforced
      // false when the branch is not protected. "Pipelines must succeed" counts as the required check
      // `pipeline`; external status checks (Ultimate) are listed by name when the API answers.
      async branchProtection(branch) {
        const project = await api('GET', P());
        const b = branch ?? project?.default_branch;
        const prot = await http.request('GET', `${P()}/protected_branches/${encodeURIComponent(b)}`, { allow: [404] });
        const rules = await http.request('GET', `${P()}/approval_rules`, { allow: [403, 404] });
        const external = await http.request('GET', `${P()}/external_status_checks`, { allow: [403, 404] });
        const requiredChecks = [...(project?.only_allow_merge_if_pipeline_succeeds ? ['pipeline'] : []), ...(Array.isArray(external.json) ? external.json.map((c) => c.name) : [])];
        const requiredApprovals = Math.max(0, ...(Array.isArray(rules.json) ? rules.json.map((r) => r.approvals_required ?? 0) : []), project?.approvals_before_merge ?? 0);
        return { enforced: prot.status !== 404, branch: b, requiredChecks, requiredApprovals, codeOwnerReview: Boolean(prot.json?.code_owner_approval_required), pipelineGate: Boolean(project?.only_allow_merge_if_pipeline_succeeds), via: [prot.status !== 404 && 'a protected branch', project?.only_allow_merge_if_pipeline_succeeds && 'Pipelines must succeed'].filter(Boolean) };
      },
      // `factory review-gate enforce` on GitLab: "Pipelines must succeed" on the project (the review-quorum
      // job runs in every merge request pipeline, so a failing quorum blocks the merge) and, with CODEOWNERS,
      // code owner approval on the protected default branch (GitLab Premium; a lower tier ignores or refuses
      // it, which is reported, not an error). An unprotected default branch is protected (Maintainers push,
      // Developers merge). Nothing else is changed.
      async enforceReviewGate({ codeOwners = false, dryRun = false } = {}) {
        const project = await api('GET', P());
        const b = project?.default_branch;
        const changes = [];
        const manual = [];
        if (!project?.only_allow_merge_if_pipeline_succeeds) changes.push('Pipelines must succeed');
        const prot = await http.request('GET', `${P()}/protected_branches/${encodeURIComponent(b)}`, { allow: [404] });
        const protectedNow = prot.status !== 404;
        if (!protectedNow) changes.push(`protect ${b} (Maintainers push, Developers merge)`);
        const ownersNow = Boolean(prot.json?.code_owner_approval_required);
        if (codeOwners && !ownersNow) changes.push(`code owner approval on ${b}`);
        const summary = (action) => `${action === 'unchanged' ? 'already set' : action.startsWith('would') ? 'would set' : 'set'}: ${changes.length ? changes.join(', ') : `Pipelines must succeed${codeOwners ? `, code owner approval on ${b}` : ''}`}`;
        if (!changes.length) return { action: 'unchanged', summary: summary('unchanged'), manual };
        if (dryRun) return { action: protectedNow || project?.only_allow_merge_if_pipeline_succeeds ? 'would-update' : 'would-create', summary: summary('would'), manual };
        if (!project?.only_allow_merge_if_pipeline_succeeds) await api('PUT', P(), { body: { only_allow_merge_if_pipeline_succeeds: true } });
        if (!protectedNow) await http.request('POST', `${P()}/protected_branches`, { body: { name: b, push_access_level: 40, merge_access_level: 30, ...(codeOwners ? { code_owner_approval_required: true } : {}) }, allow: [403] });
        else if (codeOwners && !ownersNow) await http.request('PATCH', `${P()}/protected_branches/${encodeURIComponent(b)}`, { query: { code_owner_approval_required: true }, allow: [403] });
        if (codeOwners) {
          const after = await http.request('GET', `${P()}/protected_branches/${encodeURIComponent(b)}`, { allow: [404] });
          if (!after.json?.code_owner_approval_required) manual.push(`GitLab did not turn on code owner approval for ${b} (it needs GitLab Premium): CODEOWNERS stays advisory, or set it in Settings > Repository > Protected branches on a tier that has it`);
        }
        return { action: protectedNow || project?.only_allow_merge_if_pipeline_succeeds ? 'updated' : 'created', summary: summary('done'), manual };
      },
      async ensureLabel(name, { color = 'ededed', description = '' } = {}) {
        await http.request('POST', `${P()}/labels`, { body: { name, color: `#${String(color).replace(/^#/, '')}`, description }, allow: [409] });
      },
    },
  };
  return host;
}

// The PR identity on GitLab: a project or group access token (a bot user GitLab creates with the token),
// read from `host.bot.token` ("${GITLAB_BOT_TOKEN}"). The factory does not create it: setup prints the
// steps.
export function gitlabBot(settings, { resolveBotToken, createHost, log: logDefault = (m) => console.log(m) }) {
  const where = settings.repo ? `${String(settings.url ?? DEFAULT_URL).replace(/\/+$/, '')}/${settings.repo}/-/settings/access_tokens` : 'the project\'s Settings > Access tokens';
  const steps = [
    `1. Open ${where} (a Maintainer can; a group access token works the same under the group's settings).`,
    '2. Add a token named after the bot (for example dev-bot), role Developer, scopes `api` and `write_repository`, and an expiry date.',
    '3. Store it as a secret outside the repository and export it, for example GITLAB_BOT_TOKEN, locally and in CI.',
    '4. Set "host": { "bot": { "token": "${GITLAB_BOT_TOKEN}" } } in .factory/config.json, then run `factory bot status`.',
    '5. Merge requests opened by the pipeline are then authored by the token\'s bot user, so you can approve them.',
  ];
  return {
    token: async () => resolveBotToken(),
    // Whether a separate PR identity is set up, and the login the pipeline's pull requests are opened as.
    configured: () => Boolean(resolveBotToken()),
    author() {
      const t = resolveBotToken();
      return createHost(t ? { token: t } : {}).sync.identity()?.login ?? null;
    },
    async status(deps = {}) {
      const log = deps.log ?? logDefault;
      const token = resolveBotToken();
      if (!token) {
        log('Bot:         not configured (host.bot.token is not set or its variable is empty)');
        return 1;
      }
      try {
        const who = await createHost({ token }).identity();
        log(`Bot:         ${who.login} (GitLab user id ${who.id})`);
        return 0;
      } catch (error) {
        log(`Bot:         the token is set but GitLab refused it: ${error.message}`);
        return 1;
      }
    },
    async setup(_options = {}, deps = {}) {
      const log = deps.log ?? logDefault;
      log('GitLab has no API the factory can use to create its own PR identity without a Maintainer token, so create it by hand:');
      for (const s of steps) log(s);
      return resolveBotToken() ? 0 : 1;
    },
    steps,
  };
}
