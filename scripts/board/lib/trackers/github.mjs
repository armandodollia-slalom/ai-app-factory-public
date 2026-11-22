// GitHub as the ticket tracker: issues (tickets), sub-issues (epic -> stories), a Projects v2 board (the
// Status field holds the lanes, single-select and number fields hold the triage values), labels, the
// `board-assets` branch for attachments and the hidden `board-ticket:v1` metadata block in the body.
//
// This is the board stage's GitHub code moved behind the tracker interface; it makes the same `gh` calls
// as before. Every call goes through an injectable runner `gh(args, { input, binary })` ->
// { status, stdout, stderr } (default: the gh CLI, which owns authentication), so the tests use an
// in-memory GitHub. Methods are synchronous; they can be awaited.
import { git } from '../../../pipeline/lib/git.mjs';
import { boardDisabled } from '../../../pipeline/lib/run-tags.mjs';
import { readJson, run, writeJson } from '../../../pipeline/lib/util.mjs';
import path from 'node:path';
import { buildAssetsCommit, downloadAssets, exec, pushAssetsBranch, readAsset } from '../assets.mjs';
import { blobUrl, parseBody, renderBody, sha256 } from '../ticket-format.mjs';
import { FIELD_DEFAULTS, LANES, LEVELS, NUMBER_FIELDS, SELECT_FIELDS, STORY_KEY, UnsupportedError, boardItem, fieldNames, laneNames, ticket as normalise } from './shared.mjs';

// The one place the board runs the gh CLI: `ghExec` (binary-safe, no timeout) and `defaultGh`.
export const ghExec = (args, opts = {}) => exec('gh', args, opts);
export const defaultGh = (args, { input, binary = false, cwd, env } = {}) => (binary ? exec('gh', args, { input, binary, cwd, env }) : run('gh', args, { input, cwd, env, timeoutSec: 120 }));

// Earlier names of a column: `setup` renames them in place and keeps their cards.
const FORMER_NAMES = { ready: ['Todo'] };
// Removed columns: `setup` deletes them and moves their cards to the given column.
const RETIRED = {};

const memo = { project: null, active: null, available: null };
export const resetGithubMemo = () => {
  memo.project = null;
  memo.active = null;
  memo.available = null;
};

const originMatches = (root, repo, runner = exec) => {
  const url = runner('git', ['remote', 'get-url', 'origin'], { cwd: root }).stdout.trim().replace(/\.git$/, '').toLowerCase();
  const r = String(repo).toLowerCase();
  return url.endsWith(`/${r}`) || url.endsWith(`:${r}`);
};

// What GitHub Issues and Projects can do for the harness (providers/contracts.mjs CAPABILITIES.tracker).
export const CAPABILITIES = { boardLanes: true, customFields: true, parentChild: true, attachments: 'partial', commentEdit: true, bodyHistory: true, archive: true, labels: true, assignees: true };

export function githubTracker(config, { gh = defaultGh } = {}) {
  const board = () => config.board ?? {};
  const boardRepo = () => board().repo ?? config.tickets?.repo;
  const ticketsRepo = () => config.tickets?.repo ?? board().repo;
  const lanes = () => laneNames(config);

  const ok = (args, opts) => {
    const r = gh(args, opts);
    if (r.status !== 0) throw new Error(`gh ${args.slice(0, 2).join(' ')} failed: ${String(r.stderr ?? '').trim().slice(0, 600)}`);
    return String(r.stdout);
  };
  const okJson = (args, opts) => {
    const out = ok(args, opts).trim();
    return out ? JSON.parse(out) : null;
  };
  function graphql(query, variables = {}) {
    const args = ['api', 'graphql', '-f', `query=${query}`];
    for (const [key, value] of Object.entries(variables)) {
      if (value === null || value === undefined) continue;
      args.push(typeof value === 'number' ? '-F' : '-f', `${key}=${value}`);
    }
    return okJson(args).data;
  }
  // One asset through the contents API (the fallback when git cannot read it).
  const apiAsset = (assetPath, commit) => gh(['api', '-H', 'Accept: application/vnd.github.raw', `repos/${ticketsRepo()}/contents/${assetPath.split('/').map(encodeURIComponent).join('/')}?ref=${commit}`], { binary: true });
  const columnKey = (name) => LANES.find((c) => lanes()[c] === name) ?? null;

  // ------------------------------------------------------------------ board: project and items
  function project() {
    if (memo.project) return memo.project;
    const { owner, ownerType, projectNumber, statusField } = board();
    const data = graphql(
      `query($owner:String!,$number:Int!,$field:String!){${ownerType}(login:$owner){projectV2(number:$number){id url title field(name:$field){... on ProjectV2SingleSelectField{id options{id name}}}}}}`,
      { owner, number: projectNumber, field: statusField },
    );
    const p = data[ownerType].projectV2;
    if (!p?.field?.id) throw new Error(`project ${projectNumber} has no single-select "${statusField}" field; run \`board setup\``);
    memo.project = { id: p.id, url: p.url, title: p.title, fieldId: p.field.id, options: Object.fromEntries(p.field.options.map((o) => [o.name, o.id])) };
    return memo.project;
  }

  // The issue's item on our project (added if missing) and its current column.
  // `add: false`: a read only (null when the issue has no card), as a check of the board must be.
  function issueItem(issue, { add = true } = {}) {
    const p = project();
    const [owner, name] = boardRepo().split('/');
    const data = graphql(
      `query($owner:String!,$name:String!,$number:Int!,$field:String!){repository(owner:$owner,name:$name){issue(number:$number){projectItems(first:50){nodes{id project{id} fieldValueByName(name:$field){... on ProjectV2ItemFieldSingleSelectValue{name}}}}}}}`,
      { owner, name, number: issue.number, field: board().statusField },
    );
    const item = data.repository.issue.projectItems.nodes.find((n) => n.project.id === p.id);
    if (item) return { id: item.id, column: columnKey(item.fieldValueByName?.name) };
    if (!add) return null;
    const added = okJson(['project', 'item-add', String(board().projectNumber), '--owner', board().owner, '--url', issue.url, '--format', 'json']);
    return { id: added.id, column: null };
  }

  function moveItem(itemId, lane) {
    const p = project();
    const name = lanes()[lane];
    const optionId = p.options[name];
    if (!optionId) throw new Error(`the ${board().statusField} field has no "${name}" option; run \`board setup\``);
    ok(['project', 'item-edit', '--id', itemId, '--project-id', p.id, '--field-id', p.fieldId, '--single-select-option-id', optionId]);
  }

  function items() {
    const { owner, ownerType, projectNumber, statusField } = board();
    const severityField = board().fields?.severity ?? 'Severity';
    const out = [];
    let after = null;
    for (;;) {
      const data = graphql(
        `query($owner:String!,$number:Int!,$field:String!,$severity:String!,$after:String){${ownerType}(login:$owner){projectV2(number:$number){items(first:100,after:$after){pageInfo{hasNextPage endCursor}nodes{id fieldValueByName(name:$field){... on ProjectV2ItemFieldSingleSelectValue{name}}severity:fieldValueByName(name:$severity){... on ProjectV2ItemFieldSingleSelectValue{name}}content{... on Issue{number title url state stateReason repository{nameWithOwner}assignees(first:20){nodes{login}}labels(first:30){nodes{name}}parent{number}}}}}}}}`,
        { owner, number: projectNumber, field: statusField, severity: severityField, after },
      );
      const page = data[ownerType].projectV2.items;
      for (const n of page.nodes) {
        if (!n.content?.number) continue;
        const c = n.content;
        const labels = c.labels.nodes.map((l) => l.name);
        const t = normalise({ id: c.number, key: STORY_KEY.exec(c.title ?? '')?.[1] ?? null, type: typeFromLabels(labels, c.title), title: c.title, state: c.state === 'CLOSED' ? 'closed' : 'open', stateReason: c.stateReason ?? null, labels, assignees: c.assignees.nodes.map((a) => a.login), parent: c.parent?.number ?? null, url: c.url, raw: n });
        const lane = columnKey(n.fieldValueByName?.name);
        out.push(boardItem(config, t, { itemId: n.id, lane, status: n.fieldValueByName?.name ?? null, repo: c.repository.nameWithOwner, fields: { severity: n.severity?.name ?? null } }));
      }
      if (!page.pageInfo.hasNextPage) return out;
      after = page.pageInfo.endCursor;
    }
  }

  const typeFromLabels = (labels, title) => {
    const b = board();
    if (labels.includes(b.epicLabel ?? 'epic')) return 'epic';
    if (labels.includes(b.spikeLabel ?? 'spike')) return 'spike';
    if (labels.includes('bug') || /^BUG-\d+:/.test(title ?? '')) return 'bug';
    return 'story';
  };

  // ------------------------------------------------------------------ tickets
  const cacheFile = () => path.join(config.root, config.stateDir ?? '.factory/state', 'board.json');
  // The issue of a story key (from its title), remembered in .factory/state/board.json.
  function findIssue(key) {
    const cache = { issues: {}, epics: {}, ...readJson(cacheFile(), {}) };
    if (cache.issues[key]) return cache.issues[key];
    const found = okJson(['issue', 'list', '-R', boardRepo(), '--label', board().storyLabel, '--state', 'all', '--search', `${key} in:title`, '--json', 'number,title,url', '--limit', '50']);
    const issue = (found ?? []).find((i) => STORY_KEY.exec(i.title ?? '')?.[1] === key);
    if (!issue) return null;
    cache.issues[key] = { number: issue.number, url: issue.url };
    writeJson(cacheFile(), cache);
    return cache.issues[key];
  }

  const fromIssue = (i) => {
    const labels = (i.labels ?? []).map((l) => l.name ?? l);
    let meta = null;
    if (i.body != null) {
      try {
        meta = parseBody(i.body).meta;
      } catch {
        meta = null;
      }
    }
    return normalise({
      id: i.number,
      key: STORY_KEY.exec(i.title ?? '')?.[1] ?? meta?.key ?? null,
      type: meta?.type ?? typeFromLabels(labels, i.title),
      title: i.title,
      body: i.body ?? null,
      state: String(i.state ?? 'OPEN').toUpperCase() === 'CLOSED' ? 'closed' : 'open',
      stateReason: i.stateReason ?? null,
      labels,
      assignees: (i.assignees ?? []).map((a) => a.login ?? a),
      parent: meta?.parent ?? null,
      blockedBy: meta?.blockedBy ?? [],
      url: i.url,
      updatedAt: i.updatedAt ?? null,
      meta,
      raw: i,
    });
  };

  // Every issue of the ticket repository: no bodies (the board's index; source.mjs issueIndex).
  function list({ state = 'all', label = null, type = null, updatedSince = null } = {}) {
    const rows = okJson(['issue', 'list', '-R', ticketsRepo(), '--state', state, '--limit', '1000', '--json', 'number,title,labels,state,updatedAt,url', ...(label ? ['--label', label] : [])]) ?? [];
    return rows.map(fromIssue).filter((t) => (!type || t.type === type) && (!updatedSince || String(t.updatedAt) >= updatedSince));
  }

  function view(number, fields = 'number,title,body,labels,state,stateReason,updatedAt,url') {
    const i = okJson(['issue', 'view', String(number), '-R', ticketsRepo(), '--json', fields]);
    return i ? fromIssue({ number: Number(number), ...i }) : null;
  }

  function get(keyOrId) {
    if (/^#?\d+$/.test(String(keyOrId))) return view(String(keyOrId).replace(/^#/, ''));
    const found = findIssue(keyOrId);
    return found ? view(found.number) : null;
  }

  // Open (or `state`) issues whose title holds `text` (GitHub's title search; the caller compares titles exactly).
  function search({ text, state = 'open' } = {}) {
    return (okJson(['issue', 'list', '-R', boardRepo(), '--state', state, '--search', `"${String(text).replace(/"/g, '')}" in:title`, '--json', 'number,title,url']) ?? []).map((i) => normalise({ id: i.number, title: i.title, url: i.url }));
  }

  function create({ title, body, labels = [], parent = null, addToBoard = true }) {
    const url = ok(['issue', 'create', '-R', ticketsRepo(), '--title', title, '--body-file', '-', ...labels.flatMap((l) => ['--label', l])], { input: body }).trim();
    const number = Number(url.split('/').pop());
    if (!number) throw new Error(`gh issue create failed for "${title}"`);
    let boardError = null;
    if (addToBoard && board().projectNumber) {
      const added = gh(['project', 'item-add', String(board().projectNumber), '--owner', board().owner, '--url', url]);
      if (added.status !== 0) boardError = String(added.stderr).trim().split('\n')[0];
    }
    if (parent) setParent(number, parent);
    return { ...normalise({ id: number, title, body, labels, url, parent }), boardError };
  }

  // { title, body, labels: [..] | { add, remove }, state: open|closed, assignees: [..] | { add, remove } }
  function update(id, { title, body, labels, state, assignees, fields } = {}) {
    const n = String(id);
    const edits = [];
    if (body != null) edits.push('--body-file', '-');
    if (title != null) edits.push('--title', title);
    if (labels != null) {
      const add = Array.isArray(labels) ? labels : labels.add ?? [];
      const remove = Array.isArray(labels) ? [] : labels.remove ?? [];
      if (add.length) edits.push('--add-label', add.join(','));
      if (remove.length) edits.push('--remove-label', remove.join(','));
    }
    if (assignees != null && !Array.isArray(assignees)) {
      if (assignees.add?.length) edits.push('--add-assignee', assignees.add.join(','));
      if (assignees.remove?.length) edits.push('--remove-assignee', assignees.remove.join(','));
    }
    if (edits.length) ok(['issue', 'edit', n, '-R', ticketsRepo(), ...edits], body != null ? { input: body } : undefined);
    if (state === 'closed') ok(['issue', 'close', n, '-R', ticketsRepo()]);
    if (state === 'open') ok(['issue', 'reopen', n, '-R', ticketsRepo()]);
    if (fields) setFields(id, fields);
  }

  function children(id) {
    const [owner, name] = ticketsRepo().split('/');
    const data = okJson(['api', 'graphql', '-f', `query=query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){issue(number:$number){subIssues(first:100){nodes{number title}}}}}`, '-f', `owner=${owner}`, '-f', `name=${name}`, '-F', `number=${id}`]);
    return data.data.repository.issue.subIssues.nodes.map((n) => normalise({ id: n.number, title: n.title, key: STORY_KEY.exec(n.title ?? '')?.[1] ?? null }));
  }

  function parentOf(id) {
    const [owner, name] = boardRepo().split('/');
    const p = graphql(`query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){issue(number:$number){parent{number url}}}}`, { owner, name, number: Number(id) }).repository.issue?.parent ?? null;
    return p ? { id: p.number, number: p.number, url: p.url } : null;
  }

  // Makes `child` a sub-issue of `parent`; false when it already is.
  function setParent(child, parent) {
    const [owner, name] = ticketsRepo().split('/');
    const q = (n) => okJson(['api', 'graphql', '-f', 'query=query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){issue(number:$number){id parent{number}}}}', '-f', `owner=${owner}`, '-f', `name=${name}`, '-F', `number=${n}`]).data.repository.issue;
    const c = q(child);
    if (c.parent?.number === Number(parent)) return false;
    const p = q(parent);
    ok(['api', 'graphql', '-f', 'query=mutation($p:ID!,$c:ID!){addSubIssue(input:{issueId:$p,subIssueId:$c,replaceParent:true}){issue{id}}}', '-f', `p=${p.id}`, '-f', `c=${c.id}`]);
    return true;
  }

  const commentId = (c) => c.databaseId ?? (Number(/issuecomment-(\d+)/.exec(c.url ?? '')?.[1] ?? String(c.id ?? '').replace(/\D/g, '')) || null);
  function comments(id) {
    const list = okJson(['issue', 'view', String(id), '-R', boardRepo(), '--json', 'comments'])?.comments ?? [];
    return list.map((c) => ({ id: commentId(c), author: c.author?.login ?? c.author ?? null, body: c.body ?? '', createdAt: c.createdAt ?? null, url: c.url ?? null }));
  }
  function editComment(id, commentIdValue, body) {
    ok(['api', '-X', 'PATCH', `repos/${boardRepo()}/issues/comments/${commentIdValue}`, '--input', '-'], { input: JSON.stringify({ body }) });
  }
  // Posts a comment, or edits the one that carries `marker` (a substring, usually a hidden marker).
  // Returns { id, url, created }.
  function comment(id, body, { marker = null } = {}) {
    if (marker) {
      const existing = comments(id).find((c) => (marker instanceof RegExp ? marker.test(c.body) : c.body.includes(marker)));
      if (existing?.id) {
        editComment(id, existing.id, body);
        return { id: existing.id, url: existing.url, created: false };
      }
    }
    const url = ok(['issue', 'comment', String(id), '-R', boardRepo(), '--body-file', '-'], { input: body }).trim();
    return { id: Number(/issuecomment-(\d+)/.exec(url)?.[1]) || null, url, created: true };
  }

  // Attachments live on the board-assets branch; the issue's manifest (body metadata) lists them.
  function attachments(id) {
    const t = view(id);
    const assets = t?.meta?.assets;
    return (assets?.files ?? []).map((f) => ({ ...f, url: blobUrl(assets.repo, assets.commit, f.path), commit: assets.commit }));
  }
  function download(attachment, dest, { runner = exec } = {}) {
    const data = readAsset(config, attachment.commit, attachment.path, { run: runner, fallback: apiAsset });
    if (attachment.sha256 && sha256(data) !== attachment.sha256) throw new Error(`attachment ${attachment.path} does not match its sha256`);
    return data;
  }
  // Commits a file to the assets branch (files/<key>/<name>) and pushes it. The caller adds it to the
  // ticket's manifest when it re-renders the body.
  function attach(id, { name, data, key = String(id) }, { runner = exec } = {}) {
    const assetPath = `files/${key}/${name}`;
    const built = buildAssetsCommit(config, [{ path: assetPath, data }], { message: `Attachment for ${key}`, run: runner });
    if (built.changed) pushAssetsBranch(config, { run: runner });
    return { name, path: assetPath, commit: built.commit, sha256: sha256(data), size: data.length, url: blobUrl(ticketsRepo(), built.commit, assetPath) };
  }

  function history(id) {
    const [owner, name] = ticketsRepo().split('/');
    const data = okJson(['api', 'graphql', '-f', `query=query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){issue(number:$number){userContentEdits(first:50){nodes{diff}}}}}`, '-f', `owner=${owner}`, '-f', `name=${name}`, '-F', `number=${id}`]);
    return data.data.repository.issue.userContentEdits.nodes.map((n) => n.diff);
  }

  // A pull request on any code host: GitHub itself links a PR whose body says `Closes #N`; for one on
  // another product, a comment carries the link.
  function link(id, { pr, url, title }) {
    const href = url ?? pr;
    return comment(id, `Linked pull request: [${title ?? href}](${href})\n\n<!-- pipeline-link:${JSON.stringify({ url: href })} -->`, { marker: `<!-- pipeline-link:${JSON.stringify({ url: href })} -->` });
  }

  function ensureLabel(name, { color = 'ededed', description = '' } = {}) {
    ok(['label', 'create', name, '-R', ticketsRepo(), '--color', color, '--description', description, '--force']);
  }

  // ------------------------------------------------------------------ triage fields (review gate)
  function projectFields() {
    const { owner, ownerType, projectNumber } = board();
    const p = graphql(
      `query($owner:String!,$number:Int!){${ownerType}(login:$owner){projectV2(number:$number){id fields(first:50){nodes{... on ProjectV2FieldCommon{id name dataType} ... on ProjectV2SingleSelectField{options{id name}}}}}}}`,
      { owner, number: projectNumber },
    )[ownerType].projectV2;
    const fields = {};
    for (const f of p.fields.nodes) if (f?.name) fields[f.name] = { id: f.id, dataType: f.dataType, options: Object.fromEntries((f.options ?? []).map((o) => [o.name, o.id])) };
    return { projectId: p.id, fields };
  }

  function itemIdFor({ number, url }) {
    const [owner, name] = boardRepo().split('/');
    const p = projectFields();
    const data = graphql('query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){issue(number:$number){projectItems(first:50){nodes{id project{id}}}}}}', { owner, name, number });
    const item = data.repository.issue.projectItems.nodes.find((n) => n.project.id === p.projectId);
    if (item) return { itemId: item.id, project: p };
    const added = okJson(['project', 'item-add', String(board().projectNumber), '--owner', board().owner, '--url', url, '--format', 'json']);
    return { itemId: added.id, project: p };
  }

  // Writes triage values ({ impact, ..., reopens }; null clears) to the ticket's card. Fields the
  // project does not have are skipped. Returns the names written.
  function setFields(issue, values) {
    const target = typeof issue === 'object' ? issue : { number: Number(issue), url: `https://github.com/${boardRepo()}/issues/${issue}` };
    const names = fieldNames(config);
    const { itemId, project: p } = itemIdFor(target);
    const written = [];
    for (const [k, v] of Object.entries(values)) {
      const f = p.fields[names[k]];
      if (!f || v === undefined) continue;
      const base = ['project', 'item-edit', '--id', itemId, '--project-id', p.projectId, '--field-id', f.id];
      if (v === null) ok([...base, '--clear']);
      else if (SELECT_FIELDS.includes(k)) {
        if (!f.options[v]) continue;
        ok([...base, '--single-select-option-id', f.options[v]]);
      } else ok([...base, '--number', String(v)]);
      written.push(names[k]);
    }
    return written;
  }

  function getFields(id) {
    const names = fieldNames(config);
    const it = items().find((i) => String(i.number) === String(id));
    if (!it) return {};
    // Projects v2 values other than Severity are read per item.
    const node = graphql(
      'query($id:ID!){node(id:$id){... on ProjectV2Item{fieldValues(first:50){nodes{... on ProjectV2ItemFieldSingleSelectValue{name field{... on ProjectV2FieldCommon{name}}} ... on ProjectV2ItemFieldNumberValue{number field{... on ProjectV2FieldCommon{name}}}}}}}}',
      { id: it.itemId },
    ).node;
    const out = {};
    for (const v of node?.fieldValues?.nodes ?? []) {
      const key = Object.keys(names).find((k) => names[k] === v.field?.name);
      if (key) out[key] = v.name ?? v.number ?? null;
    }
    return out;
  }

  // Creates the missing triage fields (idempotent). Returns the names created.
  function ensureFields({ log = () => {}, dryRun = false } = {}) {
    const names = fieldNames(config);
    const { fields } = projectFields();
    const created = [];
    for (const k of [...SELECT_FIELDS, ...NUMBER_FIELDS]) {
      const name = names[k];
      const have = fields[name];
      if (have) {
        if (SELECT_FIELDS.includes(k) && LEVELS.some((l) => !have.options[l])) log(`field "${name}" exists without every option (${LEVELS.join(', ')}); add the missing ones in the project settings`);
        continue;
      }
      const args = ['project', 'field-create', String(board().projectNumber), '--owner', board().owner, '--name', name];
      args.push(...(SELECT_FIELDS.includes(k) ? ['--data-type', 'SINGLE_SELECT', '--single-select-options', LEVELS.join(',')] : ['--data-type', 'NUMBER']));
      if (dryRun) log(`would create the project field "${name}" (it is missing; existing fields are never changed)`);
      else ok(args);
      created.push(name);
    }
    log(created.length ? `triage fields ${dryRun ? 'that would be created' : 'created'}: ${created.join(', ')}` : 'triage fields ready');
    return created;
  }

  // ------------------------------------------------------------------ setup
  const LABELS = () => {
    const b = board();
    return [
      [b.storyLabel, '5319e7', 'A product story run through the AI pipeline'],
      [b.blockedLabel, 'b60205', 'The pipeline could not finish this story; a human needs to look'],
      [b.resolvedLabel ?? 'escalation-resolved', '0e8a16', 'A human answered the escalation questions; board sync re-queues the ticket'],
      ['frontend', '1d76db', 'Visible UI work (WebApp)'],
      ['backend', '0e8a16', 'API and service work'],
      [b.epicLabel, '3e4b9e', 'A group of stories; its stories are its sub-issues'],
      [b.spikeLabel ?? 'spike', 'c5def5', 'A research spike: findings that feed an epic'],
    ];
  };
  const COLUMN_STYLE = {
    backlog: ['GRAY', 'Not ready for implementation'],
    ready: ['PURPLE', 'Ready for implementation; start it with `pipeline implement run <KEY>` or `--epic <EPIC>`'],
    inProgress: ['YELLOW', 'The pipeline is implementing the story (or fixing a bug feature verification found)'],
    testing: ['ORANGE', 'The review approved the code; feature verification is writing and verifying the automated tests'],
    review: ['BLUE', 'Implemented and verified; the PR is waiting for a human review'],
    failed: ['RED', 'The pipeline could not finish the story; answer the questions in the latest comment and tick Resolved to re-queue it'],
    done: ['GREEN', 'Merged'],
  };

  function ensureColumns(log) {
    const p = project();
    const wanted = LANES.map((c) => lanes()[c]);
    if (wanted.every((name) => p.options[name]) && !Object.keys(RETIRED).some((name) => p.options[name])) return log('columns ready');
    const singleSelectOptions = LANES.map((c) => ({ name: lanes()[c], color: COLUMN_STYLE[c][0], description: COLUMN_STYLE[c][1] }));
    const renamed = new Map();
    for (const c of LANES) for (const old of FORMER_NAMES[c] ?? []) if (p.options[old] && !p.options[lanes()[c]]) renamed.set(old, c);
    for (const [old, c] of Object.entries(RETIRED)) if (p.options[old]) renamed.set(old, c);
    const restore = items()
      .map((i) => ({ itemId: i.itemId, column: i.column ?? renamed.get(i.status) }))
      .filter((i) => i.column);
    const extras = Object.keys(p.options).filter((name) => !wanted.includes(name) && !renamed.has(name));
    for (const name of extras) singleSelectOptions.push({ name, color: 'GRAY', description: '' });
    const input = JSON.stringify({
      query: 'mutation($input:UpdateProjectV2FieldInput!){updateProjectV2Field(input:$input){projectV2Field{... on ProjectV2SingleSelectField{id}}}}',
      variables: { input: { fieldId: p.fieldId, singleSelectOptions } },
    });
    ok(['api', 'graphql', '--input', '-'], { input });
    resetGithubMemo();
    for (const i of restore) moveItem(i.itemId, i.column);
    log(`columns set: ${wanted.join(' | ')}; ${restore.length} card(s) kept in their columns`);
  }

  const VIEWS = (f) => [
    { name: 'Epics', layout: 'board', filter: `label:${board().epicLabel}`, vertical_group_by: [f.status] },
    { name: 'Stories by epic', layout: 'board', filter: `-label:${board().epicLabel}`, group_by: [f.parent], vertical_group_by: [f.status] },
    { name: 'Stories', layout: 'board', filter: `-label:${board().epicLabel}`, vertical_group_by: [f.status] },
    { name: 'All items', layout: 'table' },
  ];
  const FORMER_VIEWS = ['View 1', 'Board', 'Board by epic'];

  function ensureViews() {
    const { owner, ownerType, projectNumber, statusField } = board();
    try {
      const p = graphql(
        `query($owner:String!,$number:Int!){${ownerType}(login:$owner){projectV2(number:$number){views(first:50){nodes{id name filter}} fields(first:50){nodes{... on ProjectV2FieldCommon{databaseId name dataType}}}}}}`,
        { owner, number: projectNumber },
      )[ownerType].projectV2;
      const field = (pred) => p.fields.nodes.find(pred)?.databaseId;
      const want = VIEWS({ status: field((x) => x.name === statusField), parent: field((x) => x.dataType === 'PARENT_ISSUE') });
      const views = p.views.nodes;
      if (want.every((w, i) => views[i]?.name === w.name)) {
        for (const [i, w] of want.entries()) {
          if (w.filter && views[i].filter !== w.filter) graphql('mutation($id:ID!,$filter:String!){updateProjectV2View(input:{viewId:$id,filter:$filter}){clientMutationId}}', { id: views[i].id, filter: w.filter });
        }
        return `views ready: ${want.map((w) => w.name).join(', ')}`;
      }
      const managed = new Set([...want.map((w) => w.name), ...FORMER_VIEWS]);
      for (const w of want) ok(['api', '-X', 'POST', `${ownerType === 'user' ? 'users' : 'orgs'}/${owner}/projectsV2/${projectNumber}/views`, '--input', '-'], { input: JSON.stringify(w) });
      for (const v of views.filter((v) => managed.has(v.name))) graphql('mutation($id:ID!){deleteProjectV2View(input:{viewId:$id}){clientMutationId}}', { id: v.id });
      const others = views.filter((v) => !managed.has(v.name)).map((v) => `"${v.name}"`);
      return `views rebuilt: ${want.map((w) => w.name).join(', ')}${others.length ? `; drag Epics before ${others.join(', ')} to make it the default` : ''}`;
    } catch (error) {
      return `could not set up the views through the API (${error.message.split('\n')[0]}); add them by hand: ${'Epics (label:epic), Stories by epic (group by Parent issue), Stories'}`;
    }
  }

  // `board setup` on GitHub (unchanged behaviour): issues on, labels, the project (found or created),
  // linked to the repository, its Status columns (a new project's Todo renamed to Ready, missing columns
  // added, cards kept) and views (a shared project's columns and views are left alone), every card of
  // this repository without a lane in Backlog. `dryRun` reports the plan and writes nothing.
  // Returns { url, done: [...], manual: [...] }.
  function setup({ log = () => {}, writeProjectNumber = () => {}, dryRun = false, syncEpics = () => {} } = {}) {
    const { repo, owner, projectTitle } = board();
    const done = [];
    const manual = [];
    const say = (m) => {
      done.push(m);
      log(m);
    };
    if (!repo || !owner) throw new Error('the board has no repository: add a GitHub `origin` remote, or set board.owner and board.repo (and tickets.repo) in .factory/config.json');
    // --dry-run: every change is printed as "would ..." and none is made; reads still happen.
    const changes = [];
    const act = (what, fn) => {
      changes.push(what);
      if (dryRun) return say(`would ${what}`);
      const result = fn();
      say(`did ${what}`);
      return result;
    };

    const repoInfo = okJson(['repo', 'view', repo, '--json', 'hasIssuesEnabled']);
    if (repoInfo.hasIssuesEnabled) say(`issues already enabled on ${repo}`);
    else act(`enable issues on ${repo}`, () => ok(['repo', 'edit', repo, '--enable-issues']));
    const have = Object.fromEntries((okJson(['label', 'list', '-R', repo, '--limit', '200', '--json', 'name,color,description']) ?? []).map((l) => [l.name.toLowerCase(), l]));
    for (const [name, color, description] of LABELS()) {
      const cur = have[name.toLowerCase()];
      if (cur && cur.color.toLowerCase() === color && (cur.description ?? '') === description) continue;
      act(`${cur ? 'update' : 'create'} label "${name}" on ${repo}`, () => ok(['label', 'create', name, '-R', repo, '--color', color, '--description', description, '--force']));
    }
    say(`labels of ${repo} checked`);

    let number = board().projectNumber;
    if (!number) {
      const existing = okJson(['project', 'list', '--owner', owner, '--format', 'json', '--limit', '100']).projects.find((p) => p.title === projectTitle);
      if (existing) number = existing.number;
      else if (dryRun) {
        act(`create project "${projectTitle}" for ${owner}`, () => {});
        return { url: null, done, manual };
      } else number = act(`create project "${projectTitle}"`, () => okJson(['project', 'create', '--owner', owner, '--title', projectTitle, '--format', 'json']).number);
      config.board.projectNumber = number;
      if (!dryRun) writeProjectNumber(number);
      say(`project #${number} "${projectTitle}"${existing ? ' (existing)' : ' created'}`);
    }
    const linked = graphql(
      `query($owner:String!,$number:Int!){${board().ownerType}(login:$owner){projectV2(number:$number){repositories(first:100){nodes{nameWithOwner}}}}}`,
      { owner, number },
    )[board().ownerType].projectV2.repositories.nodes.some((r) => r.nameWithOwner.toLowerCase() === repo.toLowerCase());
    if (linked) say(`project #${number} already linked to ${repo}`);
    else act(`link project #${number} to ${repo} (adds the repository to the project's linked repositories; nothing else changes)`, () => gh(['project', 'link', String(number), '--owner', owner, '--repo', repo]).status === 0);
    resetGithubMemo();

    // A project that also holds other repositories' cards is shared: setup then changes nothing that is not
    // this repository's. Its columns and views stay as they are (rewriting the Status options resets every
    // card's status, and views are the other teams' too); missing columns are reported for a person to add.
    const all = items();
    const ours = (i) => String(i.repo).toLowerCase() === String(repo).toLowerCase();
    const others = all.filter((i) => !ours(i));
    if (others.length) {
      const p = project();
      const missing = LANES.map((c) => lanes()[c]).filter((name) => !p.options[name]);
      say(`project #${number} is shared (${others.length} card(s) of ${[...new Set(others.map((i) => i.repo))].join(', ')}): its columns, fields, options, views and other repositories' cards are left as they are`);
      if (missing.length) {
        const m = `missing columns: ${missing.join(', ')}. Add them in the project's Status field by hand (or set board.columns to the names the project uses); setup does not change a shared project's fields`;
        manual.push(m);
        log(m);
      }
    } else if (dryRun) {
      act(`make sure the Status columns are ${LANES.map((c) => lanes()[c]).join(' | ')} and the views are set (an unshared project)`, () => {});
    } else {
      ensureColumns(say);
      resetGithubMemo();
      say(ensureViews());
    }

    // Ticket issues are the source of truth: `board new` and `board migrate --apply` create them. Setup only gives
    // this repository's cards a lane.
    const mine = all.filter(ours);
    let placed = 0;
    const backlog = project().options[lanes().backlog];
    for (const item of mine.filter((i) => !i.column)) {
      if (!backlog) break;
      act(`put ${repo}#${item.number} (no column yet) in ${lanes().backlog}`, () => moveItem(item.itemId, 'backlog'));
      item.column = 'backlog';
      placed++;
    }
    say(`${mine.length} card(s) of ${repo} on the board${placed ? `, ${placed} placed in ${lanes().backlog}` : ''}`);
    syncEpics(mine, { dryRun });
    if (dryRun) say(changes.length ? `dry run: ${changes.length} change(s) above; none made. Other repositories' cards, and the project's columns, fields, options and views: untouched` : 'dry run: nothing to change');
    return { url: project().url, done, manual };
  }

  // Takes a card off the board view (archived items stay in the project's archive). Used for abandoned tickets.
  function archiveItem(itemId) {
    ok(['project', 'item-archive', String(board().projectNumber), '--owner', board().owner, '--id', itemId]);
  }

  // ------------------------------------------------------------------ the interface
  const tracker = {
    type: 'github',
    label: 'GitHub',
    capabilities: CAPABILITIES,
    // Keys come from titles (`KEY: title`); bodies hold the board-ticket block, long sources spill to the assets branch.
    traits: { keyFromTitle: true, blockBody: true, ticketNoun: 'issue' },
    // `Closes #N` in a pull request on the same GitHub repository closes the issue when the PR merges.
    prClosingKeyword: (issue, host) => (host?.type !== 'github' ? null : String(host.repo ?? '').toLowerCase() === String(boardRepo() ?? '').toLowerCase() || !String(host.repo ?? '') ? `Closes #${issue.number}` : `Closes ${boardRepo()}#${issue.number}`),
    // The board's own setup steps (`factory board guide`; the setup-board skill follows them).
    setupSteps: () => [
      'Credentials: `gh auth status`, then `gh auth refresh -s project` if the `project` scope is missing (gh owns authentication; no token variable is needed locally). In CI, `FACTORY_TOKEN` is a token with `repo` and `project` (a classic token, or a fine-grained one with Issues and Projects read/write).',
      'In .factory/config.json set `board.owner`, `board.ownerType` (`user` or `organization`), `board.repo` (`owner/name`), and either `board.projectNumber` of an existing project or `board.projectTitle` for a new one. `tickets.repo` defaults to this checkout\'s GitHub origin.',
      '`factory board setup` creates the project when needed, the status columns (Backlog, Ready, In Progress, Testing, Pending Review, Failed, Done, or the names in `board.columns`), the triage fields the review gate writes, and the labels. Keep the team\'s existing names when the project already exists.',
      'A project that already holds other repositories\' cards is shared: setup links this repository, creates its labels, gives only this repository\'s cards a lane, and keeps every column, view and other card as it is. It reports missing columns instead of adding them (rewriting the Status field would reset every card\'s status).',
    ],
    cliAuth: { name: 'gh, signed in', check: () => defaultGh(['auth', 'status']).status === 0, note: 'needed for the board and for opening PRs' },
    get webUrl() {
      return board().projectNumber ? (memo.project?.url ?? `https://github.com/${ticketsRepo()}/issues`) : `https://github.com/${ticketsRepo()}/issues`;
    },
    // The board is live only when configured, not opted out and the checkout's origin is the configured
    // repository, so throwaway test repositories and forks never touch the real board.
    active() {
      if (memo.active?.root === config.root) return memo.active.value;
      let value = Boolean(board().projectNumber) && !boardDisabled();
      if (value) value = originMatches(config.root, board().repo, (cmd, args, o) => git(o.cwd, args));
      memo.active = { root: config.root, value };
      return value;
    },
    // Tickets are readable from this checkout: tickets.repo is origin and nobody switched it off.
    available({ run: runner = exec } = {}) {
      if (boardDisabled() || process.env.PIPELINE_TICKETS_OFFLINE === '1' || !config.tickets?.repo) return false;
      if (memo.available?.root === config.root) return memo.available.value;
      const value = originMatches(config.root, config.tickets.repo, runner);
      memo.available = { root: config.root, value };
      return value;
    },
    reachable() {
      const r = gh(['api', 'repos/' + ticketsRepo(), '--jq', '.full_name']);
      return r.status === 0 ? { ok: true, reason: null } : { ok: false, reason: String(r.stderr).trim().split('\n')[0] };
    },
    identity() {
      const login = ok(['api', 'user', '--jq', '.login']).trim();
      return { login, id: login };
    },
    tickets: { get, find: findIssue, view, list, search, create, update, children, parent: parentOf, setParent, comment, comments, editComment, attach, attachments, download, link, history },
    labels: { ensure: ensureLabel },
    // The body codec: the source Markdown inside the board-ticket block (ticket-format.mjs).
    format: {
      render: (t, text, opts) => renderBody(t, text, opts),
      parse: (t) => parseBody(t.body),
      // The ticket's assets live on the repository's assets branch: git first, the contents API second.
      assets: {
        download: (meta, dir, opts) => downloadAssets(config, meta, dir, { ...opts, fallback: apiAsset }),
        read: (commit, assetPath, opts = {}) => readAsset(config, commit, assetPath, { ...opts, fallback: apiAsset }),
      },
    },
    board: {
      lanes: () => LANES.map((lane) => ({ lane, name: lanes()[lane], id: memo.project?.options?.[lanes()[lane]] ?? null })),
      lane(id) {
        const issue = typeof id === 'object' ? id : { number: Number(id), url: `https://github.com/${boardRepo()}/issues/${id}` };
        return issueItem(issue, { add: false })?.column ?? null;
      },
      item: (issue) => issueItem(issue),
      move(id, lane) {
        const issue = typeof id === 'object' ? id : { number: Number(id), url: `https://github.com/${boardRepo()}/issues/${id}` };
        moveItem(issueItem(issue).id, lane);
      },
      moveItem,
      archiveItem,
      items: ({ lane = null, repoScoped = false } = {}) => items().filter((i) => (!lane || i.column === lane) && (!repoScoped || String(i.repo).toLowerCase() === String(boardRepo()).toLowerCase())),
      project,
      fields: { get: getFields, set: setFields, ensure: ensureFields, project: projectFields },
      setup,
      // Gives an epic's open children the epic's assignees (issues only; runs in GitHub Actions).
      syncAssignees(number) {
        const [owner, name] = boardRepo().split('/');
        const epic = graphql(
          `query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){issue(number:$number){labels(first:30){nodes{name}} assignees(first:20){nodes{login}} subIssues(first:100){nodes{number state assignees(first:20){nodes{login}}}}}}}`,
          { owner, name, number },
        ).repository.issue;
        if (!epic) throw new Error(`#${number} not found in ${boardRepo()}`);
        if (!epic.labels.nodes.some((l) => l.name === board().epicLabel)) return [];
        const want = epic.assignees.nodes.map((a) => a.login);
        const changed = [];
        for (const story of epic.subIssues.nodes.filter((s) => s.state === 'OPEN')) {
          const has = story.assignees.nodes.map((a) => a.login);
          const add = want.filter((l) => !has.includes(l));
          const remove = has.filter((l) => !want.includes(l));
          if (!add.length && !remove.length) continue;
          ok(['issue', 'edit', String(story.number), '-R', boardRepo(), ...(add.length ? ['--add-assignee', add.join(',')] : []), ...(remove.length ? ['--remove-assignee', remove.join(',')] : [])]);
          changed.push({ number: story.number, add, remove });
        }
        return changed;
      },
    },
    github: { gh, ok, okJson, graphql, repo: ticketsRepo, boardRepo },
  };
  return tracker;
}

export { FIELD_DEFAULTS, UnsupportedError };
