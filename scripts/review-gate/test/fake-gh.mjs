// An in-memory GitHub for the review gate tests: answers the `gh` calls the gate makes (PRs, their
// checks, labels, reviewers, comments, reviews and commits; issues; the project's fields and items).
// Inject `state.gh` as the gh runner; every call is recorded in `state.calls`.
export function fakeGh(repo = 'acme/shop') {
  const state = {
    repo,
    prs: new Map(),
    issues: new Map(),
    labels: new Set(),
    fields: {},
    items: new Map(),
    calls: [],
    merges: [],
    nextComment: 1000,
  };
  const ok = (v = '') => ({ status: 0, stdout: typeof v === 'string' ? v : JSON.stringify(v), stderr: '' });
  const fail = (m) => ({ status: 1, stdout: '', stderr: m });
  const flag = (args, name) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const num = (v) => Number(/\/pull\/(\d+)/.exec(String(v))?.[1] ?? v);

  state.addPr = (n, pr = {}) => {
    state.prs.set(n, { number: n, url: `https://github.com/${repo}/pull/${n}`, state: 'OPEN', author: 'pipeline-bot', createdAt: '2026-11-01T10:00:00Z', mergedAt: null, closedAt: null, headRefName: `bugfix/x/${n}`, headRefOid: 'head1', baseRefName: 'main', additions: 10, deletions: 2, changedFiles: 1, labels: [], body: '', title: `Fix ${n}`, isDraft: false, files: [], checks: [], comments: [], reviews: [], reviewComments: [], commits: [], reviewers: [], autoMerge: false, mergeStateStatus: 'CLEAN', ...pr });
    return state.prs.get(n);
  };
  state.addIssue = (n, issue = {}) => {
    state.issues.set(n, { number: n, title: `BUG-${n}: bug`, body: '', labels: [], assignees: [], ...issue });
    return state.issues.get(n);
  };
  state.addFields = (names = ['Impact', 'Complexity', 'Fix risk', 'Severity', 'Confidence', 'Human reopens']) => {
    for (const name of names) {
      const select = !['Confidence', 'Human reopens'].includes(name);
      state.fields[name] = { id: `F_${name}`, name, dataType: select ? 'SINGLE_SELECT' : 'NUMBER', options: select ? ['Low', 'Medium', 'High', 'Severe'].map((o) => ({ id: `O_${name}_${o}`, name: o })) : undefined };
    }
  };

  function graphql(args) {
    const q = args.find((a) => a.startsWith('query='))?.slice(6) ?? '';
    if (q.includes('fields(first:50)')) return { user: { projectV2: { id: 'P1', fields: { nodes: Object.values(state.fields) } } } };
    if (q.includes('projectItems(first:50)')) {
      const n = Number(args.find((a) => a.startsWith('number='))?.slice(7));
      const it = state.items.get(n);
      return { repository: { issue: { projectItems: { nodes: it ? [{ id: it.id, project: { id: 'P1' } }] : [] } } } };
    }
    throw new Error(`fake gh: unhandled query ${q.slice(0, 80)}`);
  }

  state.gh = (args, { input, env } = {}) => {
    state.calls.push({ args, input, env });
    const [a, b] = args;
    try {
      if (a === 'api' && b === 'graphql') return ok({ data: graphql(args) });
      if (a === 'api' && flag(args, '-X') === 'PATCH') {
        const id = Number(args.find((x) => x.startsWith('repos/')).split('/').pop());
        for (const pr of state.prs.values()) for (const c of pr.comments) if (c.id === id) c.body = JSON.parse(input).body;
        return ok('{}');
      }
      if (a === 'api' && args[1] === `repos/${repo}` && args.includes('.allow_auto_merge')) return ok(String(state.allowAuto ?? true));
      // The repository reads of the code host contract (the adapter conformance suite).
      // Who the gate's gh acts as (`whoami`; `whoamiFail` breaks the read).
      if (a === 'api' && b === 'user') return state.whoamiFail ? fail('HTTP 403') : ok({ login: state.whoami ?? 'pipeline-bot', id: 1 });
      if (a === 'api' && args[1] === `repos/${repo}` && args.includes('.default_branch')) return ok('main\n');
      if (a === 'api' && args[1] === `repos/${repo}` && args.includes('.permissions')) return ok({ push: true, admin: false, maintain: false, triage: true });
      if (a === 'api' && args[1] === `repos/${repo}` && !args.includes('--jq')) return ok({ default_branch: 'main', private: false, visibility: 'public' });
      if (a === 'api' && args[1] === `repos/${repo}/rulesets`) return ok([]);
      // The PR's diff as the host gives it (`pr.diff`; a test sets it to the repository's own diff when it matters).
      if (a === 'pr' && b === 'diff') return ok(state.prs.get(num(args[2]))?.diff ?? 'diff --git a/src/a.ts b/src/a.ts\n');
      if (a === 'issue' && b === 'list') return ok([]);
      // The CI evidence the gate reads for a head (expected-ci.mjs). By default the repository has one pull-request
      // workflow, and its run for the head follows the PR's checks; a test sets state.workflows and pr.runs to say more.
      if (a === 'api') {
        const route = args.find((x) => x.startsWith('repos/')) ?? '';
        const wf = state.workflows ?? { '.github/workflows/ci.yml': 'name: ci\non: pull_request\n' };
        let m = new RegExp(`^repos/${repo}/pulls/(\\d+)$`).exec(route);
        if (m) {
          const pr = state.prs.get(Number(m[1]));
          return pr ? ok({ head: pr.headRefOid, base: pr.baseRefName }) : fail('HTTP 404');
        }
        m = new RegExp(`^repos/${repo}/pulls/(\\d+)/files`).exec(route);
        if (m) return ok((state.prs.get(Number(m[1]))?.files ?? []).join('\n'));
        if (route.startsWith(`repos/${repo}/contents/.github/workflows?`)) return ok(Object.keys(wf).join('\n'));
        m = new RegExp(`^repos/${repo}/contents/(.+)\\?ref=`).exec(route);
        if (m) return wf[m[1]] != null ? ok(Buffer.from(wf[m[1]]).toString('base64')) : fail('HTTP 404');
        m = new RegExp(`^repos/${repo}/actions/runs\\?head_sha=([^&]+)`).exec(route);
        if (m) {
          const pr = [...state.prs.values()].find((p) => p.headRefOid === m[1]);
          if (pr?.runs) return ok(pr.runs);
          const buckets = (pr?.checks ?? []).filter((c) => c.name !== 'review-quorum').map((c) => c.bucket);
          if (!pr || !buckets.length) return ok([]);
          const done = !buckets.some((x) => x === 'pending');
          const conclusion = buckets.some((x) => ['fail', 'cancel'].includes(x)) ? 'failure' : 'success';
          return ok([{ id: 1, path: Object.keys(wf)[0], name: 'ci', status: done ? 'completed' : 'in_progress', conclusion: done ? conclusion : null, event: 'pull_request' }]);
        }
      }
      if (a === 'api') {
        // (`gh pr view --json comments` gives the first 100 comments only, as GitHub's does.)
        // A list answered as `gh api --paginate` does: one page per `pageSize` rows with `--slurp` (a list of pages),
        // else one row per line (`--jq '.[]'`).
        const serve = (list) => {
          if (!args.includes('--slurp')) return ok(list.map((x) => JSON.stringify(x)).join('\n'));
          const size = state.pageSize ?? 100;
          const pages = [];
          for (let i = 0; i < list.length; i += size) pages.push(list.slice(i, i + size));
          return ok(pages.length ? pages : [[]]);
        };
        // A PR's close, reopen and merge events (the issues events API); `pr.events` lists them, `eventsFail` breaks the read.
        const ev = /issues\/(\d+)\/(events|comments|timeline)$/.exec(args.find((x) => x.startsWith('repos/')) ?? '');
        if (ev) {
          const pr = state.prs.get(Number(ev[1]));
          if (!pr || (ev[2] === 'events' && pr.eventsFail)) return fail('HTTP 502');
          if (ev[2] === 'comments') return serve(pr.comments.map((c) => ({ id: c.id, body: c.body, user: { login: c.author ?? null }, created_at: c.createdAt ?? null, html_url: `${pr.url}#issuecomment-${c.id}` })));
          return serve(ev[2] === 'events' ? pr.events ?? [] : pr.timeline ?? []);
        }
        const m = /pulls\/(\d+)\/(reviews|comments|commits)/.exec(args.find((x) => x.startsWith('repos/')) ?? '');
        if (m) {
          const pr = state.prs.get(Number(m[1]));
          return serve({ reviews: pr.reviews, comments: pr.reviewComments, commits: pr.commits }[m[2]]);
        }
      }
      if (a === 'pr' && b === 'view') {
        const pr = state.prs.get(num(args[2]));
        if (!pr) return fail('no pull request found');
        const fields = flag(args, '--json').split(',');
        const all = { ...pr, author: { login: pr.author }, labels: pr.labels.map((name) => ({ name })), files: pr.files.map((path) => ({ path })), comments: pr.comments.slice(0, 100).map((c) => ({ body: c.body, url: `${pr.url}#issuecomment-${c.id}`, author: { login: c.author ?? null } })), autoMergeRequest: pr.autoMergeRequest ?? (pr.autoMerge ? { enabledAt: '2026-11-01T10:30:00Z' } : null) };
        // `-q .field` prints the field itself, as gh does.
        const q = flag(args, '-q');
        if (q && /^\.[A-Za-z]+$/.test(q)) return ok(String(all[q.slice(1)] ?? ''));
        return ok(Object.fromEntries(fields.map((f) => [f, all[f]])));
      }
      if (a === 'pr' && b === 'checks') {
        const pr = state.prs.get(num(args[2]));
        return { status: pr.checks.some((c) => c.bucket === 'pending') ? 8 : 0, stdout: JSON.stringify(pr.checks), stderr: '' };
      }
      if (a === 'pr' && b === 'list') {
        const want = flag(args, '--label');
        const st = flag(args, '--state') ?? 'open';
        const head = flag(args, '--head');
        const words = (flag(args, '--search') ?? '').replace(/\s*in:title$/, '').replace(/^"(.*)"$/, '$1').toLowerCase();
        const limit = Number(flag(args, '--limit') ?? 30);
        const list = [...state.prs.values()].filter((p) => (!want || p.labels.includes(want)) && (!head || p.headRefName === head) && (!words || String(p.title).toLowerCase().includes(words)) && (st === 'all' || (st === 'closed' ? ['closed', 'merged'].includes(p.state.toLowerCase()) : p.state.toLowerCase() === st))).slice(0, limit);
        return ok(list.map((p) => ({ number: p.number, url: p.url, title: p.title, state: p.state, labels: p.labels.map((name) => ({ name })), headRefName: p.headRefName })));
      }
      if (a === 'pr' && b === 'edit') {
        const pr = state.prs.get(num(args[2]));
        for (const l of (flag(args, '--add-label') ?? '').split(',').filter(Boolean)) if (!pr.labels.includes(l)) pr.labels.push(l);
        for (const l of (flag(args, '--remove-label') ?? '').split(',').filter(Boolean)) pr.labels = pr.labels.filter((x) => x !== l);
        if (args.includes('--body-file')) pr.body = input;
        const reviewer = flag(args, '--add-reviewer');
        if (reviewer) {
          if (state.refuseReviewers?.includes(reviewer)) return fail(`could not request ${reviewer}`);
          pr.reviewers.push(reviewer);
        }
        return ok('');
      }
      if (a === 'pr' && b === 'comment') {
        const pr = state.prs.get(num(args[2]));
        const id = ++state.nextComment;
        pr.comments.push({ id, body: input, author: state.whoami ?? 'pipeline-bot' });
        return ok(`${pr.url}#issuecomment-${id}\n`);
      }
      if (a === 'pr' && b === 'merge') {
        const pr = state.prs.get(num(args[2]));
        if (args.includes('--disable-auto')) {
          pr.autoMerge = false;
          return ok('');
        }
        if (state.refuseMerge) return fail(state.refuseMerge);
        state.merges.push({ pr: pr.number, args, token: env?.GH_TOKEN ?? null });
        if (args.includes('--auto')) {
          // GitHub refuses --auto when the repository has "Allow auto-merge" off.
          if (state.allowAuto === false) return fail('GraphQL: Auto merge is not allowed for this repository (enablePullRequestAutoMerge)');
          pr.autoMerge = true;
          return ok('');
        }
        Object.assign(pr, { state: 'MERGED', mergedAt: state.mergedAt ?? '2026-11-01T11:00:00Z', closedAt: state.mergedAt ?? '2026-11-01T11:00:00Z' });
        return ok('');
      }
      if (a === 'issue' && b === 'view') {
        const it = state.issues.get(Number(args[2]));
        if (!it) return fail('not found');
        const fields = flag(args, '--json').split(',');
        const all = { ...it, assignees: it.assignees.map((login) => ({ login })), labels: it.labels.map((name) => ({ name })) };
        return ok(Object.fromEntries(fields.map((f) => [f, all[f]])));
      }
      if (a === 'issue' && b === 'edit') {
        const it = state.issues.get(Number(args[2]));
        if (args.includes('--body-file')) it.body = input;
        const add = flag(args, '--add-label');
        if (add && !it.labels.includes(add)) it.labels.push(add);
        return ok('');
      }
      // The retry check reads the head's workflow runs (council C12: a failed read is "not checked", never "no retries").
      if (a === 'run' && b === 'list') {
        if (state.runs) return ok(state.runs);
        // By default the head's one workflow run, as its checks say (see the actions/runs route above).
        const sha = flag(args, '--commit');
        const pr = [...state.prs.values()].find((p) => p.headRefOid === sha);
        const buckets = (pr?.checks ?? []).filter((c) => c.name !== 'review-quorum').map((c) => c.bucket);
        if (!pr || !buckets.length || buckets.includes('pending')) return ok([]);
        return ok([{ databaseId: 1, conclusion: buckets.some((x) => ['fail', 'cancel'].includes(x)) ? 'failure' : 'success' }]);
      }
      if (a === 'run' && b === 'view') return ok(state.runLogs?.[args[2]] ?? '');
      if (a === 'label' && b === 'create') {
        state.labels.add(args[2]);
        return ok('');
      }
      if (a === 'project' && b === 'field-create') {
        const name = flag(args, '--name');
        state.addFields([name]);
        return ok('');
      }
      if (a === 'project' && b === 'item-add') {
        const n = Number(/issues\/(\d+)/.exec(flag(args, '--url'))[1]);
        state.items.set(n, { id: `I_${n}`, values: {} });
        return ok({ id: `I_${n}` });
      }
      if (a === 'project' && b === 'item-edit') {
        const it = [...state.items.values()].find((x) => x.id === flag(args, '--id'));
        const field = Object.values(state.fields).find((f) => f.id === flag(args, '--field-id'));
        if (args.includes('--clear')) delete it.values[field.name];
        else if (flag(args, '--number') !== undefined) it.values[field.name] = Number(flag(args, '--number'));
        else it.values[field.name] = field.options.find((o) => o.id === flag(args, '--single-select-option-id')).name;
        return ok('');
      }
    } catch (error) {
      return fail(`fake gh: ${error.message}`);
    }
    return fail(`fake gh: unsupported ${args.join(' ')}`);
  };
  return state;
}
