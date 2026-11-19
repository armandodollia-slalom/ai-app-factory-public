// An in-memory GitHub that answers both GitHub adapters at once (scripts/pipeline/lib/hosts/github.mjs
// for pull requests, scripts/board/lib/trackers/github.mjs for issues and the Projects v2 board), so the
// combination tests can run a whole flow on GitHub, or GitHub on one side and another product on the
// other. Inject `state.gh` as the gh runner of both. Only the gh calls those flows make are answered;
// anything else fails loudly ("fake gh: unsupported ...").
export function fakeGithubCombined(repo = 'acme/shop') {
  const state = { repo, prs: new Map(), issues: new Map(), comments: new Map(), statuses: [], merges: [], items: new Map(), calls: [], nextComment: 900, labels: new Set() };
  const LANES = ['Backlog', 'Ready', 'In Progress', 'Testing', 'Pending Review', 'Failed', 'Done'];
  const options = Object.fromEntries(LANES.map((name, i) => [name, `OPT_${i}`]));
  const ok = (v = '') => ({ status: 0, stdout: typeof v === 'string' ? v : JSON.stringify(v), stderr: '' });
  const fail = (m) => ({ status: 1, stdout: '', stderr: m });
  const flag = (args, name) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const field = (args, name) => args.find((a) => a.startsWith(`${name}=`))?.slice(name.length + 1);
  const num = (v) => Number(/\/(?:pull|issues)\/(\d+)/.exec(String(v))?.[1] ?? String(v).replace(/^#/, ''));
  const nextNumber = () => state.prs.size + state.issues.size + 1;
  const commentsOf = (n) => [...state.comments.values()].filter((c) => c.on === n);
  const commentJson = (c, base) => ({ id: `IC_${c.id}`, body: c.body, url: `${base}#issuecomment-${c.id}`, author: { login: c.author }, createdAt: c.createdAt });
  const pick = (obj, fields) => Object.fromEntries(fields.split(',').map((f) => [f, obj[f]]));

  const prJson = (p) => ({ ...p, author: { login: p.author }, labels: p.labels.map((name) => ({ name })), comments: commentsOf(p.number).map((c) => commentJson(c, p.url)), mergeable: 'MERGEABLE', isCrossRepository: false });
  const issueJson = (i) => ({ ...i, labels: i.labels.map((name) => ({ name })), assignees: i.assignees.map((login) => ({ login })), comments: commentsOf(i.number).map((c) => commentJson(c, i.url)) });

  // A review by `login` on the PR's head commit.
  state.approve = (n, login) => {
    const p = state.prs.get(n);
    p.reviews.push({ id: p.reviews.length + 1, user: { login, type: 'User' }, state: 'APPROVED', submitted_at: '2026-11-12T10:00:00Z', commit_id: p.headRefOid, body: '' });
  };

  function graphql(args) {
    const q = field(args, 'query') ?? '';
    if (q.includes('projectV2(number:$number){id url title field')) {
      return { [q.startsWith('query($owner:String!,$number:Int!,$field:String!){organization') ? 'organization' : 'user']: { projectV2: { id: 'PVT_1', url: `https://github.com/users/acme/projects/1`, title: 'board', field: { id: 'F_STATUS', options: LANES.map((name) => ({ id: options[name], name })) } } } };
    }
    if (q.includes('projectItems(first:50)')) {
      const n = Number(field(args, 'number'));
      const it = state.items.get(n);
      return { repository: { issue: { projectItems: { nodes: it ? [{ id: it.id, project: { id: 'PVT_1' }, fieldValueByName: it.status ? { name: it.status } : null }] : [] } } } };
    }
    if (q.includes('parent{number}') || q.includes('parent{number url}')) {
      const n = Number(field(args, 'number'));
      return { repository: { issue: { id: `ID_${n}`, parent: null } } };
    }
    throw new Error(`unhandled query ${q.slice(0, 90)}`);
  }

  state.gh = (args, { input } = {}) => {
    state.calls.push({ args, input });
    const [a, b] = args;
    try {
      if (a === 'api' && b === 'graphql') return ok({ data: graphql(args) });
      if (a === 'api' && b === 'user') return ok(args.includes('--jq') ? 'octocat\n' : { login: 'octocat', id: 1 });
      if (a === 'api' && flag(args, '-X') === 'PATCH') {
        const id = Number(args.find((x) => x.startsWith('repos/')).split('/').pop());
        state.comments.get(id).body = JSON.parse(input).body;
        return ok('{}');
      }
      if (a === 'api' && flag(args, '-X') === 'POST') {
        const sha = args.find((x) => x.startsWith('repos/')).split('/').pop();
        state.statuses.push({ sha, ...JSON.parse(input) });
        return ok('{}');
      }
      if (a === 'api' && /^repos\/[^/]+\/[^/]+\/pulls\/\d+\/(reviews|comments|commits)$/.test(b)) {
        const [, , , , n, what] = b.split('/');
        const p = state.prs.get(Number(n));
        return ok({ reviews: p.reviews, comments: [], commits: p.commits }[what].map((x) => JSON.stringify(x)).join('\n'));
      }
      if (a === 'pr' && b === 'create') {
        const n = nextNumber();
        const p = { number: n, url: `https://github.com/${repo}/pull/${n}`, title: flag(args, '--title'), body: flag(args, '--body') ?? '', state: 'OPEN', isDraft: args.includes('--draft'), headRefName: flag(args, '--head'), baseRefName: flag(args, '--base') ?? 'main', headRefOid: `sha${n}`, author: 'dev-bot', labels: args.flatMap((x, k) => (x === '--label' ? [args[k + 1]] : [])), createdAt: '2026-11-12T09:00:00Z', updatedAt: null, reviews: [], commits: [{ sha: `sha${n}`, author: { login: 'dev-bot' }, commit: { committer: { date: '2026-11-12T09:00:00Z' } } }], autoMerge: false };
        state.prs.set(n, p);
        return ok(`${p.url}\n`);
      }
      if (a === 'pr' && b === 'view') {
        const p = state.prs.get(num(args[2]));
        return p ? ok(pick(prJson(p), flag(args, '--json'))) : fail('no pull requests found');
      }
      if (a === 'pr' && b === 'diff') return ok(`diff --git a/app.js b/app.js\n+fix ${args[2]}\n`);
      if (a === 'pr' && b === 'list') {
        const st = flag(args, '--state') ?? 'open';
        const head = flag(args, '--head');
        const list = [...state.prs.values()].filter((p) => (!head || p.headRefName === head) && (st === 'all' || p.state.toLowerCase() === st));
        return ok(list.map((p) => pick(prJson(p), flag(args, '--json'))));
      }
      if (a === 'pr' && b === 'edit') {
        const p = state.prs.get(num(args[2]));
        if (args.includes('--body-file')) p.body = input;
        if (flag(args, '--title')) p.title = flag(args, '--title');
        for (const l of (flag(args, '--add-label') ?? '').split(',').filter(Boolean)) if (!p.labels.includes(l)) p.labels.push(l);
        for (const l of (flag(args, '--remove-label') ?? '').split(',').filter(Boolean)) p.labels = p.labels.filter((x) => x !== l);
        return ok('');
      }
      if ((a === 'pr' || a === 'issue') && b === 'comment') {
        const n = num(args[2]);
        const target = state.prs.get(n) ?? state.issues.get(n);
        const id = ++state.nextComment;
        state.comments.set(id, { id, on: n, body: input, author: 'octocat', createdAt: '2026-11-12T09:30:00Z' });
        return ok(`${target.url}#issuecomment-${id}\n`);
      }
      if (a === 'pr' && b === 'merge') {
        const p = state.prs.get(num(args[2]));
        state.merges.push({ pr: p.number, args });
        if (args.includes('--auto')) p.autoMerge = true;
        else p.state = 'MERGED';
        return ok('');
      }
      if (a === 'issue' && b === 'create') {
        const n = nextNumber();
        const labels = args.flatMap((x, k) => (x === '--label' ? [args[k + 1]] : []));
        state.issues.set(n, { number: n, title: flag(args, '--title'), body: input ?? '', labels, assignees: [], state: 'OPEN', updatedAt: '2026-11-12T08:00:00Z', url: `https://github.com/${repo}/issues/${n}` });
        return ok(`https://github.com/${repo}/issues/${n}\n`);
      }
      if (a === 'issue' && b === 'list') return ok([...state.issues.values()].map((i) => pick(issueJson(i), flag(args, '--json'))));
      if (a === 'issue' && b === 'view') {
        const i = state.issues.get(Number(args[2]));
        return i ? ok(pick(issueJson(i), flag(args, '--json'))) : fail('Could not resolve to an issue');
      }
      if (a === 'issue' && b === 'edit') {
        const i = state.issues.get(Number(args[2]));
        if (args.includes('--body-file')) i.body = input;
        for (const l of (flag(args, '--add-label') ?? '').split(',').filter(Boolean)) if (!i.labels.includes(l)) i.labels.push(l);
        return ok('');
      }
      if (a === 'label' && b === 'create') {
        state.labels.add(args[2]);
        return ok('');
      }
      if (a === 'project' && b === 'item-add') {
        const n = num(flag(args, '--url'));
        if (!state.items.has(n)) state.items.set(n, { id: `PVTI_${n}`, status: null });
        return ok({ id: state.items.get(n).id });
      }
      if (a === 'project' && b === 'item-edit') {
        const it = [...state.items.values()].find((x) => x.id === flag(args, '--id'));
        it.status = Object.entries(options).find(([, id]) => id === flag(args, '--single-select-option-id'))[0];
        return ok('');
      }
    } catch (error) {
      return fail(`fake gh: ${error.message}`);
    }
    return fail(`fake gh: unsupported ${args.join(' ')}`);
  };
  return state;
}
