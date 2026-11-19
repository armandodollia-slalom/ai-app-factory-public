// In-memory fakes of the provider APIs the new built-in adapters call, built from the vendors' API documentation (the
// adapters' headers list the pages and the date). They run on a worker thread: the adapters are synchronous and block
// the thread that calls them, so a server on that thread could never answer. Control endpoints:
//   GET  /__fake/state   the state, with every request received
//   POST /__fake/seed    merges JSON into the state
//   POST /__fake/limit   { times }: the next requests answer 429 with Retry-After 0
// workerData: { kind: bitbucket | gitlab | linear | jenkins | circleci | azure | sonarqube | codescanning | semgrep, auth } (the Authorization or token header
// value the requests must carry).
import http from 'node:http';
import { parentPort, workerData } from 'node:worker_threads';

const { kind, auth } = workerData;
const SHA = 'a'.repeat(40);
const SHA2 = 'b'.repeat(40);
const now = () => new Date().toISOString();

const state = {
  requests: [],
  limit: 0,
  // Bitbucket (host and Pipelines)
  prs: [{ id: 1, title: 'Fix the cart', description: 'b', state: 'OPEN', draft: false, source: { branch: { name: 'bugfix/cart' }, commit: { hash: SHA.slice(0, 12) }, repository: { full_name: 'ws/app' } }, destination: { branch: { name: 'main' }, repository: { full_name: 'ws/app' } }, author: { nickname: 'dev' }, participants: [{ user: { nickname: 'rev', uuid: '{r}' }, approved: true, state: 'approved', participated_on: now() }], created_on: now(), updated_on: now(), links: { html: { href: 'https://bitbucket.org/ws/app/pull-requests/1' } } }],
  comments: { 1: [] },
  statuses: { 1: [{ key: 'review-quorum', name: 'review-quorum', state: 'SUCCESSFUL', url: 'u' }, { key: 'build', name: 'Pipeline #7', state: 'INPROGRESS', url: 'u2' }] },
  restrictions: [],
  pipelines: [{ uuid: '{p7}', build_number: 7, state: { name: 'IN_PROGRESS' }, target: { type: 'pipeline_pullrequest_target', commit: { hash: SHA.slice(0, 12) } }, created_on: now() }],
  // GitLab (issues and CI)
  issues: [{ iid: 1, title: 'SHOP-1: Cart total', description: 'story', state: 'opened', labels: ['story', 'Ready', 'factory-key-SHOP-1'], assignees: [], web_url: 'https://gitlab.example/grp/app/-/issues/1', updated_at: now() }],
  notes: { 1: [{ id: 50, body: 'first', author: { username: 'dev' }, created_at: now(), system: false }] },
  labels: [{ name: 'story' }, { name: 'Ready' }],
  boardLists: [{ label: { name: 'Ready' } }, { label: { name: 'In Progress' } }],
  glPipelines: [{ id: 11, sha: SHA, ref: 'feat/x', status: 'success', source: 'merge_request_event', web_url: 'https://gitlab.example/p/11', created_at: now() }],
  // Linear
  linIssues: [{ id: 'uuid-1', identifier: 'ENG-1', title: 'Cart total', description: 'story', url: 'https://linear.app/acme/issue/ENG-1', updatedAt: now(), state: { id: 's2', name: 'Ready', type: 'unstarted' }, labels: { nodes: [{ id: 'l1', name: 'Story' }] }, assignee: null, parent: null, team: { id: 't1', key: 'ENG' }, attachments: { nodes: [] }, comments: [], children: [] }],
  // Jenkins
  jenkinsBuilds: { 'PR-1': [{ number: 3, url: 'http://j/job/team/job/shop/job/PR-1/3/', result: 'SUCCESS', building: false, timestamp: Date.now(), actions: [{ revision: { hash: SHA2, pullHash: SHA } }] }] },
  // CircleCI
  ccPipelines: [{ id: 'cp1', number: 21, vcs: { revision: SHA, branch: 'feat/x' } }],
  ccWorkflows: { cp1: [{ id: 'w1', name: 'build', status: 'failed', created_at: now() }] },
  // Azure Pipelines
  // Commercial scanners (server mode)
  sonarGate: { 1: 'OK' },
  sonarIssues: { 1: [{ key: 'AX1', rule: 'javascript:S3649', severity: 'CRITICAL', impacts: [{ softwareQuality: 'SECURITY', severity: 'HIGH' }], component: 'shop:src/db.js', line: 4, message: 'SQL injection', issueStatus: 'FALSE_POSITIVE', resolution: 'FALSE-POSITIVE' }, { key: 'AX2', rule: 'javascript:S1481', severity: 'MINOR', component: 'shop:src/a.js', line: 2, message: 'unused variable', issueStatus: 'OPEN' }] },
  csAnalyses: { 'refs/pull/1/merge': [{ id: 77, ref: 'refs/pull/1/merge', commit_sha: 'c'.repeat(40), tool: { name: 'CodeQL' }, url: 'https://api.github.com/x/77' }] },
  csAlerts: { 1: [{ number: 5, state: 'open', rule: { id: 'js/sql-injection', severity: 'error', security_severity_level: 'high', tags: ['security', 'external/cwe/cwe-089'] }, most_recent_instance: { location: { path: 'src/db.js', start_line: 4 }, commit_sha: SHA, message: { text: 'query built from user input' } } }, { number: 6, state: 'dismissed', dismissed_reason: 'false positive', rule: { id: 'js/xss', severity: 'error', security_severity_level: 'medium', tags: ['external/cwe/cwe-079'] }, most_recent_instance: { location: { path: 'src/view.js', start_line: 9 }, commit_sha: SHA, message: { text: 'xss' } } }] },
  sgFindings: [{ id: 9, rule_name: 'javascript.express.security.injection', rule_message: 'injection', severity: 'medium', state: 'unresolved', triage_state: 'untriaged', location: { file_path: 'src/db.js', line: 4 }, rule: { cwe_names: ['CWE-89: SQL Injection'] }, match_based_id: 'mb9', ref: 'refs/pull/1/merge' }, { id: 10, rule_name: 'javascript.lang.eval', severity: 'high', state: 'unresolved', triage_state: 'ignored', triage_reason: 'acceptable_risk', location: { file_path: 'src/x.js', line: 1 }, rule: { cwe_names: [] }, match_based_id: 'mb10', ref: 'refs/pull/1/merge' }],
  azBuilds: [{ id: 41, status: 'completed', result: 'succeeded', reason: 'pullRequest', definition: { id: 9, name: 'app-ci' }, triggerInfo: { 'pr.sourceSha': SHA, 'pr.number': '1' }, sourceVersion: 'c'.repeat(40), queueTime: now(), _links: { web: { href: 'https://dev.azure.com/o/p/_build/results?buildId=41' } } }],
};

const send = (res, status, body, headers = {}) => {
  const text = typeof body === 'string' ? body : JSON.stringify(body ?? null);
  res.writeHead(status, { 'Content-Type': typeof body === 'string' ? 'text/plain' : 'application/json', ...headers });
  res.end(text);
};
const page = (values) => ({ values, pagelen: values.length, page: 1 });

function bitbucket(method, p, q, body) {
  let m;
  const R = '/2.0/repositories/ws/app';
  if (p === '/2.0/user') return [200, { nickname: 'alice', uuid: '{u-alice}' }];
  if (p === R) return [200, { full_name: 'ws/app', mainbranch: { name: 'main' } }];
  if (p === '/2.0/user/permissions/repositories') return [200, page([{ permission: 'admin' }])];
  if (p === '/2.0/workspaces/ws/members') return [200, page([{ user: { nickname: 'rev', uuid: '{r}' } }])];
  if (p === `${R}/src/main/README.md`) return [200, '# app\n'];
  if (p === `${R}/src/main/./` || p === `${R}/src/main/.`) return [200, page([{ type: 'commit_file', path: 'README.md' }])];
  if (p === `${R}/branch-restrictions`) {
    if (method === 'POST') return state.restrictions.push(body), [201, body];
    return [200, page(state.restrictions)];
  }
  if (p === `${R}/pullrequests`) {
    if (method === 'POST') {
      const pr = { id: state.prs.length + 1, title: body.title, description: body.description, state: 'OPEN', draft: Boolean(body.draft), source: { branch: body.source.branch, commit: { hash: SHA2.slice(0, 12) } }, destination: { branch: body.destination.branch }, author: { nickname: 'alice' }, participants: [], created_on: now(), updated_on: now(), links: { html: { href: `https://bitbucket.org/ws/app/pull-requests/${state.prs.length + 1}` } } };
      state.prs.push(pr);
      state.comments[pr.id] = [];
      state.statuses[pr.id] = [];
      return [201, pr];
    }
    const query = q.get('q') ?? '';
    const states = [...query.matchAll(/state="(\w+)"/g)].map((x) => x[1]);
    const branch = /source\.branch\.name="([^"]+)"/.exec(query)?.[1];
    return [200, page(state.prs.filter((x) => (!states.length || states.includes(x.state)) && (!branch || x.source.branch.name === branch)))];
  }
  if ((m = new RegExp(`^${R}/pullrequests/(\\d+)(/.*)?$`).exec(p))) {
    const pr = state.prs.find((x) => x.id === Number(m[1]));
    if (!pr) return [404, { error: { message: 'not found' } }];
    const sub = m[2] ?? '';
    if (!sub && method === 'GET') return [200, pr];
    if (!sub && method === 'PUT') return Object.assign(pr, { title: body.title ?? pr.title, description: body.description ?? pr.description, draft: body.draft ?? pr.draft }), [200, pr];
    if (sub === '/decline') return (pr.state = 'DECLINED'), [200, pr];
    if (sub === '/merge') return Object.assign(pr, { state: 'MERGED', updated_on: now(), merge_commit: { hash: 'f'.repeat(40) } }), [200, pr];
    if (sub === '/comments' && method === 'POST') {
      const c = { id: 900 + state.comments[pr.id].length, content: { raw: body.content.raw }, user: { nickname: 'alice' }, created_on: now(), links: { html: { href: `${pr.links.html.href}#comment-x` } } };
      state.comments[pr.id].push(c);
      return [201, c];
    }
    if (sub === '/comments') return [200, page(state.comments[pr.id])];
    if ((m = /^\/comments\/(\d+)$/.exec(sub))) {
      const c = state.comments[pr.id].find((x) => x.id === Number(m[1]));
      c.content.raw = body.content.raw;
      return [200, c];
    }
    if (sub === '/commits') return [200, page([{ hash: pr.id === 1 ? SHA : SHA2, message: 'fix', date: now(), parents: [{}], author: { raw: 'dev <d@x>' } }])];
    if (sub === '/diffstat') return [200, page([{ status: 'modified', new: { path: 'src/cart.ts' }, lines_added: 3, lines_removed: 1 }])];
    if (sub === '/diff') return [200, 'diff --git a/src/cart.ts b/src/cart.ts\n'];
    if (sub === '/statuses') return [200, page(state.statuses[pr.id] ?? [])];
  }
  if ((m = new RegExp(`^${R}/commit/([0-9a-f]+)/statuses/build$`).exec(p))) {
    const pr = state.prs.find((x) => SHA.startsWith(x.source.commit.hash) === SHA.startsWith(m[1].slice(0, 12)) && m[1].startsWith(x.source.commit.hash)) ?? state.prs.at(-1);
    (state.statuses[pr.id] ??= []).push(body);
    return [201, body];
  }
  if (p === `${R}/pipelines/` || p === `${R}/pipelines`) return [200, page(state.pipelines)];
  if ((m = new RegExp(`^${R}/pipelines/([^/]+)/steps/?$`).exec(p))) return [200, page([{ uuid: '{s1}', name: 'build', state: { name: 'COMPLETED', result: { name: 'FAILED' } } }])];
  if ((m = new RegExp(`^${R}/pipelines/([^/]+)/steps/([^/]+)/log$`).exec(p))) return [200, 'FAIL src/cart.test.ts\n'];
  return null;
}

function gitlab(method, p, q, body) {
  let m;
  const P = '/api/v4/projects/grp%2Fapp';
  if (p === '/api/v4/user') return [200, { username: 'alice', id: 3 }];
  if (p === '/api/v4/users') return [200, [{ id: 9, username: q.get('username') }]];
  if (p === P) return [200, { path_with_namespace: 'grp/app', default_branch: 'main' }];
  if (p === `${P}/labels`) {
    if (method === 'POST') {
      if (state.labels.some((l) => l.name === body.name)) return [409, { message: 'Label already exists' }];
      return state.labels.push({ name: body.name }), [201, body];
    }
    return [200, state.labels];
  }
  if ((m = new RegExp(`^${P}/boards/(\\d+)/lists$`).exec(p))) return [200, state.boardLists];
  if (p === `${P}/uploads`) return [201, { markdown: '[shot.png](/uploads/abc/shot.png)', url: '/uploads/abc/shot.png', full_path: '/grp/app/uploads/abc/shot.png' }];
  if (p === `${P}/issues`) {
    if (method === 'POST') {
      const i = { iid: state.issues.length + 1, title: body.title, description: body.description, state: 'opened', labels: String(body.labels ?? '').split(',').filter(Boolean), assignees: [], web_url: `https://gitlab.example/grp/app/-/issues/${state.issues.length + 1}`, updated_at: now() };
      state.issues.push(i);
      state.notes[i.iid] = [];
      return [201, i];
    }
    const labels = (q.get('labels') ?? '').split(',').filter(Boolean);
    const st = q.get('state') ?? 'opened';
    const search = q.get('search');
    const list = state.issues.filter((i) => (st === 'all' || i.state === st) && labels.every((l) => i.labels.includes(l)) && (!search || i.title.includes(search)));
    const per = Number(q.get('per_page') ?? 20);
    const pg = Number(q.get('page') ?? 1);
    return [200, list.slice((pg - 1) * per, pg * per), { 'x-next-page': pg * per < list.length ? String(pg + 1) : '' }];
  }
  if ((m = new RegExp(`^${P}/issues/(\\d+)(/.*)?$`).exec(p))) {
    const i = state.issues.find((x) => x.iid === Number(m[1]));
    if (!i) return [404, { message: '404 Issue Not Found' }];
    const sub = m[2] ?? '';
    if (!sub && method === 'GET') return [200, i];
    if (!sub && method === 'PUT') {
      if (body.title != null) i.title = body.title;
      if (body.description != null) i.description = body.description;
      if (body.labels != null) i.labels = String(body.labels).split(',').filter(Boolean);
      for (const l of String(body.add_labels ?? '').split(',').filter(Boolean)) if (!i.labels.includes(l)) i.labels.push(l);
      for (const l of String(body.remove_labels ?? '').split(',').filter(Boolean)) i.labels = i.labels.filter((x) => x !== l);
      if (body.state_event === 'close') i.state = 'closed';
      if (body.state_event === 'reopen') i.state = 'opened';
      i.updated_at = now();
      return [200, i];
    }
    if (sub === '/notes' && method === 'POST') {
      const n = { id: 100 + Object.values(state.notes).flat().length, body: body.body, author: { username: 'alice' }, created_at: now(), system: false };
      state.notes[i.iid].push(n);
      return [201, n];
    }
    if (sub === '/notes') return [200, state.notes[i.iid] ?? []];
    if ((m = /^\/notes\/(\d+)$/.exec(sub))) {
      const n = state.notes[i.iid].find((x) => x.id === Number(m[1]));
      n.body = body.body;
      return [200, n];
    }
    if (sub === '/links') return [201, {}];
  }
  if (p === `${P}/pipelines`) return [200, state.glPipelines.filter((x) => (!q.get('sha') || x.sha === q.get('sha')) && (!q.get('ref') || x.ref === q.get('ref')))];
  if ((m = new RegExp(`^${P}/pipelines/(\\d+)/jobs$`).exec(p))) return [200, [{ id: 71, name: 'test', status: 'failed' }]];
  if ((m = new RegExp(`^${P}/jobs/(\\d+)/trace$`).exec(p))) return [200, 'FAIL CartTests.Total\n'];
  if ((m = new RegExp(`^${P}/pipelines/(\\d+)/retry$`).exec(p))) return [201, { id: Number(m[1]) }];
  return null;
}

function linear(method, p, q, body) {
  if (p !== '/graphql' || method !== 'POST') return null;
  const { query, variables: v = {} } = body;
  const issueOf = (id) => state.linIssues.find((x) => x.identifier === id || x.id === id);
  const view = (i) => ({ ...i, comments: undefined, children: undefined });
  const states = [{ id: 's1', name: 'Backlog', type: 'backlog' }, { id: 's2', name: 'Ready', type: 'unstarted' }, { id: 's3', name: 'In Progress', type: 'started' }, { id: 's4', name: 'Testing', type: 'started' }, { id: 's5', name: 'Pending Review', type: 'started' }, { id: 's6', name: 'Failed', type: 'started' }, { id: 's7', name: 'Done', type: 'completed' }];
  const labels = state.linLabels ?? (state.linLabels = [{ id: 'l1', name: 'Story' }]);
  if (/viewer/.test(query)) return [200, { data: { viewer: { id: 'u1', name: 'Alice', email: 'alice@acme.test' } } }];
  if (/teams\(/.test(query)) return [200, { data: { teams: { nodes: [{ id: 't1', key: 'ENG', name: 'Engineering', states: { nodes: states }, labels: { nodes: labels } }] } } }];
  if (/issueLabelCreate/.test(query)) {
    const l = { id: `l${labels.length + 1}`, name: v.input.name };
    labels.push(l);
    return [200, { data: { issueLabelCreate: { issueLabel: l } } }];
  }
  if (/issueCreate/.test(query)) {
    const n = state.linIssues.length + 1;
    const i = { id: `uuid-${n}`, identifier: `ENG-${n}`, title: v.input.title, description: v.input.description, url: `https://linear.app/acme/issue/ENG-${n}`, updatedAt: now(), state: states.find((s) => s.id === v.input.stateId) ?? states[0], labels: { nodes: labels.filter((l) => (v.input.labelIds ?? []).includes(l.id)) }, assignee: null, parent: v.input.parentId ? { identifier: state.linIssues.find((x) => x.id === v.input.parentId)?.identifier } : null, team: { id: 't1', key: 'ENG' }, attachments: { nodes: [] }, comments: [], children: [] };
    state.linIssues.push(i);
    return [200, { data: { issueCreate: { success: true, issue: view(i) } } }];
  }
  if (/issueUpdate/.test(query)) {
    const i = issueOf(v.id);
    const input = v.input ?? {};
    if (input.title != null) i.title = input.title;
    if (input.description != null) i.description = input.description;
    if (input.stateId) i.state = states.find((s) => s.id === input.stateId);
    if (input.labelIds) i.labels = { nodes: labels.filter((l) => input.labelIds.includes(l.id)) };
    if (input.parentId) i.parent = { identifier: state.linIssues.find((x) => x.id === input.parentId)?.identifier };
    return [200, { data: { issueUpdate: { success: true } } }];
  }
  if (/issueArchive/.test(query)) return [200, { data: { issueArchive: { success: true } } }];
  if (/commentCreate/.test(query)) {
    const i = issueOf(v.input.issueId);
    const c = { id: `c${Date.now()}${Math.random()}`, body: v.input.body, url: `${i.url}#comment`, createdAt: now(), user: { email: 'alice@acme.test' } };
    i.comments.push(c);
    return [200, { data: { commentCreate: { comment: c } } }];
  }
  if (/commentUpdate/.test(query)) {
    for (const i of state.linIssues) for (const c of i.comments) if (c.id === v.id) c.body = v.input.body;
    return [200, { data: { commentUpdate: { success: true } } }];
  }
  if (/attachmentCreate/.test(query)) {
    const i = issueOf(v.input.issueId);
    i.attachments.nodes = i.attachments.nodes.filter((a) => a.url !== v.input.url).concat([{ id: `a${Date.now()}`, url: v.input.url, title: v.input.title, metadata: v.input.metadata }]);
    return [200, { data: { attachmentCreate: { success: true } } }];
  }
  if (/attachmentLinkURL/.test(query)) {
    const i = issueOf(v.issueId);
    i.attachments.nodes.push({ id: `a${Date.now()}`, url: v.url, title: v.title, metadata: {} });
    return [200, { data: { attachmentLinkURL: { success: true } } }];
  }
  if (/users\(/.test(query)) return [200, { data: { users: { nodes: [{ id: 'u1' }] } } }];
  if (/comments\(first/.test(query)) {
    const i = issueOf(v.id);
    return i ? [200, { data: { issue: { comments: { nodes: i.comments, pageInfo: { hasNextPage: false } } } } }] : [200, { data: { issue: null }, errors: [{ message: 'Entity not found', extensions: { code: 'ENTITY_NOT_FOUND' } }] }];
  }
  if (/children\(first/.test(query)) {
    const i = issueOf(v.id);
    return [200, { data: { issue: { children: { nodes: state.linIssues.filter((x) => x.parent?.identifier === i?.identifier).map((x) => ({ identifier: x.identifier })), pageInfo: { hasNextPage: false } } } } }];
  }
  if (/issue\(id: \$id\) \{ id \}/.test(query)) return [200, { data: { issue: issueOf(v.id) ? { id: issueOf(v.id).id } : null } }];
  if (/issue\(id:/.test(query)) {
    const i = issueOf(v.id);
    return i ? [200, { data: { issue: view(i) } }] : [200, { data: { issue: null }, errors: [{ message: 'Entity not found: Issue', extensions: { code: 'ENTITY_NOT_FOUND' } }] }];
  }
  if (/issues\(filter/.test(query)) {
    const f = v.filter ?? {};
    const done = (i) => ['completed', 'canceled'].includes(i.state.type);
    let list = state.linIssues.filter((i) => !f.state?.type?.nin || !done(i)).filter((i) => !f.state?.type?.in || done(i));
    if (f.title?.containsIgnoreCase) list = list.filter((i) => i.title.toLowerCase().includes(f.title.containsIgnoreCase.toLowerCase()));
    if (f.labels?.name?.in) list = list.filter((i) => i.labels.nodes.some((l) => f.labels.name.in.includes(l.name)));
    return [200, { data: { issues: { nodes: list.map(view), pageInfo: { hasNextPage: false, endCursor: null } } } }];
  }
  return [200, { errors: [{ message: `fake: unhandled query ${query.slice(0, 60)}` }] }];
}

function jenkins(method, p) {
  let m;
  if ((m = /^\/job\/team\/job\/shop\/job\/([^/]+)\/api\/json$/.exec(p))) {
    const builds = state.jenkinsBuilds[decodeURIComponent(m[1])];
    return builds ? [200, { builds }] : [404, { message: 'not found' }];
  }
  if ((m = /^\/job\/team\/job\/shop\/job\/([^/]+)\/(\d+)\/consoleText$/.exec(p))) return [200, `Started by GitHub\nFAIL ${m[1]} #${m[2]}\n`];
  if (/^\/job\/team\/job\/shop\/job\/[^/]+\/build$/.test(p) && method === 'POST') return [201, ''];
  return null;
}

function circleci(method, p, q, body) {
  let m;
  if (p === '/api/v2/project/gh/acme/shop/pipeline') return [200, { items: state.ccPipelines, next_page_token: null }];
  if ((m = /^\/api\/v2\/pipeline\/([^/]+)\/workflow$/.exec(p))) return [200, { items: state.ccWorkflows[m[1]] ?? [] }];
  if (/^\/api\/v2\/workflow\/([^/]+)\/job$/.test(p)) return [200, { items: [{ name: 'test', job_number: 55, status: 'failed' }] }];
  if ((m = /^\/api\/v2\/workflow\/([^/]+)\/rerun$/.exec(p)) && method === 'POST') return [202, { workflow_id: m[1], from_failed: body?.from_failed }];
  if (p === '/api/v1.1/project/github/acme/shop/55') return [200, { steps: [{ name: 'npm test', actions: [{ status: 'failed', output_url: `${state.base}/out/55` }] }] }];
  if (p === '/out/55') return [200, [{ message: 'FAIL cart.test.ts\n' }]];
  return null;
}

function azure(method, p) {
  let m;
  const A = '/o/p/_apis';
  if (p === `${A}/git/repositories/app`) return [200, { id: 'repo-1', name: 'app' }];
  if (p === `${A}/policy/configurations`) return [200, { value: [{ isEnabled: true, isBlocking: true, isDeleted: false, settings: { buildDefinitionId: 9, displayName: 'app-ci' } }] }];
  if (p === `${A}/build/builds`) return [200, { value: state.azBuilds }];
  if (new RegExp(`^${A}/build/builds/(\\d+)/timeline$`).test(p)) return [200, { records: [{ name: 'Test', result: 'failed', log: { id: 5 } }, { name: 'Build', result: 'succeeded', log: { id: 4 } }] }];
  if ((m = new RegExp(`^${A}/build/builds/(\\d+)/logs/(\\d+)$`).exec(p))) return [200, `log ${m[2]}: FAIL CartTests\n`];
  if ((m = new RegExp(`^${A}/build/builds/(\\d+)$`).exec(p)) && method === 'PATCH') return [200, { id: Number(m[1]), status: 'notStarted' }];
  return null;
}

// SonarQube Web API (qualitygates/project_status, issues/search), GitHub code scanning REST, Semgrep findings API.
function sonarqube(method, p, q) {
  const pr = q.get('pullRequest');
  if (p === '/api/qualitygates/project_status') {
    if (q.get('projectKey') !== 'shop') return [404, { errors: [{ msg: 'Project not found' }] }];
    if (!state.sonarGate[pr]) return [404, { errors: [{ msg: 'No analysis for this pull request' }] }];
    return [200, { projectStatus: { status: state.sonarGate[pr], conditions: [] } }];
  }
  if (p === '/api/issues/search') {
    const list = state.sonarIssues[pr] ?? [];
    return [200, { paging: { pageIndex: 1, pageSize: 500, total: list.length }, issues: list }];
  }
  return null;
}
function codescanning(method, p, q) {
  if (p === '/repos/acme/shop/code-scanning/analyses') return [200, (state.csAnalyses[q.get('ref')] ?? []).filter((a) => !q.get('tool_name') || a.tool.name === q.get('tool_name'))];
  if (p === '/repos/acme/shop/code-scanning/alerts') return [200, state.csAlerts[q.get('pr')] ?? []];
  if (/^\/repos\/private\/repo\/code-scanning\//.test(p)) return [403, { message: 'Advanced Security must be enabled for this repository to use code scanning.' }];
  return null;
}
function semgrep(method, p, q) {
  if (p === '/api/v1/deployments/acme/findings') return [200, { findings: state.sgFindings.filter((f) => f.ref === q.get('ref') && q.get('repos') === 'acme/shop') }];
  return null;
}

const HANDLERS = { bitbucket, gitlab, linear, jenkins, circleci, azure, sonarqube, codescanning, semgrep };
const tokenOf = (req) => req.headers.authorization ?? req.headers['private-token'] ?? req.headers['circle-token'] ?? null;

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const raw = Buffer.concat(chunks);
    const url = new URL(req.url, 'http://x');
    try {
      if (url.pathname === '/__fake/state') return send(res, 200, state);
      if (url.pathname === '/__fake/seed') return Object.assign(state, JSON.parse(raw.toString('utf8'))), send(res, 200, {});
      if (url.pathname === '/__fake/limit') return (state.limit = JSON.parse(raw.toString('utf8')).times), send(res, 200, {});
      const body = /json/.test(req.headers['content-type'] ?? '') && raw.length ? JSON.parse(raw.toString('utf8')) : raw.toString('utf8');
      state.requests.push({ method: req.method, path: url.pathname, query: url.search, body: typeof body === 'string' ? body.slice(0, 200) : body });
      if (state.limit > 0) {
        state.limit--;
        return send(res, 429, { message: 'rate limited' }, { 'Retry-After': '0' });
      }
      if (url.pathname !== '/out/55' && tokenOf(req) !== auth) return send(res, 401, { message: 'bad credentials' });
      const r = HANDLERS[kind](req.method, url.pathname, url.searchParams, body);
      if (!r) return send(res, 404, { message: `fake ${kind}: no route ${req.method} ${url.pathname}` });
      return send(res, r[0], r[1], r[2] ?? {});
    } catch (error) {
      return send(res, 500, { message: error.message });
    }
  });
});
server.listen(0, '127.0.0.1', () => {
  state.base = `http://127.0.0.1:${server.address().port}`;
  parentPort.postMessage({ port: server.address().port });
});
