// In-memory GitLab and Azure DevOps servers for the code host adapter tests: real HTTP on 127.0.0.1
// under a path prefix (a self-hosted base URL), token auth, pagination, and a one-shot 429.
import http from 'node:http';

const json = (res, status, body, headers = {}) => {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(body === undefined ? '' : JSON.stringify(body));
};

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks);
}

// Starts a server; `handle(req, url, body, state) -> [status, body, headers]`. Returns { url, state, close }.
async function serve(prefix, state, auth, handle) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const body = await readBody(req);
    state.requests.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), headers: req.headers, body: body.toString('utf8') });
    if (state.limitNext > 0) {
      state.limitNext--;
      return json(res, 429, { message: 'Too Many Requests' }, { 'retry-after': '0' });
    }
    if (!url.pathname.startsWith(prefix)) return json(res, 404, { message: 'outside the prefix' });
    if (!auth(req)) return json(res, 401, { message: '401 Unauthorized' });
    try {
      const [status, out, headers = {}] = handle(req.method, url.pathname.slice(prefix.length), url.searchParams, body, req) ?? [404, { message: 'no route' }];
      if (typeof out === 'string') {
        res.writeHead(status, { 'content-type': 'application/octet-stream', ...headers });
        return res.end(out);
      }
      return json(res, status, out, headers);
    } catch (error) {
      return json(res, 500, { message: error.message });
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return { url: `http://127.0.0.1:${port}${prefix}`, state, close: () => new Promise((resolve) => server.close(resolve)) };
}

const page = (list, q) => {
  const per = Number(q.get('per_page') ?? 20);
  const p = Number(q.get('page') ?? 1);
  const slice = list.slice((p - 1) * per, p * per);
  return [200, slice, p * per < list.length ? { 'x-next-page': String(p + 1) } : { 'x-next-page': '' }];
};

// GitLab: project `grp/sub/app`, token `glpat-good` (PRIVATE-TOKEN), bot token `glpat-bot`.
export async function fakeGitlab(prefix = '/gitlab') {
  const state = {
    requests: [],
    limitNext: 0,
    project: { id: 7, default_branch: 'main', only_allow_merge_if_pipeline_succeeds: true },
    mrs: new Map(),
    notes: new Map(),
    nextIid: 1,
    nextNote: 100,
    labels: [],
    statuses: [],
    merges: [],
    protected: { main: { name: 'main', code_owner_approval_required: true } },
    rules: [{ approvals_required: 2 }],
    files: { 'README.md': '# app\n' },
  };
  const users = { alice: { id: 11, username: 'alice' }, bob: { id: 12, username: 'bob' }, 'bot-dev': { id: 99, username: 'project_7_bot', bot: true } };
  const tokens = { 'glpat-good': users.alice, 'glpat-bot': users['bot-dev'] };
  const P = '/api/v4/projects/grp%2Fsub%2Fapp';
  state.addMr = (fields = {}) => {
    const iid = state.nextIid++;
    const mr = { iid, id: 1000 + iid, project_id: 7, source_project_id: 7, target_project_id: 7, title: `MR ${iid}`, description: '', state: 'opened', draft: false, source_branch: `feat/${iid}`, target_branch: 'main', sha: `sha${iid}`, author: { username: 'alice' }, labels: [], reviewers: [], merge_status: 'can_be_merged', created_at: '2026-11-01T10:00:00Z', updated_at: '2026-11-01T10:00:00Z', web_url: `https://gl.example/grp/sub/app/-/merge_requests/${iid}`, approvals: [], reviewerStates: [], discussions: [], commits: [], diffs: [], pipelines: [], jobs: {}, commitStatuses: [], ...fields };
    state.mrs.set(iid, mr);
    state.notes.set(iid, []);
    return mr;
  };
  const handle = (method, p, q, raw, req) => {
    const who = tokens[req.headers['private-token']];
    const body = raw.length && /json/.test(req.headers['content-type'] ?? '') ? JSON.parse(raw.toString('utf8')) : {};
    if (method === 'GET' && p === '/api/v4/user') return [200, { id: who.id, username: who.username }];
    if (method === 'GET' && p === '/api/v4/users') return [200, Object.values(users).filter((u) => u.username === q.get('username'))];
    if (method === 'GET' && p === P) return [200, state.project];
    // The project's issues (the code host contract's issues.search; none in this fake).
    if (method === 'GET' && p === `${P}/issues`) return [200, [], { 'x-next-page': '' }];
    if (method === 'POST' && p === `${P}/labels`) {
      if (state.labels.some((l) => l.name === body.name)) return [409, { message: 'Label already exists' }];
      state.labels.push(body);
      return [201, body];
    }
    if (method === 'PUT' && p === P) return [200, Object.assign(state.project, body)];
    if (method === 'POST' && p === `${P}/protected_branches`) {
      if (state.protected[body.name]) return [409, { message: 'Protected branch already exists' }];
      state.protected[body.name] = { name: body.name, code_owner_approval_required: state.premium === false ? false : Boolean(body.code_owner_approval_required), push_access_levels: [{ access_level: body.push_access_level }], merge_access_levels: [{ access_level: body.merge_access_level }] };
      return [201, state.protected[body.name]];
    }
    let pb = /^\/api\/v4\/projects\/grp%2Fsub%2Fapp\/protected_branches\/(.+)$/.exec(p);
    if (pb) {
      const b = state.protected[decodeURIComponent(pb[1])];
      if (!b) return [404, { message: '404 Not found' }];
      if (method === 'PATCH') {
        if (state.premium === false) return [403, { message: '403 Forbidden' }];
        b.code_owner_approval_required = q.get('code_owner_approval_required') === 'true';
      }
      return [200, b];
    }
    if (method === 'GET' && p === `${P}/approval_rules`) return [200, state.rules];
    if (method === 'GET' && p === `${P}/external_status_checks`) return [200, [{ name: 'review-quorum' }]];
    let m = /^\/api\/v4\/projects\/grp%2Fsub%2Fapp\/repository\/files\/(.+)\/raw$/.exec(p);
    if (m) {
      const file = decodeURIComponent(m[1]);
      return state.files[file] != null ? [200, state.files[file]] : [404, { message: '404 File Not Found' }];
    }
    m = /^\/api\/v4\/projects\/grp%2Fsub%2Fapp\/statuses\/(\w+)$/.exec(p);
    if (m && method === 'POST') {
      state.statuses.push({ sha: m[1], ...body });
      return [201, body];
    }
    m = /^\/api\/v4\/projects\/grp%2Fsub%2Fapp\/repository\/commits\/(\w+)\/statuses$/.exec(p);
    if (m) return page([...state.mrs.values()].find((x) => x.sha === m[1])?.commitStatuses ?? [], q);
    m = /^\/api\/v4\/projects\/grp%2Fsub%2Fapp\/pipelines\/(\d+)\/jobs$/.exec(p);
    if (m) return page([...state.mrs.values()].flatMap((x) => x.jobs[m[1]] ?? []), q);
    if (method === 'POST' && p === `${P}/uploads`) return [201, { url: '/uploads/abc/demo.webm', full_path: '/grp/sub/app/uploads/abc/demo.webm', markdown: '![demo](/uploads/abc/demo.webm)' }];
    if (p === `${P}/merge_requests`) {
      if (method === 'POST') {
        if ([...state.mrs.values()].some((x) => x.source_branch === body.source_branch && x.state === 'opened')) return [409, { message: ['Another open merge request already exists for this source branch: !1'] }];
        const mr = state.addMr({ title: body.title, description: body.description, source_branch: body.source_branch, target_branch: body.target_branch, labels: body.labels ? body.labels.split(',') : [], reviewers: (body.reviewer_ids ?? []).map((id) => Object.values(users).find((u) => u.id === id)), author: { username: who.username }, draft: /^Draft:/.test(body.title) });
        return [201, mr];
      }
      let list = [...state.mrs.values()].sort((a, b) => b.iid - a.iid);
      const st = q.get('state');
      if (st && st !== 'all') list = list.filter((x) => x.state === st);
      if (q.get('source_branch')) list = list.filter((x) => x.source_branch === q.get('source_branch'));
      if (q.get('labels')) list = list.filter((x) => x.labels.includes(q.get('labels')));
      return page(list, q);
    }
    m = /^\/api\/v4\/projects\/grp%2Fsub%2Fapp\/merge_requests\/(\d+)(\/.*)?$/.exec(p);
    if (!m) return null;
    const mr = state.mrs.get(Number(m[1]));
    if (!mr) return [404, { message: '404 Not found' }];
    const sub = m[2] ?? '';
    if (sub === '' && method === 'GET') return [200, mr];
    if (sub === '' && method === 'PUT') {
      if (body.title != null) mr.title = body.title;
      if (body.description != null) mr.description = body.description;
      if (body.labels != null) mr.labels = body.labels.split(',').filter(Boolean);
      for (const l of (body.add_labels ?? '').split(',').filter(Boolean)) if (!mr.labels.includes(l)) mr.labels.push(l);
      for (const l of (body.remove_labels ?? '').split(',').filter(Boolean)) mr.labels = mr.labels.filter((x) => x !== l);
      if (body.state_event === 'close') mr.state = 'closed';
      if (body.state_event === 'reopen') mr.state = 'opened';
      if (body.reviewer_ids) mr.reviewers = body.reviewer_ids.map((id) => Object.values(users).find((u) => u.id === id));
      mr.draft = /^Draft:/.test(mr.title);
      return [200, mr];
    }
    if (sub === '/notes') {
      if (method === 'POST') {
        const n = { id: state.nextNote++, body: body.body, author: { username: who.username }, system: false, created_at: '2026-11-02T00:00:00Z' };
        state.notes.get(mr.iid).push(n);
        return [201, n];
      }
      return page(state.notes.get(mr.iid), q);
    }
    const nm = /^\/notes\/(\d+)$/.exec(sub);
    if (nm && method === 'PUT') {
      const n = state.notes.get(mr.iid).find((x) => x.id === Number(nm[1]));
      n.body = body.body;
      return [200, n];
    }
    if (sub === '/approvals') return [200, { approved_by: mr.approvals.map((u) => ({ user: u })) }];
    if (sub === '/reviewers') return [200, mr.reviewerStates];
    if (sub === '/discussions') return page(mr.discussions, q);
    if (sub === '/commits') return page(mr.commits, q);
    if (sub === '/diffs') return page(mr.diffs, q);
    if (sub === '/pipelines') return [200, mr.pipelines];
    if (sub === '/merge' && method === 'PUT') {
      if (mr.state !== 'opened') return [405, { message: 'Method Not Allowed' }];
      state.merges.push({ iid: mr.iid, ...body, by: who.username });
      if (!body.merge_when_pipeline_succeeds) mr.state = 'merged';
      else mr.autoMerge = true;
      return [200, mr];
    }
    if (sub === '/cancel_merge_when_pipeline_succeeds' && method === 'POST') {
      mr.autoMerge = false;
      return [201, mr];
    }
    return null;
  };
  return serve(prefix, state, (req) => Boolean(tokens[req.headers['private-token']]), handle);
}

// Azure DevOps Server: collection `coll`, project `Shop`, repository `app`, PAT `pat-good`.
export async function fakeAzure(prefix = '/tfs') {
  const state = { requests: [], limitNext: 0, prs: new Map(), nextId: 1, nextThread: 1, commitStatuses: [], policies: [], files: { 'README.md': '# app\n' } };
  const users = { alice: { id: 'u-alice', uniqueName: 'alice@acme.test', displayName: 'Alice' }, bob: { id: 'u-bob', uniqueName: 'bob@acme.test', displayName: 'Bob' } };
  const tokens = { 'pat-good': users.alice, 'pat-bot': { id: 'u-bot', uniqueName: 'dev-bot@acme.test', displayName: 'dev-bot' } };
  const who = (req) => {
    const m = /^Basic (.+)$/.exec(req.headers.authorization ?? '');
    return m ? tokens[Buffer.from(m[1], 'base64').toString('utf8').replace(/^:/, '')] : null;
  };
  const G = '/coll/Shop/_apis/git/repositories/app';
  state.addPr = (fields = {}) => {
    const id = state.nextId++;
    const pr = { pullRequestId: id, title: `PR ${id}`, description: '', status: 'active', isDraft: false, sourceRefName: `refs/heads/feat/${id}`, targetRefName: 'refs/heads/main', lastMergeSourceCommit: { commitId: `sha${id}` }, createdBy: { uniqueName: 'alice@acme.test' }, labels: [], reviewers: [], mergeStatus: 'succeeded', creationDate: '2026-11-01T10:00:00Z', repository: { id: 'R1', project: { id: 'P1' } }, threads: [], commits: [], iterations: [], changes: [], statuses: [], ...fields };
    state.prs.set(id, pr);
    return pr;
  };
  const handle = (method, p, q, raw, req) => {
    const me = who(req);
    const body = raw.length && /json/.test(req.headers['content-type'] ?? '') ? JSON.parse(raw.toString('utf8')) : {};
    if (!q.get('api-version')) return [400, { message: 'api-version is required' }];
    if (p === '/coll/_apis/connectionData') return [200, { authenticatedUser: { id: me.id, providerDisplayName: me.displayName, properties: { Account: { $value: me.uniqueName } } } }];
    if (p === '/coll/_apis/identities') return [200, { value: Object.values(users).filter((u) => u.uniqueName === q.get('filterValue') || u.displayName === q.get('filterValue') || u.uniqueName.startsWith(`${q.get('filterValue')}@`)) }];
    if (p === '/coll/Shop/_apis/policy/configurations' && method === 'POST') {
      const created = { id: state.policies.length + 1, ...body };
      state.policies.push(created);
      return [200, created];
    }
    const pc = /^\/coll\/Shop\/_apis\/policy\/configurations\/(\d+)$/.exec(p);
    if (pc && method === 'PUT') {
      const i = state.policies.findIndex((x) => String(x.id) === pc[1]);
      state.policies[i] = { id: Number(pc[1]), ...body };
      return [200, state.policies[i]];
    }
    if (p === '/coll/Shop/_apis/policy/configurations') return [200, { value: state.policies }];
    if (p === '/coll/Shop/_apis/policy/evaluations') {
      const id = Number(q.get('artifactId').split('/').pop());
      return [200, { value: state.prs.get(id)?.evaluations ?? [] }];
    }
    if (p === G) return [200, { id: 'R1', name: 'app', defaultBranch: 'refs/heads/main' }];
    if (p === `${G}/items`) {
      // A folder listing (scopePath, one level), or one file's content (path).
      if (q.get('scopePath') != null) return [200, { value: Object.keys(state.files).map((f) => ({ path: `/${f}`, isFolder: false })) }];
      const f = state.files[q.get('path').replace(/^\//, '')];
      return f != null ? [200, f] : [404, { message: 'TF401174: The item could not be found' }];
    }
    let m = /^\/coll\/Shop\/_apis\/git\/repositories\/app\/commits\/(\w+)\/statuses$/.exec(p);
    if (m && method === 'POST') {
      state.commitStatuses.push({ sha: m[1], ...body });
      return [201, body];
    }
    if (p === `${G}/pullrequests`) {
      if (method === 'POST') {
        if ([...state.prs.values()].some((x) => x.sourceRefName === body.sourceRefName && x.targetRefName === body.targetRefName && x.status === 'active')) return [409, { message: 'TF401179: An active pull request for the source and target branch already exists.' }];
        const pr = state.addPr({ title: body.title, description: body.description, isDraft: body.isDraft, sourceRefName: body.sourceRefName, targetRefName: body.targetRefName, labels: body.labels ?? [], reviewers: (body.reviewers ?? []).map((r) => ({ ...Object.values(users).find((u) => u.id === r.id), vote: 0 })), createdBy: { uniqueName: me.uniqueName } });
        return [201, pr];
      }
      let list = [...state.prs.values()].sort((a, b) => b.pullRequestId - a.pullRequestId);
      const st = q.get('searchCriteria.status');
      if (st && st !== 'all') list = list.filter((x) => x.status === st);
      if (q.get('searchCriteria.sourceRefName')) list = list.filter((x) => x.sourceRefName === q.get('searchCriteria.sourceRefName'));
      const skip = Number(q.get('$skip') ?? 0);
      const top = Number(q.get('$top') ?? 101);
      return [200, { value: list.slice(skip, skip + top), count: Math.min(top, list.length - skip) }];
    }
    m = /^\/coll\/Shop\/_apis\/git\/repositories\/app\/pullrequests\/(\d+)(\/.*)?$/.exec(p);
    if (!m) return null;
    const pr = state.prs.get(Number(m[1]));
    if (!pr) return [404, { message: 'TF401180: The requested pull request was not found.' }];
    const sub = m[2] ?? '';
    if (sub === '' && method === 'GET') return [200, pr];
    if (sub === '' && method === 'PATCH') {
      for (const k of ['title', 'description', 'isDraft', 'status', 'completionOptions']) if (body[k] !== undefined) pr[k] = body[k];
      if (body.autoCompleteSetBy) pr.autoCompleteSetBy = body.autoCompleteSetBy.id === '00000000-0000-0000-0000-000000000000' ? null : body.autoCompleteSetBy;
      return [200, pr];
    }
    if (sub === '/labels' && method === 'POST') {
      pr.labels.push({ name: body.name, active: true });
      return [200, { name: body.name }];
    }
    const lm = /^\/labels\/(.+)$/.exec(sub);
    if (lm && method === 'DELETE') {
      pr.labels = pr.labels.filter((l) => l.name !== decodeURIComponent(lm[1]));
      return [204, undefined];
    }
    if (sub === '/threads') {
      if (method === 'POST') {
        const t = { id: state.nextThread++, comments: body.comments.map((c, i) => ({ id: i + 1, content: c.content, commentType: 'text', author: { uniqueName: me.uniqueName }, publishedDate: '2026-11-02T00:00:00Z' })), status: 'closed' };
        pr.threads.push(t);
        return [200, t];
      }
      return [200, { value: pr.threads }];
    }
    const cm = /^\/threads\/(\d+)\/comments\/(\d+)$/.exec(sub);
    if (cm && method === 'PATCH') {
      const c = pr.threads.find((t) => t.id === Number(cm[1])).comments.find((x) => x.id === Number(cm[2]));
      c.content = body.content;
      return [200, c];
    }
    if (sub === '/commits') return [200, { value: pr.commits }];
    const rm = /^\/reviewers\/(.+)$/.exec(sub);
    if (rm && method === 'PUT') {
      const u = Object.values(users).find((x) => x.id === rm[1]);
      pr.reviewers.push({ ...u, vote: 0 });
      return [200, u];
    }
    if (sub === '/iterations') return [200, { value: pr.iterations }];
    if (/^\/iterations\/\d+\/changes$/.test(sub)) return [200, { changeEntries: pr.changes }];
    if (sub === '/statuses') {
      if (method === 'POST') {
        pr.statuses.push({ id: pr.statuses.length + 1, ...body });
        return [200, body];
      }
      return [200, { value: pr.statuses }];
    }
    const am = /^\/attachments\/(.+)$/.exec(sub);
    if (am && method === 'POST') return [201, { url: `https://ado.example${prefix}${G}/pullRequests/${pr.pullRequestId}/attachments/${am[1]}` }];
    return null;
  };
  return serve(prefix, state, (req) => Boolean(who(req)), handle);
}
