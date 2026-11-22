// The Bitbucket Cloud code host: REST API 2.0 through fetch (https://developer.atlassian.com/cloud/bitbucket/rest/,
// read 2026-11-17: api-group-pullrequests, api-group-commit-statuses, api-group-branch-restrictions, api-group-source).
// A pull request's number is its id. Reviews are the participants' approvals and "changes requested" states (Bitbucket
// keeps no commit per approval, so a listed approval counts for the current head; "Reset approvals on push" in the
// repository's settings removes stale ones). Checks are the commit statuses Bitbucket shows on the pull request.
//
// What Bitbucket Cloud cannot do for the harness (capabilities below): labels on pull requests (the gate keeps
// approvals:N in its notice comment), a merge bound to a head SHA (the gate re-reads the head right before merging and
// refuses if it moved; host auto-merge is never used), uploading files to a pull request (videos stay on the storage
// branch), and naming the checks a branch requires ("require passing builds" counts builds; merge checks are blocking
// only on the Premium plan, `enforce_merge_checks`).
//
// Bitbucket Data Center / Server has a different REST API (1.0, projects and repos, other shapes): it is not covered by
// this adapter. Use the custom adapter (docs/providers/custom.md) for it.
//
// settings: { url (https://bitbucket.org), repo ("workspace/repository"), resolveToken(), user ("${BITBUCKET_USER}",
// for an API token or app password; without it the token is sent as a Bearer access token) }. deps: { fetch, token, sleep }.
import { HostError, UnsupportedError } from './errors.mjs';
import { createHttp } from './http.mjs';
import { expandEnv } from '../env.mjs';

export const DEFAULT_URL = 'https://bitbucket.org';
export const CAPABILITIES = { requiredChecks: 'partial', codeOwners: false, autoMerge: false, mergeHeadGuard: false, cancelAutoMerge: false, drafts: true, labels: false, checkAnnotations: false, commitStatus: true, attachments: false, botIdentity: true, diff: true, reviewCommentThreads: true, stateEvents: false };

const STATE = { OPEN: 'open', MERGED: 'merged', DECLINED: 'closed', SUPERSEDED: 'closed' };
const CHECK = { SUCCESSFUL: ['completed', 'success'], FAILED: ['completed', 'failure'], STOPPED: ['completed', 'cancelled'], INPROGRESS: ['pending', null] };
const STATUS_OUT = { success: 'SUCCESSFUL', failure: 'FAILED', error: 'FAILED', pending: 'INPROGRESS', running: 'INPROGRESS', cancelled: 'STOPPED' };
const STRATEGY = { squash: 'squash', merge: 'merge_commit', rebase: 'fast_forward' };
const numOf = (pr) => Number(/pull-requests\/(\d+)/.exec(String(pr))?.[1] ?? String(pr).replace(/^#/, '')) || null;

// The API base of a Bitbucket Cloud URL.
export const apiBase = (url) => (/(^|\/\/)bitbucket\.org\/?$/.test(String(url).replace(/\/+$/, '')) || !url ? 'https://api.bitbucket.org/2.0' : `${String(url).replace(/\/+$/, '')}/2.0`);

export function normalizePr(p) {
  if (!p) return null;
  return {
    number: p.id,
    url: p.links?.html?.href ?? null,
    title: p.title ?? '',
    body: p.description ?? p.summary?.raw ?? '',
    state: STATE[p.state] ?? 'open',
    draft: Boolean(p.draft),
    head: p.source?.branch?.name ?? null,
    base: p.destination?.branch?.name ?? null,
    // Bitbucket returns a short hash here; the full one comes from the commits list (pr.get completes it).
    headSha: p.source?.commit?.hash ?? null,
    author: p.author?.nickname ?? p.author?.display_name ?? null,
    labels: [],
    mergeable: null,
    createdAt: p.created_on ?? null,
    updatedAt: p.updated_on ?? null,
    mergedAt: p.state === 'MERGED' ? p.updated_on ?? null : null,
    closedAt: ['MERGED', 'DECLINED', 'SUPERSEDED'].includes(p.state) ? p.updated_on ?? null : null,
    mergeCommit: p.merge_commit?.hash ?? null,
    additions: null,
    deletions: null,
    changedFiles: null,
    fromFork: Boolean(p.source?.repository?.full_name && p.destination?.repository?.full_name && p.source.repository.full_name !== p.destination.repository.full_name),
  };
}

export function createBitbucketHost(settings, deps = {}) {
  const url = String(settings.url ?? DEFAULT_URL).replace(/\/+$/, '');
  const repo = settings.repo ?? null;
  const token = deps.token ?? settings.resolveToken?.() ?? null;
  const env = deps.env ?? process.env;
  let user;
  try {
    user = settings.user ? expandEnv(settings.user, env, 'host.user') : null;
  } catch {
    user = null;
  }
  const auth = token ? (user ? { Authorization: `Basic ${Buffer.from(`${user}:${token}`).toString('base64')}` } : { Authorization: `Bearer ${token}` }) : {};
  const http = createHttp({ baseUrl: apiBase(url), headers: auth, fetch: deps.fetch, sleep: deps.sleep, label: 'Bitbucket', secrets: [token, user] });
  const need = () => {
    if (!repo) throw new HostError('the Bitbucket repository is unknown: set host.repo ("workspace/repository") in .factory/config.json', { code: 'config' });
    if (!token) throw new HostError('no Bitbucket token: set host.token to "${BITBUCKET_TOKEN}" (a repository or workspace access token with the pullrequest:write and repository:write scopes) and export it', { code: 'auth', status: 401 });
    return repo.split('/').map(encodeURIComponent).join('/');
  };
  const R = () => `/repositories/${need()}`;
  const PR = (pr) => `${R()}/pullrequests/${numOf(pr)}`;
  const api = (method, p, opts) => http.json(method, p, opts);

  // Every page (the `next` link), up to 50 pages.
  async function all(p, query = {}) {
    const out = [];
    let next = null;
    for (let guard = 0; guard < 50; guard++) {
      const r = next ? await http.request('GET', next, { absolute: true }) : await http.request('GET', p, { query: { pagelen: 50, ...query } });
      out.push(...(r.json?.values ?? []));
      next = r.json?.next ?? null;
      if (!next) break;
    }
    return out;
  }

  const userUuid = async (login) => {
    const [ws] = String(repo).split('/');
    const found = await http.request('GET', `/workspaces/${encodeURIComponent(ws)}/members`, { query: { q: `user.nickname="${String(login).replace(/^@/, '').replace(/"/g, '')}"` }, allow: [403, 404] });
    return found.json?.values?.[0]?.user?.uuid ?? null;
  };
  const fullSha = async (pr, short) => {
    if (!short || short.length >= 40) return short;
    const first = await http.request('GET', `${PR(pr)}/commits`, { query: { pagelen: 1 }, allow: [404] });
    const h = first.json?.values?.[0]?.hash;
    return h && h.startsWith(short) ? h : short;
  };
  const get = async (n) => {
    const r = await http.request('GET', PR(n), { allow: [404] });
    if (r.status === 404) return null;
    const p = normalizePr(r.json);
    p.headSha = await fullSha(n, p.headSha);
    return p;
  };

  const host = {
    type: 'bitbucket',
    label: 'Bitbucket',
    capabilities: CAPABILITIES,
    // Bitbucket Cloud cannot reopen a declined pull request (used by holdMode to avoid close-reopen).
    reopenPr: false,
    hints: { codeOwnersFile: null, checked: 'the branch restrictions and merge checks', enforce: '"Minimum number of successful builds" and approvals as merge checks on the default branch', settings: 'Repository settings > Branch restrictions (and, on the Premium plan, "Prevent a merge with unresolved merge checks")', planDecision: 'the Premium plan for blocking merge checks, or accept advisory review', autoMerge: 'nothing (Bitbucket Cloud has no auto-merge; the review gate merges at the next board sync)' },
    webUrl: repo ? `${url}/${repo}` : url,
    async identity() {
      need();
      const u = await api('GET', '/user');
      return { login: u?.nickname ?? u?.username ?? null, id: u?.uuid ?? u?.account_id ?? null };
    },
    pr: {
      async open({ head, base, title, body = '', draft = false, reviewers = [] }) {
        const target = base ?? (await host.repo.defaultBranch());
        const ids = [];
        for (const r of reviewers) {
          const uuid = await userUuid(r);
          if (uuid) ids.push({ uuid });
        }
        const p = await api('POST', `${R()}/pullrequests`, { body: { title, description: body, source: { branch: { name: head } }, destination: { branch: { name: target } }, ...(draft ? { draft: true } : {}), ...(ids.length ? { reviewers: ids } : {}), close_source_branch: false } });
        return normalizePr(p);
      },
      async get(n) {
        if (/^#?\d+$/.test(String(n)) || /pull-requests\/\d+/.test(String(n))) return get(n);
        const open = await host.pr.list({ state: 'open', head: String(n) });
        return open[0] ?? (await host.pr.list({ state: 'all', head: String(n) }))[0] ?? null;
      },
      async list({ state = 'open', head, base, limit = 200 } = {}) {
        const states = { open: ['OPEN'], merged: ['MERGED'], closed: ['DECLINED', 'SUPERSEDED', 'MERGED'], all: ['OPEN', 'MERGED', 'DECLINED', 'SUPERSEDED'] }[state] ?? ['OPEN'];
        const q = [`(${states.map((s) => `state="${s}"`).join(' OR ')})`, head ? `source.branch.name="${head.replace(/"/g, '')}"` : null, base ? `destination.branch.name="${base.replace(/"/g, '')}"` : null].filter(Boolean).join(' AND ');
        return (await all(`${R()}/pullrequests`, { q, sort: '-created_on' })).map(normalizePr).slice(0, limit);
      },
      async update(pr, { title, body, state, draft } = {}) {
        const data = {};
        if (title != null) data.title = title;
        if (body != null) data.description = body;
        if (draft != null) data.draft = Boolean(draft);
        if (Object.keys(data).length) {
          const current = await api('GET', PR(pr));
          await api('PUT', PR(pr), { body: { title: data.title ?? current.title, ...data } });
        }
        if (state === 'closed') await api('POST', `${PR(pr)}/decline`);
        if (state === 'open') throw new UnsupportedError('Bitbucket Cloud cannot reopen a declined pull request; use draft mode to hold and release pull requests');
        // Labels: Bitbucket has none on pull requests (capabilities.labels false); the gate keeps them in its notice.
      },
      async close(pr, { comment = null } = {}) {
        if (comment) await host.pr.comment(pr, comment);
        await api('POST', `${PR(pr)}/decline`);
        return true;
      },
      async comment(pr, body, { marker } = {}) {
        const existing = marker ? (await host.pr.comments(pr)).filter((c) => c.body.includes(marker)).at(-1) : null;
        const c = existing ? await api('PUT', `${PR(pr)}/comments/${existing.id}`, { body: { content: { raw: body } } }) : await api('POST', `${PR(pr)}/comments`, { body: { content: { raw: body } } });
        return { id: c?.id ?? existing?.id ?? null, url: c?.links?.html?.href ?? null };
      },
      async comments(pr) {
        return (await all(`${PR(pr)}/comments`)).filter((c) => !c.inline && !c.deleted).map((c) => ({ id: c.id, author: c.user?.nickname ?? c.user?.display_name ?? null, body: c.content?.raw ?? '', createdAt: c.created_on ?? null, url: c.links?.html?.href ?? null }));
      },
      // `strict` (the review gate's rejection check): a pull request without its participants list throws (unknown: review).
      async reviews(pr, { strict = false } = {}) {
        const p = await api('GET', PR(pr));
        if (strict && !Array.isArray(p?.participants)) throw new HostError('Bitbucket: the participants of the pull request could not be read');
        const head = await fullSha(pr, p?.source?.commit?.hash);
        return (p?.participants ?? [])
          .filter((x) => x.approved || x.state)
          .map((x) => ({ id: x.user?.uuid ?? null, author: x.user?.nickname ?? x.user?.display_name ?? null, bot: x.user?.type === 'app_user', state: x.approved || x.state === 'approved' ? 'approved' : x.state === 'changes_requested' ? 'changes_requested' : 'commented', submittedAt: x.participated_on ?? null, commit: head, body: '' }));
      },
      async reviewComments(pr) {
        return (await all(`${PR(pr)}/comments`)).filter((c) => c.inline && !c.deleted).map((c) => ({ id: c.id, author: c.user?.nickname ?? null, body: c.content?.raw ?? '', path: c.inline?.path ?? null, line: c.inline?.to ?? c.inline?.from ?? null, reviewId: null, createdAt: c.created_on ?? null }));
      },
      async commits(pr) {
        return (await all(`${PR(pr)}/commits`)).map((c) => ({ sha: c.hash, author: c.author?.user?.nickname ?? c.author?.raw ?? null, committedAt: c.date ?? null, parents: c.parents?.length ?? null, message: c.message ?? null }));
      },
      async files(pr) {
        return (await all(`${PR(pr)}/diffstat`)).map((f) => ({ path: f.new?.path ?? f.old?.path, status: { added: 'added', removed: 'removed', renamed: 'renamed' }[f.status] ?? 'modified', additions: f.lines_added ?? null, deletions: f.lines_removed ?? null, conflict: /conflict/.test(String(f.status)) }));
      },
      async diff(pr) {
        return (await http.request('GET', `${PR(pr)}/diff`, { accept: 'text/plain' })).text;
      },
      async checks(pr) {
        return (await all(`${PR(pr)}/statuses`)).map((s) => {
          const [status, conclusion] = CHECK[s.state] ?? ['pending', null];
          return { name: s.name ?? s.key ?? null, status, conclusion, url: s.url ?? null };
        });
      },
      // Bitbucket says nothing about mergeability until a merge is tried; a file the diffstat marks as a merge conflict
      // makes it dirty. The branch's merge checks (builds, approvals) are applied by Bitbucket when the merge is tried.
      async mergeState(pr) {
        const p = await api('GET', PR(pr));
        const st = STATE[p?.state] ?? 'open';
        let conflict = false;
        if (st === 'open') conflict = (await host.pr.files(pr)).some((f) => f.conflict);
        return { state: st, mergeState: st !== 'open' ? 'clean' : conflict ? 'dirty' : 'clean', raw: conflict ? 'CONFLICT' : 'OPEN', mergedAt: st === 'merged' ? p.updated_on ?? null : null, autoMerge: false };
      },
      // No SHA guard on Bitbucket's merge: the head is compared first (the gate does it too) and the merge refused when it
      // moved. Never `auto` (Bitbucket Cloud has no auto-merge).
      async merge(pr, { method = 'squash', headSha = null, auto = false, deleteBranch = false } = {}) {
        if (auto) throw new UnsupportedError('Bitbucket Cloud has no auto-merge: the review gate merges the pull request itself at the next board sync');
        if (headSha) {
          const now = (await get(pr))?.headSha;
          if (now && !now.startsWith(headSha.slice(0, now.length)) && !headSha.startsWith(now)) throw new HostError(`pull request ${pr}: its head moved from ${headSha.slice(0, 7)} to ${String(now).slice(0, 7)}; not merged`, { status: 409, code: 'head-moved' });
        }
        const done = await api('POST', `${PR(pr)}/merge`, { body: { type: 'pullrequest', merge_strategy: STRATEGY[method] ?? 'squash', close_source_branch: Boolean(deleteBranch) } });
        return { merged: done?.state === 'MERGED', mergedAt: done?.updated_on ?? null, autoMerge: false };
      },
      async autoMergeArmed() {
        return false;
      },
      async cancelAutoMerge() {
        return false;
      },
      async requestReviewers(pr, logins = []) {
        const p = await api('GET', PR(pr));
        const have = (p?.reviewers ?? []).map((r) => ({ uuid: r.uuid }));
        const done = [];
        for (const l of logins) {
          const uuid = await userUuid(l);
          if (!uuid) continue;
          have.push({ uuid });
          done.push(l);
        }
        if (done.length) await api('PUT', PR(pr), { body: { title: p.title, reviewers: have } });
        return done;
      },
      async setStatus(sha, { name, state, description = '', url: target } = {}) {
        await api('POST', `${R()}/commit/${sha}/statuses/build`, { body: { key: String(name).slice(0, 40), name, state: STATUS_OUT[state] ?? 'FAILED', description: String(description).slice(0, 255), url: target ?? `${url}/${repo}` } });
      },
      async uploadAttachment() {
        throw new UnsupportedError('Bitbucket Cloud has no upload for pull requests: the video stays on the storage branch and is linked');
      },
    },
    repo: {
      slug: repo,
      toString: () => repo ?? '',
      toJSON: () => repo,
      async defaultBranch() {
        return (await api('GET', R()))?.mainbranch?.name ?? null;
      },
      async settings() {
        return { autoMergeAllowed: false };
      },
      async file(p, ref) {
        const r = await http.request('GET', `${R()}/src/${encodeURIComponent(ref ?? (await host.repo.defaultBranch()))}/${String(p).split('/').map(encodeURIComponent).join('/')}`, { accept: '*/*', allow: [404] });
        return r.status === 404 ? null : r.text;
      },
      async list(dir, ref) {
        const r = await http.request('GET', `${R()}/src/${encodeURIComponent(ref ?? (await host.repo.defaultBranch()))}/${String(dir).split('/').map(encodeURIComponent).join('/')}/`, { query: { pagelen: 100 }, allow: [404] });
        return r.status === 404 ? null : (r.json?.values ?? []).filter((e) => e.type === 'commit_file').map((e) => e.path);
      },
      async permissions() {
        const r = await http.request('GET', '/user/permissions/repositories', { query: { q: `repository.full_name="${repo}"` }, allow: [401, 403] });
        const level = r.json?.values?.[0]?.permission ?? null;
        if (!level) throw new UnsupportedError('Bitbucket did not report this token\'s permission on the repository (a repository access token cannot read it): give it the pullrequest:write and repository:write scopes');
        return { push: ['write', 'admin'].includes(level), pullRequests: ['write', 'admin'].includes(level), readPolicies: level === 'admin', admin: level === 'admin' };
      },
      // Branch restrictions on the branch: require_passing_builds_to_merge (a count of builds, not their names: the
      // whole set of builds must pass), require_approvals_to_merge, require_default_reviewer_approvals_to_merge, and
      // enforce_merge_checks (Premium: without it the checks only warn).
      async branchProtection(branch) {
        const b = branch ?? (await host.repo.defaultBranch());
        const list = (await all(`${R()}/branch-restrictions`)).filter((x) => x.pattern === b || x.pattern === '*' || (x.branch_match_kind === 'branching_model' && x.branch_type === 'development'));
        const kinds = new Set(list.map((x) => x.kind));
        const builds = kinds.has('require_passing_builds_to_merge');
        return {
          enforced: list.length > 0,
          branch: b,
          requiredChecks: builds ? ['all builds'] : [],
          requiredApprovals: Math.max(0, ...list.filter((x) => x.kind === 'require_approvals_to_merge').map((x) => x.value ?? 0)),
          codeOwnerReview: kinds.has('require_default_reviewer_approvals_to_merge'),
          pipelineGate: builds,
          blocking: kinds.has('enforce_merge_checks'),
          via: [...kinds],
        };
      },
      // `factory review-gate enforce`: "Minimum number of successful builds" (1, with none failed or in progress: every
      // build reported on the head, review-quorum among them, must pass) on the default branch. Approvals stay per pull
      // request (the gate's approvals:N). Blocking merge checks need the Premium plan: listed for a person.
      async enforceReviewGate({ dryRun = false } = {}) {
        const b = await host.repo.defaultBranch();
        const have = (await all(`${R()}/branch-restrictions`)).filter((x) => x.pattern === b);
        const changes = [];
        if (!have.some((x) => x.kind === 'require_passing_builds_to_merge')) changes.push(`require passing builds on ${b}`);
        const manual = have.some((x) => x.kind === 'enforce_merge_checks') ? [] : [`turn on "Prevent a merge with unresolved merge checks" for ${b} (Premium plan); without it Bitbucket only warns`];
        const summary = (a) => `${a === 'unchanged' ? 'already set' : a.startsWith('would') ? 'would set' : 'set'}: ${changes.join(', ') || `require passing builds on ${b}`}`;
        if (!changes.length) return { action: 'unchanged', summary: summary('unchanged'), manual, warnings: [] };
        if (dryRun) return { action: 'would-create', summary: summary('would'), manual, warnings: [] };
        await api('POST', `${R()}/branch-restrictions`, { body: { kind: 'require_passing_builds_to_merge', pattern: b, branch_match_kind: 'glob', value: 1 } });
        return { action: 'created', summary: summary('done'), manual, warnings: [] };
      },
      async ensureLabel() {
        // No labels on Bitbucket pull requests.
      },
    },
    issues: {
      async search() {
        throw new UnsupportedError('the factory files issues on GitHub, GitLab or a tracker; Bitbucket\'s issue tracker is not used');
      },
      async create() {
        throw new UnsupportedError('the factory files issues on GitHub, GitLab or a tracker; Bitbucket\'s issue tracker is not used');
      },
    },
  };
  return host;
}

// The PR identity on Bitbucket: a repository or workspace access token (Bitbucket creates a bot user for it).
export function bitbucketBot(settings, { resolveBotToken, createHost, log: logDefault = (m) => console.log(m) }) {
  const where = settings.repo ? `${String(settings.url ?? DEFAULT_URL).replace(/\/+$/, '')}/${settings.repo}/admin/access-tokens` : 'the repository\'s Repository settings > Access tokens';
  const steps = [
    `1. Open ${where} (a repository admin can; a workspace access token works the same under the workspace settings).`,
    '2. Create a token named after the bot (for example dev-bot) with the scopes pullrequest:write, repository:write and pipeline:read.',
    '3. Store it as a secret outside the repository and export it, for example BITBUCKET_BOT_TOKEN, locally and as a secured repository variable in CI.',
    '4. Set "host": { "bot": { "token": "${BITBUCKET_BOT_TOKEN}" } } in .factory/config.json, then run `factory bot status`.',
  ];
  return {
    token: async () => resolveBotToken(),
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
        log(`Bot:         ${who.login ?? who.id} (Bitbucket)`);
        return 0;
      } catch (error) {
        log(`Bot:         the token is set but Bitbucket refused it: ${error.message}`);
        return 1;
      }
    },
    async setup(_options = {}, deps = {}) {
      const log = deps.log ?? logDefault;
      log('Bitbucket access tokens are created by an admin in the web UI:');
      for (const s of steps) log(s);
      return resolveBotToken() ? 0 : 1;
    },
    steps,
  };
}
