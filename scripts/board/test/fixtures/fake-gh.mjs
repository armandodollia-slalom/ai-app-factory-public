#!/usr/bin/env node
// A fake `gh` for the board tests: serves the calls the board stage makes from a JSON file
// (FAKE_GH_STATE) and records every call in it. Issues: { number: { title, state, labels, assignees,
// parent, item, column, body, comments: [{ id, body, author, createdAt }] } }; the project's Status
// options are `options`.
import fs from 'node:fs';

const file = process.env.FAKE_GH_STATE;
const state = JSON.parse(fs.readFileSync(file, 'utf8'));
const args = process.argv.slice(2);
const stdin = () => {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
};
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const out = (v) => process.stdout.write(typeof v === 'string' ? v : JSON.stringify(v));
const save = () => fs.writeFileSync(file, JSON.stringify(state, null, 2));
const repo = state.repo;
const issue = (n) => state.issues[String(n)];
const url = (n) => `https://github.com/${repo}/issues/${n}`;
state.calls = [...(state.calls ?? []), args.filter((a) => !a.startsWith('query=')).join(' ')];

function graphql() {
  const fields = {};
  for (let i = 0; i < args.length; i++) if (args[i] === '-f' || args[i] === '-F') {
    const [k, ...v] = args[i + 1].split('=');
    fields[k] = v.join('=');
  }
  const q = fields.query;
  if (q.includes('projectItems(first:50)')) {
    const it = issue(fields.number);
    return { repository: { issue: { projectItems: { nodes: it.item ? [{ id: it.item, project: { id: 'P' }, fieldValueByName: it.column ? { name: it.column } : null }] : [] } } } };
  }
  if (q.includes('parent{number url}')) {
    const it = issue(fields.number);
    return { repository: { issue: { parent: it.parent ? { number: it.parent, url: url(it.parent) } : null } } };
  }
  if (q.includes('items(first:100')) {
    const nodes = Object.entries(state.issues)
      .filter(([, it]) => it.item)
      .map(([n, it]) => ({ id: it.item, fieldValueByName: it.column ? { name: it.column } : null, content: { number: Number(n), title: it.title, url: url(n), state: it.state ?? 'OPEN', repository: { nameWithOwner: it.repo ?? repo }, assignees: { nodes: (it.assignees ?? []).map((login) => ({ login })) }, labels: { nodes: (it.labels ?? []).map((name) => ({ name })) }, parent: it.parent ? { number: it.parent } : null } }));
    return { user: { projectV2: { items: { pageInfo: { hasNextPage: false, endCursor: null }, nodes } } } };
  }
  if (q.includes('projectV2(number:$number){id url title field')) {
    return { user: { projectV2: { id: 'P', url: 'https://github.com/users/acme/projects/1', title: 'Board', field: { id: 'F', options: Object.entries(state.options).map(([name, id]) => ({ id, name })) } } } };
  }
  if (q.includes('repositories(first:100)')) return { user: { projectV2: { repositories: { nodes: (state.linked ?? []).map((nameWithOwner) => ({ nameWithOwner })) } } } };
  if (q.includes('views(first:50)')) return { user: { projectV2: { views: { nodes: state.views ?? [] }, fields: { nodes: [] } } } };
  if (q.includes('updateProjectV2Field') || q.includes('deleteProjectV2View') || q.includes('updateProjectV2View')) {
    state.mutations = [...(state.mutations ?? []), q.slice(0, 60)];
    return {};
  }
  throw new Error(`fake gh: unhandled query ${q.slice(0, 120)}`);
}

function main() {
  const [a, b] = args;
  if (a === 'api' && b === 'user') return out(`${state.login}\n`);
  if (a === 'api' && b === 'graphql') return out({ data: graphql() });
  if (a === 'api' && opt('-X') === 'PATCH') {
    const id = Number(args.find((x) => x.startsWith('repos/')).split('/').pop());
    const { body } = JSON.parse(stdin());
    for (const it of Object.values(state.issues)) for (const c of it.comments ?? []) if (c.id === id) c.body = body;
    return out('{}');
  }
  if (a === 'issue' && b === 'list') {
    const key = (opt('--search') ?? '').split(' ')[0];
    return out(Object.entries(state.issues).filter(([, it]) => it.title.startsWith(`${key}:`)).map(([n, it]) => ({ number: Number(n), title: it.title, url: url(n) })));
  }
  if (a === 'issue' && b === 'view') {
    const it = issue(args[2]);
    const comments = () => (it.comments ?? []).map((c) => ({ id: `IC_${c.id}`, url: `${url(args[2])}#issuecomment-${c.id}`, body: c.body, author: { login: c.author ?? state.login }, createdAt: c.createdAt ?? null }));
    if (opt('--json') === 'comments') return out({ comments: comments() });
    const fields = (opt('--json') ?? 'body').split(',');
    const all = { number: Number(args[2]), title: it.title, body: it.body ?? '', labels: (it.labels ?? []).map((name) => ({ name })), comments: comments(), state: it.state ?? 'OPEN', url: url(args[2]), updatedAt: it.updatedAt ?? null };
    return out(Object.fromEntries(fields.map((f) => [f, all[f]])));
  }
  if (a === 'issue' && b === 'comment') {
    const it = issue(args[2]);
    const id = (state.nextComment = (state.nextComment ?? 1000) + 1);
    it.comments = [...(it.comments ?? []), { id, body: stdin() }];
    return out(`${url(args[2])}#issuecomment-${id}\n`);
  }
  if (a === 'issue' && b === 'edit') {
    const it = issue(args[2]);
    if (opt('--add-label')) {
      if (state.knownLabels && !state.knownLabels.includes(opt('--add-label'))) throw new Error(`could not add label: '${opt('--add-label')}' not found`);
      it.labels = [...new Set([...(it.labels ?? []), opt('--add-label')])];
    }
    if (opt('--remove-label')) it.labels = (it.labels ?? []).filter((l) => l !== opt('--remove-label'));
    if (args.includes('--body-file')) it.body = stdin();
    return out('');
  }
  if (a === 'project' && b === 'item-edit') {
    const name = Object.entries(state.options).find(([, id]) => id === opt('--single-select-option-id'))?.[0];
    const it = Object.values(state.issues).find((x) => x.item === opt('--id'));
    it.column = name;
    return out('');
  }
  if (a === 'label' && b === 'create') {
    if (state.knownLabels) state.knownLabels.push(args[2]);
    return out('');
  }
  if (a === 'pr' && b === 'list') return out(JSON.stringify((state.prs ?? []).filter((pr) => !opt('--head') || pr.head === opt('--head'))));
  // A PR's commits through the code host adapter (`gh api repos/<repo>/pulls/<n>/commits --paginate --jq '.[]'`).
  if (a === 'api' && /^repos\/[^/]+\/[^/]+\/pulls\/\d+\/commits$/.test(b)) {
    const pr = (state.prs ?? []).find((x) => String(x.number) === b.split('/')[4]);
    return out((pr?.commits ?? []).map((c) => JSON.stringify({ sha: c.oid ?? c.sha, author: c.authors?.[0] ?? null, commit: { message: c.messageHeadline ?? '' } })).join('\n'));
  }
  if (a === 'repo' && b === 'edit') {
    state.writes = [...(state.writes ?? []), 'repo edit'];
    return out('');
  }
  if (a === 'repo' && b === 'view') return out({ hasIssuesEnabled: state.issuesEnabled ?? false });
  if (a === 'label' && b === 'list') return out((state.knownLabels ?? []).map((name) => ({ name, color: 'ededed', description: '' })));
  if (a === 'project' && b === 'link') {
    state.linked = [...(state.linked ?? []), opt('--repo')];
    return out('');
  }
  if (a === 'api' && opt('-X') === 'POST' && args.some((x) => /projectsV2\/\d+\/views/.test(x))) {
    state.mutations = [...(state.mutations ?? []), 'create view'];
    return out('{}');
  }
  throw new Error(`fake gh: unhandled ${args.join(' ')}`);
}

try {
  main();
  save();
} catch (error) {
  save();
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
}
