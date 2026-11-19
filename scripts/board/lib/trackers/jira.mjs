// Jira as the ticket tracker, through its REST API (global fetch; no CLI, no dependency).
//
//   Cloud (`*.atlassian.net`):   REST v3, bodies in Atlassian Document Format, email + API token (basic)
//   Data Center / Server:        REST v2, bodies in wiki markup, a personal access token (bearer)
// `tracker.deployment` ("cloud" | "datacenter") picks one; otherwise the host name decides, and a
// self-hosted URL asks /rest/api/2/serverInfo.
//
// Mapping (from `tracker` in .factory/config.json):
//   tickets      issues of `tracker.project`; types from `tracker.types` (default Epic, Story, Bug, Task)
//   key          the Jira key (SHOP-123); a ticket the factory created carries its own key in the label
//                `factory-key-<KEY>` and is found by it
//   epic links   Cloud: the `parent` field; Data Center: the Epic Link field (`tracker.fields.epicLink`,
//                a custom field id), else `parent` (sub-tasks)
//   lanes        statuses (`tracker.lanes`, default the board.columns names); a move is a transition
//   fields       custom fields (`tracker.fields.severity` = "customfield_10050", ...); select lists take
//                Low/Medium/High/Severe, the others numbers
//   metadata     the issue property `factory.ticket` ({ meta, body, descriptionHash }): it survives a
//                person editing the description; the description itself is the Markdown converted
//   markers      hidden `<!-- ... -->` markers of comments go to the comment property `factory.markers`
//   attachments  issue attachments; a pull request link is a remote link
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { adfToMd, mdToAdf, mdToWiki, wikiToMd } from './markdown.mjs';
import { basicAuth, bearerAuth, restClient } from './http.mjs';
import { LANES, LEVELS, NUMBER_FIELDS, SELECT_FIELDS, TrackerError, UnsupportedError, boardItem, expandEnv, fieldNames, joinMarkers, keyFromLabels, keyLabel, laneNames, laneOf, safeKey, splitMarkers, ticket as normalise, typeNames, typeOf } from './shared.mjs';
import { metaFor } from '../ticket-format.mjs';

export const JIRA_TYPES = { epic: 'Epic', story: 'Story', bug: 'Bug', spike: 'Task' };
export const META_PROPERTY = 'factory.ticket';
export const MARKER_PROPERTY = 'factory.markers';
// Jira rejects descriptions over 32,767 characters (wiki); keep a margin.
export const JIRA_BODY_LIMIT = 32_000;
const sha = (s) => createHash('sha256').update(typeof s === 'string' ? s : JSON.stringify(s)).digest('hex');

// What Jira can do for the harness (providers/contracts.mjs CAPABILITIES.tracker). No archive (a closed ticket stays in
// its column); the description history is the changelog.
export const CAPABILITIES = { boardLanes: true, customFields: true, parentChild: true, attachments: true, commentEdit: true, bodyHistory: true, archive: false, labels: true, assignees: true };

export function jiraTracker(config, { send } = {}) {
  const t = config.tracker ?? {};
  if (!t.url) throw new TrackerError('config', 'tracker.url is not set: the Jira site (https://<site>.atlassian.net) or Data Center base URL');
  if (!t.project) throw new TrackerError('config', 'tracker.project is not set: the Jira project key');
  const base = String(t.url).replace(/\/+$/, '');
  const project = t.project;
  const lanes = () => laneNames(config);
  const types = () => typeNames(config, JIRA_TYPES);
  const fieldIds = () => fieldNames(config);

  let deployment = t.deployment ? (/^cloud$/i.test(t.deployment) ? 'cloud' : 'datacenter') : /\.(atlassian\.net|jira\.com|jira-dev\.com)$/i.test(new URL(base).hostname) ? 'cloud' : null;
  let client = null;
  function http() {
    if (client) return client;
    const token = expandEnv(t.auth?.token, process.env, 'tracker.auth.token');
    const user = expandEnv(t.auth?.user, process.env, 'tracker.auth.user');
    if (!token) throw new TrackerError('config', 'tracker.auth.token is not set; use "${JIRA_API_TOKEN}" (never a literal token)');
    const authorization = user ? basicAuth(user, token) : bearerAuth(token);
    client = restClient({ baseUrl: base, authorization, product: 'Jira', send, retries: t.retries ?? 4 });
    return client;
  }
  function kind() {
    if (deployment) return deployment;
    const info = http().json('GET', '/rest/api/2/serverInfo');
    deployment = /cloud/i.test(info?.deploymentType ?? '') ? 'cloud' : 'datacenter';
    return deployment;
  }
  const api = () => (kind() === 'cloud' ? '/rest/api/3' : '/rest/api/2');
  const toBody = (md) => (kind() === 'cloud' ? mdToAdf(md) : mdToWiki(md));
  const fromBody = (b) => (b == null ? '' : typeof b === 'string' ? wikiToMd(b) : adfToMd(b));
  const call = (method, p, body, opts) => http().json(method, `${api()}${p}`, body, opts);
  const enc = encodeURIComponent;
  const epicLinkField = () => (kind() === 'cloud' ? null : t.fields?.epicLink ?? null);

  const FIELDS = () => ['summary', 'description', 'issuetype', 'status', 'labels', 'assignee', 'parent', 'updated', 'issuelinks', 'resolution', ...(epicLinkField() ? [epicLinkField()] : []), ...Object.entries(fieldIds()).filter(([k, v]) => [...SELECT_FIELDS, ...NUMBER_FIELDS].includes(k) && /^customfield_/.test(v)).map(([, v]) => v)];

  function readFields(fields) {
    const ids = fieldIds();
    const out = {};
    for (const k of [...SELECT_FIELDS, ...NUMBER_FIELDS]) {
      const v = fields?.[ids[k]];
      if (v === undefined) continue;
      out[k] = v == null ? null : typeof v === 'object' ? (v.value ?? v.name ?? null) : v;
    }
    return out;
  }

  function fromIssue(issue, { property = undefined } = {}) {
    const f = issue.fields ?? {};
    const labels = f.labels ?? [];
    const meta = property?.meta ?? null;
    let body = null;
    if (f.description !== undefined) {
      body = property?.body != null && property.descriptionHash === sha(f.description ?? '') ? property.body : fromBody(f.description);
    }
    const parentKey = f.parent?.key ?? (epicLinkField() ? f[epicLinkField()] : null) ?? null;
    return normalise({
      id: issue.key,
      key: keyFromLabels(labels) ?? meta?.key ?? safeKey(issue.key),
      type: meta?.type ?? typeOf(config, JIRA_TYPES, f.issuetype?.name) ?? 'story',
      title: f.summary ?? '',
      body,
      state: f.status?.statusCategory?.key === 'done' ? 'closed' : 'open',
      stateReason: f.resolution?.name ?? null,
      labels,
      assignees: f.assignee ? [f.assignee.accountId ?? f.assignee.name ?? f.assignee.displayName] : [],
      parent: parentKey,
      blockedBy: (f.issuelinks ?? []).filter((l) => /block/i.test(l.type?.name ?? '') && l.inwardIssue).map((l) => l.inwardIssue.key),
      url: `${base}/browse/${issue.key}`,
      updatedAt: f.updated ?? null,
      meta,
      raw: issue,
    });
  }

  const quote = (s) => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  const nativeKey = new RegExp(`^${project.replace(/[^A-Za-z0-9]/g, '')}-\\d+$`, 'i');

  // JQL search with pagination: Cloud /search/jql (nextPageToken), Data Center /search (startAt).
  function search(jql, { fields = FIELDS(), max = 5000 } = {}) {
    const out = [];
    if (kind() === 'cloud') {
      let token;
      do {
        const page = call('POST', '/search/jql', { jql, fields, maxResults: 100, ...(token ? { nextPageToken: token } : {}) });
        out.push(...(page?.issues ?? []));
        token = page?.isLast === false || page?.nextPageToken ? page.nextPageToken : null;
      } while (token && out.length < max);
    } else {
      let startAt = 0;
      for (;;) {
        const page = call('POST', '/search', { jql, fields, startAt, maxResults: 100 });
        const issues = page?.issues ?? [];
        out.push(...issues);
        startAt += issues.length;
        if (!issues.length || startAt >= (page.total ?? 0) || out.length >= max) break;
      }
    }
    return out;
  }

  function property(key, name = META_PROPERTY) {
    try {
      return call('GET', `/issue/${enc(key)}/properties/${enc(name)}`)?.value ?? null;
    } catch (error) {
      if (error.code === 'not-found') return null;
      throw error;
    }
  }

  function find(keyOrId) {
    const k = String(keyOrId);
    if (nativeKey.test(k)) return k.toUpperCase();
    const hit = search(`project = ${quote(project)} AND labels = ${quote(keyLabel(k))}`, { fields: ['summary'], max: 1 })[0];
    return hit?.key ?? null;
  }

  function get(keyOrId) {
    const key = find(keyOrId);
    if (!key) return null;
    let issue;
    try {
      issue = call('GET', `/issue/${enc(key)}?fields=${enc(FIELDS().join(','))}`);
    } catch (error) {
      if (error.code === 'not-found') return null;
      throw error;
    }
    return fromIssue(issue, { property: property(key) });
  }

  function list({ type = null, state = 'all', parent = null, label = null, updatedSince = null } = {}) {
    const clauses = [`project = ${quote(project)}`];
    if (type) clauses.push(`issuetype = ${quote(types()[type] ?? type)}`);
    if (state === 'open') clauses.push('statusCategory != Done');
    if (state === 'closed') clauses.push('statusCategory = Done');
    if (parent) clauses.push(epicLinkField() ? `${quote('Epic Link')} = ${quote(parent)}` : `parent = ${quote(parent)}`);
    if (label) clauses.push(`labels = ${quote(label)}`);
    if (updatedSince) clauses.push(`updated >= ${quote(new Date(updatedSince).toISOString().slice(0, 16).replace('T', ' '))}`);
    return search(`${clauses.join(' AND ')} ORDER BY key ASC`, { fields: FIELDS().filter((f) => f !== 'description') }).map((i) => fromIssue(i));
  }

  // Tickets whose summary holds `text` (JQL `~` is a word match; the caller compares titles exactly).
  function searchTickets({ text, state = 'open' } = {}) {
    const clauses = [`project = ${quote(project)}`, `summary ~ ${quote(String(text).replace(/[+\-&|!(){}[\]^~*?:\\/]/g, ' '))}`];
    if (state === 'open') clauses.push('statusCategory != Done');
    if (state === 'closed') clauses.push('statusCategory = Done');
    return search(`${clauses.join(' AND ')} ORDER BY key ASC`, { fields: FIELDS().filter((f) => f !== 'description'), max: 200 }).map((i) => fromIssue(i));
  }

  const parentFields = (parent) => (parent ? (epicLinkField() ? { [epicLinkField()]: parent } : { parent: { key: parent } }) : {});
  const assigneeOf = (who) => (who == null ? null : kind() === 'cloud' ? { accountId: who } : { name: who });

  function fieldValues(values) {
    const ids = fieldIds();
    const out = {};
    for (const [k, v] of Object.entries(values ?? {})) {
      const id = ids[k];
      if (!id || v === undefined || !/^customfield_|^[a-z]/.test(id)) continue;
      if (![...SELECT_FIELDS, ...NUMBER_FIELDS].includes(k)) continue;
      out[id] = v === null ? null : SELECT_FIELDS.includes(k) ? { value: String(v) } : Number(v);
    }
    return out;
  }

  function writeMeta(key, meta, markdown, description) {
    const value = { meta: meta ?? null, body: markdown.length <= 30_000 ? markdown : null, descriptionHash: sha(description) };
    call('PUT', `/issue/${enc(key)}/properties/${enc(META_PROPERTY)}`, value);
  }

  function create({ type = 'story', key = null, title, body = '', parent = null, labels = [], blockedBy = [], fields = null, meta = null }) {
    const description = toBody(body);
    const allLabels = [...new Set([...labels, ...(key && !nativeKey.test(key) ? [keyLabel(key)] : [])])].map((l) => l.replace(/\s+/g, '-'));
    const created = call('POST', '/issue', { fields: { project: { key: project }, summary: title, issuetype: { name: types()[type] ?? type }, description, labels: allLabels, ...parentFields(parent), ...fieldValues(fields) } });
    if (meta || body) writeMeta(created.key, meta, body, description);
    for (const blocker of blockedBy ?? []) {
      const b = find(blocker);
      if (b) call('POST', '/issueLink', { type: { name: 'Blocks' }, outwardIssue: { key: b }, inwardIssue: { key: created.key } });
    }
    return normalise({ id: created.key, key: key ?? created.key, type, title, body, labels: allLabels, parent, url: `${base}/browse/${created.key}`, meta });
  }

  function update(id, { title, body, labels, state, fields, assignees, meta } = {}) {
    const key = find(id) ?? id;
    const set = {};
    const ops = {};
    if (title != null) set.summary = title;
    let description;
    if (body != null) set.description = description = toBody(body);
    if (Array.isArray(labels)) set.labels = labels;
    else if (labels) ops.labels = [...(labels.add ?? []).map((l) => ({ add: l })), ...(labels.remove ?? []).map((l) => ({ remove: l }))];
    if (assignees != null) {
      const who = Array.isArray(assignees) ? assignees[0] : assignees.add?.[0] ?? (assignees.remove?.length ? null : undefined);
      if (who !== undefined) set.assignee = assigneeOf(who);
    }
    Object.assign(set, fieldValues(fields));
    if (Object.keys(set).length || Object.keys(ops).length) call('PUT', `/issue/${enc(key)}`, { ...(Object.keys(set).length ? { fields: set } : {}), ...(Object.keys(ops).length ? { update: ops } : {}) });
    if (body != null) writeMeta(key, meta ?? property(key)?.meta ?? null, body, description);
    else if (meta) call('PUT', `/issue/${enc(key)}/properties/${enc(META_PROPERTY)}`, { ...(property(key) ?? {}), meta });
    if (state === 'closed') move(key, 'done');
    if (state === 'open') move(key, 'ready');
  }

  function children(id) {
    return list({ parent: find(id) ?? id });
  }

  function parentOf(id) {
    const t2 = get(id);
    return t2?.parent ? { id: t2.parent, number: t2.parent, url: `${base}/browse/${t2.parent}` } : null;
  }

  function setParent(child, parent) {
    const c = get(child);
    const p = find(parent) ?? parent;
    if (c?.parent === p) return false;
    call('PUT', `/issue/${enc(c?.id ?? child)}`, { fields: parentFields(p) });
    return true;
  }

  // Comments: bodies converted to Markdown, hidden markers back from the comment property.
  function comments(id) {
    const key = find(id) ?? id;
    const out = [];
    let startAt = 0;
    for (;;) {
      const page = call('GET', `/issue/${enc(key)}/comment?startAt=${startAt}&maxResults=100&expand=properties`);
      for (const c of page?.comments ?? []) {
        const markers = (c.properties ?? []).find((p) => p.key === MARKER_PROPERTY)?.value?.markers ?? [];
        out.push({ id: c.id, author: c.author?.accountId ?? c.author?.name ?? c.author?.displayName ?? null, body: joinMarkers(fromBody(c.body).trimEnd(), markers), createdAt: c.created ?? null, url: `${base}/browse/${key}?focusedCommentId=${c.id}` });
      }
      startAt += page?.comments?.length ?? 0;
      if (!page?.comments?.length || startAt >= (page.total ?? 0)) break;
    }
    return out;
  }

  function writeComment(key, commentId, body) {
    const { markers, text } = splitMarkers(body);
    const payload = { body: toBody(text) };
    const c = commentId ? call('PUT', `/issue/${enc(key)}/comment/${enc(commentId)}`, payload) : call('POST', `/issue/${enc(key)}/comment`, payload);
    const cid = c?.id ?? commentId;
    if (markers.length || commentId) call('PUT', `/comment/${enc(cid)}/properties/${enc(MARKER_PROPERTY)}`, { markers });
    return cid;
  }

  function comment(id, body, { marker = null } = {}) {
    const key = find(id) ?? id;
    if (marker) {
      const existing = comments(key).find((c) => (marker instanceof RegExp ? marker.test(c.body) : c.body.includes(marker)));
      if (existing) {
        writeComment(key, existing.id, body);
        return { id: existing.id, url: existing.url, created: false };
      }
    }
    const cid = writeComment(key, null, body);
    return { id: cid, url: `${base}/browse/${key}?focusedCommentId=${cid}`, created: true };
  }

  const editComment = (id, commentId, body) => writeComment(find(id) ?? id, commentId, body);

  // Attachments: multipart upload (X-Atlassian-Token: no-check).
  function attach(id, { name, data, file }) {
    const key = find(id) ?? id;
    const bytes = data ?? fs.readFileSync(file);
    const filename = name ?? path.basename(file);
    const boundary = `----factory${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`;
    const body = Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename.replace(/"/g, '')}"\r\nContent-Type: application/octet-stream\r\n\r\n`), bytes, Buffer.from(`\r\n--${boundary}--\r\n`)]);
    const res = http().request('POST', `${api()}/issue/${enc(key)}/attachments`, { body, contentType: `multipart/form-data; boundary=${boundary}`, headers: { 'X-Atlassian-Token': 'no-check' } });
    const a = JSON.parse(res.body.toString('utf8'))[0];
    return { id: a.id, name: a.filename, url: a.content, size: a.size, sha256: createHash('sha256').update(bytes).digest('hex') };
  }

  function attachments(id) {
    const key = find(id) ?? id;
    const issue = call('GET', `/issue/${enc(key)}?fields=attachment`);
    return (issue?.fields?.attachment ?? []).map((a) => ({ id: a.id, name: a.filename, url: a.content, size: a.size, mimeType: a.mimeType ?? null }));
  }

  function download(attachment, dest = null) {
    const res = http().request('GET', attachment.url, { accept: '*/*' });
    if (dest) {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, res.body);
    }
    return res.body;
  }

  // A pull request on any code host, as a remote link (idempotent through its globalId).
  function link(id, { pr, url, title }) {
    const href = url ?? pr;
    const key = find(id) ?? id;
    call('POST', `/issue/${enc(key)}/remotelink`, { globalId: `factory-pr=${href}`, object: { url: href, title: title ?? href, icon: { title: 'Pull request' } } });
    return { url: href };
  }

  // ------------------------------------------------------------------ board
  function transitions(key) {
    return call('GET', `/issue/${enc(key)}/transitions`)?.transitions ?? [];
  }

  function move(id, lane) {
    const key = find(id) ?? id;
    const target = lanes()[lane];
    if (!target) throw new TrackerError('config', `no status configured for the lane "${lane}" (tracker.lanes.${lane})`);
    const current = call('GET', `/issue/${enc(key)}?fields=status`)?.fields?.status?.name;
    if (String(current).toLowerCase() === String(target).toLowerCase()) return false;
    const tr = transitions(key).find((x) => String(x.to?.name ?? x.name).toLowerCase() === String(target).toLowerCase());
    if (!tr) throw new TrackerError('config', `Jira has no transition from "${current}" to "${target}" for ${key}; add one to the workflow (every status the factory uses should allow "Any status" transitions) or change tracker.lanes.${lane}`);
    call('POST', `/issue/${enc(key)}/transitions`, { transition: { id: tr.id } });
    return true;
  }

  function items({ lane = null } = {}) {
    const clauses = [`project = ${quote(project)}`];
    if (lane) clauses.push(`status = ${quote(lanes()[lane])}`);
    return search(clauses.join(' AND '), { fields: FIELDS().filter((f) => f !== 'description') }).map((issue) => {
      const tk = fromIssue(issue);
      const status = issue.fields?.status?.name ?? null;
      return boardItem(config, tk, { itemId: issue.key, lane: laneOf(config, status), status, repo: project, fields: readFields(issue.fields) });
    });
  }

  function projectStatuses() {
    const byType = call('GET', `/project/${enc(project)}/statuses`) ?? [];
    return byType.map((x) => ({ type: x.name, statuses: (x.statuses ?? []).map((s) => ({ id: s.id, name: s.name })) }));
  }

  function setup({ dryRun = false, log = () => {} } = {}) {
    const done = [];
    const manual = [];
    const say = (m) => {
      done.push(m);
      log(m);
    };
    const todo = (m) => {
      manual.push(m);
      log(`by hand: ${m}`);
    };
    const p = call('GET', `/project/${enc(project)}`);
    say(`project ${p.key} "${p.name}" found (${kind() === 'cloud' ? 'Jira Cloud, REST v3' : 'Jira Data Center, REST v2'})`);
    const issueTypes = (p.issueTypes ?? []).map((x) => x.name.toLowerCase());
    for (const [ft, name] of Object.entries(types())) {
      if (issueTypes.length && !issueTypes.includes(String(name).toLowerCase())) todo(`add the issue type "${name}" (the factory's ${ft}) to project ${project}, or map ${ft} to an existing type in tracker.types.${ft}`);
    }
    const statuses = new Set(projectStatuses().flatMap((x) => x.statuses.map((s) => s.name.toLowerCase())));
    for (const lane of LANES) {
      const name = lanes()[lane];
      if (!statuses.has(String(name).toLowerCase())) todo(`add the status "${name}" (lane ${lane}) to the workflow of ${project} with a transition from any status, or set tracker.lanes.${lane} to an existing status`);
    }
    say(`lanes checked: ${LANES.map((l) => `${l} -> ${lanes()[l]}`).join(', ')}`);
    const all = call('GET', '/field') ?? [];
    const ids = fieldIds();
    for (const k of [...SELECT_FIELDS, ...NUMBER_FIELDS]) {
      const want = ids[k];
      const found = all.find((f) => f.id === want) ?? all.find((f) => f.name === want);
      if (!found) todo(`create the custom field "${want}" (${SELECT_FIELDS.includes(k) ? `select list: ${LEVELS.join(', ')}` : 'number'}), add it to the project's screens and set tracker.fields.${k} to its id (customfield_NNNNN)`);
      else if (found.id !== want) todo(`set tracker.fields.${k} to "${found.id}" (the id of the field "${want}")`);
    }
    if (kind() === 'datacenter' && !t.fields?.epicLink) todo('set tracker.fields.epicLink to the id of the Epic Link field (Data Center links stories to epics through it)');
    const boardId = t.board?.id;
    if (boardId) {
      try {
        const conf = http().json('GET', `/rest/agile/1.0/board/${enc(boardId)}/configuration`);
        const mapped = new Set((conf?.columnConfig?.columns ?? []).flatMap((c) => (c.statuses ?? []).map((s) => String(s.id))));
        const byName = new Map(projectStatuses().flatMap((x) => x.statuses).map((s) => [s.name.toLowerCase(), String(s.id)]));
        const unmapped = LANES.map((l) => lanes()[l]).filter((n) => byName.has(String(n).toLowerCase()) && !mapped.has(byName.get(String(n).toLowerCase())));
        if (unmapped.length) todo(`map the statuses ${unmapped.join(', ')} to columns of board ${boardId} (Board settings > Columns)`);
        else say(`board ${boardId}: every lane is on a column`);
      } catch (error) {
        todo(`check board ${boardId} by hand (${error.message.split('\n')[0]})`);
      }
    }
    say(`${dryRun ? 'dry run: ' : ''}labels are created on first use; nothing existing was changed`);
    return { url: `${base}/projects/${project}`, done, manual };
  }

  return {
    type: 'jira',
    label: 'Jira',
    capabilities: CAPABILITIES,
    traits: { keyFromTitle: false, blockBody: false, ticketNoun: 'issue' },
    setupSteps: () => [
      'Credentials: Jira Cloud uses an account e-mail and an API token (id.atlassian.com > Security > API tokens): set `tracker.auth.user` to `${JIRA_EMAIL}` and `tracker.auth.token` to `${JIRA_API_TOKEN}`. Jira Data Center uses a personal access token only (`tracker.auth.token`, Bearer). The account needs Browse projects, Create issues, Edit issues, Transition issues, Add comments and Create attachments on the project.',
      'Set `tracker.url` (the site, https://<name>.atlassian.net, or the Data Center base URL), `tracker.project` (the project key) and `tracker.board.id` (the board the team uses; `factory board guide` cannot list boards without credentials).',
      'Lanes: map each pipeline lane to an existing workflow status in `tracker.lanes`. A missing status is added to the workflow by a Jira administrator; setup never edits a workflow.',
      'Types: `tracker.types` to the project\'s issue types (Epic, Story, Bug, Task). Fields: `tracker.fields` to custom field ids (customfield_10050) for severity, impact, complexity, fixRisk, confidence and reopens; a Jira administrator creates missing ones (setup lists them).',
      '`factory adapter check tracker` reads every operation; `factory board setup --dry-run` lists what is missing.',
    ],
    get deployment() {
      return kind();
    },
    webUrl: `${base}/browse/${project}`,
    active: () => !/^(0|off|false|no)$/i.test(process.env.PIPELINE_BOARD ?? ''),
    available: () => !/^(0|off|false|no)$/i.test(process.env.PIPELINE_BOARD ?? '') && process.env.PIPELINE_TICKETS_OFFLINE !== '1',
    reachable() {
      try {
        call('GET', '/myself');
        return { ok: true, reason: null };
      } catch (error) {
        return { ok: false, reason: error.message };
      }
    },
    identity() {
      const me = call('GET', '/myself');
      return { login: me.emailAddress ?? me.name ?? me.displayName, id: me.accountId ?? me.key ?? me.name };
    },
    tickets: { get, find, list, search: searchTickets, create, update, children, parent: parentOf, setParent, comment, comments, editComment, attach, attachments, download, link, history: () => { throw new UnsupportedError('Jira keeps no copy of earlier descriptions the factory can read back; the cached history folder (.factory/state/board/<KEY>/history) is used instead'); } },
    labels: { ensure: () => false },
    format: {
      limit: JIRA_BODY_LIMIT,
      render(ticketInfo, text, { assets = null } = {}) {
        const meta = metaFor(ticketInfo, text, { assets });
        return { body: text, meta, spilled: text.length > JIRA_BODY_LIMIT };
      },
      parse: (tk) => parseStored(tk),
    },
    board: {
      lanes: () => LANES.map((lane) => ({ lane, name: lanes()[lane], id: lanes()[lane] })),
      lane: (id) => laneOf(config, call('GET', `/issue/${enc(find(id) ?? id)}?fields=status`)?.fields?.status?.name),
      item: (issue) => ({ id: issue.number ?? issue.id, column: laneOf(config, call('GET', `/issue/${enc(issue.number ?? issue.id)}?fields=status`)?.fields?.status?.name) }),
      move,
      moveItem: (itemId, lane) => move(itemId, lane),
      items,
      fields: {
        get: (id) => readFields(call('GET', `/issue/${enc(find(id) ?? id)}?fields=${enc(FIELDS().join(','))}`)?.fields),
        set(issue, values) {
          const key = typeof issue === 'object' ? (issue.number ?? issue.id) : issue;
          const f = fieldValues(values);
          if (Object.keys(f).length) call('PUT', `/issue/${enc(key)}`, { fields: f });
          return Object.keys(f);
        },
        ensure: ({ log = () => {} } = {}) => {
          log('Jira custom fields are created by an administrator; `board setup` lists what is missing');
          return [];
        },
      },
      setup,
      syncAssignees(id) {
        const epic = get(id);
        if (!epic || epic.type !== 'epic') return [];
        const want = epic.assignees[0] ?? null;
        const changed = [];
        for (const c of children(epic.id).filter((x) => x.state === 'open')) {
          if ((c.assignees[0] ?? null) === want) continue;
          update(c.id, { assignees: want ? [want] : { remove: c.assignees } });
          changed.push({ number: c.id, add: want ? [want] : [], remove: c.assignees });
        }
        return changed;
      },
    },
  };
}

// The source and metadata of a Jira or Azure Boards ticket (the tracker's `format.parse`): the meta
// property / block, the factory's appended sections (Decisions, Triage) removed. A ticket a person
// created by hand (no metadata) reads as `# <KEY>: <title>` plus its description.
const SECTION_STARTS = ['<!-- pipeline-decisions:begin -->', '<!-- bug-triage:begin -->'];
export function parseStored(tk) {
  const body = String(tk.body ?? '').replace(/\r\n/g, '\n');
  const meta = tk.meta;
  if (!meta) {
    const heading = /^#\s/m.test(body.split('\n').find((l) => l.trim()) ?? '') ? '' : `# ${tk.key}: ${tk.title}\n\n`;
    return { meta: null, content: `${heading}${body.trimEnd()}\n`, legacy: true, spilled: null, edited: false };
  }
  const starts = SECTION_STARTS.map((m) => body.indexOf(m)).filter((i) => i >= 0);
  let content = starts.length ? body.slice(0, Math.min(...starts)).trimEnd() + (meta.finalNewline ? '\n' : '') : body;
  if (!starts.length && sha256Text(content) !== meta.sourceHash) {
    const trimmed = content.trimEnd() + (meta.finalNewline ? '\n' : '');
    if (sha256Text(trimmed) === meta.sourceHash) content = trimmed;
  }
  if (meta.eol === 'crlf') content = content.replace(/\n/g, '\r\n');
  return { meta, content, legacy: false, spilled: null, edited: sha256Text(content) !== meta.sourceHash };
}
const sha256Text = (s) => createHash('sha256').update(Buffer.from(s, 'utf8')).digest('hex');
