// GitLab Issues and issue boards as the ticket tracker, through the REST API v4 (global fetch; no CLI): gitlab.com or
// self-managed. Docs read 2026-11-17: https://docs.gitlab.com/api/issues/, /api/notes/, /api/issue_links/,
// /api/boards/, /api/labels/, /api/project_markdown_uploads/.
//
// Mapping (from `tracker` in .factory/config.json):
//   tickets      issues of `tracker.project` ("group/project"); the ticket id is the issue's iid
//   key          the factory's key in the label `factory-key-<KEY>` (and the title `KEY: title` the factory writes)
//   types        labels (`tracker.types`: default epic, story, bug, spike); GitLab's own epics are group-level and
//                Premium, so an epic is an issue with the epic label
//   epic links   the child carries the label `factory-parent-<iid>` and a "relates to" link to the epic
//   lanes        board lists are labels: a move swaps the lane labels (`tracker.lanes` are label names; a lane
//                mapped to "" has no label, the board's Open list); `done` also closes the issue
//   fields       none (GitLab has no custom fields the API writes on every tier): the triage values stay in the
//                ticket's triage section (capability customFields false)
//   metadata     a hidden `<!-- factory-ticket:... -->` block at the end of the description (it survives a person
//                editing the text above it)
//   attachments  project uploads, linked from a comment
import fs from 'node:fs';
import path from 'node:path';
import { restClient } from './http.mjs';
import { DEFAULT_URL, gitlabLabelsAndState } from '../../../pipeline/lib/hosts/gitlab.mjs';
import { LANES, TrackerError, UnsupportedError, boardItem, expandEnv, keyFromLabels, keyLabel, laneNames, safeKey, ticket as normalise, typeNames } from './shared.mjs';
import { metaFor } from '../ticket-format.mjs';

export const GITLAB_TYPES = { epic: 'epic', story: 'story', bug: 'bug', spike: 'spike' };
export const CAPABILITIES = { boardLanes: true, customFields: false, parentChild: 'partial', attachments: 'partial', commentEdit: true, bodyHistory: false, archive: false, labels: true, assignees: true };
const META = /\n*<!-- factory-ticket:([A-Za-z0-9+/=]+) -->\s*$/;
const PARENT = 'factory-parent-';

export function encodeMeta(meta) {
  return `<!-- factory-ticket:${Buffer.from(JSON.stringify(meta)).toString('base64')} -->`;
}
export function decodeMeta(body) {
  const m = META.exec(String(body ?? ''));
  if (!m) return { meta: null, text: String(body ?? '') };
  try {
    return { meta: JSON.parse(Buffer.from(m[1], 'base64').toString('utf8')), text: String(body).slice(0, m.index) };
  } catch {
    return { meta: null, text: String(body).slice(0, m.index) };
  }
}

export function gitlabTracker(config, { send } = {}) {
  const t = config.tracker ?? {};
  const base = String(t.url ?? config.host?.url ?? DEFAULT_URL).replace(/\/+$/, '');
  const project = t.project ?? (config.host?.type === 'gitlab' ? config.host.repo : null);
  if (!project) throw new TrackerError('config', 'tracker.project is not set: the GitLab project ("group/project") that holds the issues');
  const lanes = () => laneNames(config);
  const types = () => typeNames(config, GITLAB_TYPES);
  let client = null;
  function http() {
    if (client) return client;
    const token = expandEnv(t.auth?.token ?? config.host?.token, process.env, 'tracker.auth.token');
    if (!token) throw new TrackerError('config', 'tracker.auth.token is not set; use "${GITLAB_TOKEN}" (a token with the api scope; never a literal token)');
    client = restClient({ baseUrl: `${base}/api/v4`, authorization: null, headers: { 'PRIVATE-TOKEN': token }, product: 'GitLab', send, retries: t.retries ?? 4 });
    return client;
  }
  const P = `/projects/${encodeURIComponent(project)}`;
  const call = (method, p, body) => http().json(method, p, body);
  const laneLabels = () => LANES.map((l) => lanes()[l]).filter(Boolean);

  function all(p, query = {}) {
    const out = [];
    for (let page = 1; page < 200; page++) {
      const qs = new URLSearchParams({ ...Object.fromEntries(Object.entries(query).filter(([, v]) => v != null && v !== '')), per_page: '100', page: String(page) });
      const res = http().request('GET', `${p}?${qs}`);
      const list = JSON.parse(res.body.toString('utf8') || '[]');
      out.push(...list);
      const next = res.headers?.['x-next-page'];
      if (!next || list.length < 100) break;
    }
    return out;
  }

  const typeOfLabels = (labels) => (Object.entries(types()).find(([, name]) => labels.includes(name))?.[0] ?? 'story');
  function fromIssue(i) {
    const labels = (i.labels ?? []).map((l) => l?.name ?? l);
    const { meta, text } = decodeMeta(i.description);
    const parent = labels.find((l) => l.startsWith(PARENT))?.slice(PARENT.length) ?? null;
    return normalise({
      id: i.iid,
      key: keyFromLabels(labels) ?? meta?.key ?? /^([A-Z][A-Z0-9]*-\d+):/.exec(i.title ?? '')?.[1] ?? safeKey(`${project.split('/').pop()}-${i.iid}`),
      type: meta?.type ?? typeOfLabels(labels),
      title: i.title ?? '',
      body: text,
      state: i.state === 'closed' ? 'closed' : 'open',
      stateReason: i.state === 'closed' ? 'completed' : null,
      labels,
      assignees: (i.assignees ?? []).map((a) => a.username),
      parent: parent ? Number(parent) : null,
      url: i.web_url ?? null,
      updatedAt: i.updated_at ?? null,
      meta,
      raw: i,
    });
  }
  const iid = (id) => Number(String(typeof id === 'object' ? (id.number ?? id.id) : id).replace(/^#/, '')) || find(id)?.number || null;

  function find(key) {
    const hits = all(`${P}/issues`, { labels: keyLabel(key), state: 'all' });
    if (hits[0]) return { number: hits[0].iid, url: hits[0].web_url };
    const byTitle = all(`${P}/issues`, { search: `${key}:`, in: 'title', state: 'all' }).find((i) => String(i.title).startsWith(`${key}:`));
    return byTitle ? { number: byTitle.iid, url: byTitle.web_url } : null;
  }
  function get(id) {
    const n = /^#?\d+$/.test(String(id)) ? Number(String(id).replace('#', '')) : find(id)?.number;
    if (!n) return null;
    const res = http().request('GET', `${P}/issues/${n}`, {}).body.toString('utf8');
    return fromIssue(JSON.parse(res));
  }
  function list({ type = null, state = 'all', parent = null, label = null, updatedSince = null } = {}) {
    const labels = [type ? types()[type] : null, label, parent ? `${PARENT}${parent}` : null].filter(Boolean).join(',');
    return all(`${P}/issues`, { state: state === 'open' ? 'opened' : state === 'closed' ? 'closed' : 'all', labels, updated_after: updatedSince }).map(fromIssue);
  }
  const search = ({ text, state = 'open' } = {}) => all(`${P}/issues`, { search: text, in: 'title', state: state === 'open' ? 'opened' : state }).map(fromIssue);
  const userIds = (names) => names.map((u) => all('/users', { username: String(u).replace(/^@/, '') })[0]?.id).filter(Boolean);

  function create({ type = 'story', key = null, title, body = '', parent = null, labels = [], meta = null }) {
    const all_ = [...new Set([types()[type], ...(key ? [keyLabel(key)] : []), ...(parent ? [`${PARENT}${iid(parent)}`] : []), ...labels].filter(Boolean))];
    const description = meta ? `${body}\n\n${encodeMeta(meta)}` : body;
    const i = call('POST', `${P}/issues`, { title, description, labels: all_.join(',') });
    if (parent) setParent(i.iid, parent);
    return fromIssue(i);
  }
  function update(id, { title, body, labels, state, assignees, meta } = {}) {
    const n = iid(id);
    const data = {};
    if (title != null) data.title = title;
    if (body != null || meta) {
      const current = body == null || meta == null ? decodeMeta(call('GET', `${P}/issues/${n}`)?.description) : null;
      const m = meta ?? current?.meta;
      data.description = `${body ?? current.text}${m ? `\n\n${encodeMeta(m)}` : ''}`;
    }
    gitlabLabelsAndState(data, { labels, state });
    if (assignees) data.assignee_ids = userIds(Array.isArray(assignees) ? assignees : assignees.add ?? []);
    if (Object.keys(data).length) call('PUT', `${P}/issues/${n}`, data);
  }
  const children = (id) => list({ parent: iid(id) });
  function parentOf(id) {
    const tk = get(id);
    return tk?.parent ? get(tk.parent) : null;
  }
  function setParent(child, parent) {
    const c = iid(child);
    const p = iid(parent);
    const current = get(c);
    const stale = (current?.labels ?? []).filter((l) => l.startsWith(PARENT) && l !== `${PARENT}${p}`);
    call('PUT', `${P}/issues/${c}`, { add_labels: `${PARENT}${p}`, ...(stale.length ? { remove_labels: stale.join(',') } : {}) });
    try {
      call('POST', `${P}/issues/${p}/links`, { target_project_id: project, target_issue_iid: c, link_type: 'relates_to' });
    } catch (error) {
      if (!/409|already/i.test(error.message)) throw error;
    }
  }
  const comments = (id) => all(`${P}/issues/${iid(id)}/notes`, { sort: 'asc' }).filter((n) => !n.system).map((n) => ({ id: n.id, author: n.author?.username ?? null, body: n.body ?? '', createdAt: n.created_at ?? null, url: `${base}/${project}/-/issues/${iid(id)}#note_${n.id}` }));
  function comment(id, body, { marker = null } = {}) {
    const n = iid(id);
    const existing = marker ? comments(n).filter((c) => c.body.includes(marker)).at(-1) : null;
    const note = existing ? call('PUT', `${P}/issues/${n}/notes/${existing.id}`, { body }) : call('POST', `${P}/issues/${n}/notes`, { body });
    return { id: note?.id ?? existing?.id, url: `${base}/${project}/-/issues/${n}#note_${note?.id ?? existing?.id}` };
  }
  const editComment = (id, commentId, body) => call('PUT', `${P}/issues/${iid(id)}/notes/${commentId}`, { body });
  function attach(id, { name, data, file }) {
    const bytes = data ?? fs.readFileSync(file);
    const boundary = `factory${Date.now()}`;
    const payload = Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${String(name ?? path.basename(file)).replace(/"/g, '')}"\r\nContent-Type: application/octet-stream\r\n\r\n`), Buffer.from(bytes), Buffer.from(`\r\n--${boundary}--\r\n`)]);
    const res = http().request('POST', `${P}/uploads`, { body: payload, contentType: `multipart/form-data; boundary=${boundary}` });
    const up = JSON.parse(res.body.toString('utf8'));
    comment(id, `Attached: ${up.markdown}`);
    return { url: up.full_path ? `${base}${up.full_path}` : `${base}/${project}${up.url}`, name };
  }
  const attachments = (id) => comments(id).flatMap((c) => [...c.body.matchAll(/\[([^\]]+)\]\((\/uploads\/[^)]+)\)/g)].map((m) => ({ name: m[1], url: `${base}/${project}${m[2]}` })));
  function download(attachment, dest) {
    const res = http().request('GET', attachment.url, { accept: '*/*' });
    if (dest) fs.writeFileSync(dest, res.body);
    return res.body;
  }
  const link = (id, { url, title }) => comment(id, `${title ?? 'Pull request'}: ${url}`, { marker: `<!-- factory-link:${url} -->` });

  // A move swaps the lane labels; `done` closes the issue, any other lane reopens it.
  function move(id, lane) {
    const n = iid(id);
    const want = lanes()[lane];
    const remove = laneLabels().filter((l) => l !== want);
    call('PUT', `${P}/issues/${n}`, { ...(want ? { add_labels: want } : {}), remove_labels: remove.join(','), state_event: lane === 'done' ? 'close' : 'reopen' });
  }
  const laneOfIssue = (i) => {
    if (i.state === 'closed') return 'done';
    const labels = (i.labels ?? []).map((l) => l?.name ?? l);
    return LANES.find((l) => lanes()[l] && labels.includes(lanes()[l])) ?? 'backlog';
  };
  function items({ lane = null } = {}) {
    return all(`${P}/issues`, { state: 'all' }).map((i) => {
      const tk = fromIssue(i);
      const l = laneOfIssue(i);
      return boardItem(config, tk, { itemId: i.iid, lane: l, status: lanes()[l] ?? null, repo: project });
    }).filter((x) => !lane || x.column === lane);
  }

  function setup({ dryRun = false, log = () => {} } = {}) {
    const done = [];
    const manual = [];
    const say = (m) => (done.push(m), log(m));
    const p = call('GET', P);
    say(`project ${p.path_with_namespace} found`);
    const have = new Set(all(`${P}/labels`).map((l) => l.name));
    const want = [...laneLabels(), ...Object.values(types())];
    for (const name of want.filter((n) => !have.has(n))) {
      if (dryRun) say(`would create the label "${name}"`);
      else {
        call('POST', `${P}/labels`, { name, color: '#428BCA' });
        say(`created the label "${name}"`);
      }
    }
    const boardId = t.board?.id;
    if (boardId) {
      const lists = all(`${P}/boards/${boardId}/lists`).map((l) => l.label?.name).filter(Boolean);
      const missing = laneLabels().filter((n) => !['done'].some((d) => lanes()[d] === n) && !lists.includes(n));
      if (missing.length) {
        manual.push(`add lists for the labels ${missing.join(', ')} to board ${boardId} (Plan > Issue boards); setup never edits a board`);
        log(`by hand: ${manual.at(-1)}`);
      } else say(`board ${boardId}: every lane is a list`);
    } else {
      manual.push('set tracker.board.id to the issue board the team uses, and give it one list per lane label');
      log(`by hand: ${manual.at(-1)}`);
    }
    say('triage fields: GitLab has none the API writes; the review gate keeps them in the ticket\'s triage section');
    return { url: `${base}/${project}/-/boards${boardId ? `/${boardId}` : ''}`, done, manual };
  }

  return {
    type: 'gitlab',
    label: 'GitLab',
    capabilities: CAPABILITIES,
    traits: { keyFromTitle: false, blockBody: false, ticketNoun: 'issue' },
    // Issues and merge requests in the same GitLab project: "Closes #N" in the merge request closes the issue on merge.
    prClosingKeyword: (issue, host) => (host?.type === 'gitlab' && String(host.repo ?? '') === project ? `Closes #${issue.number}` : null),
    setupSteps: () => [
      'Credentials: a project or group access token (or a personal one) with the api scope, as `${GITLAB_TOKEN}` in `tracker.auth.token` (the host token is used when the issues live in the same project). Role Reporter at least to read, Developer to label, move and close issues.',
      'Set `tracker.project` to the project that holds the issues ("group/project"), `tracker.url` for a self-managed server, and `tracker.board.id` to the issue board the team uses.',
      'Lanes are labels: map each lane to the label of a board list in `tracker.lanes` (backlog may be "" for the Open list; done closes the issue). Setup creates missing labels; a person adds the board lists.',
      'GitLab has no custom fields the API writes: the triage values stay in the ticket\'s triage section. Epics are issues with the epic label (GitLab\'s own epics are group-level and need Premium).',
      '`factory adapter check tracker`, then `factory board setup --dry-run`.',
    ],
    webUrl: `${base}/${project}/-/issues`,
    active: () => !/^(0|off|false|no)$/i.test(process.env.PIPELINE_BOARD ?? ''),
    available: () => !/^(0|off|false|no)$/i.test(process.env.PIPELINE_BOARD ?? '') && process.env.PIPELINE_TICKETS_OFFLINE !== '1',
    reachable() {
      try {
        call('GET', P);
        return { ok: true, reason: null };
      } catch (error) {
        return { ok: false, reason: error.message };
      }
    },
    identity() {
      const me = call('GET', '/user');
      return { login: me.username, id: me.id };
    },
    tickets: { get, find, list, search, create, update, children, parent: parentOf, setParent, comment, comments, editComment, attach, attachments, download, link, history: () => { throw new UnsupportedError('GitLab\'s API gives no earlier versions of a description: the cached history folder (.factory/state/board/<KEY>/history) is used instead'); } },
    labels: {
      ensure(name, { color = 'ededed', description = '' } = {}) {
        try {
          call('POST', `${P}/labels`, { name, color: `#${String(color).replace(/^#/, '')}`, description });
          return true;
        } catch (error) {
          if (/409|already exists/i.test(error.message)) return false;
          throw error;
        }
      },
    },
    format: {
      render(ticketInfo, text, { assets = null } = {}) {
        const meta = metaFor(ticketInfo, text, { assets });
        return { body: text, meta, spilled: false };
      },
      parse(tk) {
        const meta = tk.meta ?? decodeMeta(tk.body).meta;
        const content = decodeMeta(tk.body).text;
        if (!meta) return { meta: null, content: `${/^#\s/m.test(content) ? '' : `# ${tk.key}: ${tk.title}\n\n`}${content.trimEnd()}\n`, legacy: true, spilled: null, edited: false };
        return { meta, content, legacy: false, spilled: null, edited: false };
      },
    },
    board: {
      lanes: () => LANES.map((lane) => ({ lane, name: lanes()[lane], id: lanes()[lane] })),
      lane: (id) => laneOfIssue(call('GET', `${P}/issues/${iid(id)}`)),
      item: (issue) => ({ id: iid(issue), column: laneOfIssue(call('GET', `${P}/issues/${iid(issue)}`)) }),
      move,
      moveItem: (itemId, lane) => move(itemId, lane),
      items,
      fields: {
        get: () => ({}),
        set: () => [],
        ensure: ({ log = () => {} } = {}) => {
          log('GitLab has no custom fields the API writes: the triage values stay in the ticket\'s triage section');
          return [];
        },
      },
      setup,
      syncAssignees(id) {
        const epic = get(id);
        if (!epic || epic.type !== 'epic') return [];
        const want = epic.assignees;
        const changed = [];
        for (const c of children(epic.id).filter((x) => x.state === 'open')) {
          if (String(c.assignees) === String(want)) continue;
          update(c.id, { assignees: want });
          changed.push({ number: c.id, add: want.filter((w) => !c.assignees.includes(w)), remove: c.assignees.filter((a) => !want.includes(a)) });
        }
        return changed;
      },
    },
  };
}
