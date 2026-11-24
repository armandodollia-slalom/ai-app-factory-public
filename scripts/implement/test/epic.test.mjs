// Epic delivery against a real throwaway git repo, with the story workers, agents, feature verification, PR check, PR and
// board faked in-process: the epic plan and its note reaching the story orchestrators, merges into the
// epic branch in Blocked-by order, one PR with every Closes line, partial failure, cross-story owns
// serialization, joining an in-progress epic, and bug epics delivered as PR groups.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { seedTicket } from '../../pipeline/test/fixtures/tickets.mjs';
import { loadConfig } from '../../pipeline/lib/config.mjs';
import { loadTicket, resetTicketMemo } from '../../pipeline/lib/tickets.mjs';
import { readJsonl } from '../../pipeline/lib/util.mjs';
import { recordOutage } from '../../pipeline/lib/outage.mjs';
import { ticketDir } from '../../board/lib/source.mjs';
import { defaultDeps, epicToJoin, loadEpicRun, runEpic, saveEpicRun } from '../lib/epic.mjs';
import { deliveryShape, featureGroupTitle, epicDeps, epicPrBody, groupDeps, journeyGroup, nextStories, ownsConflict, singleGroups, validateGroups, validateNote } from '../lib/epic-plan.mjs';
import { groupRow, labelDecisions } from '../lib/decisions.mjs';
import { failedResults } from '../lib/board-events.mjs';
import { planTask } from '../lib/tasks.mjs';
import { prCheckHold } from '../lib/implement.mjs';

// Hermetic: no test here reaches the code host. A `gh` first on PATH records any call and fails it; every host read the
// epic route makes goes through its injected deliveryIo (the red-branch remedy's open-PR lookup made a real `gh pr list`).
const ghCalls = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'epic-gh-')), 'calls.log');
fs.mkdirSync(path.join(path.dirname(ghCalls), 'bin'));
fs.writeFileSync(path.join(path.dirname(ghCalls), 'bin', 'gh'), `#!/bin/sh\necho "$*" >> '${ghCalls}'\nexit 1\n`, { mode: 0o755 });
fs.writeFileSync(path.join(path.dirname(ghCalls), 'bin', 'gh.cmd'), `@echo %* >> "${ghCalls}"\r\n@exit /b 1\r\n`);
process.env.PATH = `${path.join(path.dirname(ghCalls), 'bin')}${path.delimiter}${process.env.PATH}`;
after(() => {
  // `gh --version` is the local install probe of building a host object, not a call to the host.
  const calls = (fs.existsSync(ghCalls) ? fs.readFileSync(ghCalls, 'utf8') : '').split(/\r?\n/).map((l) => l.trim()).filter((l) => l && l !== '--version').join('\n');
  assert.equal(calls, '', `the epic tests called the code host:\n${calls}`);
});

const git = (cwd, ...args) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};
const write = (root, rel, text) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), text);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const result = (o) => `Planned.\nAGENT_RESULT: ${JSON.stringify(o)}\n`;

const story = (key, title, blockers = []) => `# ${key}: ${title}\n\n${blockers.length ? `* **Blocked by:** ${blockers.join(', ')}\n\n` : ''}**Acceptance Criteria:**\n\n- it works\n`;

function makeRepo({ bugs = false } = {}) {
  resetTicketMemo();
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'epic-')));
  const repo = path.join(tmp, 'shop');
  write(repo, 'src/Shared/Common.cs', '// shared\n');
  write(repo, '.gitignore', '.factory/state/\nartifacts/\n');
  seedTicket(repo, { key: 'epic-shop', type: 'epic', text: '# Epic: Shop\n\nThe shop epic.\n', number: 10 });
  if (bugs) {
    seedTicket(repo, { key: 'BUG-1', type: 'bug', parent: 'epic-shop', number: 21, text: story('BUG-1', 'Cart total wrong') });
    seedTicket(repo, { key: 'BUG-2', type: 'bug', parent: 'epic-shop', number: 22, text: story('BUG-2', 'Cart rounding', ['BUG-1']) });
    seedTicket(repo, { key: 'BUG-3', type: 'bug', parent: 'epic-shop', number: 23, text: story('BUG-3', 'Login redirect') });
  } else {
    seedTicket(repo, { key: 'DEMO-1', parent: 'epic-shop', number: 11, text: story('DEMO-1', 'Catalog') });
    seedTicket(repo, { key: 'DEMO-2', parent: 'epic-shop', number: 12, text: story('DEMO-2', 'Basket', ['DEMO-1']) });
    seedTicket(repo, { key: 'DEMO-3', parent: 'epic-shop', number: 13, text: story('DEMO-3', 'Ordering') });
  }
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 't@example.com');
  git(repo, 'config', 'user.name', 'T');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'init');
  const base = loadConfig('implement', repo);
  const config = { ...base, agent: { ...base.agent, cmd: null, cli: 'claude', models: { default: null, implementer: null } }, implement: { ...base.implement, checks: [], unitTests: null, prepareCmd: null, lsp: { enabled: false }, epic: { ...base.implement.epic } } };
  const keys = bugs ? ['BUG-1', 'BUG-2', 'BUG-3'] : ['DEMO-1', 'DEMO-2', 'DEMO-3'];
  const tickets = keys.map((k) => loadTicket(config, k, { fetch: false }));
  const epicT = loadTicket(config, 'epic-shop', { fetch: false });
  const epic = { ...epicT, number: 10, url: 'https://github.com/example/repo/issues/10' };
  return { tmp, repo, config, tickets, epic, inputs: tickets.map((t) => config.abs(t.file)) };
}

const fakeLsp = () => ({ start: async () => ({}), stop: async () => {}, stopAll: async () => {}, diagnostics: async () => ({ available: false, errors: [], warnings: [] }), calls: () => [], isReferences: () => false, leasedRunning: () => false });

// A story worker that implements the story on its branch (from the base it was given) and reports an
// outcome. `outcomes` overrides per key; `files` sets the file each story writes.
function fakeWorker({ outcomes = {}, files = {}, delay = 20, notes = false } = {}) {
  const calls = [];
  let running = 0;
  const peak = { n: 0, overlap: [] };
  const live = new Set();
  const startWorker = async (config, s) => {
    calls.push({ key: s.key, base: s.base, branch: s.branch, epicNote: s.epicNote, epicBranch: s.epicBranch, note: s.epicNote ? fs.readFileSync(s.epicNote, 'utf8') : null });
    running++;
    live.add(s.key);
    peak.n = Math.max(peak.n, running);
    peak.overlap.push([...live]);
    try {
      git(config.root, 'worktree', 'add', '-q', '-b', s.branch, s.worktree, s.base);
      write(s.worktree, files[s.key] ?? `src/${s.key}.cs`, `// ${s.key}\n`);
      git(s.worktree, 'add', '-A');
      git(s.worktree, 'commit', '-qm', `${s.key}: Implementation`);
      // The implementer's Implementation Notes go into the story worktree's ticket cache.
      if (notes) write(ticketDir(loadConfig('implement', s.worktree), s.key), 'story.md', `# ${s.key}\n\n## Implementation Notes\n\nDone.\n`);
      await sleep(delay);
      return { key: s.key, outcome: outcomes[s.key] ?? 'done', reason: outcomes[s.key] ? 'nope' : null, branch: s.branch, worktree: s.worktree, mode: 'self', agentRuns: 3, cost_usd: 1.5 };
    } finally {
      running--;
      live.delete(s.key);
    }
  };
  return { startWorker, calls, peak };
}

function fakeDeps(note, extra = {}) {
  const board = [];
  const prs = [];
  const agentCalls = [];
  const checks = [];
  const gates = [];
  const ships = [];
  const parities = [];
  // What happened around each unit's PR, in order: the pre-open proof and assessment, the open, the gate, the CI wait.
  const order = [];
  const deps = {
    runAgent: async (config, opts) => {
      agentCalls.push(opts);
      const out = typeof note === 'function' ? note(agentCalls.length, opts) : note;
      return { ok: true, status: 0, output: result(out), version: 'v1' };
    },
    lsp: fakeLsp(),
    board: (root, key, args) => board.push([key, ...args]),
    epicFv: async (env, { key }) => ({ status: 'verified', key }),
    reverifyStale: async () => ({ stale: [], failed: [] }),
    prCheck: async (env, keys) => (checks.push(keys), { verdict: 'PASS', score: 10, openFindings: [] }),
    // The delivery's effects (implement.mjs deliveryIo), faked: the epic route runs the real shared delivery. `ci(o)`
    // answers each CI gate call (`o.kind`: 'branch' before the open, 'pr' after it).
    deliveryIo: {
      push: (o) => (order.push(['push', o.commitRecords === false ? 'sync' : 'first', o.branch]), (extra.onPush?.(o) ?? { pushed: true })),
      repo: () => 'acme/shop',
      gate: async (o) => {
        const kind = /^https?:/.test(o.pr) ? 'pr' : 'branch';
        order.push([`${kind}-ci`, kind === 'pr' ? o.pr : o.branch, o.fixRounds]);
        return (await extra.ci?.({ ...o, kind })) ?? { state: 'success', names: ['CI'], rounds: 0, prOnly: [], failing: [], pending: [] };
      },
      assess: ({ keys }) => (order.push(['assess', keys.join(',')]), { severity: 'Low', tickets: keys.map((k) => ({ key: k, impact: 'Low', fixRisk: 'Low', confidence: 0.9 })) }),
      publishGate: ({ pr, keys, base, worktree, assessment }) => (order.push(['gate', pr, assessment]), gates.push({ pr, keys, worktree, base, assessment })),
      regate: ({ pr, args }) => order.push(['regate', pr, ...args]),
      media: () => ({ video: null, api: null, notes: [] }),
      updateBody: (pr) => order.push(['update-body', pr]),
      hold: (pr, o) => (order.push(['hold', pr]), { mode: 'draft', label: 'work-in-progress', from: new Date().toISOString(), why: o.why }),
      release: (pr) => order.push(['ready', pr]),
      // The host shows a hold as applied (a test says otherwise through `confirm`).
      confirmHold: (pr, o) => extra.confirm?.(pr, o) ?? true,
      ownsPr: () => true,
      prOpen: (branch) => Boolean(extra.openOnHost?.(branch)),
      findOpenPr: (branch) => extra.openOnHost?.(branch) ?? null,
      stateDecision: async (pr, d) => order.push(['decision', pr, d.outcome]),
      usage: () => extra.usage ?? [],
      prBody: () => 'the earlier body',
      // The PR's change as the host has it: this checkout's (the release compares it with the rated change).
      prDiffKey: undefined,
    },
    openPr: (env, { title, body, existing, records, draft }) => {
      order.push(['open', existing ?? null, records ?? true]);
      prs.push({ title, body, branch: env.branch, base: env.prBase, existing, draft: Boolean(draft) });
      return { url: `https://github.com/example/repo/pull/${100 + prs.length}`, pushed: true, draft: Boolean(draft) };
    },
    shipMetrics: async (wt) => ships.push(wt?.root ?? null),
    // As the real gate: refused without the unit's CI fixing budget (council r3, sol-06).
    parityGate: (o) => {
      if (typeof o.budget?.left !== 'function' || typeof o.budget?.charge !== 'function') throw new Error('parityGate needs the unit\'s CI fixing budget');
      parities.push(o.targetArgs.join(' '));
      return { results: [{ check: 'gate.yml lint', ok: true, output: '' }], fixRun: null };
    },
    // The remote's head of a unit branch with an open PR (no remote in these repositories): unchanged, unless a test says.
    remoteHead: (wt, branch) => extra.remote?.(branch) ?? { head: null, moved: false },
    ...extra,
  };
  return { deps, board, prs, agentCalls, checks, gates, ships, parities, order };
}

const featureNote = {
  summary: 'Catalog feeds the basket; ordering is separate.',
  contracts: [{ name: 'GET /api/catalog/items', kind: 'api', definition: 'items[]', owner: 'DEMO-1', usedBy: ['DEMO-2'] }],
  stories: [
    { key: 'DEMO-1', owns: ['src/DEMO-1.cs'] },
    { key: 'DEMO-2', owns: ['src/DEMO-2.cs'] },
    { key: 'DEMO-3', owns: ['src/DEMO-3.cs'] },
  ],
  buildOrder: ['DEMO-1', 'DEMO-2', 'DEMO-3'],
  journeys: [{ id: 'browse-to-basket', title: 'Browse then add to basket', stories: ['DEMO-1', 'DEMO-2'], steps: ['open catalog', 'add item'], expected: 'basket shows the item' }],
};

// ---------------------------------------------------------------------------------------------
// Pure logic
// ---------------------------------------------------------------------------------------------

test('validateNote: normalizes the note, rejects unknown keys, bad journeys and dependency cycles', () => {
  const ok = validateNote(featureNote, { keys: ['DEMO-1', 'DEMO-2', 'DEMO-3'] });
  assert.equal(ok.ok, true, ok.errors.join('\n'));
  assert.deepEqual(ok.note.stories.map((s) => s.key), ['DEMO-1', 'DEMO-2', 'DEMO-3']);
  const bad = validateNote({ stories: [{ key: 'X-9' }, { key: 'DEMO-1', dependsOn: ['DEMO-2'] }, { key: 'DEMO-2', dependsOn: ['DEMO-1'] }], journeys: [{ id: 'Bad Id', stories: ['NOPE-1'] }], foundation: { goal: 'x', owns: [] } }, { keys: ['DEMO-1', 'DEMO-2'] });
  assert.equal(bad.ok, false);
  for (const re of [/X-9/, /cycle/, /Bad Id/, /NOPE-1/, /foundation.owns/]) assert.ok(bad.errors.some((e) => re.test(e)), `${re} in ${bad.errors.join('; ')}`);
  assert.match(validateNote(null, { keys: [] }).errors[0], /AGENT_RESULT/);
});

test('validateGroups: coverage, duplicates, Blocked-by order; no cap by default, a configured cap is enforced', () => {
  const stories = [{ key: 'BUG-1', blockedBy: [] }, { key: 'BUG-2', blockedBy: ['BUG-1'] }, { key: 'BUG-3', blockedBy: [] }];
  const one = [{ id: 'all', tickets: ['BUG-1', 'BUG-2', 'BUG-3'] }];
  assert.equal(validateGroups(one, { stories }).ok, true, 'no cap by default');
  assert.equal(validateGroups(one, { stories, maxPerGroup: 0 }).ok, true, '0 means no cap');
  assert.match(validateGroups(one, { stories, maxPerGroup: 2 }).errors.join(), /more than implement\.epic\.maxTicketsPerGroup \(2\)/);
  const errors = validateGroups([{ id: 'b', tickets: ['BUG-2', 'BUG-3'] }, { id: 'a', tickets: ['BUG-1', 'BUG-3'] }], { stories }).errors.join('\n');
  assert.match(errors, /BUG-3 is in both b and a/);
  assert.match(errors, /BUG-2 is blocked by \(or dependsOn\) BUG-1, which is in the later group a/);
  assert.match(validateGroups([{ id: 'a', tickets: ['BUG-1'] }], { stories }).errors.join(), /BUG-2 is in no group/);
  assert.deepEqual(Object.fromEntries(groupDeps([{ id: 'a', tickets: ['BUG-1'] }, { id: 'b', tickets: ['BUG-2', 'BUG-3'] }], stories)), { a: [], b: ['a'] });
});

test("bug groups honour the design note's dependsOn like Blocked-by: ordering is validated and the later group waits", () => {
  const stories = [{ key: 'BUG-1', blockedBy: [] }, { key: 'BUG-2', blockedBy: [] }, { key: 'BUG-3', blockedBy: [] }];
  const note = { stories: [{ key: 'BUG-3', dependsOn: ['BUG-1'] }] };
  const groups = [{ id: 'auth', tickets: ['BUG-1'] }, { id: 'paging', tickets: ['BUG-2'] }, { id: 'validation', tickets: ['BUG-3'] }];
  assert.deepEqual(Object.fromEntries(groupDeps(groups, stories, note)), { auth: [], paging: [], validation: ['auth'] });
  assert.deepEqual(Object.fromEntries(groupDeps(groups, stories)), { auth: [], paging: [], validation: [] }, 'without the note only Blocked-by counts');
  assert.match(validateGroups([...groups].reverse(), { stories, note }).errors.join(), /BUG-3 is blocked by \(or dependsOn\) BUG-1, which is in the later group auth/);
  const v = validateNote({ stories: note.stories, prGroups: [...groups].reverse() }, { keys: ['BUG-1', 'BUG-2', 'BUG-3'], groups: true, stories });
  assert.equal(v.ok, false);
  assert.deepEqual(v.noteErrors, [], 'only the grouping is wrong, so the run can fall back to one PR per ticket');
});

test('deliveryShape: bug epics are grouped when most tickets are bugs; --grouping overrides', () => {
  const bug = (k) => ({ key: k, type: 'bug' });
  const st = (k) => ({ key: k, type: 'story' });
  assert.deepEqual(deliveryShape([bug('BUG-1'), bug('BUG-2'), st('X-1')]), { kind: 'groups', planned: true });
  assert.deepEqual(deliveryShape([bug('BUG-1'), st('X-1')]), { kind: 'epic' });
  assert.deepEqual(deliveryShape([st('X-1')], 'ticket'), { kind: 'groups', planned: false });
  assert.deepEqual(deliveryShape([bug('BUG-1')], 'epic'), { kind: 'epic' });
});

test('nextStories: dependencies merged first, overlapping owns never run together, failed blockers skip dependents', () => {
  const deps = epicDeps([{ key: 'A-1', blockedBy: [] }, { key: 'A-2', blockedBy: ['A-1'] }, { key: 'A-3', blockedBy: [] }, { key: 'A-4', blockedBy: [] }], { stories: [{ key: 'A-4', dependsOn: ['A-3'] }] });
  assert.deepEqual(deps.get('A-4'), ['A-3'], "the note's dependsOn adds ordering");
  const owns = new Map([['A-1', ['src/Catalog/**']], ['A-3', ['src/Catalog/Api.cs']], ['A-4', ['src/Ordering/**']]]);
  assert.ok(ownsConflict(owns.get('A-1'), owns.get('A-3')));
  const base = { order: ['A-1', 'A-2', 'A-3', 'A-4'], deps, owns, running: new Set(), merged: new Set(), failed: new Set(), slots: 4 };
  assert.deepEqual(nextStories({ ...base, pending: new Set(['A-1', 'A-2', 'A-3', 'A-4']) }).start, ['A-1'], 'A-3 overlaps A-1; A-2 and A-4 wait for their dependencies');
  assert.deepEqual(nextStories({ ...base, pending: new Set(['A-2', 'A-3', 'A-4']), running: new Set(), merged: new Set(['A-1']) }).start, ['A-2', 'A-3']);
  assert.deepEqual(nextStories({ ...base, pending: new Set(['A-2']), failed: new Set(['A-1']) }).skip, [{ key: 'A-2', blocker: 'A-1' }]);
});

test('epicPrBody: every story with Closes #N, the epic linked, per-story evidence; group PRs say why they are grouped', () => {
  const stories = [{ key: 'DEMO-1', number: 11, title: 'Catalog' }, { key: 'DEMO-2', number: 12, title: 'Basket' }];
  const body = epicPrBody({ epic: { key: 'epic-shop', number: 10, title: 'Shop', url: 'u' }, branch: 'epic/shop', stories, results: { 'DEMO-1': { outcome: 'done', mode: 'self', agentRuns: 3 } }, fv: { key: 'EPIC-10', status: 'verified' }, prChecks: { 'DEMO-1': { verdict: 'PASS', score: 10 } } });
  assert.match(body, /Closes #11\nCloses #12/);
  assert.match(body, /Part of #10/);
  assert.match(body, /DEMO-1 \(#11\): Catalog \| done \| self, 3 agent runs .* PASS 10\/10/);
  assert.match(body, /Cross-story journeys: .* verified \(`EPIC-10`\)/);
  const g = epicPrBody({ epic: { key: 'epic-shop', number: 10 }, branch: 'bugfix/shop/cart', stories, results: {}, group: { id: 'cart', title: 'Cart fixes', tickets: ['DEMO-1', 'DEMO-2'], reason: 'same service', risk: 'low' } });
  assert.match(g, /as one PR group, `cart`: Cart fixes/);
  assert.match(g, /Grouped because: same service \(risk: low\)/);
});

test("planTask carries the epic design note to the story orchestrator", () => {
  const task = planTask({ key: 'DEMO-2', storyFile: '/w/s.md', worktree: '/w', uiStory: false, limits: { maxSubtasks: 4, selfModeMaxFiles: 6, maxLargeSubtasks: 1 }, epicNote: '# Epic design note\n\nReuse CatalogItemDto.' });
  assert.match(task, /### Epic design note[\s\S]*Reuse CatalogItemDto/);
  assert.doesNotMatch(planTask({ key: 'X-1', storyFile: '/w/s.md', worktree: '/w', uiStory: false, limits: { maxSubtasks: 4, selfModeMaxFiles: 6, maxLargeSubtasks: 1 } }), /Epic design note/);
});

test('decisions: a PR group where one ticket failed and others verified is labeled bad-grouping', () => {
  assert.deepEqual(groupRow({ type: 'pr-group', epic: 'epic-shop', groupId: 'cart', tickets: ['BUG-1', 'BUG-2'], verified: 1 }).labels, ['bad-grouping']);
  assert.deepEqual(groupRow({ type: 'pr-group', groupId: 'auth', tickets: ['BUG-3'], verified: 1, pr: 'u' }).labels, []);
  const rows = labelDecisions({ outcomes: [{ type: 'pr-group', epic: 'e', groupId: 'g', tickets: ['A-1', 'A-2'], verified: 2, mergeConflicts: 1 }] });
  assert.deepEqual(rows[0].labels, ['bad-grouping'], 'merge conflicts inside a group count too');
});

// ---------------------------------------------------------------------------------------------
// The runner
// ---------------------------------------------------------------------------------------------

test('feature epic: plan note reaches every story, stories merge into the epic branch in Blocked-by order, one PR closes them all', async () => {
  const env = makeRepo();
  const worker = fakeWorker();
  const f = fakeDeps(featureNote, { startWorker: worker.startWorker });
  const r = await runEpic(env.config, { epic: env.epic, tickets: env.tickets, inputs: env.inputs, base: 'main', parallel: 2, pr: true, deps: f.deps, log: () => {} });
  assert.equal(r.epic.outcome, 'done', JSON.stringify(r));
  assert.deepEqual(r.results.map((x) => [x.key, x.outcome]), [['DEMO-1', 'done'], ['DEMO-2', 'done'], ['DEMO-3', 'done']]);
  // Epic plan: one read-mode orchestrator run, logged as stage implement-epic-plan.
  assert.equal(f.agentCalls[0].mode, 'read');
  assert.match(f.agentCalls[0].task, /EPIC PLAN mode[\s\S]*### Story DEMO-2 \(blocked by DEMO-1\)/);
  const wt = path.join(env.tmp, 'shop-worktrees', 'epic-shop');
  const decisions = readJsonl(path.join(wt, '.factory/metrics/decisions.jsonl'));
  assert.ok(decisions.some((d) => d.stage === 'implement-epic-plan' && d.decision === 'plan-written'));
  // Every story got the note and branched from the epic branch.
  for (const c of worker.calls) {
    assert.equal(c.base, 'epic/shop');
    assert.equal(c.epicBranch, 'epic/shop');
    assert.match(c.note, /Catalog feeds the basket/);
  }
  const order = worker.calls.map((c) => c.key);
  assert.ok(order.indexOf('DEMO-1') < order.indexOf('DEMO-2'), 'DEMO-2 starts after DEMO-1 merged');
  const merges = git(wt, 'log', '--format=%s', '--merges', 'main..epic/shop').split('\n').reverse();
  assert.ok(merges.indexOf('DEMO-1: Merge into epic/shop') < merges.indexOf('DEMO-2: Merge into epic/shop'));
  assert.ok(fs.existsSync(path.join(wt, 'src/DEMO-2.cs')) && fs.existsSync(path.join(wt, 'src/DEMO-3.cs')));
  // One PR, every Closes line; board: review with the epic branch per story, then epic-pr.
  assert.deepEqual(f.checks, [['DEMO-1', 'DEMO-2', 'DEMO-3', 'EPIC-10']], 'one PR check over every story and the journeys');
  assert.equal(f.prs.length, 1);
  assert.equal(f.prs[0].title, 'Epic: Shop');
  assert.match(f.prs[0].body, /Closes #11\nCloses #12\nCloses #13/);
  for (const k of ['DEMO-1', 'DEMO-2', 'DEMO-3']) assert.ok(f.board.some((b) => b[0] === k && b[1] === 'review' && b.includes('--epic-branch') && b.includes('epic/shop')), `${k} review`);
  assert.ok(f.board.some((b) => b[1] === 'epic-pr' && b[2] === '10' && b.includes('https://github.com/example/repo/pull/101')));
  assert.equal(loadEpicRun(env.config, 'epic-shop').status, 'delivered');
  assert.deepEqual(f.gates, [], 'feature epic PRs are not gated');
});

test('feature epic: stories whose owns overlap never run at the same time', async () => {
  const env = makeRepo();
  const worker = fakeWorker({ delay: 60 });
  const note = { ...featureNote, stories: [{ key: 'DEMO-1', owns: ['src/**'] }, { key: 'DEMO-2', owns: ['src/DEMO-2.cs'] }, { key: 'DEMO-3', owns: ['src/DEMO-3.cs'] }] };
  const f = fakeDeps(note, { startWorker: worker.startWorker });
  await runEpic(env.config, { epic: env.epic, tickets: env.tickets, inputs: env.inputs, base: 'main', parallel: 3, deps: f.deps, log: () => {} });
  assert.ok(worker.peak.overlap.every((live) => !(live.includes('DEMO-1') && live.includes('DEMO-3'))), JSON.stringify(worker.peak.overlap));
  assert.equal(worker.calls.length, 3);
});

test('feature epic: a failed story skips its dependents, independents still merge, no PR; a later single ticket joins the epic branch', async () => {
  const env = makeRepo();
  const worker = fakeWorker({ outcomes: { 'DEMO-1': 'pair-exhausted' } });
  const f = fakeDeps(featureNote, { startWorker: worker.startWorker });
  const r = await runEpic(env.config, { epic: env.epic, tickets: env.tickets, inputs: env.inputs, base: 'main', parallel: 2, pr: true, deps: f.deps, log: () => {} });
  assert.deepEqual(Object.fromEntries(r.results.map((x) => [x.key, x.outcome])), { 'DEMO-1': 'pair-exhausted', 'DEMO-2': 'skipped', 'DEMO-3': 'done' });
  assert.match(r.results.find((x) => x.key === 'DEMO-2').reason, /^blocker DEMO-1 ended pair-exhausted/);
  assert.equal(f.prs.length, 0, 'no epic PR while a story failed');
  assert.equal(r.epic.outcome, 'stories-failed');
  const state = loadEpicRun(env.config, 'epic-shop');
  assert.equal(state.status, 'failed');
  assert.equal(state.stories['DEMO-3'].merged, true);

  // DEMO-1 is fixed and run on its own: it joins the epic branch (no PR), unless --standalone.
  const join = epicToJoin(env.config, [env.tickets[0]]);
  assert.equal(join.unit.branch, 'epic/shop');
  assert.equal(epicToJoin(env.config, [env.tickets[0]], { standalone: true }), null);
  git(env.repo, 'worktree', 'remove', '--force', path.join(env.tmp, 'shop-worktrees', 'demo-1'));
  git(env.repo, 'branch', '-D', worker.calls[0].branch);
  const again = fakeWorker();
  const f2 = fakeDeps(featureNote, { startWorker: again.startWorker });
  const j = await runEpic(env.config, { epic: env.epic, tickets: [env.tickets[0]], inputs: [env.inputs[0]], base: 'main', only: ['DEMO-1'], deps: f2.deps, log: () => {} });
  assert.equal(j.epic.outcome, 'joined');
  assert.deepEqual(again.calls.map((c) => [c.key, c.base]), [['DEMO-1', 'epic/shop']]);
  assert.equal(f2.agentCalls.length, 0, 'a joining ticket does not plan the epic again');
  assert.equal(f2.prs.length, 0);
  assert.equal(loadEpicRun(env.config, 'epic-shop').stories['DEMO-1'].merged, true);
});

test('bug epic: the orchestrator groups the bugs; each group gets its branch, its PR and its board evidence', async () => {
  const env = makeRepo({ bugs: true });
  const worker = fakeWorker({ notes: true });
  const note = { summary: 'two areas', stories: [], prGroups: [{ id: 'cart', title: 'Cart totals', tickets: ['BUG-1', 'BUG-2'], reason: 'same root cause', risk: 'low' }, { id: 'auth', title: 'Login', tickets: ['BUG-3'], reason: 'security fix ships alone', risk: 'high' }] };
  // The unit's PR check (and its push's feature verification check) read the tickets as the stories left them.
  const checkedTexts = [];
  const followUp = { id: 'FLOW-1-1', lens: 'flow', title: 'Fix the pre-existing rounding of zero totals', reason: 'same on main' };
  const prCheck = async (uenv, keys) => (keys.forEach((k) => checkedTexts.push(fs.readFileSync(path.join(ticketDir(uenv.wtConfig, k), 'story.md'), 'utf8'))), { verdict: 'PASS', score: 10, openFindings: [], followUps: keys.includes('BUG-1') ? [followUp] : [] });
  const f = fakeDeps(note, { startWorker: worker.startWorker, prCheck });
  const r = await runEpic(env.config, { epic: env.epic, tickets: env.tickets, inputs: env.inputs, base: 'main', parallel: 2, pr: true, deps: f.deps, log: () => {} });
  assert.equal(r.epic.outcome, 'done', JSON.stringify(r.epic));
  assert.match(f.agentCalls[0].task, /bug epic[\s\S]*prGroups/);
  assert.doesNotMatch(f.agentCalls[0].task, /at most \d+ tickets per group/, 'no cap by default');
  assert.deepEqual(f.prs.map((p) => p.branch).sort(), ['bugfix/shop/auth', 'bugfix/shop/cart']);
  assert.equal(checkedTexts.length, 3);
  for (const t of checkedTexts) assert.match(t, /## Implementation Notes/, 'the unit worktree has the story worktree\'s ticket text');
  const cart = f.prs.find((p) => p.branch === 'bugfix/shop/cart');
  assert.match(cart.body, /Closes #21\nCloses #22/);
  assert.doesNotMatch(cart.body, /#23/);
  // Council C2: a judge's "pre-existing, belongs in a follow-up" dismissal lands in the PR and on the epic.
  assert.match(cart.body, /## Follow-ups \(not in this PR\)\n\n(- .*\n)*- Fix the pre-existing rounding of zero totals \(PR check before this PR FLOW-1-1: same on main\)/);
  const auth = f.prs.find((p) => p.branch === 'bugfix/shop/auth');
  assert.doesNotMatch(auth.body, /rounding of zero totals/);
  const cartEvidence = f.board.find((b) => b[1] === 'epic-pr' && b.includes('cart'));
  assert.deepEqual(JSON.parse(cartEvidence[cartEvidence.indexOf('--follow-ups') + 1]).filter((u) => /rounding/.test(u)), ['Fix the pre-existing rounding of zero totals']);
  assert.equal(worker.calls.find((c) => c.key === 'BUG-3').base, 'bugfix/shop/auth');
  // Cards go to Pending Review with their group's PR; the epic evidence lists each group PR.
  const cartUrl = `https://github.com/example/repo/pull/${101 + f.prs.indexOf(cart)}`;
  for (const k of ['BUG-1', 'BUG-2']) assert.ok(f.board.some((b) => b[0] === k && b[1] === 'review' && b.includes('--pr') && b.includes(cartUrl)), `${k} review with the group PR`);
  assert.equal(f.board.filter((b) => b[1] === 'epic-pr' && b.includes('--group')).length, 2);
  // Every published group PR goes through the review gate, from its group worktree.
  assert.deepEqual(f.gates.map((g) => [g.keys.join(','), g.pr === cartUrl, g.base]).sort(), [['BUG-1,BUG-2', true, 'main'], ['BUG-3', false, 'main']]);
  // Council C2: a group's PR check records reached the store only after its branch merged. Each unit ships its
  // worktree's records when it ends, after the PR and the gate; the main checkout ships the epic plan's records.
  assert.deepEqual([...f.ships].sort(), [env.config.root, ...f.gates.map((g) => g.worktree)].sort());
  // Dogfood C4: what CI runs on a PR runs before the group PR opens, and the PR says so.
  assert.deepEqual(f.parities.sort(), ['--stories BUG-1,BUG-2', '--stories BUG-3']);
  assert.match(cart.body, /- CI checks run before this PR: all 1 passed/);
  // Decision log and per-group outcomes in this checkout's metrics.
  const decisions = readJsonl(path.join(env.repo, '.factory/metrics/decisions.jsonl'));
  const grouping = decisions.find((d) => d.decision === 'pr-groups');
  assert.deepEqual(grouping.items.map((i) => i.id), ['cart', 'auth']);
  const outcomes = readJsonl(path.join(env.repo, '.factory/metrics/decision-outcomes.jsonl')).filter((o) => o.type === 'pr-group');
  assert.deepEqual(outcomes.map((o) => [o.groupId, o.verified, Boolean(o.pr), o.cost_usd]).sort(), [['auth', 1, true, 1.5], ['cart', 2, true, 3]]);
});

// Dogfood C2: the epic merged BUG-7's branch (delivered in its own open PR #21) into a new group and was about to
// open a second PR for it.
test('bug epic: a ticket already delivered in a PR of its own is not delivered again; its group opens no PR', async () => {
  const env = makeRepo({ bugs: true });
  const worker = fakeWorker({ notes: true });
  const note = { summary: 'two areas', stories: [], prGroups: [{ id: 'cart', title: 'Cart totals', tickets: ['BUG-1', 'BUG-2'], reason: 'same root cause', risk: 'low' }, { id: 'auth', title: 'Login', tickets: ['BUG-3'], reason: 'alone', risk: 'low' }] };
  spawnSync('git', ['branch', 'feat/bug-3-earlier'], { cwd: env.repo });
  const runs = path.join(env.repo, '.factory/state/implement');
  fs.mkdirSync(runs, { recursive: true });
  fs.writeFileSync(path.join(runs, 'BUG-3.json'), JSON.stringify({ key: 'BUG-3', outcome: 'done', status: 'finished', branch: 'feat/bug-3-earlier', pr: 'https://github.com/example/repo/pull/21' }));
  const f = fakeDeps(note, { startWorker: worker.startWorker, prCheck: async () => ({ verdict: 'PASS', score: 10, openFindings: [] }) });
  const lines = [];
  const r = await runEpic(env.config, { epic: env.epic, tickets: env.tickets, inputs: env.inputs, base: 'main', parallel: 2, pr: true, deps: f.deps, log: (m) => lines.push(m) });
  assert.equal(r.epic.outcome, 'done', JSON.stringify(r.epic));
  assert.deepEqual(f.prs.map((p) => p.branch), ['bugfix/shop/cart'], 'no second PR for BUG-3');
  // Council C3: the summary said "PRs were not all opened" when the only PR-less group had nothing to deliver.
  assert.ok(lines.some((l) => /every unit verified: 1 group PR\(s\) opened by this run, 1 with nothing to deliver$/.test(l)), lines.join('\n'));
  assert.ok(!lines.some((l) => /PRs were not all opened|not delivered:/.test(l)));
  assert.ok(!worker.calls.some((c) => c.key === 'BUG-3'), 'BUG-3 is not run again');
  const auth = loadEpicRun(env.config, env.epic.key).units.auth;
  assert.equal(auth.noPr, true);
  assert.match(auth.reason, /BUG-3 delivered in its own PR https:\/\/github\.com\/example\/repo\/pull\/21/);
  assert.match(auth.noPrReason, /^BUG-3 delivered in its own PR/);
});

test('bug epic: a grouping that stays invalid falls back to one PR per bug; a failed group skips the groups that depend on it', async () => {
  const env = makeRepo({ bugs: true });
  const worker = fakeWorker({ outcomes: { 'BUG-1': 'pair-exhausted' } });
  // BUG-2 (blocked by BUG-1) in an earlier group than BUG-1: invalid twice.
  const note = { stories: [], prGroups: [{ id: 'two', tickets: ['BUG-2'] }, { id: 'one', tickets: ['BUG-1', 'BUG-3'] }] };
  const f = fakeDeps(note, { startWorker: worker.startWorker });
  const r = await runEpic(env.config, { epic: env.epic, tickets: env.tickets, inputs: env.inputs, base: 'main', parallel: 1, pr: true, deps: f.deps, log: () => {} });
  assert.equal(f.agentCalls.length, 2, 'asked once more with the errors');
  assert.match(f.agentCalls[1].task, /previous note was rejected[\s\S]*later group/);
  const decisions = readJsonl(path.join(env.repo, '.factory/metrics/decisions.jsonl'));
  assert.equal(decisions.find((d) => d.decision === 'pr-groups').fallback, true);
  assert.deepEqual(Object.fromEntries(r.results.map((x) => [x.key, x.outcome])), { 'BUG-1': 'pair-exhausted', 'BUG-2': 'skipped', 'BUG-3': 'done' });
  assert.deepEqual(f.prs.map((p) => p.branch), ['bugfix/shop/bug-3'], 'only the independent group gets a PR');
  assert.equal(r.epic.outcome, 'stories-failed');
});

test('bug epic: an agent provider outage stops the run without failing or skipping the tickets it did not reach', async () => {
  const env = makeRepo({ bugs: true });
  const prev = process.env.PIPELINE_OUTAGE_FILE;
  process.env.PIPELINE_OUTAGE_FILE = path.join(env.tmp, 'agent-outage.json');
  try {
    const worker = fakeWorker();
    // BUG-1's agents hit the provider's quota: the worker reports it interrupted (startWorker does).
    const startWorker = async (config, s) => {
      if (s.key !== 'BUG-1') return worker.startWorker(config, s);
      recordOutage({ cli: 'copilot', agent: 'implementer', reason: 'You have exceeded your monthly quota' });
      return { key: s.key, outcome: 'error', reason: 'interrupted: the agent provider is unavailable', outage: true, branch: s.branch, worktree: s.worktree };
    };
    const note = { stories: [], prGroups: [{ id: 'cart', tickets: ['BUG-1', 'BUG-2'] }, { id: 'auth', tickets: ['BUG-3'] }] };
    const f = fakeDeps(note, { startWorker });
    const r = await runEpic(env.config, { epic: env.epic, tickets: env.tickets, inputs: env.inputs, base: 'main', parallel: 1, pr: true, deps: f.deps, log: () => {} });
    const byKey = Object.fromEntries(r.results.map((x) => [x.key, x.outcome]));
    assert.deepEqual(byKey, { 'BUG-1': 'error', 'BUG-2': null, 'BUG-3': null }, 'BUG-2 is not skipped for its blocker, BUG-3 never starts');
    assert.deepEqual(worker.calls, [], 'no story starts after the outage');
    assert.equal(f.prs.length, 0);
    assert.deepEqual(failedResults(r.results).map((x) => x.key), ['BUG-1']);
  } finally {
    if (prev === undefined) delete process.env.PIPELINE_OUTAGE_FILE;
    else process.env.PIPELINE_OUTAGE_FILE = prev;
  }
});

test('bug epic: a ticket still escalated from an earlier run is not run again and still blocks its dependents', async () => {
  const env = makeRepo({ bugs: true });
  const runs = path.join(env.repo, '.factory/state', 'implement');
  fs.mkdirSync(runs, { recursive: true });
  fs.writeFileSync(path.join(runs, 'BUG-1.json'), JSON.stringify({ key: 'BUG-1', status: 'finished', outcome: 'fv-escalated' }));
  const escalations = path.join(env.tmp, 'shop-worktrees', 'bug-1', '.factory/state', 'escalations');
  fs.mkdirSync(escalations, { recursive: true });
  fs.writeFileSync(path.join(escalations, 'BUG-1-automation.md'), '# BUG-1 automation: tests did not reach 9/10\n');
  const worker = fakeWorker();
  const note = { stories: [], prGroups: [{ id: 'cart', tickets: ['BUG-1', 'BUG-2'] }, { id: 'auth', tickets: ['BUG-3'] }] };
  const f = fakeDeps(note, { startWorker: worker.startWorker });
  const r = await runEpic(env.config, { epic: env.epic, tickets: env.tickets, inputs: env.inputs, base: 'main', parallel: 1, pr: true, deps: f.deps, log: () => {} });
  assert.deepEqual(worker.calls.map((c) => c.key), ['BUG-3'], 'BUG-1 is not run again');
  const byKey = Object.fromEntries(r.results.map((x) => [x.key, x]));
  assert.equal(byKey['BUG-1'].outcome, 'fv-escalated');
  assert.match(byKey['BUG-2'].reason, /^blocker BUG-1 ended fv-escalated/);
  assert.deepEqual(f.prs.map((p) => p.branch), ['bugfix/shop/auth']);
});

test('bug epic: tickets whose verified tests went stale through later tickets are re-verified before the push; a failed re-verify blocks the PR', async () => {
  const env = makeRepo({ bugs: true });
  const worker = fakeWorker();
  const note = { stories: [], prGroups: [{ id: 'cart', tickets: ['BUG-1', 'BUG-2'] }, { id: 'auth', tickets: ['BUG-3'] }] };
  const seen = [];
  const reverifyStale = async (uenv, keys) => (seen.push([uenv.unit.id, keys]), uenv.unit.id === 'cart' ? { stale: ['BUG-1'], failed: ['BUG-1'] } : { stale: [], failed: [] });
  const f = fakeDeps(note, { startWorker: worker.startWorker, reverifyStale });
  const r = await runEpic(env.config, { epic: env.epic, tickets: env.tickets, inputs: env.inputs, base: 'main', parallel: 1, pr: true, deps: f.deps, log: () => {} });
  assert.deepEqual(seen.map(([id, keys]) => [id, [...keys].sort()]), [['cart', ['BUG-1', 'BUG-2']], ['auth', ['BUG-3']]]);
  assert.deepEqual(f.prs.map((p) => p.branch), ['bugfix/shop/auth'], 'the cart group gets no PR while BUG-1 is not re-verified');
  assert.equal(loadEpicRun(env.config, 'epic-shop').units.cart.outcome, 'fv-reverify-failed');
  assert.equal(r.epic.outcome, 'fv-reverify-failed');
});

test('bug epic: a merge into the group is not blocked by metrics an earlier agent left uncommitted in the group worktree', async () => {
  const env = makeRepo({ bugs: true });
  // As in the repo: metrics logs are append-only and merge as a union.
  write(env.repo, '.gitattributes', '.factory/metrics/*.jsonl merge=union\n');
  git(env.repo, 'add', '-A');
  git(env.repo, 'commit', '-qm', 'union merges for metrics');
  const worker = fakeWorker();
  const metrics = '.factory/metrics/token-usage.jsonl';
  const appendTo = (dir, line) => fs.appendFileSync(path.join(dir, metrics), `${line}\n`);
  const startWorker = async (config, s) => {
    const r = await worker.startWorker(config, s);
    // Every ticket records its usage on its branch, like the real worker.
    fs.mkdirSync(path.join(s.worktree, '.factory/metrics'), { recursive: true });
    appendTo(s.worktree, `{"story":"${s.key}"}`);
    git(s.worktree, 'add', '-A');
    git(s.worktree, 'commit', '-qm', `${s.key}: Record implement metrics`);
    // A conflict-resolving agent ran in the group worktree and left its record uncommitted there.
    if (s.key === 'BUG-2') {
      const unitWt = git(env.repo, 'worktree', 'list', '--porcelain').split('\n').filter((l) => l.startsWith('worktree ')).map((l) => l.slice(9)).find((p) => p.endsWith('--cart'));
      appendTo(unitWt, '{"story":"BUG-1","step":"merge into bugfix/shop/cart"}');
    }
    return r;
  };
  const note = { stories: [], prGroups: [{ id: 'cart', tickets: ['BUG-1', 'BUG-2'] }, { id: 'auth', tickets: ['BUG-3'] }] };
  const f = fakeDeps(note, { startWorker });
  const r = await runEpic(env.config, { epic: env.epic, tickets: env.tickets, inputs: env.inputs, base: 'main', parallel: 1, pr: true, deps: f.deps, log: () => {} });
  assert.deepEqual(Object.fromEntries(r.results.map((x) => [x.key, x.outcome])), { 'BUG-1': 'done', 'BUG-2': 'done', 'BUG-3': 'done' });
  assert.deepEqual(f.prs.map((p) => p.branch).sort(), ['bugfix/shop/auth', 'bugfix/shop/cart']);
});

test('bug epic: a group PR opened by a later run is gated with every ticket merged into the group, not only that run\'s', async () => {
  const env = makeRepo({ bugs: true });
  const note = { stories: [], prGroups: [{ id: 'all', title: 'All', tickets: ['BUG-1', 'BUG-2', 'BUG-3'] }] };
  // Run 1: BUG-1 merges, BUG-2 fails, so the group gets no PR; run 2 finishes the group.
  const w1 = fakeWorker({ outcomes: { 'BUG-2': 'pair-exhausted' } });
  const first = fakeDeps(note, { startWorker: w1.startWorker });
  await runEpic(env.config, { epic: env.epic, tickets: env.tickets, inputs: env.inputs, base: 'main', parallel: 1, pr: true, deps: first.deps, log: () => {} });
  assert.deepEqual(first.gates, []);
  const bug2 = w1.calls.find((c) => c.key === 'BUG-2');
  git(env.repo, 'worktree', 'remove', '--force', path.join(env.tmp, 'shop-worktrees', 'bug-2'));
  git(env.repo, 'branch', '-D', bug2.branch);
  const second = fakeDeps(note, { startWorker: fakeWorker().startWorker });
  await runEpic(env.config, { epic: env.epic, tickets: env.tickets, inputs: env.inputs, base: 'main', parallel: 1, pr: true, deps: second.deps, log: () => {} });
  assert.equal(second.prs.length, 1);
  assert.deepEqual(second.gates.map((g) => [...g.keys].sort()), [['BUG-1', 'BUG-2', 'BUG-3']], 'BUG-1, merged by run 1, is rated too');
});

test('bug epic: a stacked group gets the tickets of the groups below it synced before its PR check and push', async () => {
  const env = makeRepo({ bugs: true });
  const worker = fakeWorker({ notes: true });
  // BUG-2 is blocked by BUG-1, so group two stacks on group one and its branch carries BUG-1's plan.
  const note = { stories: [], prGroups: [{ id: 'one', title: 'One', tickets: ['BUG-1'] }, { id: 'two', title: 'Two', tickets: ['BUG-2'] }, { id: 'three', title: 'Three', tickets: ['BUG-3'] }] };
  const seen = {};
  const prCheck = async (uenv) => {
    const p = path.join(ticketDir(uenv.wtConfig, 'BUG-1'), 'story.md');
    seen[uenv.unit.id] = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
    return { verdict: 'PASS', score: 10, openFindings: [] };
  };
  const f = fakeDeps(note, { startWorker: worker.startWorker, prCheck });
  await runEpic(env.config, { epic: env.epic, tickets: env.tickets, inputs: env.inputs, base: 'main', parallel: 1, pr: true, deps: f.deps, log: () => {} });
  assert.match(seen.two ?? '', /## Implementation Notes/, "the stacked group's worktree has BUG-1's ticket with its notes");
  assert.equal(seen.three, null, 'an independent group gets no other tickets');
});

// Dogfood C4: a later run delivered a finished group again, and the push was rejected (its PR branch had moved).
test('bug epic: a group an earlier run delivered is not delivered or pushed again; the run keeps its PR', async () => {
  const env = makeRepo({ bugs: true });
  const worker = fakeWorker();
  const note = { stories: [], prGroups: [{ id: 'all', title: 'All', tickets: ['BUG-1', 'BUG-2', 'BUG-3'] }] };
  const first = fakeDeps(note, { startWorker: worker.startWorker });
  const r1 = await runEpic(env.config, { epic: env.epic, tickets: env.tickets, inputs: env.inputs, base: 'main', parallel: 1, pr: true, deps: first.deps, log: () => {} });
  const runsBefore = worker.calls.length;
  const second = fakeDeps(note, { startWorker: worker.startWorker });
  const r2 = await runEpic(env.config, { epic: env.epic, tickets: env.tickets, inputs: env.inputs, base: 'main', parallel: 1, pr: true, deps: second.deps, log: () => {} });
  assert.equal(r2.epic.outcome, 'done');
  assert.deepEqual(r2.epic.prs, r1.epic.prs, 'the run reports the PR it already has');
  assert.deepEqual(second.prs, [], 'nothing pushed or opened');
  assert.deepEqual(second.gates, []);
  assert.equal(worker.calls.length, runsBefore, 'no ticket runs again');
  assert.ok(r2.results.every((r) => r.outcome === 'skipped' && r.reason === `delivered in ${r1.epic.prs[0]} by an earlier run`));
  assert.equal(first.gates.length, 1, 'the new group PR is gated');
});

// Dogfood C4: two tickets added to a bug epic after its plan were "skipped: its group never ran" and the run ended done.
test('bug epic: tickets added after the plan are planned into groups of their own; the earlier groups are kept', async () => {
  const env = makeRepo({ bugs: true });
  const worker = fakeWorker({ notes: true });
  const before = { stories: [], prGroups: [{ id: 'cart', title: 'Cart', tickets: ['BUG-1', 'BUG-2'] }] };
  const first = fakeDeps(before, { startWorker: worker.startWorker });
  await runEpic(env.config, { epic: env.epic, tickets: env.tickets.filter((t) => t.key !== 'BUG-3'), inputs: env.inputs, base: 'main', parallel: 1, pr: true, deps: first.deps, log: () => {} });
  const later = { stories: [], prGroups: [{ id: 'cart', title: 'Login', tickets: ['BUG-3'] }] };
  const second = fakeDeps(later, { startWorker: worker.startWorker });
  const r = await runEpic(env.config, { epic: env.epic, tickets: env.tickets, inputs: env.inputs, base: 'main', parallel: 1, pr: true, deps: second.deps, log: () => {} });
  assert.equal(r.epic.outcome, 'done', JSON.stringify(r.epic));
  assert.equal(second.agentCalls.length, 1, 'the orchestrator plans the new ticket');
  assert.match(second.agentCalls[0].task, /BUG-3/);
  assert.doesNotMatch(second.agentCalls[0].task, /BUG-1:/, 'only the new ticket is planned');
  assert.deepEqual(second.prs.map((p) => p.branch), ['bugfix/shop/cart-2'], 'a new group beside the kept one, its id made unique');
  assert.equal(r.results.find((x) => x.key === 'BUG-3').outcome, 'done');
  assert.ok(worker.calls.some((c) => c.key === 'BUG-3'));
});

test('bug epic: tickets no group can run, or a failed plan for added tickets, fail the epic with the reason', async () => {
  const env = makeRepo({ bugs: true });
  const worker = fakeWorker();
  // Two groups that block each other: neither can start, so their tickets are never run.
  const tickets = env.tickets.map((t) => (t.key === 'BUG-1' ? { ...t, blockedBy: ['BUG-3'] } : t.key === 'BUG-3' ? { ...t, blockedBy: ['BUG-1'] } : t));
  const note = { stories: [], prGroups: [{ id: 'a', title: 'A', tickets: ['BUG-1', 'BUG-2'] }, { id: 'b', title: 'B', tickets: ['BUG-3'] }] };
  const f = fakeDeps(note, { startWorker: worker.startWorker });
  const r = await runEpic(env.config, { epic: env.epic, tickets, inputs: env.inputs, base: 'main', parallel: 1, pr: true, deps: f.deps, log: () => {} });
  assert.equal(r.epic.outcome, 'undelivered');
  assert.match(r.epic.reason, /BUG-1, BUG-2, BUG-3 not delivered: no PR group ran them/);
  assert.ok(r.results.every((x) => x.outcome === 'undelivered'));

  const env2 = makeRepo({ bugs: true });
  const first = fakeDeps({ stories: [], prGroups: [{ id: 'cart', title: 'Cart', tickets: ['BUG-1', 'BUG-2'] }] }, { startWorker: fakeWorker().startWorker });
  await runEpic(env2.config, { epic: env2.epic, tickets: env2.tickets.filter((t) => t.key !== 'BUG-3'), inputs: env2.inputs, base: 'main', parallel: 1, pr: true, deps: first.deps, log: () => {} });
  const failing = fakeDeps(null, { planEpic: async () => ({ ok: false, outcome: 'plan-failed', reason: 'no valid groups' }) });
  const r2 = await runEpic(env2.config, { epic: env2.epic, tickets: env2.tickets, inputs: env2.inputs, base: 'main', parallel: 1, pr: true, deps: failing.deps, log: () => {} });
  assert.equal(r2.epic.outcome, 'plan-failed');
  assert.match(r2.epic.reason, /planning the tickets added since the epic's plan failed: no valid groups/);
});

test('singleGroups: one group per ticket', () => {
  assert.deepEqual(singleGroups([{ key: 'BUG-1', title: 'a' }]).map((g) => [g.id, g.tickets]), [['bug-1', ['BUG-1']]]);
});

// Dogfood C4: never push to a group PR that is merged or closed, or over commits its branch got on GitHub since.
// Council C7 (Opus 1): a group whose CI passed only on a retry (or whose fix round escalated) left its tickets in
// Pending Review. Its tickets now fail with the delivery's findings, and the gate gets the delivery as an input.
// Council C7 (Opus 2): the epic said "delivered / done" while BUG-34 and BUG-35 waited for a person, and listed the
// closed #56 among its PRs.
test('bug epic: a ticket waiting for a person keeps the epic waiting; a closed PR is not one of its PRs', async () => {
  const env = makeRepo({ bugs: true });
  const worker = fakeWorker({ notes: true });
  const note = { summary: 'two areas', stories: [], prGroups: [{ id: 'cart', title: 'Cart totals', tickets: ['BUG-1', 'BUG-2'], reason: 'r', risk: 'low' }, { id: 'auth', title: 'Login', tickets: ['BUG-3'], reason: 'r', risk: 'high' }] };
  const tickets = env.tickets.map((t) => (t.key === 'BUG-3' ? { ...t, labels: ['needs-human'] } : t));
  const f = fakeDeps(note, { startWorker: worker.startWorker, prState: (pr) => (pr.endsWith('/101') ? 'CLOSED' : 'OPEN') });
  const r = await runEpic(env.config, { epic: env.epic, tickets, inputs: env.inputs, base: 'main', parallel: 2, pr: true, deps: f.deps, log: () => {} });
  assert.equal(r.epic.outcome, 'waiting', JSON.stringify(r.epic));
  assert.match(r.epic.reason, /BUG-3 waits for a person's decision/);
  assert.ok(!r.epic.prs.some((p) => p.endsWith('/101')), JSON.stringify(r.epic.prs));
  const saved = loadEpicRun(env.config, env.epic.key);
  assert.deepEqual([saved.status, saved.waiting], ['waiting', ['BUG-3']]);
});


// ---------------------------------------------------------------------------------------------
// Every epic PR opens finished, through the standalone ticket's delivery (implement.mjs deliverFinished; owner requirement
// C16, extended to epics in C18). The delivery's effects are faked (fakeDeps deliveryIo); its logic is the real one.
// ---------------------------------------------------------------------------------------------

const twoGroups = (extra = {}) => ({ summary: 'two areas', stories: [], prGroups: [{ id: 'cart', title: 'Cart totals', tickets: ['BUG-1', 'BUG-2'], reason: 'same root cause', risk: 'low' }, { id: 'auth', title: 'Login', tickets: ['BUG-3'], reason: 'alone', risk: 'high' }], ...extra });
const steps = (f, branch) => {
  // The steps of one group's delivery: from its first push to its last CI wait (groups run one at a time here).
  const at = f.order.findIndex((o) => o[0] === 'push' && o[2] === branch);
  const next = f.order.findIndex((o, i) => i > at && o[0] === 'push' && o[1] === 'first' && o[2] !== branch);
  return f.order.slice(at, next < 0 ? undefined : next).map((o) => o[0]);
};
const epicRun = (env, f, extra = {}) => runEpic(env.config, { epic: env.epic, tickets: env.tickets, inputs: env.inputs, base: 'main', parallel: 1, pr: true, deps: f.deps, log: () => {}, ...extra });
const unitState = (env, id) => loadEpicRun(env.config, env.epic.key).units?.[id] ?? {};

test('epic delivery: each group PR opens once, after its push, its CI proven on the head and the gate rating; after the open only the CI wait', async () => {
  const env = makeRepo({ bugs: true });
  const cleaned = [];
  const f = fakeDeps(twoGroups(), { startWorker: fakeWorker().startWorker, cleanup: (root, plan, o) => cleaned.push(o.label) });
  const r = await epicRun(env, f);
  assert.equal(r.epic.outcome, 'done', JSON.stringify(r.epic));
  // A bug group's PR opens held (a draft) until its rating is published, and is marked ready once its checks are green.
  for (const b of ['bugfix/shop/cart', 'bugfix/shop/auth']) assert.deepEqual(steps(f, b), ['push', 'branch-ci', 'push', 'assess', 'open', 'gate', 'pr-ci', 'ready', 'regate'], b);
  // Once the epic run ended, what each delivered group made on this machine goes (prune.mjs planDelivered).
  assert.deepEqual(cleaned.sort(), ['epic-shop auth', 'epic-shop cart']);
  assert.ok(f.order.filter((o) => o[0] === 'open').every((o) => o[2] === false), 'nothing committed or merged at the open');
  assert.ok(f.order.filter((o) => o[0] === 'pr-ci').every((o) => o[2] === 0), 'no fixing round on a ready PR');
  assert.ok(f.order.filter((o) => o[0] === 'branch-ci').every((o) => o[2] >= 1), 'the CI fixing round is allowed only before the open');
  assert.equal(f.prs.length, 2);
  const cart = f.prs.find((p) => p.branch === 'bugfix/shop/cart');
  assert.match(cart.body, /^- CI before this PR: every pipeline a push of `bugfix\/shop\/cart` runs passed on [0-9a-f]{7} \(CI\)[\s\S]*- Review gate, assessed before this PR opened: severity Low/);
  assert.match(cart.body, /Closes #21\nCloses #22/, 'the full body');
  const audit = unitState(env, 'cart').delivery.readyAudit;
  assert.deepEqual([audit.ok, audit.after, audit.readyAt], [true, [], unitState(env, 'cart').delivery.readyAt]);
  assert.ok(audit.holds.every((h) => h.to), 'the hold it opened with was released');
});

test('epic delivery: a red group branch is fixed on the branch before its PR exists (the fixing round runs only before the open)', async () => {
  const env = makeRepo({ bugs: true });
  const ci = ({ kind, branch, cwd }) => {
    if (kind !== 'branch' || branch !== 'bugfix/shop/cart') return null;
    git(cwd, 'commit', '-q', '--allow-empty', '-m', 'BUG-1: the CI fix');
    return { state: 'success', names: ['CI'], rounds: 1, prOnly: [], failing: [], pending: [] };
  };
  const f = fakeDeps(twoGroups(), { startWorker: fakeWorker().startWorker, ci });
  const r = await epicRun(env, f);
  assert.equal(r.epic.outcome, 'done');
  assert.deepEqual(steps(f, 'bugfix/shop/cart').slice(0, 5), ['push', 'branch-ci', 'push', 'assess', 'open']);
  assert.match(f.prs.find((p) => p.branch === 'bugfix/shop/cart').body, /after 1 CI fixing round\(s\) on the branch/);
});

test('epic delivery: the base moves while the branch CI runs; the new head is proven again before the PR opens on it', async () => {
  const env = makeRepo({ bugs: true });
  let moved = false;
  const onPush = (o) => {
    if (o.commitRecords === false && o.branch === 'bugfix/shop/cart' && !moved) {
      moved = true;
      git(o.worktree, 'commit', '-q', '--allow-empty', '-m', 'Merge the latest main');
    }
    return { pushed: true };
  };
  const f = fakeDeps(twoGroups(), { startWorker: fakeWorker().startWorker, onPush });
  await epicRun(env, f);
  assert.deepEqual(steps(f, 'bugfix/shop/cart').slice(0, 5), ['push', 'branch-ci', 'push', 'branch-ci', 'assess']);
  assert.ok(steps(f, 'bugfix/shop/cart').indexOf('open') > 3, 'opened after the second proof');
});

test('epic delivery: a check only the PR runs fails after the open: the PR goes on hold, is fixed, and is ready again when green', async () => {
  const env = makeRepo({ bugs: true });
  let failed = false;
  const ci = ({ kind, pr, fixRounds }) => {
    if (kind !== 'pr' || !pr.endsWith('/101')) return null;
    if (!failed && fixRounds === 0) {
      failed = true;
      return { state: 'failure', failing: ['pr-only'], pending: [] };
    }
    return { state: 'success', failing: [], pending: [] };
  };
  const f = fakeDeps(twoGroups(), { startWorker: fakeWorker().startWorker, ci });
  const r = await epicRun(env, f);
  assert.equal(r.epic.outcome, 'done', JSON.stringify(r.epic));
  // Already held since it opened (a bug PR opens held until rated): the fixing round runs under that hold.
  assert.deepEqual(steps(f, 'bugfix/shop/cart').slice(4), ['open', 'gate', 'pr-ci', 'pr-ci', 'ready', 'regate']);
  const holds = unitState(env, 'cart').delivery.holds;
  assert.equal(holds.length, 1);
  assert.ok(holds[0].to && holds[0].cycle === 1, JSON.stringify(holds));
});

test('epic delivery: a failure before the open escalates on the tickets with no PR (red CI that stays red, an owner question)', async () => {
  const env = makeRepo({ bugs: true });
  const ci = ({ kind, branch }) => (kind === 'branch' && branch === 'bugfix/shop/auth' ? { state: 'failure', names: ['CI'], failing: ['eShop tests'], pending: [], rounds: 1 } : null);
  const question = { id: 'Q-1', title: 'Which total wins?', question: 'the cart or the order total?' };
  const prCheck = async (uenv, keys) => ({ verdict: 'PASS', score: 10, openFindings: [], ...(keys.includes('BUG-1') ? { questions: [question] } : {}) });
  const f = fakeDeps(twoGroups(), { startWorker: fakeWorker().startWorker, ci, prCheck });
  const r = await epicRun(env, f);
  assert.equal(f.prs.length, 0, 'no PR for either group');
  assert.ok(!f.order.some((o) => o[0] === 'open'));
  const by = Object.fromEntries(r.results.map((x) => [x.key, x]));
  assert.deepEqual([by['BUG-1'].outcome, by['BUG-2'].outcome], ['needs-decision', 'needs-decision']);
  assert.match(by['BUG-3'].outcome, /^ci-/);
  assert.match(by['BUG-3'].reason, /^before its PR: /);
  // Every one of them escalates on its ticket (the question, or the CI findings), with no PR.
  assert.deepEqual(failedResults(r.results, { pr: false }).map((x) => x.key).sort(), ['BUG-1', 'BUG-2', 'BUG-3']);
  assert.equal(unitState(env, 'auth').branchPushed, true);
});

test('epic delivery: dependent groups each open finished, the later one on its blocker\'s branch, after the blocker\'s PR', async () => {
  const env = makeRepo({ bugs: true });
  const note = twoGroups({ stories: [{ key: 'BUG-3', dependsOn: ['BUG-1'] }] });
  const f = fakeDeps(note, { startWorker: fakeWorker().startWorker });
  const r = await epicRun(env, f, { parallel: 2 });
  assert.equal(r.epic.outcome, 'done', JSON.stringify(r.epic));
  const firstAuthPush = f.order.findIndex((o) => o[0] === 'push' && o[2] === 'bugfix/shop/auth');
  const cartOpen = f.order.findIndex((o) => o[0] === 'open');
  assert.ok(cartOpen >= 0 && cartOpen < firstAuthPush, 'the blocker\'s PR opened before the dependent group was pushed');
  assert.deepEqual(steps(f, 'bugfix/shop/auth'), ['push', 'branch-ci', 'push', 'assess', 'open', 'gate', 'pr-ci', 'ready', 'regate']);
  assert.equal(f.prs.find((p) => p.branch === 'bugfix/shop/auth').base, 'bugfix/shop/cart');
});

test('epic resume after the open: a run that stopped while waiting on the PR continues after the open, with no agent and no second PR', async () => {
  const env = makeRepo({ bugs: true });
  const stop = ({ kind, pr }) => {
    if (kind === 'pr' && pr.endsWith('/101')) throw new Error('the run was stopped');
    return null;
  };
  const f1 = fakeDeps(twoGroups(), { startWorker: fakeWorker().startWorker, ci: stop });
  await assert.rejects(epicRun(env, f1), /the run was stopped/);
  assert.equal(unitState(env, 'cart').delivery.phase, 'ci-wait');
  const worker = fakeWorker();
  const f2 = fakeDeps(twoGroups(), { startWorker: worker.startWorker });
  const r = await epicRun(env, f2);
  assert.equal(r.epic.outcome, 'done', JSON.stringify(r.epic));
  assert.ok(!worker.calls.some((c) => ['BUG-1', 'BUG-2'].includes(c.key)), 'no agent ran for the open PR');
  assert.equal(f2.prs.filter((p) => p.branch === 'bugfix/shop/cart').length, 0, 'not opened again');
  assert.ok(f2.order.some((o) => o[0] === 'pr-ci' && o[1].endsWith('/101')));
});

test('epic resume before the record: a PR opened right before the stop is found on the host, adopted with its rating published, never opened twice', async () => {
  const env = makeRepo({ bugs: true });
  const f1 = fakeDeps(twoGroups(), { startWorker: fakeWorker().startWorker });
  const open = f1.deps.openPr;
  // The host opened the PR; the run stopped before it could record it.
  f1.deps.openPr = (uenv, o) => {
    open(uenv, o);
    throw new Error('stopped right after the host opened the PR');
  };
  await assert.rejects(epicRun(env, f1), /stopped right after the host opened/);
  assert.equal(unitState(env, 'cart').delivery.phase, 'pre-open');
  const opened = f1.prs[0];
  const worker = fakeWorker();
  const f2 = fakeDeps(twoGroups(), { startWorker: worker.startWorker, openOnHost: (branch) => (branch === opened.branch ? { url: 'https://github.com/example/repo/pull/101', createdAt: new Date().toISOString(), draft: false } : null) });
  const r = await epicRun(env, f2);
  assert.equal(r.epic.outcome, 'done', JSON.stringify(r.epic));
  assert.equal(f2.prs.filter((p) => p.branch === 'bugfix/shop/cart').length, 0);
  assert.ok(!worker.calls.some((c) => ['BUG-1', 'BUG-2'].includes(c.key)));
  assert.equal(unitState(env, 'cart').pr, 'https://github.com/example/repo/pull/101');
  // The adopted bug PR gets its rating published before anything after the open (ADV2-15).
  const at = (k) => f2.order.findIndex((o) => o[0] === k && o[1] === 'https://github.com/example/repo/pull/101');
  assert.ok(at('gate') >= 0 && at('gate') < at('pr-ci'), JSON.stringify(f2.order));
});

test('a rating that cannot be published on the open PR holds it for a person; it is never released unrated', async () => {
  const env = makeRepo({ bugs: true });
  const f = fakeDeps(twoGroups(), { startWorker: fakeWorker().startWorker });
  f.deps.deliveryIo.publishGate = ({ pr }) => (f.order.push(['gate-failed', pr]), { status: 1, stderr: 'the gate could not reach the host' });
  const r = await epicRun(env, f);
  const cart = unitState(env, 'cart');
  assert.equal(cart.outcome, 'gate-assessment-failed', JSON.stringify(r.epic));
  assert.ok(cart.delivery.holds.some((h) => !h.to && h.ok !== false), 'held');
  assert.ok(!f.order.some((o) => o[0] === 'ready'), 'never released');
});

test('a unit\'s saved PR check counts only for the very commit it reviewed: any commit since, a records-only one too, is checked again (Sol 25)', async () => {
  for (const change of [false, true, 'metrics']) {
    const env = makeRepo({ bugs: true });
    const f1 = fakeDeps(twoGroups(), { startWorker: fakeWorker().startWorker });
    f1.deps.deliveryIo.assess = () => null;
    await epicRun(env, f1);
    assert.equal(unitState(env, 'cart').outcome, 'gate-assessment-failed');
    const wt = unitState(env, 'cart').worktree;
    if (change) {
      const file = change === 'metrics' ? '.factory/metrics/a-person.jsonl' : 'src/a-person.cs';
      write(wt, file, '// a person\'s change after the check\n');
      git(wt, 'add', '-f', file);
      git(wt, 'commit', '-qm', 'a person');
    }
    const f2 = fakeDeps(twoGroups(), { startWorker: fakeWorker().startWorker });
    await epicRun(env, f2);
    assert.equal(f2.checks.some((k) => k.includes('BUG-1')), Boolean(change), change ? `checked again (${change})` : 'the saved verdict stands');
  }
});

test('epic join: a reopened ticket of a group whose PR is open puts the PR on hold before any agent runs, then the PR is proven and ready again', async () => {
  const env = makeRepo({ bugs: true });
  const origin = path.join(env.tmp, 'origin.git');
  git(env.tmp, 'init', '-q', '--bare', origin);
  git(env.repo, 'remote', 'add', 'origin', origin);
  const note = { summary: 'one area', stories: [], prGroups: [{ id: 'cart', title: 'Cart', tickets: ['BUG-1', 'BUG-2', 'BUG-3'], reason: 'same area', risk: 'low' }] };
  const onPush = (o) => (git(o.worktree, 'push', '-q', 'origin', `HEAD:refs/heads/${o.branch}`), { pushed: true });
  const f = fakeDeps(note, { startWorker: fakeWorker().startWorker, onPush });
  await epicRun(env, f);
  assert.equal(loadEpicRun(env.config, 'epic-shop').status, 'delivered');
  const bug1 = env.tickets.find((t) => t.key === 'BUG-1');
  assert.equal(epicToJoin(env.config, [bug1], { reopen: true, prOpen: () => true }).unit.branch, 'bugfix/shop/cart');
  git(env.repo, 'worktree', 'remove', '--force', path.join(env.tmp, 'shop-worktrees', 'bug-1'));
  git(env.repo, 'branch', '-D', 'feat/bug-1');
  const order = [];
  const again = fakeWorker({ files: { 'BUG-1': 'src/BUG-1-reopen-fix.cs' } });
  const startWorker = (config, s) => (order.push(['agent', s.key]), again.startWorker(config, s));
  const f2 = fakeDeps(note, { startWorker, onPush });
  const realHold = f2.deps.deliveryIo.hold;
  f2.deps.deliveryIo.hold = (pr, o) => (order.push(['hold', pr]), realHold(pr, o));
  const j = await runEpic(env.config, { epic: env.epic, tickets: [bug1], inputs: [env.inputs[env.tickets.indexOf(bug1)]], base: 'main', only: ['BUG-1'], force: true, pr: true, deps: f2.deps, log: () => {} });
  assert.equal(j.epic.outcome, 'joined');
  assert.deepEqual(order.map((o) => o[0]), ['hold', 'agent'], 'the PR was on hold before the agent started');
  assert.equal(f2.parities.length, 1, 'the joined re-run runs CI parity like every group delivery (Sol 34)');
  assert.equal(f2.prs.length, 0, 'the open PR is never opened again');
  assert.deepEqual(f2.order.map((o) => o[0]).filter((k) => k !== 'hold'), ['push', 'branch-ci', 'push', 'assess', 'update-body', 'gate', 'pr-ci', 'ready', 'regate']);
  assert.equal(git(env.repo, 'rev-parse', 'bugfix/shop/cart'), git(origin, 'rev-parse', 'bugfix/shop/cart'), 'the group branch was pushed');
  assert.deepEqual(f2.gates.map((g) => [g.pr, g.keys]), [['https://github.com/example/repo/pull/101', ['BUG-1', 'BUG-2', 'BUG-3']]]);
  assert.ok(f2.board.some((b) => b[0] === 'BUG-1' && b[1] === 'review' && b.includes('https://github.com/example/repo/pull/101')));
});

test('ADV-1 (D3) epic join: an unconfirmed hold stops before any agent runs, and an earlier failed hold does not count as held on retry', async () => {
  const env = makeRepo({ bugs: true });
  const origin = path.join(env.tmp, 'origin.git');
  git(env.tmp, 'init', '-q', '--bare', origin);
  git(env.repo, 'remote', 'add', 'origin', origin);
  const note = { summary: 'one area', stories: [], prGroups: [{ id: 'cart', title: 'Cart', tickets: ['BUG-1', 'BUG-2', 'BUG-3'], reason: 'same area', risk: 'low' }] };
  const onPush = (o) => (git(o.worktree, 'push', '-q', 'origin', `HEAD:refs/heads/${o.branch}`), { pushed: true });
  const f = fakeDeps(note, { startWorker: fakeWorker().startWorker, onPush });
  await epicRun(env, f);
  const bug1 = env.tickets.find((t) => t.key === 'BUG-1');
  git(env.repo, 'worktree', 'remove', '--force', path.join(env.tmp, 'shop-worktrees', 'bug-1'));
  git(env.repo, 'branch', '-D', 'feat/bug-1');

  // Attempt 1: host fails to confirm hold -> must stop with hold-failed before any agent runs.
  const order1 = [];
  const fFail = fakeDeps(note, { startWorker: (c, s) => (order1.push(['agent', s.key]), fakeWorker().startWorker(c, s)), onPush });
  fFail.deps.deliveryIo.hold = (pr, o) => (order1.push(['hold-failed', pr]), { mode: o.mode, ok: false, from: new Date().toISOString(), why: o.why });
  const jFail = await runEpic(env.config, { epic: env.epic, tickets: [bug1], inputs: [env.inputs[env.tickets.indexOf(bug1)]], base: 'main', only: ['BUG-1'], force: true, pr: true, deps: fFail.deps, log: () => {} });
  assert.equal(jFail.epic.outcome, 'hold-failed');
  assert.equal(jFail.results[0].outcome, 'hold-failed');
  assert.deepEqual(order1.map((o) => o[0]), ['hold-failed'], 'no agent may run when hold is not confirmed');
  assert.equal(unitState(env, 'cart').outcome, 'hold-failed');
  assert.equal(unitState(env, 'cart').delivery.holds.at(-1).ok, false);

  // Attempt 2: prior failed hold (no `to`, `ok: false`) must NOT count as already on hold -> retries hold, then runs.
  const order2 = [];
  const again = fakeWorker({ files: { 'BUG-1': 'src/BUG-1-reopen-fix.cs' } });
  const fOk = fakeDeps(note, { startWorker: (c, s) => (order2.push(['agent', s.key]), again.startWorker(c, s)), onPush });
  const realHold = fOk.deps.deliveryIo.hold;
  fOk.deps.deliveryIo.hold = (pr, o) => (order2.push(['hold', pr]), realHold(pr, o));
  const jOk = await runEpic(env.config, { epic: env.epic, tickets: [bug1], inputs: [env.inputs[env.tickets.indexOf(bug1)]], base: 'main', only: ['BUG-1'], force: true, pr: true, deps: fOk.deps, log: () => {} });
  assert.equal(jOk.epic.outcome, 'joined');
  assert.deepEqual(order2.map((o) => o[0]), ['hold', 'agent'], 'must re-attempt hold after prior failed hold before running agent');
});

test('epic re-delivery: a group whose PR stayed on hold after a failed fix is delivered again on that PR, never opened twice', async () => {
  const env = makeRepo({ bugs: true });
  const red = ({ kind, pr }) => (kind === 'pr' && pr.endsWith('/101') ? { state: 'failure', failing: ['pr-only'], pending: [] } : null);
  const f1 = fakeDeps(twoGroups(), { startWorker: fakeWorker().startWorker, ci: red });
  const r1 = await epicRun(env, f1);
  assert.notEqual(r1.epic.outcome, 'done');
  const held = unitState(env, 'cart');
  assert.ok(held.delivery.holds.some((h) => !h.to), 'the PR stays on hold for a person');
  for (const k of ['bug-1', 'bug-2', 'bug-3']) {
    git(env.repo, 'worktree', 'remove', '--force', path.join(env.tmp, 'shop-worktrees', k));
    git(env.repo, 'branch', '-D', `feat/${k}`);
  }
  const order = [];
  const again = fakeWorker({ files: { 'BUG-1': 'src/BUG-1-again.cs', 'BUG-2': 'src/BUG-2-again.cs', 'BUG-3': 'src/BUG-3-again.cs' } });
  const startWorker = (config, s) => (order.push(['agent', s.key]), again.startWorker(config, s));
  const f2 = fakeDeps(twoGroups(), { startWorker, prState: () => 'OPEN' });
  const r2 = await epicRun(env, f2, { force: true });
  assert.equal(r2.epic.outcome, 'done', JSON.stringify(r2.epic));
  const cart = steps(f2, 'bugfix/shop/cart');
  assert.ok(!cart.includes('open') && cart.includes('update-body') && cart.includes('ready'), cart.join(','));
  assert.ok(unitState(env, 'cart').delivery.holds.every((h) => h.to), 'released once green');
});

// The epic counterparts of ADV-30 and ADV-33: a unit's kept hold whose release was attempted but never confirmed is not
// trusted (the PR may already be ready on the host), and an unreadable PR state counts as open (fail closed).
const redCartThenClean = async (env) => {
  const red = ({ kind, pr }) => (kind === 'pr' && pr.endsWith('/101') ? { state: 'failure', failing: ['pr-only'], pending: [] } : null);
  await epicRun(env, fakeDeps(twoGroups(), { startWorker: fakeWorker().startWorker, ci: red }));
  for (const k of ['bug-1', 'bug-2', 'bug-3']) {
    git(env.repo, 'worktree', 'remove', '--force', path.join(env.tmp, 'shop-worktrees', k));
    git(env.repo, 'branch', '-D', `feat/${k}`);
  }
};
const patchCartHolds = (env, fn) => saveEpicRun(env.config, env.epic.key, (cur) => ({ ...cur, units: { ...cur.units, cart: { ...cur.units.cart, delivery: { ...cur.units.cart.delivery, holds: cur.units.cart.delivery.holds.map(fn) } } } }));
const tracked = (order, extra = {}) => {
  const again = fakeWorker({ files: { 'BUG-1': 'src/BUG-1-again.cs', 'BUG-2': 'src/BUG-2-again.cs', 'BUG-3': 'src/BUG-3-again.cs' } });
  const f = fakeDeps(twoGroups(), { startWorker: (config, s) => (order.push(['agent', s.key]), again.startWorker(config, s)), ...extra });
  const realHold = f.deps.deliveryIo.hold;
  f.deps.deliveryIo.hold = (pr, o) => (order.push(['hold', pr]), extra.hold ? extra.hold(pr, o) : realHold(pr, o));
  return f;
};
const cartPr = 'https://github.com/example/repo/pull/101';

test('epic unit: a kept hold whose release is unconfirmed is held and confirmed again before any agent runs', async () => {
  const env = makeRepo({ bugs: true });
  await redCartThenClean(env);
  patchCartHolds(env, (h) => (h.to ? h : { ...h, releaseConfirmed: false, releaseFailedAt: new Date().toISOString() }));
  assert.ok(unitState(env, 'cart').delivery.holds.some((h) => !h.to && h.releaseConfirmed === false));
  const order = [];
  const r = await epicRun(env, tracked(order, { prState: () => 'OPEN' }), { force: true });
  assert.equal(r.epic.outcome, 'done', JSON.stringify(r.epic));
  const hold = order.findIndex((o) => o[0] === 'hold' && o[1] === cartPr);
  const agent = order.findIndex((o) => o[0] === 'agent' && ['BUG-1', 'BUG-2'].includes(o[1]));
  assert.ok(hold >= 0 && hold < agent, `the PR is held again before the agents: ${JSON.stringify(order)}`);
});

test('epic unit: an unreadable PR state counts as open; a hold that cannot be confirmed stops the unit with hold-failed and no agent', async () => {
  const env = makeRepo({ bugs: true });
  await redCartThenClean(env);
  patchCartHolds(env, (h) => (h.to ? h : { ...h, to: new Date().toISOString(), releaseConfirmed: true }));
  const order = [];
  const f = tracked(order, { prState: () => 'UNKNOWN', hold: (pr, o) => ({ mode: o.mode, ok: false, from: new Date().toISOString(), why: o.why }) });
  await epicRun(env, f, { force: true });
  assert.ok(order.some((o) => o[0] === 'hold' && o[1] === cartPr), `the unreadable PR is held first: ${JSON.stringify(order)}`);
  assert.ok(!order.some((o) => o[0] === 'agent' && ['BUG-1', 'BUG-2'].includes(o[1])), `no agent on the cart unit: ${JSON.stringify(order)}`);
  assert.equal(unitState(env, 'cart').outcome, 'hold-failed');
  // The real read: a host that cannot be read is UNKNOWN, never "not open".
  assert.equal(defaultDeps({ ...env.config, host: { type: 'no-such-host' } }, () => {}).prState(cartPr), 'UNKNOWN');
});

test('epic delivery: the ready audit covers the unit\'s tickets; an agent run of one of them after ready is reported', async () => {
  const env = makeRepo({ bugs: true });
  const later = new Date(Date.now() + 60_000).toISOString();
  const f = fakeDeps(twoGroups(), { startWorker: fakeWorker().startWorker, usage: [{ story: 'BUG-2', agent: 'implementer', ts: later, seconds: 1 }] });
  await epicRun(env, f);
  const audit = unitState(env, 'cart').delivery.readyAudit;
  assert.equal(audit.ok, false);
  assert.deepEqual(audit.after.map((a) => a.agent), ['implementer']);
  assert.equal(unitState(env, 'auth').delivery.readyAudit.ok, true, 'another unit\'s tickets do not count');
});

test('feature epic delivery: the epic PR opens finished too (no gate rating for a feature)', async () => {
  const env = makeRepo();
  const f = fakeDeps(featureNote, { startWorker: fakeWorker().startWorker });
  const r = await epicRun(env, f, { parallel: 2 });
  assert.equal(r.epic.outcome, 'done', JSON.stringify(r));
  assert.deepEqual(f.order.map((o) => o[0]), ['push', 'branch-ci', 'push', 'open', 'pr-ci']);
  // Every PR gets the CI parity run before delivery, the epic's one PR included, and its result is in the body.
  assert.deepEqual(f.parities, ['--stories DEMO-1,DEMO-2,DEMO-3']);
  assert.match(f.prs[0].body, /CI checks run before this PR: all 1 passed \(lint\)/);
});

test('epic delivery: implement.ci.parity.enabled false turns a feature epic\'s parity run off, as for a single ticket; a bug group runs it always', async () => {
  for (const bugs of [false, true]) {
    const env = makeRepo({ bugs });
    env.config.implement.ci = { ...env.config.implement.ci, parity: { enabled: false } };
    const f = fakeDeps(bugs ? twoGroups() : featureNote, { startWorker: fakeWorker().startWorker });
    const r = await epicRun(env, f);
    assert.equal(r.epic.outcome, 'done', JSON.stringify(r.epic));
    assert.ok(f.prs.length >= 1);
    if (bugs) assert.deepEqual(f.parities.sort(), ['--stories BUG-1,BUG-2', '--stories BUG-3'], 'bug groups: the setting does not apply');
    else assert.deepEqual(f.parities, [], 'feature epic');
  }
});

test('openPr never opens or pushes to a PR that is already open', async () => {
  const { openPr } = await import('../lib/epic.mjs');
  await assert.rejects(openPr({ worktree: os.tmpdir(), branch: 'bugfix/shop/cart', prBase: 'main' }, { title: 't', body: 'b', existing: 'https://github.com/example/repo/pull/7' }), /already open; it is re-delivered on hold/);
});

// ---------------------------------------------------------------------------------------------
// A feature epic's PR split (implement.epic.prSplit, --pr-split): one PR for the epic (default), one per story, or
// groups the orchestrator chooses (validated like bug-epic groups, capped by implement.epic.maxTicketsPerGroup). Every
// PR still opens once, after every agent stage, on a CI-proven head (the same delivery); the cross-story journeys are
// verified on one group, stacked on the others that hold a journey story.
// ---------------------------------------------------------------------------------------------

test('deliveryShape: a feature epic follows prSplit; a bug epic ignores it; --grouping still overrides', () => {
  const feats = [{ key: 'A-1' }, { key: 'A-2' }];
  assert.deepEqual(deliveryShape(feats), { kind: 'epic' }, 'default: one PR');
  assert.deepEqual(deliveryShape(feats, 'auto', 'story'), { kind: 'groups', planned: false, feature: true });
  assert.deepEqual(deliveryShape(feats, 'auto', 'groups'), { kind: 'groups', planned: true, feature: true });
  assert.deepEqual(deliveryShape([{ key: 'BUG-1' }, { key: 'BUG-2' }], 'auto', 'story'), { kind: 'groups', planned: true });
  assert.deepEqual(deliveryShape(feats, 'epic', 'groups'), { kind: 'epic' });
});

test('journeyGroup: the last group holding a journey story verifies every journey, stacked on the other holders', () => {
  const groups = [{ id: 'a', tickets: ['K-1'] }, { id: 'b', tickets: ['K-2'] }, { id: 'c', tickets: ['K-3'] }];
  const deps = new Map([['a', []], ['b', ['a']], ['c', []]]);
  assert.deepEqual(journeyGroup(groups, deps, [{ stories: ['K-1', 'K-2'] }]), { id: 'b', added: [] }, 'b already stacks on a');
  assert.deepEqual(journeyGroup(groups, deps, [{ stories: ['K-1', 'K-3'] }]), { id: 'c', added: ['a'] });
  assert.equal(journeyGroup(groups, deps, []), null);
});

test('feature epic, prSplit story: the design note is planned once, then one PR per story on feature branches, no bug rating, journeys on one story\'s PR', async () => {
  const env = makeRepo();
  const fvs = [];
  const f = fakeDeps(featureNote, { startWorker: fakeWorker().startWorker, epicFv: async (uenv, { key, note }) => (fvs.push({ unit: uenv.unit.id, key, journeys: note.journeys.map((j) => j.id) }), { status: 'verified', key }) });
  const r = await epicRun(env, f, { prSplit: 'story' });
  assert.equal(r.epic.outcome, 'done', JSON.stringify(r.epic));
  assert.equal(f.agentCalls.length, 1);
  assert.match(f.agentCalls[0].task, /delivered as one PR per story/);
  assert.doesNotMatch(f.agentCalls[0].task, /prGroups|bug epic/);
  assert.deepEqual(f.prs.map((p) => p.branch).sort(), ['feat/shop--demo-1', 'feat/shop--demo-2', 'feat/shop--demo-3']);
  assert.ok(!f.order.some((o) => o[0] === 'assess' || o[0] === 'gate'), 'a feature PR gets no bug-fix rating');
  for (const b of ['feat/shop--demo-1', 'feat/shop--demo-2', 'feat/shop--demo-3']) assert.deepEqual(steps(f, b), ['push', 'branch-ci', 'push', 'open', 'pr-ci'], b);
  assert.equal(f.order.filter((o) => o[0] === 'open').length, 3, 'each PR opened once');
  assert.deepEqual(f.parities.sort(), ['--stories DEMO-1', '--stories DEMO-2', '--stories DEMO-3'], 'each PR of a split epic gets the CI parity run');
  // DEMO-2 is blocked by DEMO-1: its PR is stacked on DEMO-1's branch and verifies the journey that crosses both.
  assert.equal(f.prs.find((p) => p.branch === 'feat/shop--demo-2').base, 'feat/shop--demo-1');
  assert.deepEqual(fvs, [{ unit: 'demo-2', key: 'EPIC-10', journeys: ['browse-to-basket'] }]);
  assert.match(f.prs.find((p) => p.branch === 'feat/shop--demo-1').title, /^Shop: .*\(DEMO-1\)$/);
  const decisions = readJsonl(path.join(env.repo, '.factory/metrics/decisions.jsonl'));
  assert.ok(decisions.some((d) => d.decision === 'pr-groups' && /prSplit "story"/.test(d.reason)));
  assert.equal(unitState(env, 'demo-2').journeys, true);
});

test('feature epic, prSplit groups: the orchestrator groups the stories; a journey across groups is verified on the closing group, stacked on the other', async () => {
  const env = makeRepo();
  const fvs = [];
  const note = { ...featureNote, journeys: [{ id: 'catalog-to-order', title: 'Browse then order', stories: ['DEMO-1', 'DEMO-3'], steps: ['open catalog', 'order'], expected: 'order placed' }], prGroups: [{ id: 'browse', title: 'Catalog and basket', tickets: ['DEMO-1', 'DEMO-2'], reason: 'the basket builds on the catalog', risk: 'low' }, { id: 'orders', title: 'Ordering', tickets: ['DEMO-3'], reason: 'another service', risk: 'low' }] };
  const f = fakeDeps(note, { startWorker: fakeWorker().startWorker, epicFv: async (uenv, { key, note: n }) => (fvs.push({ unit: uenv.unit.id, key, journeys: n.journeys.map((j) => j.id) }), { status: 'verified', key }) });
  const r = await epicRun(env, f, { prSplit: 'groups' });
  assert.equal(r.epic.outcome, 'done', JSON.stringify(r.epic));
  assert.match(f.agentCalls[0].task, /delivered as several PRs[\s\S]*prGroups/);
  assert.deepEqual(f.prs.map((p) => p.branch).sort(), ['feat/shop--browse', 'feat/shop--orders']);
  const orders = f.prs.find((p) => p.branch === 'feat/shop--orders');
  assert.equal(orders.base, 'feat/shop--browse', 'stacked on the group holding the other journey story');
  assert.match(orders.title, /^Shop: Ordering \(DEMO-3\)$/);
  assert.deepEqual(fvs, [{ unit: 'orders', key: 'EPIC-10', journeys: ['catalog-to-order'] }]);
  assert.deepEqual(unitState(env, 'orders').deps, ['browse']);
  assert.ok(!f.order.some((o) => o[0] === 'assess'));
  assert.ok(f.order.filter((o) => o[0] === 'open').length === 2);
});

test('feature epic, prSplit groups: a group over the cap, or a foundation, is rejected; a grouping rejected twice falls back to one PR per story', async () => {
  const keys = ['DEMO-1', 'DEMO-2', 'DEMO-3'];
  const stories = keys.map((key) => ({ key, blockedBy: key === 'DEMO-2' ? ['DEMO-1'] : [] }));
  const big = { stories: [], prGroups: [{ id: 'all', title: 'All', tickets: keys }] };
  const v = validateNote(big, { keys, groups: true, stories, maxPerGroup: 2, featureGroups: true });
  assert.ok(v.groupErrors.some((e) => /more than implement\.epic\.maxTicketsPerGroup \(2\)/.test(e)), v.errors.join('; '));
  const withFoundation = validateNote({ ...big, prGroups: [{ id: 'a', title: 'A', tickets: keys }], foundation: { goal: 'g', owns: ['src/x/**'] } }, { keys, groups: true, stories, featureGroups: true });
  assert.ok(withFoundation.noteErrors.some((e) => /foundation must be null/.test(e)));
  const env = makeRepo();
  env.config.implement.epic = { ...env.config.implement.epic, maxTicketsPerGroup: 2 };
  const f = fakeDeps({ ...featureNote, prGroups: big.prGroups }, { startWorker: fakeWorker().startWorker });
  const r = await epicRun(env, f, { prSplit: 'groups' });
  assert.equal(r.epic.outcome, 'done', JSON.stringify(r.epic));
  assert.equal(f.agentCalls.length, 2, 'asked again once');
  assert.match(f.agentCalls[0].task, /at most 2 stories per group/);
  assert.match(f.agentCalls[1].task, /previous note was rejected/);
  assert.equal(f.prs.length, 3, 'one PR per story');
});

// A crash after the PR opened (the run summary's PR state read threw `host.ownsPr is not a function`): the epic state is
// saved as interrupted with the phase and the reason, never left `running`, and the checkout's own records (the epic
// plan's usage and decisions) are shipped even so.
test('epic run: a step that throws after the PR opened leaves a resumable interrupted state and ships the plan records', async () => {
  const env = makeRepo();
  const note = { ...featureNote, journeys: [], prGroups: [{ id: 'all', title: 'Shop: catalog, basket and orders', tickets: ['DEMO-1', 'DEMO-2', 'DEMO-3'], reason: 'one feature', risk: 'low' }] };
  const f = fakeDeps(note, { startWorker: fakeWorker().startWorker, prState: () => { throw new TypeError('host.ownsPr is not a function'); } });
  await assert.rejects(() => epicRun(env, f, { prSplit: 'groups' }), /ownsPr is not a function/);
  const state = loadEpicRun(env.config, env.epic.key);
  assert.equal(state.status, 'interrupted');
  assert.equal(state.outcome, 'crashed');
  assert.equal(state.phase, 'summary', 'the phase it stopped in is saved');
  assert.match(state.reason, /summary stopped: host\.ownsPr is not a function/);
  assert.equal(state.pid, null);
  assert.equal(state.plan?.ok, true, 'the plan is kept for the resume');
  assert.equal(unitState(env, 'all').status, 'done', 'the delivered group is kept');
  assert.ok(f.ships.includes(env.config.root), 'the main checkout (epic plan records) is shipped');
  assert.equal(f.prs.length, 1);
  assert.equal(f.prs[0].title, 'Shop: catalog, basket and orders (DEMO-1, DEMO-2, DEMO-3)', 'the epic title is not repeated');
  // The resume (fixed host): the delivered group is not delivered again, no agent runs, the epic ends delivered.
  const agentsBefore = f.agentCalls.length;
  const g = fakeDeps(note, { startWorker: () => { throw new Error('no worker may start on this resume'); }, prState: () => 'OPEN' });
  const r = await epicRun(env, g, { prSplit: 'groups' });
  assert.equal(r.epic.outcome, 'done', JSON.stringify(r.epic));
  assert.equal(g.agentCalls.length, 0);
  assert.equal(f.agentCalls.length, agentsBefore);
  assert.equal(g.prs.length, 0, 'no second PR');
  const end = loadEpicRun(env.config, env.epic.key);
  assert.equal(end.status, 'delivered');
  assert.equal(end.phase, 'finished');
});

test('featureGroupTitle: the epic title is never repeated', () => {
  assert.equal(featureGroupTitle('Shop by brand', 'Shop by brand: Brands page and sorting', ['B-1', 'B-2']), 'Shop by brand: Brands page and sorting (B-1, B-2)');
  assert.equal(featureGroupTitle('Shop by brand', 'Shop by Brand', ['B-1']), 'Shop by Brand (B-1)');
  assert.equal(featureGroupTitle('Shop', 'Ordering', ['D-3']), 'Shop: Ordering (D-3)');
});

// The live epic run: the unit PR check in fix mode ended ESCALATED 8/10 with three major findings, and the group PR still
// opened ready. An unfinished change never gets a PR (the single delivery's pre-open rule): the branch is pushed, the
// findings go on the tickets, and the run says why.
test('epic delivery: a unit PR check that ends escalated in fix mode opens no PR; the branch is pushed and the findings stay on the tickets', async () => {
  const env = makeRepo();
  env.config.prCheck = { ...env.config.prCheck, mode: 'fix' };
  const note = { ...featureNote, journeys: [], prGroups: [{ id: 'all', title: 'Everything', tickets: ['DEMO-1', 'DEMO-2', 'DEMO-3'], reason: 'one feature', risk: 'low' }] };
  const escalated = { status: 'done', mode: 'fix', verdict: 'ESCALATED', score: 8, openFindings: [{ id: 'VID-1', severity: 'major', title: 'UI cases without videos' }, { id: 'VID-4', severity: 'minor', title: 'a caption is terse' }] };
  const fixFlags = [];
  const f = fakeDeps(note, { startWorker: fakeWorker().startWorker, prCheck: async (e, keys, o) => (fixFlags.push(o?.fix), escalated) });
  const r = await epicRun(env, f, { prSplit: 'groups' });
  assert.deepEqual([...new Set(fixFlags)], [true], 'the unit check follows prCheck.mode (fix)');
  assert.equal(f.prs.length, 0, 'no PR opens');
  assert.ok(!f.order.some((o) => o[0] === 'open'));
  assert.ok(f.order.some((o) => o[0] === 'push'), 'the branch is pushed');
  assert.notEqual(r.epic.outcome, 'done');
  assert.match(r.epic.reason, /PR check ended ESCALATED \(8\/10\) with 1 finding\(s\) at major or worse still upheld/);
  // Report mode reports: the same verdict goes into the PR as it is.
  assert.equal(prCheckHold(escalated, { mode: 'report' }), null);
  assert.equal(prCheckHold({ status: 'done', verdict: 'PASS', score: 9, openFindings: [{ id: 'X', severity: 'minor', title: 't' }] }, { mode: 'fix' }), null);
  assert.equal(prCheckHold({ status: 'done', verdict: 'FAIL', score: 7, openFindings: [{ id: 'X', severity: 'blocking', title: 't' }] }, { mode: 'fix' }).outcome, 'pr-check-escalated');
});

// ---- round 3 ---------------------------------------------------------------------------------------------------------

test('epic unit: a kept hold the host no longer shows (a person released it) is held again before any agent (Sol 26)', async () => {
  const env = makeRepo({ bugs: true });
  await redCartThenClean(env);
  assert.ok(unitState(env, 'cart').delivery.holds.some((h) => !h.to && h.ok !== false && h.releaseConfirmed !== false), 'a kept hold');
  const order = [];
  const f = tracked(order, { prState: () => 'OPEN' });
  f.deps.deliveryIo.confirmHold = (pr) => (order.push(['confirm', pr]), false);
  await epicRun(env, f, { force: true });
  const confirm = order.findIndex((o) => o[0] === 'confirm' && o[1] === cartPr);
  const hold = order.findIndex((o) => o[0] === 'hold' && o[1] === cartPr);
  const agent = order.findIndex((o) => o[0] === 'agent' && ['BUG-1', 'BUG-2'].includes(o[1]));
  assert.ok(confirm >= 0 && confirm < hold && hold < agent, `confirmed, held again, then the agents: ${JSON.stringify(order)}`);
});

test('epic resume after a recorded open: the rating is published first, then only the steps after the open; a person\'s push is taken or the group stops (Sol 23, Sol 24, Sol 37)', async () => {
  const env = makeRepo({ bugs: true });
  const f1 = fakeDeps(twoGroups(), { startWorker: fakeWorker().startWorker });
  // The host returned the PR and the run recorded it; it stopped before the rating was published.
  f1.deps.deliveryIo.confirmHold = () => {
    throw new Error('the run was stopped after the open was recorded');
  };
  await assert.rejects(epicRun(env, f1), /stopped after the open was recorded/);
  const d = unitState(env, 'cart').delivery;
  assert.deepEqual([d.phase, d.pr, d.opened], ['pre-open', cartPr, true]);
  const worker = fakeWorker();
  const f2 = fakeDeps(twoGroups(), { startWorker: worker.startWorker });
  const r = await epicRun(env, f2);
  assert.equal(r.epic.outcome, 'done', JSON.stringify(r.epic));
  assert.ok(!worker.calls.some((c) => ['BUG-1', 'BUG-2'].includes(c.key)), 'no agent ran on the open PR');
  assert.equal(f2.prs.filter((p) => p.branch === 'bugfix/shop/cart').length, 0, 'not opened again');
  const at = (k) => f2.order.findIndex((o) => o[0] === k && o[1] === cartPr);
  assert.ok(at('gate') >= 0 && at('gate') < at('pr-ci'), JSON.stringify(f2.order));
  // The remote cannot be read on a later resume of an open group: it stops, nothing runs.
  const f3 = fakeDeps(twoGroups(), { startWorker: worker.startWorker, remote: () => ({ stop: 'origin/bugfix/shop/cart could not be read' }) });
  saveEpicRun(env.config, env.epic.key, (cur) => ({ ...cur, status: 'running', units: { ...cur.units, cart: { ...cur.units.cart, status: 'running', delivery: { ...cur.units.cart.delivery, phase: 'ci-wait' } } } }));
  await epicRun(env, f3);
  assert.equal(unitState(env, 'cart').outcome, 'error');
  assert.match(unitState(env, 'cart').reason, /could not be read; nothing ran/);
  assert.ok(!f3.order.some((o) => o[0] === 'pr-ci' && o[1] === cartPr));
});


// ---- round 4 -----------------------------------------------------------------------------------------------------------

test('epic unit: a known PR with a recorded close-reopen hold is held and confirmed before any agent, also when the host says CLOSED (resuming-26)', async () => {
  const env = makeRepo({ bugs: true });
  await redCartThenClean(env);
  patchCartHolds(env, (h) => (h.to ? h : { ...h, mode: 'close-reopen' }));
  const order = [];
  const f = tracked(order, { prState: () => 'CLOSED' });
  f.deps.deliveryIo.confirmHold = (pr) => (order.push(['confirm', pr]), true);
  await epicRun(env, f, { force: true });
  const confirm = order.findIndex((o) => o[0] === 'confirm' && o[1] === cartPr);
  const agent = order.findIndex((o) => o[0] === 'agent' && ['BUG-1', 'BUG-2'].includes(o[1]));
  assert.ok(confirm >= 0 && (agent < 0 || confirm < agent), `confirmed before any agent: ${JSON.stringify(order)}`);
});

test('epic unit: a delivery that pushed but has no PR reads the remote head first; unreadable stops the unit (resuming-23)', async () => {
  const env = makeRepo({ bugs: true });
  const f1 = fakeDeps(twoGroups(), { startWorker: fakeWorker().startWorker });
  f1.deps.deliveryIo.assess = () => null;
  await epicRun(env, f1);
  assert.equal(unitState(env, 'cart').outcome, 'gate-assessment-failed');
  assert.equal(unitState(env, 'cart').delivery.pr ?? null, null, 'no PR');
  const asked = [];
  const f2 = fakeDeps(twoGroups(), { startWorker: fakeWorker().startWorker, remote: (branch) => (asked.push(branch), { stop: `origin/${branch} could not be read` }) });
  await epicRun(env, f2);
  assert.ok(asked.includes('bugfix/shop/cart'));
  assert.equal(unitState(env, 'cart').outcome, 'error');
  assert.ok(!f2.order.some((o) => o[0] === 'open' || (o[0] === 'gate' && o[1]?.endsWith?.('/101'))));
});

test('epic resume after the open whose branch a person moved: the unit\'s PR check and rating run again on it with the PR held, not only the CI wait (resuming-24)', async () => {
  const env = makeRepo({ bugs: true });
  const stop = ({ kind, pr }) => {
    if (kind === 'pr' && pr.endsWith('/101')) throw new Error('the run was stopped');
    return null;
  };
  const f1 = fakeDeps(twoGroups(), { startWorker: fakeWorker().startWorker, ci: stop });
  await assert.rejects(epicRun(env, f1), /the run was stopped/);
  assert.equal(unitState(env, 'cart').delivery.phase, 'ci-wait');
  // A person's commit on the PR's branch, taken into the unit's checkout by the resume.
  const wt = unitState(env, 'cart').worktree;
  write(wt, 'src/a-person.cs', '// a person\'s fix\n');
  git(wt, 'add', 'src/a-person.cs');
  git(wt, 'commit', '-qm', 'a person');
  const f2 = fakeDeps(twoGroups(), { startWorker: fakeWorker().startWorker, prState: () => 'OPEN', remote: (branch) => (branch === 'bugfix/shop/cart' ? { head: git(wt, 'rev-parse', 'HEAD'), moved: true } : { head: null, moved: false }) });
  await epicRun(env, f2);
  assert.ok(f2.checks.some((k) => k.includes('BUG-1')), 'the PR check ran again on the new head');
  // Re-delivered on the same PR (its hold confirmed on the host, never released before): rated again, then released.
  const cart = f2.order.slice(0, f2.order.findIndex((o) => o[0] === 'regate'));
  const idx = (k) => cart.findIndex((o) => o[0] === k);
  assert.ok(idx('assess') >= 0 && idx('update-body') > idx('assess') && idx('gate') > idx('update-body') && idx('ready') > idx('gate'), `rated again before the release: ${JSON.stringify(cart)}`);
  assert.ok(!cart.some((o) => o[0] === 'open'), 'never opened again');
});

// ---- round 5 -----------------------------------------------------------------------------------------------------------

test('epic resume: a checkout already brought to a person\'s commit is compared with what the run pushed, so the stages run again (resuming-24)', async () => {
  const env = makeRepo({ bugs: true });
  const stop = ({ kind, pr }) => {
    if (kind === 'pr' && pr.endsWith('/101')) throw new Error('the run was stopped');
    return null;
  };
  const f1 = fakeDeps(twoGroups(), { startWorker: fakeWorker().startWorker, ci: stop });
  await assert.rejects(epicRun(env, f1), /the run was stopped/);
  const wt = unitState(env, 'cart').worktree;
  assert.equal(unitState(env, 'cart').delivery.deliveredHead, git(wt, 'rev-parse', 'HEAD'));
  write(wt, 'src/a-person.cs', '// a person\'s fix\n');
  git(wt, 'add', 'src/a-person.cs');
  git(wt, 'commit', '-qm', 'a person');
  // The remote is at the person's commit, and so is this checkout already: `moved` alone says nothing changed.
  const f2 = fakeDeps(twoGroups(), { startWorker: fakeWorker().startWorker, prState: () => 'OPEN', remote: (branch) => (branch === 'bugfix/shop/cart' ? { head: git(wt, 'rev-parse', 'HEAD'), moved: false } : { head: null, moved: false }) });
  await epicRun(env, f2);
  assert.ok(f2.checks.some((k) => k.includes('BUG-1')), 'the PR check ran again on the person\'s commit');
  const cart = f2.order.slice(0, f2.order.findIndex((o) => o[0] === 'regate'));
  assert.ok(cart.some((o) => o[0] === 'assess') && !cart.some((o) => o[0] === 'open'), `rated again on the same PR, never opened again: ${JSON.stringify(cart)}`);
});

test('epic resume: a PR the earlier run opened but did not record is not adopted past a person\'s push; it is held and the stages run again (Gemini resume follow-up)', async () => {
  const env = makeRepo({ bugs: true });
  const f1 = fakeDeps(twoGroups(), { startWorker: fakeWorker().startWorker });
  f1.deps.deliveryIo.assess = () => null;
  await epicRun(env, f1);
  assert.equal(unitState(env, 'cart').delivery.phase, 'pre-open');
  assert.equal(unitState(env, 'cart').delivery.pr ?? null, null);
  const wt = unitState(env, 'cart').worktree;
  write(wt, 'src/a-person.cs', '// a person\'s fix\n');
  git(wt, 'add', 'src/a-person.cs');
  git(wt, 'commit', '-qm', 'a person');
  const found = { url: 'https://github.com/example/repo/pull/150', createdAt: '2026-11-20T01:00:00.000Z', draft: true };
  const f2 = fakeDeps(twoGroups(), { startWorker: fakeWorker().startWorker, prState: () => 'OPEN', openOnHost: (branch) => (branch === 'bugfix/shop/cart' ? found : null), remote: (branch) => (branch === 'bugfix/shop/cart' ? { head: git(wt, 'rev-parse', 'HEAD'), moved: true } : { head: null, moved: false }) });
  await epicRun(env, f2);
  assert.ok(f2.checks.some((k) => k.includes('BUG-1')), `the stages ran again: ${JSON.stringify(f2.order)}`);
  const cart = f2.order.slice(0, f2.order.findIndex((o) => o[0] === 'regate'));
  assert.ok(cart.some((o) => o[0] === 'assess') && !cart.some((o) => o[0] === 'open'), `rated again on the found PR, never a second one: ${JSON.stringify(cart)}`);
  assert.equal(unitState(env, 'cart').delivery.pr ?? unitState(env, 'cart').pr, found.url);
});
