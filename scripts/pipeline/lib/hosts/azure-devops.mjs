// The Azure DevOps code host (Services, or Server through `host.url`): Git REST API through fetch.
// A pull request's number is its pullRequestId; labels are PR labels (tags); approvals are reviewer
// votes (10 and 5 approve, -10 and -5 request changes); auto-merge is autoComplete; checks are the PR's
// statuses plus its policy evaluations.
//
// settings: { url ("https://dev.azure.com" or "https://server/tfs"), repo ("organization/project/
// repository"), resolveToken(), apiVersion (default 7.1) }. deps: { fetch, token, sleep }.
// The token is a PAT (basic auth) or an Entra ID access token of a service principal (a JWT: bearer).
import fs from 'node:fs';
import path from 'node:path';
import { HostError, UnsupportedError } from './errors.mjs';
import { createHttp } from './http.mjs';
import { DEFAULT_URLS, defaultMergeMethod } from '../products.mjs';

export const DEFAULT_URL = DEFAULT_URLS['azure-devops'];
const NO_ONE = '00000000-0000-0000-0000-000000000000';

const STATUS = { active: 'open', completed: 'merged', abandoned: 'closed' };
// The policy type id of a Status policy (the same in every organization).
const STATUS_POLICY = 'cbdc66da-9728-4af8-aada-9a5a32e4a226';
const refName = (b) => (b == null ? undefined : String(b).startsWith('refs/') ? String(b) : `refs/heads/${b}`);
const shortRef = (r) => (r == null ? null : String(r).replace(/^refs\/heads\//, ''));
const numOf = (pr) => Number(/pullrequest\/(\d+)/i.exec(String(pr))?.[1] ?? String(pr).replace(/^[!#]/, '')) || null;
const isJwt = (t) => /^[\w-]+\.[\w-]+\.[\w-]+$/.test(String(t));

// Reviewer vote -> review state.
export const voteState = (v) => (v >= 5 ? 'approved' : v <= -5 ? 'changes_requested' : null);

// Status state (succeeded, failed, error, pending, notSet, notApplicable) -> { status, conclusion }.
export function statusState(s) {
  switch (String(s ?? '').toLowerCase()) {
    case 'succeeded':
    case 'approved':
      return ['completed', 'success'];
    case 'failed':
    case 'error':
    case 'rejected':
    case 'broken':
      return ['completed', 'failure'];
    case 'notapplicable':
      return ['completed', 'skipped'];
    case 'running':
      return ['in_progress', null];
    default:
      return ['pending', null];
  }
}

// What Azure Repos can do for the harness (providers/contracts.mjs CAPABILITIES.host). No CODEOWNERS: required
// reviewers per path are a branch policy a person adds; no labels on the gate's terms (PR tags, partial).
export const CAPABILITIES = { requiredChecks: true, codeOwners: 'partial', autoMerge: true, mergeHeadGuard: true, cancelAutoMerge: true, drafts: true, labels: 'partial', checkAnnotations: false, commitStatus: true, attachments: true, botIdentity: true, diff: false, reviewCommentThreads: true, stateEvents: false };

// Azure DevOps' completion strategy for a merge method; a method it has none for gets the default method's.
const STRATEGY = { squash: 'squash', merge: 'noFastForward', rebase: 'rebase' };
const mergeStrategy = (m) => STRATEGY[m] ?? STRATEGY[defaultMergeMethod()];

export function createAzureDevopsHost(settings, deps = {}) {
  const url = String(settings.url ?? DEFAULT_URL).replace(/\/+$/, '');
  const repoPath = settings.repo ?? null;
  const [org, project, repository] = String(repoPath ?? '').split('/');
  const token = deps.token ?? settings.resolveToken?.() ?? null;
  const v = settings.apiVersion ?? '7.1';
  const preview = `${v}-preview.1`;
  const auth = token ? { Authorization: isJwt(token) ? `Bearer ${token}` : `Basic ${Buffer.from(`:${token}`).toString('base64')}` } : {};
  const http = createHttp({ baseUrl: url, headers: auth, fetch: deps.fetch, sleep: deps.sleep, label: 'Azure DevOps', secrets: [token] });
  const enc = encodeURIComponent;
  const need = () => {
    if (!org || !project || !repository) throw new HostError('the Azure DevOps repository is unknown: set host.repo ("organization/project/repository") in .factory/config.json', { code: 'config' });
    if (!token) throw new HostError('no Azure DevOps token: set host.token to "${AZURE_DEVOPS_TOKEN}" (a PAT with Code read & write, or a service principal\'s access token) and export it', { code: 'auth', status: 401 });
  };
  const G = () => (need(), `/${enc(org)}/${enc(project)}/_apis/git/repositories/${enc(repository)}`);
  const PR = (pr) => `${G()}/pullrequests/${numOf(pr)}`;
  const api = (method, p, opts = {}) => http.json(method, p, { ...opts, query: { 'api-version': v, ...(opts.query ?? {}) } });
  const req = (method, p, opts = {}) => http.request(method, p, { ...opts, query: { 'api-version': v, ...(opts.query ?? {}) } });
  const webBase = repoPath ? `${url}/${enc(org)}/${enc(project)}/_git/${enc(repository)}` : url;
  // Identities live on vssps.dev.azure.com for Services, on the server itself for Azure DevOps Server.
  const identityBase = /^https:\/\/dev\.azure\.com$/i.test(url) ? 'https://vssps.dev.azure.com' : url;

  const normalize = (p) =>
    p && {
      number: p.pullRequestId,
      url: `${webBase}/pullrequest/${p.pullRequestId}`,
      title: p.title ?? '',
      body: p.description ?? '',
      state: STATUS[p.status] ?? 'open',
      draft: Boolean(p.isDraft),
      head: shortRef(p.sourceRefName),
      base: shortRef(p.targetRefName),
      headSha: p.lastMergeSourceCommit?.commitId ?? null,
      author: p.createdBy?.uniqueName ?? p.createdBy?.displayName ?? null,
      labels: (p.labels ?? []).filter((l) => l.active !== false).map((l) => l.name),
      mergeable: p.mergeStatus === 'succeeded' ? true : p.mergeStatus === 'conflicts' ? false : null,
      createdAt: p.creationDate ?? null,
      updatedAt: null,
      mergedAt: p.status === 'completed' ? p.closedDate ?? null : null,
      closedAt: p.closedDate ?? null,
      mergeCommit: p.lastMergeCommit?.commitId ?? null,
      additions: null,
      deletions: null,
      changedFiles: null,
      fromFork: Boolean(p.forkSource),
    };

  const rawPr = (pr) => api('GET', PR(pr));
  let me;
  const identity = async () => {
    need();
    me ??= await http.json('GET', `/${enc(org)}/_apis/connectionData`, { query: { 'api-version': `${v}-preview` } });
    const u = me?.authenticatedUser ?? {};
    return { login: u.properties?.Account?.$value ?? u.providerDisplayName ?? null, id: u.id ?? null };
  };
  const identityId = async (login) => {
    const r = await http.request('GET', `${identityBase}/${enc(org)}/_apis/identities`, { absolute: true, query: { searchFilter: 'General', filterValue: login, queryMembership: 'None', 'api-version': v }, allow: [404] });
    return r.json?.value?.[0]?.id ?? null;
  };
  const threads = async (pr) => (await api('GET', `${PR(pr)}/threads`))?.value ?? [];
  const textComments = (list) => list.flatMap((t) => (t.comments ?? []).filter((c) => c.commentType !== 'system' && !c.isDeleted).map((c) => ({ thread: t, c })));

  const host = {
    type: 'azure-devops',
    label: 'Azure DevOps',
    capabilities: CAPABILITIES,
    hints: { checked: 'the branch policies', enforce: 'a blocking Status policy for review-quorum and Build validation for the CI pipelines', settings: 'Project settings > Repositories > Policies', planDecision: 'add the policies by hand, or accept advisory review', autoMerge: 'Azure DevOps (auto-complete is always available)' },
    webUrl: webBase,
    identity,
    pr: {
      async open({ head, base, title, body = '', draft = false, labels = [], reviewers = [] }) {
        const target = base ?? (await host.repo.defaultBranch());
        const ids = [];
        for (const r of reviewers) {
          const id = await identityId(r);
          if (id) ids.push({ id });
        }
        const p = await api('POST', `${G()}/pullrequests`, { body: { sourceRefName: refName(head), targetRefName: refName(target), title, description: body, isDraft: Boolean(draft), ...(labels.length ? { labels: labels.map((name) => ({ name })) } : {}), ...(ids.length ? { reviewers: ids } : {}) } });
        return normalize(p);
      },
      async get(numberOrBranch) {
        if (/^[!#]?\d+$/.test(String(numberOrBranch)) || /pullrequest\/\d+/i.test(String(numberOrBranch))) {
          const r = await req('GET', PR(numberOrBranch), { allow: [404] });
          return r.status === 404 ? null : normalize(r.json);
        }
        return (await host.pr.list({ state: 'open', head: numberOrBranch }))[0] ?? (await host.pr.list({ state: 'all', head: numberOrBranch }))[0] ?? null;
      },
      async list({ state = 'open', head, base, label, limit = 200 } = {}) {
        const status = { open: 'active', merged: 'completed', closed: 'all', all: 'all' }[state] ?? 'active';
        const out = [];
        for (let skip = 0; out.length < limit; skip += 100) {
          const page = (await api('GET', `${G()}/pullrequests`, { query: { 'searchCriteria.status': status, 'searchCriteria.sourceRefName': refName(head), 'searchCriteria.targetRefName': refName(base), $top: 100, $skip: skip } }))?.value ?? [];
          out.push(...page.map(normalize));
          if (page.length < 100) break;
        }
        return out.filter((p) => (state !== 'closed' || p.state !== 'open') && (!label || p.labels.includes(label))).slice(0, limit);
      },
      async update(pr, { title, body, labels, state, draft } = {}) {
        const data = {};
        if (title != null) data.title = title;
        if (body != null) data.description = body;
        if (state === 'closed') data.status = 'abandoned';
        if (state === 'open') data.status = 'active';
        if (draft != null) data.isDraft = Boolean(draft);
        if (Object.keys(data).length) await api('PATCH', PR(pr), { body: data });
        if (labels) {
          let add = labels.add ?? [];
          let remove = labels.remove ?? [];
          if (Array.isArray(labels)) {
            const current = (await host.pr.get(pr))?.labels ?? [];
            add = labels.filter((l) => !current.includes(l));
            remove = current.filter((l) => !labels.includes(l));
          }
          for (const name of add) await http.request('POST', `${PR(pr)}/labels`, { query: { 'api-version': preview }, body: { name } });
          for (const name of remove) await http.request('DELETE', `${PR(pr)}/labels/${enc(name)}`, { query: { 'api-version': preview }, allow: [404] });
        }
      },
      async comment(pr, body, { marker } = {}) {
        const hit = marker ? textComments(await threads(pr)).filter(({ c }) => String(c.content ?? '').includes(marker)).at(-1) : null;
        if (hit) {
          await api('PATCH', `${PR(pr)}/threads/${hit.thread.id}/comments/${hit.c.id}`, { body: { content: body } });
          return { id: `${hit.thread.id}/${hit.c.id}`, url: `${webBase}/pullrequest/${numOf(pr)}?discussionId=${hit.thread.id}` };
        }
        const t = await api('POST', `${PR(pr)}/threads`, { body: { comments: [{ parentCommentId: 0, content: body, commentType: 1 }], status: 4 } });
        return { id: `${t?.id}/${t?.comments?.[0]?.id ?? 1}`, url: `${webBase}/pullrequest/${numOf(pr)}?discussionId=${t?.id}` };
      },
      async comments(pr) {
        return textComments((await threads(pr)).filter((t) => !t.threadContext)).map(({ thread, c }) => ({ id: `${thread.id}/${c.id}`, author: c.author?.uniqueName ?? c.author?.displayName ?? null, body: c.content ?? '', createdAt: c.publishedDate ?? null }));
      },
      // Votes carry no time or commit: a vote Azure still shows counts for the current head (the branch
      // policy "reset votes on new pushes" clears stale ones), so `commit` is the head.
      // `strict` (the review gate's rejection check): a pull request without its reviewers list throws (unknown: review).
      async reviews(pr, { strict = false } = {}) {
        const p = await rawPr(pr);
        if (strict && (!Array.isArray(p?.reviewers) || p.reviewers.some((r) => typeof r?.vote !== 'number'))) throw new HostError('Azure Repos: the reviewers of the pull request could not be read');
        return (p?.reviewers ?? [])
          .filter((r) => voteState(r.vote) && !r.isContainer)
          .map((r) => ({ id: `${r.id}:${r.vote}`, author: r.uniqueName ?? r.displayName ?? null, bot: false, state: voteState(r.vote), submittedAt: null, commit: p.lastMergeSourceCommit?.commitId ?? null, body: '' }));
      },
      async reviewComments(pr) {
        return textComments((await threads(pr)).filter((t) => t.threadContext?.filePath)).map(({ thread, c }) => ({ id: `${thread.id}/${c.id}`, author: c.author?.uniqueName ?? null, body: c.content ?? '', path: String(thread.threadContext.filePath).replace(/^\//, ''), line: thread.threadContext.rightFileStart?.line ?? thread.threadContext.leftFileStart?.line ?? null, reviewId: null, createdAt: c.publishedDate ?? null }));
      },
      async commits(pr) {
        return ((await api('GET', `${PR(pr)}/commits`))?.value ?? []).map((c) => ({ sha: c.commitId, author: c.author?.email ?? c.author?.name ?? null, committedAt: c.committer?.date ?? c.author?.date ?? null, parents: c.parents?.length ?? null, message: c.commentTruncated ? null : (c.comment ?? null) }));
      },
      async requestReviewers(pr, logins = []) {
        const done = [];
        for (const login of logins) {
          const id = await identityId(login);
          if (!id) continue;
          const r = await req('PUT', `${PR(pr)}/reviewers/${id}`, { body: { vote: 0 }, allow: [400, 403, 404] });
          if (r.status < 300) done.push(login);
        }
        return done;
      },
      async files(pr) {
        const its = (await api('GET', `${PR(pr)}/iterations`))?.value ?? [];
        const last = its.at(-1)?.id;
        if (!last) return [];
        const changes = (await api('GET', `${PR(pr)}/iterations/${last}/changes`, { query: { $compareTo: 0 } }))?.changeEntries ?? [];
        const kind = (t) => (/add/i.test(t) ? 'added' : /delete/i.test(t) ? 'removed' : /rename/i.test(t) ? 'renamed' : 'modified');
        return changes.filter((c) => !c.item?.isFolder).map((c) => ({ path: String(c.item?.path ?? '').replace(/^\//, ''), status: kind(c.changeType), additions: null, deletions: null }));
      },
      async diff() {
        throw new UnsupportedError('Azure DevOps has no unified diff API for a pull request: fetch the branches and run `git diff <base>...<head>` locally');
      },
      async checks(pr) {
        const p = await rawPr(pr);
        const out = [];
        const latest = new Map();
        for (const s of (await api('GET', `${PR(pr)}/statuses`))?.value ?? []) {
          const name = [s.context?.genre, s.context?.name].filter(Boolean).join('/');
          if (!latest.has(name) || (s.id ?? 0) > (latest.get(name).id ?? 0)) latest.set(name, s);
        }
        for (const [name, s] of latest) {
          const [status, conclusion] = statusState(s.state);
          out.push({ name, status, conclusion, url: s.targetUrl ?? null });
        }
        const projectId = p?.repository?.project?.id;
        if (projectId) {
          const r = await http.request('GET', `/${enc(org)}/${enc(project)}/_apis/policy/evaluations`, { query: { artifactId: `vstfs:///CodeReview/CodeReviewId/${projectId}/${numOf(pr)}`, 'api-version': preview }, allow: [403, 404] });
          for (const e of r.json?.value ?? []) {
            const [status, conclusion] = statusState(e.status);
            out.push({ name: e.configuration?.settings?.displayName || e.configuration?.type?.displayName || 'policy', status, conclusion, url: null });
          }
        }
        return out;
      },
      // A commit status; with `pr`, also the pull request status that branch policies read.
      async setStatus(sha, { name, state, description = '', url: target, pr } = {}) {
        const genre = String(name ?? '').includes('/') ? String(name).split('/')[0] : 'factory';
        const short = String(name ?? '').includes('/') ? String(name).split('/').slice(1).join('/') : name;
        const azState = { success: 'succeeded', failure: 'failed', error: 'error', pending: 'pending' }[state] ?? 'error';
        const body = { state: azState, description: String(description).slice(0, 255), context: { name: short, genre }, ...(target ? { targetUrl: target } : {}) };
        await api('POST', `${G()}/commits/${sha}/statuses`, { body });
        if (pr) await http.request('POST', `${PR(pr)}/statuses`, { query: { 'api-version': preview }, body });
      },
      // The merge state the gate reads: status (active, completed, abandoned) and mergeStatus (succeeded, conflicts,
      // queued, notSet, rejectedByPolicy, failure) of the pull request.
      async mergeState(pr, { tries = 5, waitMs = 3000 } = {}) {
        let p = null;
        for (let i = 0; i < tries; i++) {
          p = await rawPr(pr);
          if (!['queued', 'notSet'].includes(p?.mergeStatus) || p?.status !== 'active') break;
          if (waitMs) await new Promise((r) => setTimeout(r, waitMs));
        }
        const m = p?.mergeStatus ?? 'notSet';
        const mergeState = m === 'succeeded' ? 'clean' : m === 'conflicts' ? 'dirty' : ['queued', 'notSet'].includes(m) ? 'unknown' : 'blocked';
        const state = p?.status === 'completed' ? 'merged' : p?.status === 'abandoned' ? 'closed' : 'open';
        return { state, mergeState, raw: m, mergedAt: p?.closedDate && state === 'merged' ? p.closedDate : null, autoMerge: Boolean(p?.autoCompleteSetBy?.id && p.autoCompleteSetBy.id !== NO_ONE) };
      },
      // Completes the pull request, bound to `headSha`: Azure DevOps completes only the source commit it is given
      // (lastMergeSourceCommit), and the head is checked first so a moved branch is refused. `auto`: auto-complete.
      async merge(pr, { method = defaultMergeMethod(), auto = false, headSha = null, deleteBranch = false } = {}) {
        const completionOptions = { mergeStrategy: mergeStrategy(method), deleteSourceBranch: Boolean(deleteBranch) };
        const p = await rawPr(pr);
        const current = p?.lastMergeSourceCommit?.commitId ?? null;
        if (headSha && current && current !== headSha) throw new HostError(`pull request ${pr}: its head moved from ${headSha.slice(0, 7)} to ${current.slice(0, 7)}; not merged`, { status: 409, code: 'head-moved' });
        if (auto) {
          const who = await identity();
          await api('PATCH', PR(pr), { body: { autoCompleteSetBy: { id: who.id }, completionOptions } });
          return { merged: false, mergedAt: null, autoMerge: true };
        }
        const done = await api('PATCH', PR(pr), { body: { status: 'completed', lastMergeSourceCommit: { commitId: headSha ?? current }, completionOptions } });
        return { merged: done?.status === 'completed', mergedAt: done?.closedDate ?? null, autoMerge: false };
      },
      async autoMergeArmed(pr) {
        const p = await rawPr(pr);
        return Boolean(p?.autoCompleteSetBy?.id && p.autoCompleteSetBy.id !== NO_ONE);
      },
      async close(pr, { comment = null } = {}) {
        if (comment) await host.pr.comment(pr, comment);
        await api('PATCH', PR(pr), { body: { status: 'abandoned' } });
        return true;
      },
      async cancelAutoMerge(pr) {
        const r = await req('PATCH', PR(pr), { body: { autoCompleteSetBy: { id: NO_ONE } }, allow: [400, 404] });
        return r.status < 300;
      },
      async uploadAttachment(pr, file) {
        const r = await http.request('POST', `${PR(pr)}/attachments/${enc(path.basename(file))}`, { query: { 'api-version': preview }, raw: fs.readFileSync(file) });
        return r.json?.url ?? null;
      },
    },
    issues: {
      async search() {
        throw new UnsupportedError('Azure Repos has no issues: factory issues are filed where the factory lives (GitHub or GitLab), or as Azure Boards work items by a person');
      },
      async create() {
        throw new UnsupportedError('Azure Repos has no issues: factory issues are filed where the factory lives (GitHub or GitLab), or as Azure Boards work items by a person');
      },
    },
    repo: {
      slug: repoPath,
      toString: () => repoPath ?? '',
      toJSON: () => repoPath,
      async defaultBranch() {
        return shortRef((await api('GET', G()))?.defaultBranch);
      },
      // Auto-complete is available on every Azure Repos pull request.
      async settings() {
        return { autoMergeAllowed: true };
      },
      // The files of a folder at a ref (items API, one level).
      async list(dir, ref) {
        const r = await req('GET', `${G()}/items`, { query: { scopePath: `/${String(dir).replace(/^\//, '')}`, recursionLevel: 'OneLevel', ...(ref ? { 'versionDescriptor.version': shortRef(ref), 'versionDescriptor.versionType': /^[0-9a-f]{40}$/i.test(ref) ? 'commit' : 'branch' } : {}) }, allow: [404] });
        return r.status === 404 ? null : (r.json?.value ?? []).filter((i) => !i.isFolder).map((i) => String(i.path).replace(/^\//, ''));
      },
      async file(p, ref) {
        const r = await req('GET', `${G()}/items`, { query: { path: `/${String(p).replace(/^\//, '')}`, includeContent: true, $format: 'octetStream', ...(ref ? { 'versionDescriptor.version': shortRef(ref), 'versionDescriptor.versionType': /^[0-9a-f]{40}$/i.test(ref) ? 'commit' : 'branch' } : {}) }, accept: 'application/octet-stream', allow: [404] });
        return r.status === 404 ? null : r.text;
      },
      // Branch policies on the branch: "Minimum number of reviewers" (approvals), "Status" and "Build"
      // policies (required checks), "Required reviewers" (code-owner style review). enforced: any enabled
      // blocking policy.
      // Azure DevOps has no endpoint that says what a PAT may do on a repository.
      async permissions() {
        throw new UnsupportedError('Azure DevOps cannot report a token\'s permissions: give the PAT the Code (Read & write) scope and, for the policy check, Policy (Read); doctor checks that the repository is readable instead');
      },
      async branchProtection(branch) {
        const b = branch ?? (await host.repo.defaultBranch());
        const repoInfo = await api('GET', G());
        const list = (await api('GET', `/${enc(org)}/${enc(project)}/_apis/policy/configurations`, { query: { repositoryId: repoInfo?.id, refName: refName(b) } }))?.value ?? [];
        const active = list.filter((p) => p.isEnabled && p.isBlocking);
        const type = (p) => p.type?.displayName ?? '';
        return {
          enforced: active.length > 0,
          branch: b,
          requiredChecks: active.filter((p) => ['Status', 'Build'].includes(type(p))).map((p) => (type(p) === 'Status' ? [p.settings?.statusGenre, p.settings?.statusName].filter(Boolean).join('/') : p.settings?.displayName || `build ${p.settings?.buildDefinitionId}`)),
          requiredApprovals: Math.max(0, ...active.filter((p) => type(p) === 'Minimum number of reviewers').map((p) => p.settings?.minimumApproverCount ?? 0)),
          codeOwnerReview: active.some((p) => type(p) === 'Required reviewers'),
        };
      },
      // `factory review-gate enforce` on Azure DevOps: a blocking Status policy on the default branch that
      // requires the `factory/review-quorum` status the review-quorum pipeline posts (reset on every push).
      // Azure DevOps has no CODEOWNERS file: required reviewers by path are a Required reviewers policy
      // whose reviewers are identities only a person can choose, so they are listed under `manual`.
      async enforceReviewGate({ codeOwners = false, dryRun = false, ownerPaths = ['/.factory/*'] } = {}) {
        const b = await host.repo.defaultBranch();
        const repoInfo = await api('GET', G());
        const scope = [{ repositoryId: repoInfo?.id, refName: refName(b), matchKind: 'exact' }];
        const list = (await api('GET', `/${enc(org)}/${enc(project)}/_apis/policy/configurations`, { query: { repositoryId: repoInfo?.id, refName: refName(b) } }))?.value ?? [];
        const isQuorum = (p) => p.type?.id === STATUS_POLICY && p.settings?.statusName === 'review-quorum' && (p.settings?.statusGenre ?? '') === 'factory';
        const existing = list.find(isQuorum);
        const manual = codeOwners ? [`Azure DevOps has no CODEOWNERS: add a Required reviewers policy on ${b} for ${ownerPaths.join(', ')} and the generated files (Project settings > Repositories > ${repository} > Policies > ${b}), with the code owners as reviewers`] : [];
        const body = { isEnabled: true, isBlocking: true, type: { id: STATUS_POLICY }, settings: { statusName: 'review-quorum', statusGenre: 'factory', invalidateOnSourceUpdate: true, policyApplicability: null, defaultDisplayName: 'review-quorum', scope } };
        const summary = (what) => `Status policy "factory/review-quorum" on ${b} ${what} (blocking, reset on every push)`;
        if (existing?.isEnabled && existing?.isBlocking) return { action: 'unchanged', summary: summary('already required'), manual };
        if (dryRun) return { action: existing ? 'would-update' : 'would-create', summary: summary('would be required'), manual };
        if (existing) await api('PUT', `/${enc(org)}/${enc(project)}/_apis/policy/configurations/${existing.id}`, { body: { ...body, settings: { ...existing.settings, ...body.settings } } });
        else await api('POST', `/${enc(org)}/${enc(project)}/_apis/policy/configurations`, { body });
        return { action: existing ? 'updated' : 'created', summary: summary('required'), manual };
      },
      // Azure creates a PR label when it is first added: nothing to prepare.
      async ensureLabel() {},
    },
  };
  return host;
}

// The PR identity on Azure DevOps: a service principal (an Entra ID application added to the
// organization) or a dedicated user's PAT, read from `host.bot.token`. No API can create it for the
// factory: setup prints the steps.
export function azureBot(settings, { resolveBotToken, createHost, log: logDefault = (m) => console.log(m) }) {
  const [org, project] = String(settings.repo ?? '').split('/');
  const steps = [
    `1. In Microsoft Entra ID, register an application (the bot), or create a dedicated user; add it to the organization ${org || '<organization>'} (Organization settings > Users, access level Basic).`,
    `2. Add it to the Contributors group of the project ${project || '<project>'} (it needs Contribute and Contribute to pull requests on the repository).`,
    '3. For a user, create a PAT with the Code (Read & write) scope; for a service principal, have CI obtain an access token for the resource 499b84ac-1321-427f-aa17-267ca6975798.',
    '4. Export it outside the repository, for example AZURE_DEVOPS_BOT_TOKEN, and set "host": { "bot": { "token": "${AZURE_DEVOPS_BOT_TOKEN}" } } in .factory/config.json.',
    '5. Run `factory bot status`. Pull requests the pipeline opens are then created by the bot, so you can approve them (keep the policy "Allow requestors to approve their own changes" off).',
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
        log(`Bot:         ${who.login} (Azure DevOps id ${who.id})`);
        return 0;
      } catch (error) {
        log(`Bot:         the token is set but Azure DevOps refused it: ${error.message}`);
        return 1;
      }
    },
    async setup(_options = {}, deps = {}) {
      const log = deps.log ?? logDefault;
      log('Azure DevOps has no API that creates the pipeline\'s PR identity, so create it by hand:');
      for (const s of steps) log(s);
      return resolveBotToken() ? 0 : 1;
    },
    steps,
  };
}
