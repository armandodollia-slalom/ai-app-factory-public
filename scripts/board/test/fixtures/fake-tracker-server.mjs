// A fake Jira (Cloud v3 or Data Center v2) or Azure DevOps (Boards) REST server for the tracker tests.
// It runs on a worker thread, because the tracker adapters are synchronous: they block the main thread
// (Atomics.wait) while their fetch runs on another worker, so a server on the main thread could never
// answer. The test controls it over HTTP:
//   GET  /__fake/state            the whole state, with every request received (`requests`)
//   POST /__fake/seed             merges JSON into the state
//   POST /__fake/fail             { path (regex), status, times, retryAfter } answers the next requests
// Everything else is served under `prefix` (a self-hosted base path such as /jira or /tfs/Collection)
// and needs the Authorization header `auth`.
import http from 'node:http';
import { parentPort, workerData } from 'node:worker_threads';

const { kind, prefix = '', auth } = workerData;
const state = { requests: [], fails: [], issues: {}, comments: {}, properties: {}, commentProps: {}, attachments: {}, links: [], remoteLinks: {}, nextId: 100, nextComment: 5000, items: {}, revisions: {}, deployment: kind === 'jira-cloud' ? 'Cloud' : 'Server' };

const send = (res, status, body, headers = {}) => {
  const data = Buffer.isBuffer(body) ? body : Buffer.from(body == null ? '' : typeof body === 'string' ? body : JSON.stringify(body));
  res.writeHead(status, { 'Content-Type': Buffer.isBuffer(body) ? 'application/octet-stream' : 'application/json', ...headers });
  res.end(data);
};

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const raw = Buffer.concat(chunks);
    const url = new URL(req.url, 'http://x');
    try {
      if (url.pathname === '/__fake/state') return send(res, 200, state);
      if (url.pathname === '/__fake/seed') {
        const seed = JSON.parse(raw.toString('utf8'));
        for (const [k, v] of Object.entries(seed)) state[k] = v && typeof v === 'object' && !Array.isArray(v) ? { ...state[k], ...v } : v;
        return send(res, 200, {});
      }
      if (url.pathname === '/__fake/fail') {
        state.fails.push(JSON.parse(raw.toString('utf8')));
        return send(res, 200, {});
      }
      state.requests.push({ method: req.method, path: url.pathname, search: url.search, contentType: req.headers['content-type'] ?? null, body: raw.length && /json/.test(req.headers['content-type'] ?? '') ? JSON.parse(raw.toString('utf8')) : null });
      if (!url.pathname.startsWith(prefix)) return send(res, 404, { error: 'outside the base path' });
      if (req.headers.authorization !== auth) return send(res, 401, { message: 'bad credentials' });
      const fail = state.fails.find((f) => new RegExp(f.path).test(url.pathname) && f.times > 0);
      if (fail) {
        fail.times--;
        return send(res, fail.status, { message: 'injected' }, fail.retryAfter != null ? { 'Retry-After': String(fail.retryAfter) } : {});
      }
      const p = url.pathname.slice(prefix.length);
      const body = /json/.test(req.headers['content-type'] ?? '') && raw.length ? JSON.parse(raw.toString('utf8')) : raw;
      const r = kind.startsWith('jira') ? jira(req.method, p, url.searchParams, body, req.headers) : azure(req.method, p, url.searchParams, body);
      if (r == null) return send(res, 404, { message: `fake: no route ${req.method} ${p}` });
      return send(res, r.status ?? 200, r.body, r.headers);
    } catch (error) {
      return send(res, 500, { message: error.stack });
    }
  });
});
server.listen(0, '127.0.0.1', () => parentPort.postMessage({ port: server.address().port }));

// ------------------------------------------------------------------ Jira
const STATUSES = [
  { id: '1', name: 'Backlog', cat: 'new' },
  { id: '2', name: 'Ready', cat: 'new' },
  { id: '3', name: 'In Progress', cat: 'indeterminate' },
  { id: '4', name: 'Testing', cat: 'indeterminate' },
  { id: '5', name: 'Pending Review', cat: 'indeterminate' },
  { id: '6', name: 'Failed', cat: 'indeterminate' },
  { id: '7', name: 'Done', cat: 'done' },
];
const statusObj = (name) => {
  const s = STATUSES.find((x) => x.name === name) ?? STATUSES[0];
  return { id: s.id, name: s.name, statusCategory: { key: s.cat } };
};

function matchJql(issue, jql) {
  const where = jql.replace(/\s+ORDER BY.*$/i, '');
  return where.split(/\s+AND\s+/i).every((c) => {
    let m;
    const val = (s) => s.replace(/^"|"$/g, '').replace(/\\"/g, '"');
    if ((m = /^project = (.+)$/.exec(c))) return issue.key.startsWith(`${val(m[1])}-`);
    if ((m = /^labels = (.+)$/.exec(c))) return (issue.fields.labels ?? []).includes(val(m[1]));
    if ((m = /^issuetype = (.+)$/.exec(c))) return issue.fields.issuetype.name === val(m[1]);
    if ((m = /^parent = (.+)$/.exec(c))) return issue.fields.parent?.key === val(m[1]);
    if ((m = /^"Epic Link" = (.+)$/.exec(c))) return issue.fields.customfield_10014 === val(m[1]);
    if ((m = /^status = (.+)$/.exec(c))) return issue.fields.status.name === val(m[1]);
    if (/^statusCategory != Done$/.test(c)) return issue.fields.status.statusCategory.key !== 'done';
    if (/^statusCategory = Done$/.test(c)) return issue.fields.status.statusCategory.key === 'done';
    if (/^updated >= /.test(c)) return true;
    throw new Error(`fake jira: unsupported JQL clause ${c}`);
  });
}

function jira(method, p, q, body) {
  const v = /^\/rest\/api\/(2|3)(\/.*)$/.exec(p);
  if (/^\/rest\/agile\/1\.0\/board\/\d+\/configuration$/.test(p)) return { body: { columnConfig: { columns: [{ name: 'To do', statuses: [{ id: '1' }, { id: '2' }] }, { name: 'Doing', statuses: [{ id: '3' }, { id: '4' }, { id: '5' }] }, { name: 'Done', statuses: [{ id: '7' }] }] } } };
  if (/^\/secure\/attachment\/(\d+)\//.test(p)) {
    const id = /^\/secure\/attachment\/(\d+)\//.exec(p)[1];
    const a = Object.values(state.attachments).flat().find((x) => x.id === id);
    return a ? { body: Buffer.from(a.data, 'base64') } : null;
  }
  if (!v) return null;
  const path = v[2];
  let m;
  const site = `http://127.0.0.1:${server.address().port}${prefix}`;
  const fieldsOf = (issue, wanted) => (wanted ? Object.fromEntries(Object.entries(issue.fields).filter(([k]) => wanted.includes(k))) : issue.fields);
  if (path === '/serverInfo') return { body: { deploymentType: state.deployment } };
  if (path === '/myself') return { body: { accountId: 'acc-1', name: 'jdoe', emailAddress: 'me@example.com', displayName: 'Jo Doe' } };
  if (path === '/field') return { body: [{ id: 'customfield_10050', name: 'Severity' }, { id: 'customfield_10051', name: 'Impact' }, { id: 'customfield_10052', name: 'Confidence' }] };
  if ((m = /^\/project\/([^/]+)$/.exec(path))) return { body: { key: m[1], name: 'Shop', issueTypes: [{ name: 'Epic' }, { name: 'Story' }, { name: 'Bug' }] } };
  if ((m = /^\/project\/([^/]+)\/statuses$/.exec(path))) return { body: [{ name: 'Story', statuses: STATUSES.filter((s) => s.name !== 'Failed').map((s) => ({ id: s.id, name: s.name })) }] };
  if (path === '/search/jql' && method === 'POST') {
    const all = Object.values(state.issues).filter((i) => matchJql(i, body.jql));
    const start = Number(body.nextPageToken ?? 0);
    const page = all.slice(start, start + 2);
    const next = start + 2 < all.length ? String(start + 2) : undefined;
    return { body: { issues: page.map((i) => ({ key: i.key, id: i.id, fields: fieldsOf(i, body.fields) })), ...(next ? { nextPageToken: next } : {}), isLast: !next } };
  }
  if (path === '/search' && method === 'POST') {
    const all = Object.values(state.issues).filter((i) => matchJql(i, body.jql));
    const start = body.startAt ?? 0;
    return { body: { startAt: start, maxResults: 2, total: all.length, issues: all.slice(start, start + 2).map((i) => ({ key: i.key, id: i.id, fields: fieldsOf(i, body.fields) })) } };
  }
  if (path === '/issue' && method === 'POST') {
    const n = Object.keys(state.issues).length + 1;
    const key = `${body.fields.project.key}-${n}`;
    state.issues[key] = { key, id: String(10000 + n), fields: { summary: body.fields.summary, description: body.fields.description ?? null, issuetype: body.fields.issuetype, labels: body.fields.labels ?? [], status: statusObj('Backlog'), parent: body.fields.parent ?? null, customfield_10014: body.fields.customfield_10014 ?? null, updated: new Date().toISOString(), issuelinks: [], attachment: [], assignee: null, ...Object.fromEntries(Object.entries(body.fields).filter(([k]) => k.startsWith('customfield_'))) } };
    return { status: 201, body: { id: state.issues[key].id, key, self: `${site}/rest/api/${v[1]}/issue/${key}` } };
  }
  if (path === '/issueLink' && method === 'POST') {
    state.links.push(body);
    const blocked = state.issues[body.inwardIssue.key];
    blocked?.fields.issuelinks.push({ type: { name: 'Blocks' }, inwardIssue: { key: body.outwardIssue.key } });
    return { status: 201, body: '' };
  }
  if ((m = /^\/comment\/([^/]+)\/properties\/([^/]+)$/.exec(path)) && method === 'PUT') {
    state.commentProps[m[1]] = { ...(state.commentProps[m[1]] ?? {}), [decodeURIComponent(m[2])]: body };
    return { status: 200, body: '' };
  }
  if (!(m = /^\/issue\/([^/]+)(\/.*)?$/.exec(path))) return null;
  const key = decodeURIComponent(m[1]);
  const issue = state.issues[key];
  const sub = m[2] ?? '';
  if (!issue) return { status: 404, body: { errorMessages: ['Issue does not exist'] } };
  if (!sub && method === 'GET') {
    const wanted = q.get('fields')?.split(',');
    return { body: { key, id: issue.id, fields: { ...fieldsOf(issue, wanted), ...(wanted?.includes('attachment') ? { attachment: (state.attachments[key] ?? []).map((a) => ({ id: a.id, filename: a.filename, size: a.size, content: `${site}/secure/attachment/${a.id}/${a.filename}` })) } : {}) } } };
  }
  if (!sub && method === 'PUT') {
    Object.assign(issue.fields, body.fields ?? {});
    for (const op of body.update?.labels ?? []) {
      if (op.add) issue.fields.labels = [...new Set([...issue.fields.labels, op.add])];
      if (op.remove) issue.fields.labels = issue.fields.labels.filter((l) => l !== op.remove);
    }
    issue.fields.updated = new Date().toISOString();
    return { status: 204, body: '' };
  }
  if ((m = /^\/properties\/(.+)$/.exec(sub))) {
    const name = decodeURIComponent(m[1]);
    if (method === 'PUT') {
      state.properties[key] = { ...(state.properties[key] ?? {}), [name]: body };
      return { status: 200, body: '' };
    }
    const value = state.properties[key]?.[name];
    return value === undefined ? { status: 404, body: { errorMessages: ['no property'] } } : { body: { key: name, value } };
  }
  if (sub === '/comment' && method === 'GET') {
    const all = state.comments[key] ?? [];
    const start = Number(q.get('startAt') ?? 0);
    return { body: { startAt: start, maxResults: 2, total: all.length, comments: all.slice(start, start + 2).map((c) => ({ ...c, properties: q.get('expand')?.includes('properties') ? Object.entries(state.commentProps[c.id] ?? {}).map(([k2, value]) => ({ key: k2, value })) : undefined })) } };
  }
  if (sub === '/comment' && method === 'POST') {
    const c = { id: String(state.nextComment++), body: body.body, author: { accountId: 'acc-1', name: 'jdoe' }, created: new Date().toISOString() };
    state.comments[key] = [...(state.comments[key] ?? []), c];
    return { status: 201, body: c };
  }
  if ((m = /^\/comment\/([^/]+)$/.exec(sub)) && method === 'PUT') {
    const c = (state.comments[key] ?? []).find((x) => x.id === m[1]);
    c.body = body.body;
    return { body: c };
  }
  if (sub === '/transitions' && method === 'GET') return { body: { transitions: STATUSES.filter((s) => s.name !== 'Failed').map((s) => ({ id: `t${s.id}`, name: `to ${s.name}`, to: { id: s.id, name: s.name } })) } };
  if (sub === '/transitions' && method === 'POST') {
    const s = STATUSES.find((x) => `t${x.id}` === body.transition.id);
    issue.fields.status = statusObj(s.name);
    return { status: 204, body: '' };
  }
  if (sub === '/attachments' && method === 'POST') {
    const text = body.toString('latin1');
    const filename = /filename="([^"]+)"/.exec(text)[1];
    const start = text.indexOf('\r\n\r\n') + 4;
    const end = text.lastIndexOf('\r\n--');
    const data = body.subarray(start, end);
    const a = { id: String(state.nextId++), filename, size: data.length, data: data.toString('base64') };
    state.attachments[key] = [...(state.attachments[key] ?? []), a];
    return { body: [{ id: a.id, filename, size: a.size, content: `${site}/secure/attachment/${a.id}/${filename}` }] };
  }
  if (sub === '/remotelink' && method === 'POST') {
    state.remoteLinks[key] = { ...(state.remoteLinks[key] ?? {}), [body.globalId]: body.object };
    return { body: { id: 1 } };
  }
  return null;
}

// ------------------------------------------------------------------ Azure DevOps
const PROJECT = 'Shop';
const ITEM = (id) => `http://127.0.0.1:${server.address().port}${prefix}/${PROJECT}/_apis/wit/workItems/${id}`;
const tagsOf = (w) => String(w.fields['System.Tags'] ?? '').split(';').map((x) => x.trim()).filter(Boolean);

function applyPatch(w, ops) {
  for (const op of ops) {
    if (op.path.startsWith('/fields/')) {
      const f = op.path.slice(8);
      if (op.op === 'remove') delete w.fields[f];
      else w.fields[f] = op.value;
    } else if (op.path === '/relations/-') {
      w.relations.push(op.value);
      // Azure DevOps adds the reciprocal link on the parent.
      if (op.value.rel === 'System.LinkTypes.Hierarchy-Reverse') state.items[/(\d+)$/.exec(op.value.url)[1]]?.relations.push({ rel: 'System.LinkTypes.Hierarchy-Forward', url: ITEM(w.id) });
    } else if (/^\/relations\/\d+$/.test(op.path) && op.op === 'remove') {
      const [gone] = w.relations.splice(Number(op.path.split('/').pop()), 1);
      if (gone?.rel === 'System.LinkTypes.Hierarchy-Reverse') {
        const parent = state.items[/(\d+)$/.exec(gone.url)[1]];
        if (parent) parent.relations = parent.relations.filter((r) => !(r.rel === 'System.LinkTypes.Hierarchy-Forward' && r.url === ITEM(w.id)));
      }
    }
  }
  w.fields['System.Parent'] = Number(/(\d+)$/.exec(w.relations.find((r) => r.rel === 'System.LinkTypes.Hierarchy-Reverse')?.url ?? '')?.[1]) || undefined;
  w.rev = (w.rev ?? 0) + 1;
  w.fields['System.ChangedDate'] = new Date().toISOString();
  state.revisions[w.id] = [...(state.revisions[w.id] ?? []), JSON.parse(JSON.stringify({ id: w.id, rev: w.rev, fields: w.fields }))];
}

function matchWiql(w, query) {
  const where = /WHERE (.*?)( ORDER BY .*)?$/.exec(query)[1];
  return where.split(/ AND /).every((c) => {
    let m;
    if ((m = /^\[System\.TeamProject\] = '(.+)'$/.exec(c))) return m[1] === PROJECT;
    if ((m = /^\[System\.Tags\] CONTAINS '(.+)'$/.exec(c))) return tagsOf(w).includes(m[1]);
    if ((m = /^\[System\.WorkItemType\] = '(.+)'$/.exec(c))) return w.fields['System.WorkItemType'] === m[1];
    if ((m = /^\[System\.State\] = '(.+)'$/.exec(c))) return w.fields['System.State'] === m[1];
    if ((m = /^\[System\.Parent\] = (\d+)$/.exec(c))) return w.fields['System.Parent'] === Number(m[1]);
    if ((m = /^\[System\.State\] (NOT IN|IN) \((.+)\)$/.exec(c))) {
      const set = m[2].split(', ').map((x) => x.replace(/^'|'$/g, ''));
      return m[1] === 'IN' ? set.includes(w.fields['System.State']) : !set.includes(w.fields['System.State']);
    }
    if (/^\[System\.ChangedDate\] >= /.test(c)) return true;
    throw new Error(`fake azure: unsupported WIQL clause ${c}`);
  });
}

function azure(method, p, q, body) {
  let m;
  if (p === '/_apis/connectionData') return { body: { authenticatedUser: { id: 'u-1', providerDisplayName: 'Jo Doe', properties: { Account: { $value: 'jo@example.com' } } } } };
  if ((m = /^\/_apis\/projects\/([^/]+)$/.exec(p))) return decodeURIComponent(m[1]) === PROJECT ? { body: { id: 'p-1', name: PROJECT } } : { status: 404, body: {} };
  if ((m = /^\/_apis\/wit\/fields\/(.+)$/.exec(p))) return ['Custom.Severity', 'Custom.Impact'].includes(decodeURIComponent(m[1])) ? { body: { referenceName: decodeURIComponent(m[1]) } } : { status: 404, body: { message: 'no field' } };
  if (!p.startsWith(`/${PROJECT}/`)) return null;
  const rest = p.slice(PROJECT.length + 1);
  if (rest === '/_apis/wit/workitemtypes') return { body: { value: [{ name: 'Epic' }, { name: 'User Story' }, { name: 'Bug' }, { name: 'Task' }] } };
  if ((m = /^\/_apis\/wit\/workitemtypes\/([^/]+)\/states$/.exec(rest))) return { body: { value: ['Backlog', 'Ready', 'In Progress', 'Testing', 'Pending Review', 'Done'].map((name) => ({ name })) } };
  if ((m = /^\/([^/]+)\/_apis\/work\/boards\/([^/]+)\/columns$/.exec(rest))) return { body: { value: [{ name: 'New', stateMappings: { 'User Story': 'Backlog' } }, { name: 'Doing', stateMappings: { 'User Story': 'In Progress' } }, { name: 'Done', stateMappings: { 'User Story': 'Done' } }] } };
  if (rest === '/_apis/wit/wiql' && method === 'POST') {
    const ids = Object.values(state.items).filter((w) => matchWiql(w, body.query)).map((w) => ({ id: w.id }));
    return { body: { workItems: ids } };
  }
  if (rest === '/_apis/wit/workitemsbatch' && method === 'POST') {
    if (body.ids.length > 200) return { status: 400, body: { message: 'too many ids' } };
    return { body: { count: body.ids.length, value: body.ids.map((id) => state.items[id]).filter(Boolean) } };
  }
  if ((m = /^\/_apis\/wit\/workitems\/\$(.+)$/.exec(rest)) && method === 'POST') {
    const id = state.nextId++;
    const w = { id, rev: 0, fields: { 'System.WorkItemType': decodeURIComponent(m[1]), 'System.State': 'Backlog', 'System.TeamProject': PROJECT }, relations: [], url: ITEM(id) };
    applyPatch(w, body);
    state.items[id] = w;
    return { body: w };
  }
  if ((m = /^\/_apis\/wit\/workitems\/(\d+)$/i.exec(rest))) {
    const w = state.items[m[1]];
    if (!w) return { status: 404, body: { message: 'not found' } };
    if (method === 'GET') return { body: w };
    if (method === 'PATCH') {
      applyPatch(w, body);
      return { body: w };
    }
  }
  if ((m = /^\/_apis\/wit\/workItems\/(\d+)\/comments$/.exec(rest))) {
    const all = (state.comments[m[1]] ??= []);
    if (method === 'POST') {
      const c = { id: state.nextComment++, text: body.text, createdBy: { uniqueName: 'jo@example.com' }, createdDate: new Date().toISOString() };
      all.push(c);
      return { body: c };
    }
    const start = Number(q.get('continuationToken') ?? 0);
    const next = start + 2 < all.length ? String(start + 2) : undefined;
    return { body: { comments: all.slice(start, start + 2), ...(next ? { continuationToken: next } : {}) } };
  }
  if ((m = /^\/_apis\/wit\/workItems\/(\d+)\/comments\/(\d+)$/.exec(rest)) && method === 'PATCH') {
    const c = state.comments[m[1]].find((x) => x.id === Number(m[2]));
    c.text = body.text;
    return { body: c };
  }
  if ((m = /^\/_apis\/wit\/workItems\/(\d+)\/revisions$/.exec(rest))) {
    const all = state.revisions[m[1]] ?? [];
    const skip = Number(q.get('$skip') ?? 0);
    return { body: { value: all.slice(skip, skip + 200) } };
  }
  if (rest === '/_apis/wit/attachments' && method === 'POST') {
    const id = `att-${state.nextId++}`;
    state.attachments[id] = { name: q.get('fileName'), data: body.toString('base64') };
    return { body: { id, url: `http://127.0.0.1:${server.address().port}${prefix}/${PROJECT}/_apis/wit/attachments/${id}` } };
  }
  if ((m = /^\/_apis\/wit\/attachments\/([^/]+)$/.exec(rest)) && method === 'GET') {
    const a = state.attachments[m[1]];
    return a ? { body: Buffer.from(a.data, 'base64') } : null;
  }
  return null;
}
