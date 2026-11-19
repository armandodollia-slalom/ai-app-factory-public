// Linear as the ticket tracker, through its GraphQL API (https://api.linear.app/graphql; global fetch, no SDK).
// Docs read 2026-11-17: https://linear.app/developers/graphql (endpoint, personal API key in Authorization without
// "Bearer", issue(id: "ENG-123"), issueCreate/issueUpdate), and the public schema for comments, attachments, labels,
// workflow states and Relay pagination (first/after, pageInfo). Verified only against the fake in the tests.
//
// Mapping (from `tracker` in .factory/config.json):
//   tickets      issues of the team `tracker.project` (the team key, ENG); the ticket id and key are the issue's
//                identifier (ENG-123)
//   types        labels (`tracker.types`: default epic, story, bug, spike); Linear has no issue types
//   epic links   Linear's own parent issue (sub-issues)
//   lanes        workflow states of the team (`tracker.lanes` are state names); `done` is a completed state
//   fields       none (Linear has no custom fields): the triage values stay in the ticket's triage section
//   metadata     an attachment on the issue (url "<issue url>#factory-ticket", its `metadata` holds the factory's
//                ticket metadata), so a person editing the description never loses it
//   attachments  link attachments (a file upload needs Linear's signed upload flow: not used; files are linked)
import { restClient } from './http.mjs';
import { LANES, TrackerError, UnsupportedError, boardItem, expandEnv, laneNames, ticket as normalise, typeNames } from './shared.mjs';
import { metaFor } from '../ticket-format.mjs';

export const LINEAR_TYPES = { epic: 'Epic', story: 'Story', bug: 'Bug', spike: 'Spike' };
export const CAPABILITIES = { boardLanes: true, customFields: false, parentChild: true, attachments: 'partial', commentEdit: true, bodyHistory: false, archive: true, labels: true, assignees: 'partial' };
const META_SUFFIX = '#factory-ticket';
const ISSUE = 'id identifier title description url updatedAt state { id name type } labels { nodes { id name } } assignee { id name email displayName } parent { identifier } team { id key } attachments { nodes { id url title metadata } }';

export function linearTracker(config, { send } = {}) {
  const t = config.tracker ?? {};
  const teamKey = t.project;
  if (!teamKey) throw new TrackerError('config', 'tracker.project is not set: the Linear team key (ENG)');
  const endpoint = String(t.url ?? 'https://api.linear.app').replace(/\/+$/, '').replace(/\/graphql$/, '');
  const lanes = () => laneNames(config);
  const types = () => typeNames(config, LINEAR_TYPES);
  let client = null;
  function http() {
    if (client) return client;
    const token = expandEnv(t.auth?.token, process.env, 'tracker.auth.token');
    if (!token) throw new TrackerError('config', 'tracker.auth.token is not set; use "${LINEAR_API_KEY}" (a personal API key, or an OAuth token as "Bearer ${...}"; never a literal key)');
    client = restClient({ baseUrl: endpoint, authorization: token, product: 'Linear', send, retries: t.retries ?? 4 });
    return client;
  }
  // One GraphQL call; GraphQL errors (HTTP 200 with `errors`) are errors here, a rate limit says so.
  function gql(query, variables = {}) {
    const out = http().json('POST', '/graphql', { query, variables });
    if (out?.errors?.length) {
      const e = out.errors[0];
      const code = e.extensions?.code ?? e.extensions?.type ?? '';
      throw new TrackerError(/RATELIMITED/i.test(code) ? 'rate-limit' : /AUTHENTICATION|FORBIDDEN/i.test(code) ? 'auth' : /not found|ENTITY_NOT_FOUND/i.test(`${code} ${e.message}`) ? 'not-found' : 'http', `Linear: ${e.message}`);
    }
    return out?.data ?? {};
  }
  function pages(field, query, variables = {}) {
    const out = [];
    let after = null;
    for (let guard = 0; guard < 100; guard++) {
      const data = gql(query, { ...variables, after });
      const conn = field.split('.').reduce((o, k) => o?.[k], data);
      out.push(...(conn?.nodes ?? []));
      if (!conn?.pageInfo?.hasNextPage) break;
      after = conn.pageInfo.endCursor;
    }
    return out;
  }
  let teamMemo = null;
  function team() {
    if (teamMemo) return teamMemo;
    const tm = gql('query($key: String!) { teams(filter: { key: { eq: $key } }) { nodes { id key name states { nodes { id name type position } } labels { nodes { id name } } } } }', { key: teamKey }).teams?.nodes?.[0];
    if (!tm) throw new TrackerError('not-found', `Linear: team ${teamKey} not found (tracker.project is the team key)`);
    teamMemo = { id: tm.id, key: tm.key, name: tm.name, states: tm.states?.nodes ?? [], labels: tm.labels?.nodes ?? [] };
    return teamMemo;
  }
  const stateOf = (lane) => team().states.find((s) => s.name.toLowerCase() === String(lanes()[lane] ?? '').toLowerCase()) ?? null;
  const laneOfState = (s) => (s ? LANES.find((l) => String(lanes()[l]).toLowerCase() === String(s.name).toLowerCase()) ?? (s.type === 'completed' ? 'done' : s.type === 'backlog' ? 'backlog' : null) : null);
  function labelId(name, { create = true } = {}) {
    const found = team().labels.find((l) => l.name.toLowerCase() === String(name).toLowerCase());
    if (found || !create) return found?.id ?? null;
    const made = gql('mutation($input: IssueLabelCreateInput!) { issueLabelCreate(input: $input) { issueLabel { id name } } }', { input: { name, teamId: team().id } }).issueLabelCreate?.issueLabel;
    if (made) team().labels.push(made);
    return made?.id ?? null;
  }

  const metaOf = (i) => (i.attachments?.nodes ?? []).find((a) => String(a.url).endsWith(META_SUFFIX))?.metadata?.factory ?? null;
  function fromIssue(i) {
    const labels = (i.labels?.nodes ?? []).map((l) => l.name);
    const meta = metaOf(i);
    return normalise({
      id: i.identifier,
      key: i.identifier,
      type: meta?.type ?? Object.entries(types()).find(([, n]) => labels.includes(n))?.[0] ?? 'story',
      title: i.title ?? '',
      body: i.description ?? '',
      state: ['completed', 'canceled'].includes(i.state?.type) ? 'closed' : 'open',
      stateReason: i.state?.type === 'canceled' ? 'not_planned' : i.state?.type === 'completed' ? 'completed' : null,
      labels,
      assignees: i.assignee ? [i.assignee.email ?? i.assignee.displayName ?? i.assignee.name] : [],
      parent: i.parent?.identifier ?? null,
      url: i.url ?? null,
      updatedAt: i.updatedAt ?? null,
      meta,
      raw: i,
    });
  }
  const idOf = (id) => String(typeof id === 'object' ? (id.number ?? id.id) : id);
  function get(id) {
    try {
      const i = gql(`query($id: String!) { issue(id: $id) { ${ISSUE} } }`, { id: idOf(id) }).issue;
      return i ? fromIssue(i) : null;
    } catch (error) {
      if (error.code === 'not-found') return null;
      throw error;
    }
  }
  const find = (key) => {
    const tk = get(key);
    return tk ? { number: tk.id, url: tk.url } : null;
  };
  function list({ type = null, state = 'all', parent = null, label = null, updatedSince = null } = {}) {
    const filter = { team: { key: { eq: teamKey } } };
    if (state === 'open') filter.state = { type: { nin: ['completed', 'canceled'] } };
    if (state === 'closed') filter.state = { type: { in: ['completed', 'canceled'] } };
    if (parent) filter.parent = { id: { eq: gql('query($id: String!) { issue(id: $id) { id } }', { id: idOf(parent) }).issue?.id } };
    const want = [type ? types()[type] : null, label].filter(Boolean);
    if (want.length) filter.labels = { name: { in: want } };
    if (updatedSince) filter.updatedAt = { gte: updatedSince };
    return pages('issues', `query($filter: IssueFilter, $after: String) { issues(filter: $filter, first: 100, after: $after) { nodes { ${ISSUE} } pageInfo { hasNextPage endCursor } } }`, { filter }).map(fromIssue);
  }
  const search = ({ text, state = 'open' } = {}) => {
    const filter = { team: { key: { eq: teamKey } }, title: { containsIgnoreCase: String(text) } };
    if (state === 'open') filter.state = { type: { nin: ['completed', 'canceled'] } };
    return pages('issues', `query($filter: IssueFilter, $after: String) { issues(filter: $filter, first: 100, after: $after) { nodes { ${ISSUE} } pageInfo { hasNextPage endCursor } } }`, { filter }).map(fromIssue);
  };
  function writeMeta(issue, meta) {
    gql('mutation($input: AttachmentCreateInput!) { attachmentCreate(input: $input) { success } }', { input: { issueId: issue.raw?.id ?? issue.id, url: `${issue.url}${META_SUFFIX}`, title: 'Factory ticket metadata', metadata: { factory: meta } } });
  }
  function create({ type = 'story', title, body = '', parent = null, labels = [], meta = null }) {
    const input = { teamId: team().id, title, description: body, labelIds: [...new Set([types()[type], ...labels].filter(Boolean))].map((n) => labelId(n)).filter(Boolean) };
    if (parent) input.parentId = gql('query($id: String!) { issue(id: $id) { id } }', { id: idOf(parent) }).issue?.id;
    const backlog = stateOf('backlog');
    if (backlog) input.stateId = backlog.id;
    const i = gql(`mutation($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { ${ISSUE} } } }`, { input }).issueCreate?.issue;
    if (!i) throw new TrackerError('http', `Linear: issueCreate returned no issue for "${title}"`);
    const tk = fromIssue(i);
    if (meta) writeMeta(tk, meta);
    return tk;
  }
  function update(id, { title, body, labels, state, assignees, meta } = {}) {
    const current = get(id);
    if (!current) throw new TrackerError('not-found', `Linear: ${idOf(id)} not found`);
    const input = {};
    if (title != null) input.title = title;
    if (body != null) input.description = body;
    if (labels) {
      const names = Array.isArray(labels) ? labels : [...current.labels.filter((l) => !(labels.remove ?? []).includes(l)), ...(labels.add ?? [])];
      input.labelIds = [...new Set(names)].map((n) => labelId(n)).filter(Boolean);
    }
    if (state === 'closed') input.stateId = stateOf('done')?.id ?? team().states.find((s) => s.type === 'completed')?.id;
    if (state === 'open' && current.state === 'closed') input.stateId = stateOf('backlog')?.id ?? team().states.find((s) => s.type === 'unstarted')?.id;
    if (assignees) {
      const who = (Array.isArray(assignees) ? assignees : assignees.add ?? [])[0];
      input.assigneeId = who ? gql('query($q: String!) { users(filter: { or: [{ email: { eq: $q } }, { displayName: { eq: $q } }] }) { nodes { id } } }', { q: who }).users?.nodes?.[0]?.id ?? null : null;
    }
    if (Object.keys(input).length) gql('mutation($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }', { id: current.raw.id, input });
    if (meta) writeMeta(current, meta);
  }
  const children = (id) => {
    const i = gql('query($id: String!, $after: String) { issue(id: $id) { children(first: 100, after: $after) { nodes { identifier } pageInfo { hasNextPage endCursor } } } }', { id: idOf(id) });
    return (i.issue?.children?.nodes ?? []).map((c) => get(c.identifier)).filter(Boolean);
  };
  const parentOf = (id) => {
    const tk = get(id);
    return tk?.parent ? get(tk.parent) : null;
  };
  function setParent(child, parent) {
    const c = get(child);
    const p = gql('query($id: String!) { issue(id: $id) { id } }', { id: idOf(parent) }).issue?.id;
    gql('mutation($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }', { id: c.raw.id, input: { parentId: p } });
  }
  const comments = (id) => pages('issue.comments', 'query($id: String!, $after: String) { issue(id: $id) { comments(first: 100, after: $after) { nodes { id body url createdAt user { displayName email } } pageInfo { hasNextPage endCursor } } } }', { id: idOf(id) }).map((c) => ({ id: c.id, author: c.user?.email ?? c.user?.displayName ?? null, body: c.body ?? '', createdAt: c.createdAt ?? null, url: c.url ?? null })).sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  function comment(id, body, { marker = null } = {}) {
    const existing = marker ? comments(id).filter((c) => c.body.includes(marker)).at(-1) : null;
    if (existing) {
      gql('mutation($id: String!, $input: CommentUpdateInput!) { commentUpdate(id: $id, input: $input) { success } }', { id: existing.id, input: { body } });
      return { id: existing.id, url: existing.url };
    }
    const issueId = get(id)?.raw?.id;
    const c = gql('mutation($input: CommentCreateInput!) { commentCreate(input: $input) { comment { id url } } }', { input: { issueId, body } }).commentCreate?.comment;
    return { id: c?.id ?? null, url: c?.url ?? null };
  }
  const editComment = (_id, commentId, body) => gql('mutation($id: String!, $input: CommentUpdateInput!) { commentUpdate(id: $id, input: $input) { success } }', { id: commentId, input: { body } });
  const link = (id, { url, title }) => gql('mutation($issueId: String!, $url: String!, $title: String) { attachmentLinkURL(issueId: $issueId, url: $url, title: $title) { success } }', { issueId: get(id)?.raw?.id, url, title: title ?? 'Pull request' });
  const attachments = (id) => (get(id)?.raw?.attachments?.nodes ?? []).filter((a) => !String(a.url).endsWith(META_SUFFIX)).map((a) => ({ name: a.title ?? a.url, url: a.url }));

  function move(id, lane) {
    const s = stateOf(lane);
    if (!s) throw new TrackerError('config', `Linear: team ${teamKey} has no state "${lanes()[lane]}" for the lane ${lane}; set tracker.lanes.${lane} to one of ${team().states.map((x) => x.name).join(', ')}`);
    gql('mutation($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }', { id: get(id)?.raw?.id, input: { stateId: s.id } });
  }
  function items({ lane = null } = {}) {
    return list().map((tk) => {
      const l = laneOfState(tk.raw.state);
      return boardItem(config, tk, { itemId: tk.id, lane: l, status: tk.raw.state?.name ?? null, repo: teamKey });
    }).filter((x) => !lane || x.column === lane);
  }
  function setup({ dryRun = false, log = () => {} } = {}) {
    const done = [];
    const manual = [];
    const say = (m) => (done.push(m), log(m));
    const tm = team();
    say(`team ${tm.key} "${tm.name}" found`);
    for (const lane of LANES) {
      if (stateOf(lane)) continue;
      manual.push(`add the workflow state "${lanes()[lane]}" (lane ${lane}) to team ${tm.key} (Settings > Teams > Workflow), or set tracker.lanes.${lane} to one of ${tm.states.map((s) => s.name).join(', ')}`);
      log(`by hand: ${manual.at(-1)}`);
    }
    for (const name of Object.values(types())) {
      if (labelId(name, { create: false })) continue;
      if (dryRun) say(`would create the label "${name}"`);
      else {
        labelId(name);
        say(`created the label "${name}"`);
      }
    }
    say('triage fields: Linear has no custom fields; the review gate keeps them in the ticket\'s triage section');
    return { url: `https://linear.app/team/${tm.key}`, done, manual };
  }

  return {
    type: 'linear',
    label: 'Linear',
    capabilities: CAPABILITIES,
    traits: { keyFromTitle: false, blockBody: false, ticketNoun: 'issue' },
    setupSteps: () => [
      'Credentials: a personal API key (Linear > Settings > Security & access > Personal API keys) as `${LINEAR_API_KEY}` in `tracker.auth.token`; an OAuth app token goes in as "Bearer ${...}". It needs read and write access to the team\'s issues.',
      'Set `tracker.project` to the team key (ENG).',
      'Lanes: map each pipeline lane to one of the team\'s workflow states in `tracker.lanes`; a missing state is added by a team admin (Settings > Teams > Workflow). Types are labels (`tracker.types`); setup creates missing labels.',
      'Linear has no custom fields: the triage values stay in the ticket\'s triage section. Epics are parent issues.',
      '`factory adapter check tracker`, then `factory board setup --dry-run`.',
    ],
    get webUrl() {
      return `https://linear.app/team/${teamKey}`;
    },
    active: () => !/^(0|off|false|no)$/i.test(process.env.PIPELINE_BOARD ?? ''),
    available: () => !/^(0|off|false|no)$/i.test(process.env.PIPELINE_BOARD ?? '') && process.env.PIPELINE_TICKETS_OFFLINE !== '1',
    reachable() {
      try {
        gql('query { viewer { id } }');
        return { ok: true, reason: null };
      } catch (error) {
        return { ok: false, reason: error.message };
      }
    },
    identity() {
      const v = gql('query { viewer { id name email } }').viewer;
      return { login: v?.email ?? v?.name ?? null, id: v?.id ?? null };
    },
    tickets: {
      get, find, list, search, create, update, children, parent: parentOf, setParent, comment, comments, editComment, link, attachments,
      attach: () => {
        throw new UnsupportedError('Linear files are uploaded through its signed upload flow, which the factory does not use: mockups are linked from the repository\'s assets branch');
      },
      download: (attachment, dest) => {
        throw new UnsupportedError(`Linear attachment ${attachment?.url ?? ''} is a link: open it${dest ? ` (not written to ${dest})` : ''}`);
      },
      history: () => {
        throw new UnsupportedError('Linear\'s API gives no earlier versions of a description: the cached history folder is used instead');
      },
    },
    labels: { ensure: (name) => Boolean(labelId(name)) },
    format: {
      render(ticketInfo, text, { assets = null } = {}) {
        return { body: text, meta: metaFor(ticketInfo, text, { assets }), spilled: false };
      },
      parse(tk) {
        const content = String(tk.body ?? '');
        if (!tk.meta) return { meta: null, content: `${/^#\s/m.test(content) ? '' : `# ${tk.key}: ${tk.title}\n\n`}${content.trimEnd()}\n`, legacy: true, spilled: null, edited: false };
        return { meta: tk.meta, content, legacy: false, spilled: null, edited: false };
      },
    },
    board: {
      lanes: () => LANES.map((lane) => ({ lane, name: lanes()[lane], id: stateOf(lane)?.id ?? null })),
      lane: (id) => laneOfState(get(id)?.raw?.state),
      item: (issue) => ({ id: idOf(issue), column: laneOfState(get(issue)?.raw?.state) }),
      move,
      moveItem: (itemId, lane) => move(itemId, lane),
      archiveItem: (itemId) => gql('mutation($id: String!) { issueArchive(id: $id) { success } }', { id: get(itemId)?.raw?.id }),
      items,
      fields: {
        get: () => ({}),
        set: () => [],
        ensure: ({ log = () => {} } = {}) => {
          log('Linear has no custom fields: the triage values stay in the ticket\'s triage section');
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
          changed.push({ number: c.id, add: want, remove: c.assignees });
        }
        return changed;
      },
    },
  };
}

