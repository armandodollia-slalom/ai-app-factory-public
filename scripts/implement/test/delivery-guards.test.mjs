// Delivery guards:
// - D2: bug triage assessment is guaranteed before a bug-fix PR opens (or delivery stops before open),
//   and the pipeline delivery publish path never starts an agent after open.
// - D3: after-open hold/release confirmation in afterOpen (no agent if hold unconfirmed; no ready
//   recorded and not reported delivered-ready if release unconfirmed).
import assert from 'node:assert/strict';
import { spawnSync as sh } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { afterOpen, carryHeldPr, confirmRecordedHold, deliverFinished, describePlan, headMovedSince, takeRemoteHead, loadRun, openPending, plan, publishRatingOrHold, saveRun, startResolvedReruns } from '../lib/implement.mjs';
import { prIsOpen } from '../lib/reopen.mjs';
import { reviewGateAssess, reviewGatePublish } from '../lib/post-publish.mjs';
import { agentRunsAfterReady, confirmPrState, headActivities, holdMode, holdPr, preOpenProblems, preOpenWarnings, releasePr } from '../lib/pre-open.mjs';
import { createBitbucketHost } from '../../pipeline/lib/hosts/bitbucket.mjs';
import { configWarnings, loadConfig } from '../../pipeline/lib/config.mjs';
import { UnsupportedError } from '../../pipeline/lib/hosts/errors.mjs';

function tmpRepo() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'delivery-guards-')));
  const g = (...a) => sh('git', a, { cwd: dir, encoding: 'utf8' });
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 't@example.com');
  g('config', 'user.name', 'T');
  fs.writeFileSync(path.join(dir, '.gitignore'), '.factory/state/\n');
  g('add', '-A');
  g('commit', '-qm', 'init');
  return {
    dir,
    config: { root: dir, stateDir: '.factory/state', metricsDir: '.factory/metrics', implement: {}, project: { languages: [] } },
  };
}

const GREEN = { state: 'success', names: ['CI'], failing: [], pending: [], rounds: 0 };

function baseIo(order, extra = {}) {
  return {
    analysisGate: () => ({ ok: true, results: [] }),
    push: () => ({ pushed: true }),
    repo: () => 'acme/shop',
    gate: async () => GREEN,
    prOpen: () => false,
    publishTicket: () => {},
    // A rating is made for the head it rates (publishRatingOrHold publishes it only for that head).
    assess: (o) => (order.push('assess'), { severity: { level: 'Low' }, tickets: [], headSha: sh('git', ['rev-parse', 'HEAD'], { cwd: o.worktree, encoding: 'utf8' }).stdout.trim() }),
    publishGate: (opts) => order.push(['publishGate', Boolean(opts.assessment), Boolean(opts.noAgent)]),
    regate: () => {},
    analyse: async () => {},
    media: () => ({ notes: [] }),
    updateBody: () => {},
    hold: () => ({ mode: 'draft', label: 'work-in-progress', ok: true, from: new Date().toISOString(), why: 'ci' }),
    release: () => true,
    ownsPr: () => true,
    stateDecision: async () => {},
    usage: () => [],
    held: () => [],
    ...extra,
  };
}

test('D2: bug-fix delivery stops before opening the PR if pre-open assessment cannot be produced', async (t) => {
  const r = tmpRepo();
  t.after(() => fs.rmSync(r.dir, { recursive: true, force: true }));
  const order = [];
  let opened = false;
  const out = await deliverFinished(r.config, r.config, {
    id: 'BUG-42',
    keys: ['BUG-42'],
    label: 'BUG-42',
    branch: 'feat/bug-42',
    worktree: r.dir,
    base: 'main',
    title: 'BUG-42: fix',
    body: 'Implements BUG-42.\n\n- Test plan and automated tests: verified\n',
    isBug: true,
    save: () => {},
    io: baseIo(order, { assess: () => (order.push('assess-failed'), null) }),
    open: async () => {
      opened = true;
      return { pushed: true, url: 'https://github.com/acme/shop/pull/42' };
    },
  });
  assert.equal(opened, false, 'PR must not open when pre-open bug assessment cannot be produced');
  assert.equal(out.pr, null);
  assert.equal(out.outcome, 'gate-assessment-failed');
  assert.match(out.reason, /assessment before the PR opened/i);
  assert.deepEqual(order, ['assess-failed']);
});

test('D2: bug-fix delivery passes noAgent: true on publishGate and allows open when review gate is off (skipped)', async (t) => {
  const r = tmpRepo();
  t.after(() => fs.rmSync(r.dir, { recursive: true, force: true }));

  // Gate active: assess runs pre-open (even on resume if file is missing), then publishGate receives assessment + noAgent.
  const order1 = [];
  const out1 = await deliverFinished(r.config, r.config, {
    id: 'BUG-43',
    keys: ['BUG-43'],
    label: 'BUG-43',
    branch: 'feat/bug-43',
    worktree: r.dir,
    base: 'main',
    title: 'BUG-43: fix',
    body: 'Implements BUG-43.\n\n- Test plan and automated tests: verified\n',
    isBug: true,
    resumed: true,
    save: () => {},
    load: () => ({}),
    io: baseIo(order1),
    open: async () => (order1.push('open'), { pushed: true, url: 'https://github.com/acme/shop/pull/43' }),
  });
  assert.equal(out1.pr, 'https://github.com/acme/shop/pull/43');
  // (Round 5: with no target branch to compute the PR's change from, the release publishes again first: fail closed.)
  assert.deepEqual(order1.slice(0, 3), ['assess', 'open', ['publishGate', true, true]]);

  // Gate off ({ skipped: true }): PR opens normally and publishGate is skipped.
  const order2 = [];
  const out2 = await deliverFinished(r.config, r.config, {
    id: 'BUG-44',
    keys: ['BUG-44'],
    label: 'BUG-44',
    branch: 'feat/bug-44',
    worktree: r.dir,
    base: 'main',
    title: 'BUG-44: fix',
    body: 'Implements BUG-44.\n\n- Test plan and automated tests: verified\n',
    isBug: true,
    save: () => {},
    load: () => ({}),
    io: baseIo(order2, { assess: () => (order2.push('assess-off'), { skipped: true, reason: 'Review gate off' }) }),
    open: async () => (order2.push('open'), { pushed: true, url: 'https://github.com/acme/shop/pull/44' }),
  });
  assert.equal(out2.pr, 'https://github.com/acme/shop/pull/44');
  assert.deepEqual(order2, ['assess-off', 'open']);
});

// ---- D3: unconfirmed hold / unconfirmed release in afterOpen ----------------------------------------------------------

test('D3: when putting an open PR on hold is not confirmed, no fixing agent runs and the run stops for a person', async (t) => {
  const r = tmpRepo();
  t.after(() => fs.rmSync(r.dir, { recursive: true, force: true }));
  const prUrl = 'https://github.com/acme/shop/pull/51';
  const gateCalls = [];
  const saved = [];
  const stated = [];
  const regated = [];
  const out = await afterOpen(r.config, r.config, {
    id: 'BUG-51',
    keys: ['BUG-51'],
    label: 'BUG-51',
    prUrl,
    branch: 'feat/bug-51',
    worktree: r.dir,
    base: 'main',
    isBug: true,
    result: { outcome: 'done' },
    readyAt: '2026-11-20T01:00:00.000Z',
    holds: [],
    save: (s) => saved.push(s),
    load: () => ({}),
    io: baseIo([], {
      gate: async (o) => {
        gateCalls.push(o.fixRounds);
        return { state: 'failure', names: ['CI'], failing: ['pr-only'], pending: [], rounds: 0 };
      },
      hold: () => ({ mode: 'draft', label: 'work-in-progress', ok: false, from: '2026-11-20T01:05:00.000Z', why: 'ci' }),
      stateDecision: async (pr, d) => stated.push({ pr, d }),
      regate: (o) => regated.push(o),
    }),
  });
  assert.deepEqual(gateCalls, [0], 'only the initial wait (fixRounds: 0) may run; no fixing round when hold is unconfirmed');
  assert.equal(out.outcome, 'hold-failed');
  assert.match(out.reason, /could not confirm putting .* on hold/i);
  assert.equal(out.holds.length, 1);
  assert.equal(out.holds[0].ok, false);
  assert.equal(stated.length, 1);
  assert.equal(stated[0].d.outcome, 'hold-failed');
  assert.equal(regated.length, 1);
  assert.equal(saved.at(-1).holds[0].ok, false);

  // An unconfirmed hold (ok: false) never excuses an agent run after readyAt in the audit.
  const rows = [{ story: 'BUG-51', run_id: 'r1', agent: 'pr-check-fixer', ts: '2026-11-20T01:06:00.000Z', seconds: 30 }];
  assert.equal(
    agentRunsAfterReady(rows, { key: 'BUG-51', readyAt: '2026-11-20T01:00:00.000Z', holds: out.holds }).length,
    1,
    'unconfirmed hold must not count as holding the PR in readyAudit',
  );
});

test('D3: when releasing a held PR is not confirmed by the host, ready is not recorded and the ticket is not delivered-ready', async (t) => {
  const r = tmpRepo();
  t.after(() => fs.rmSync(r.dir, { recursive: true, force: true }));
  const prUrl = 'https://github.com/acme/shop/pull/52';
  const head = sh('git', ['rev-parse', 'HEAD'], { cwd: r.dir, encoding: 'utf8' }).stdout.trim();
  const saved = [];
  const stated = [];
  const out = await afterOpen(r.config, r.config, {
    id: 'BUG-52',
    keys: ['BUG-52'],
    label: 'BUG-52',
    prUrl,
    branch: 'feat/bug-52',
    worktree: r.dir,
    base: 'main',
    isBug: false,
    result: { outcome: 'done' },
    readyAt: null,
    holds: [{ mode: 'draft', label: 'work-in-progress', ok: true, from: '2026-11-20T01:00:00.000Z', why: 'draft-first' }],
    save: (s) => saved.push(s),
    load: () => ({}),
    io: baseIo([], {
      gate: async () => GREEN,
      release: () => false,
      stateDecision: async (pr, d) => stated.push({ pr, d }),
    }),
  });
  assert.equal(out.readyAt, null, 'readyAt must remain null when release is not confirmed');
  assert.equal(out.holds[0].to, undefined, 'hold must remain open when release is not confirmed');
  assert.equal(out.holds[0].releaseConfirmed, false);
  assert.equal(out.releaseConfirmed, false);
  assert.equal(out.outcome, 'release-unconfirmed', 'must not be reported as delivered-ready');
  assert.match(out.reason, /did not confirm releasing/i);
  assert.equal(headActivities(r.config, prUrl, head), null, 'ready_for_review activity must not be recorded');
  assert.equal(saved.at(-1).readyAt, null);
  assert.equal(saved.at(-1).releaseConfirmed, false);
  assert.equal(stated.length, 1);
  assert.equal(stated[0].d.outcome, 'release-unconfirmed');

  // Contrast: when the host confirms release (returns true), ready IS recorded and outcome stays delivered.
  const okOut = await afterOpen(r.config, r.config, {
    id: 'BUG-53',
    keys: ['BUG-53'],
    label: 'BUG-53',
    prUrl: 'https://github.com/acme/shop/pull/53',
    branch: 'feat/bug-53',
    worktree: r.dir,
    base: 'main',
    isBug: false,
    result: { outcome: 'done' },
    readyAt: null,
    holds: [{ mode: 'draft', label: 'work-in-progress', ok: true, from: '2026-11-20T01:00:00.000Z', why: 'draft-first' }],
    save: () => {},
    load: () => ({}),
    io: baseIo([], { gate: async () => GREEN, release: () => true }),
  });
  assert.ok(okOut.readyAt, 'readyAt recorded on confirmed release');
  assert.ok(okOut.holds[0].to, 'hold closed on confirmed release');
  assert.equal(okOut.holds[0].releaseConfirmed, true);
  assert.equal(okOut.outcome, 'done');
});

test('ADV-6 (D3): holdPr and releasePr confirm by re-reading PR state (ignoring update return value); Bitbucket refuses state: open and avoids close-reopen', async () => {
  // 1. Adapter returning undefined from update, where PR state actually changes on the host -> confirmed.
  const state = { draft: false, state: 'open', labels: [] };
  const comments = [];
  const workingHost = {
    type: 'custom',
    capabilities: { drafts: true, labels: true },
    repo: { ensureLabel: () => {} },
    pr: {
      update: (_pr, patch) => {
        if (patch.draft !== undefined) state.draft = patch.draft;
        if (patch.state !== undefined) state.state = patch.state;
        if (patch.labels?.add) state.labels.push(...patch.labels.add);
        if (patch.labels?.remove) state.labels = state.labels.filter((l) => !patch.labels.remove.includes(l));
        // intentionally returns undefined
      },
      get: () => ({ ...state, labels: [...state.labels] }),
      comment: (_pr, body) => comments.push(body),
      // The hold ledger a close-reopen hold writes before it closes.
      comments: () => comments.map((body) => ({ body })),
    },
  };
  const hDraft = holdPr(workingHost, 7, { mode: 'draft', why: 'ci' });
  assert.equal(hDraft.ok, true);
  assert.equal(state.draft, true);
  assert.equal(comments.length, 1);
  assert.equal(releasePr(workingHost, 7, { mode: 'draft' }), true);
  assert.equal(state.draft, false);

  const hLabel = holdPr(workingHost, 7, { mode: 'label', label: 'wip', why: 'ci' });
  assert.equal(hLabel.ok, true);
  assert.equal(releasePr(workingHost, 7, { mode: 'label', label: 'wip' }), true);

  const hClose = holdPr(workingHost, 7, { mode: 'close-reopen', why: 'ci' });
  assert.equal(hClose.ok, true);
  assert.equal(releasePr(workingHost, 7, { mode: 'close-reopen' }), true);

  // 2. No-op adapter whose update() neither throws nor changes state -> re-read catches it and refuses confirmation.
  const noopComments = [];
  const noopHost = {
    type: 'custom',
    capabilities: { drafts: true, labels: true },
    repo: { ensureLabel: () => {} },
    pr: {
      update: () => {},
      get: () => ({ draft: false, state: 'closed', labels: [] }),
      comment: (_pr, body) => noopComments.push(body),
    },
  };
  assert.equal(holdPr(noopHost, 7, { mode: 'draft', why: 'ci', sleep: () => {} }).ok, false, 'hold unconfirmed when re-read shows draft=false');
  assert.equal(noopComments.length, 0, 'must not post On hold comment when hold was not confirmed');
  assert.equal(releasePr(noopHost, 7, { mode: 'close-reopen', sleep: () => {} }), false, 'release unconfirmed when re-read shows state=closed');

  // 3. Bitbucket adapter: holdMode never chooses close-reopen, and pr.update({ state: "open" }) throws UnsupportedError.
  const requests = [];
  const bb = createBitbucketHost(
    { url: 'https://bitbucket.org', repo: 'ws/repo' },
    {
      token: 'bb-test-tok',
      fetch: async (url, init) => {
        requests.push(`${init?.method ?? 'GET'} ${new URL(url).pathname}`);
        return new Response(JSON.stringify({ id: 7, title: 'Fix', state: 'DECLINED', draft: false }), { status: 200, headers: { 'content-type': 'application/json' } });
      },
    },
  );
  assert.equal(holdMode(bb, 'close-reopen'), 'draft', 'Bitbucket must not pick close-reopen');
  await assert.rejects(() => bb.pr.update(7, { state: 'open' }), UnsupportedError);
  assert.deepEqual(requests, [], 'refused before sending any request');
});

test('ADV-11 (D2): reviewGatePublish always passes --no-agent on argv, and reviewGateAssess distinguishes off (skipped), failure (null), and success', (t) => {
  const r = tmpRepo();
  t.after(() => fs.rmSync(r.dir, { recursive: true, force: true }));
  const assessFile = path.join(r.dir, '.factory/state/assessment.json');
  fs.mkdirSync(path.dirname(assessFile), { recursive: true });
  fs.writeFileSync(assessFile, JSON.stringify({ severity: { level: 'Low' }, tickets: [] }));

  // 1. reviewGatePublish passes --no-agent with and without an existing --assessment file.
  const pubCalls = [];
  reviewGatePublish(r.dir, {
    pr: 'https://github.com/acme/shop/pull/99',
    keys: ['BUG-1', 'BUG-2'],
    base: 'main',
    assessment: assessFile,
    run: (cmd, args) => (pubCalls.push([cmd, args]), { status: 0, stdout: 'published\n', stderr: '' }),
    log: () => {},
  });
  assert.equal(pubCalls.length, 1);
  assert.ok(pubCalls[0][1].includes('publish'));
  assert.ok(pubCalls[0][1].includes('--no-agent'), 'delivery publish MUST pass --no-agent');
  assert.ok(pubCalls[0][1].includes('--assessment'), 'existing assessment file is passed');
  assert.ok(pubCalls[0][1].includes(assessFile));

  reviewGatePublish(r.dir, {
    pr: 'https://github.com/acme/shop/pull/99',
    keys: ['BUG-1'],
    base: 'main',
    assessment: path.join(r.dir, 'missing.json'),
    run: (cmd, args) => (pubCalls.push([cmd, args]), { status: 0, stdout: 'published\n', stderr: '' }),
    log: () => {},
  });
  assert.ok(pubCalls[1][1].includes('--no-agent'), 'delivery publish MUST pass --no-agent even when assessment is missing');
  assert.ok(!pubCalls[1][1].includes('--assessment'));

  // 2. reviewGateAssess: gate off -> { skipped: true }; error / missing out -> null; valid out -> parsed object.
  const outFile = path.join(r.dir, '.factory/state/out-assess.json');
  const skipped = reviewGateAssess(r.dir, {
    keys: ['BUG-1'],
    base: 'main',
    out: outFile,
    run: () => ({ status: 0, stdout: 'Review gate off (reviewGate.enabled is false); not assessed.\n', stderr: '' }),
    log: () => {},
  });
  assert.equal(skipped.skipped, true);
  assert.match(skipped.reason, /^Review gate off/);

  const crashed = reviewGateAssess(r.dir, {
    keys: ['BUG-1'],
    base: 'main',
    out: outFile,
    run: () => ({ status: 1, stdout: '', stderr: 'agent failed\n' }),
    log: () => {},
  });
  assert.equal(crashed, null);

  const missingOut = reviewGateAssess(r.dir, {
    keys: ['BUG-1'],
    base: 'main',
    out: outFile,
    run: () => ({ status: 0, stdout: 'unexpected output without writing file\n', stderr: '' }),
    log: () => {},
  });
  assert.equal(missingOut, null);

  const ok = reviewGateAssess(r.dir, {
    keys: ['BUG-1'],
    base: 'main',
    out: outFile,
    run: (_cmd, args) => {
      assert.ok(args.includes('assess') && args.includes('--out'));
      fs.writeFileSync(outFile, JSON.stringify({ severity: { level: 'Low' }, tickets: [{ key: 'BUG-1' }] }));
      return { status: 0, stdout: 'assessed before the PR: severity Low\n', stderr: '' };
    },
    log: () => {},
  });
  assert.deepEqual(ok, { severity: { level: 'Low' }, tickets: [{ key: 'BUG-1' }] });
});

// ---- Round 3: ADV-15, ADV-17, ADV-18, ADV-29, Bitbucket close-reopen validation ---------------------------------------

function writeTicketFixture(dir, key, labels = []) {
  const tdir = path.join(dir, '.factory/state/board', key);
  fs.mkdirSync(tdir, { recursive: true });
  const file = path.join(tdir, 'story.md');
  fs.writeFileSync(file, `# ${key}: Fix order check\n`);
  fs.writeFileSync(path.join(tdir, 'meta.json'), JSON.stringify({ key, type: 'bug', title: 'Fix order check', slug: `${key.toLowerCase()}-fix`, labels, issue: { number: 7, state: 'open', labels } }));
  return file;
}

const afterOpenCall = (cfg, dir, id, prUrl, overrides) =>
  afterOpen(cfg, cfg, { id, keys: [id], label: id, prUrl, branch: `feat/${id.toLowerCase()}`, worktree: dir, base: 'main', isBug: false, result: { outcome: 'done' }, save: () => {}, load: () => ({}), ...overrides });

test('ADV-15 (D3): plan() derives reopenedPr from saved hold-failed open PR; startResolvedReruns defers clear-reopened', (t) => {
  const r = tmpRepo();
  t.after(() => fs.rmSync(r.dir, { recursive: true, force: true }));
  const cfg = { ...r.config, baseRef: 'main', implement: { branchPrefix: 'feat/', worktreeDir: path.join(r.dir, '.wts') } };
  const storyFile = writeTicketFixture(r.dir, 'BUG-15', []);
  const prUrl = 'https://github.com/acme/shop/pull/15';
  const wt = path.join(r.dir, '.wts', 'bug-15');
  fs.mkdirSync(wt, { recursive: true });
  saveRun(cfg, 'BUG-15', { status: 'finished', outcome: 'hold-failed', phase: null, pr: prUrl, reopenedPr: prUrl, branch: 'feat/bug-15-fix', worktree: wt, holds: [{ mode: 'draft', ok: false, from: '2026-11-20T01:00:00.000Z', why: 'reopened' }] });

  const [pOpen] = plan(cfg, [storyFile], { base: 'main', reopenDeps: { prIsOpen: (u) => u === prUrl } });
  assert.deepEqual([pOpen.reopenedPr, pOpen.fromRemote, pOpen.branch], [prUrl, true, 'feat/bug-15-fix']);
  const [pClosed] = plan(cfg, [storyFile], { base: 'main', reopenDeps: { prIsOpen: () => false } });
  assert.equal(pClosed.reopenedPr ?? null, null);
  // Closed by the run's own close-reopen hold (recorded, not released): still this ticket's PR on hold (resuming-26).
  saveRun(cfg, 'BUG-15', { phase: 'branch-ci', outcome: 'error', holds: [{ mode: 'close-reopen', ok: true, from: '2026-11-20T01:00:00.000Z', why: 'ci' }] });
  const [pHeld] = plan(cfg, [storyFile], { base: 'main', reopenDeps: { prIsOpen: () => false } });
  assert.deepEqual([pHeld.reopenedPr, pHeld.fromRemote], [prUrl, true]);
  saveRun(cfg, 'BUG-15', { outcome: 'hold-failed', phase: null, holds: [{ mode: 'draft', ok: false, from: '2026-11-20T01:00:00.000Z', why: 'reopened' }] });

  const events = [];
  startResolvedReruns(cfg, [
    { key: 'BUG-15', reopened: true, skip: null, reopenedPr: prUrl, branch: 'feat/bug-15-fix' },
    { key: 'BUG-16', reopened: true, skip: null, reopenedPr: null, followUp: 1, branch: 'feat/bug-16-r1' },
  ], { event: (_root, key, args) => events.push([key, ...args]) });
  assert.deepEqual(events, [['BUG-16', 'clear-reopened', 'BUG-16']]);
});

test('ADV-17: gate-assessment-failed, release-unconfirmed, and after-open hold-failed route through plan() resume paths', async (t) => {
  const r = tmpRepo();
  t.after(() => fs.rmSync(r.dir, { recursive: true, force: true }));
  const cfg = { ...r.config, baseRef: 'main', implement: { branchPrefix: 'feat/', worktreeDir: path.join(r.dir, '.wts') } };
  const wt = path.join(r.dir, '.wts', 'wt-adv17');
  fs.mkdirSync(wt, { recursive: true });

  // 1. gate-assessment-failed -> phase: 'pre-open' + greenAt -> plan() resume=true (openPending).
  const gateOut = await deliverFinished(cfg, cfg, { id: 'BUG-17A', keys: ['BUG-17A'], label: 'BUG-17A', branch: 'feat/bug-17a', worktree: r.dir, base: 'main', title: 'BUG-17A: fix', body: 'Implements BUG-17A.\n', isBug: true, save: () => {}, io: baseIo([], { assess: () => null }), open: async () => assert.fail('must not open') });
  assert.deepEqual([gateOut.outcome, gateOut.phase, Boolean(gateOut.greenAt)], ['gate-assessment-failed', 'pre-open', true]);
  saveRun(cfg, 'BUG-17A', { status: 'finished', outcome: gateOut.outcome, phase: gateOut.phase, greenAt: gateOut.greenAt, pr: null, branch: 'feat/bug-17a', worktree: wt });
  const [pA] = plan(cfg, [writeTicketFixture(r.dir, 'BUG-17A')], { base: 'main', reopenDeps: { prIsOpen: () => false } });
  assert.deepEqual([pA.resume, pA.skip], [true, null]);

  // 2. release-unconfirmed -> phase: 'ci-wait' -> plan() ciResume, never reports done while still a draft.
  const prB = 'https://github.com/acme/shop/pull/172';
  const holdB = [{ mode: 'draft', label: 'work-in-progress', ok: true, from: '2026-11-20T01:00:00.000Z', why: 'draft-first' }];
  const relFail = await afterOpenCall(cfg, r.dir, 'BUG-17B', prB, { readyAt: null, holds: holdB, io: baseIo([], { gate: async () => GREEN, release: () => false }) });
  assert.deepEqual([relFail.outcome, relFail.phase], ['release-unconfirmed', 'ci-wait']);
  saveRun(cfg, 'BUG-17B', { status: 'finished', outcome: relFail.outcome, phase: relFail.phase, pr: prB, readyAt: null, holds: relFail.holds, branch: 'feat/bug-17b', worktree: wt });
  const [pB] = plan(cfg, [writeTicketFixture(r.dir, 'BUG-17B')], { base: 'main', reopenDeps: { prIsOpen: () => true } });
  assert.deepEqual([pB.resume, pB.ciResume], [true, prB]);
  const stillDraft = await afterOpenCall(cfg, r.dir, 'BUG-17B', prB, { readyAt: null, holds: relFail.holds, io: baseIo([], { gate: async () => GREEN, release: () => false }) });
  assert.deepEqual([stillDraft.outcome, stillDraft.readyAt], ['release-unconfirmed', null]);
  const releasedNow = await afterOpenCall(cfg, r.dir, 'BUG-17B', prB, { readyAt: null, holds: relFail.holds, io: baseIo([], { gate: async () => GREEN, release: () => true }) });
  assert.ok(releasedNow.outcome === 'done' && releasedNow.readyAt);

  // 3. after-open hold-failed -> phase: 'ci-wait' -> plan() ciResume, failed hold does not burn draftCycles.
  const prC = 'https://github.com/acme/shop/pull/173';
  const red = { state: 'failure', names: ['CI'], failing: ['pr-only'], pending: [], rounds: 0 };
  const holdFail = await afterOpenCall(cfg, r.dir, 'BUG-17C', prC, { readyAt: '2026-11-20T01:00:00.000Z', holds: [], io: baseIo([], { gate: async () => red, hold: () => ({ mode: 'draft', label: 'work-in-progress', ok: false, from: '2026-11-20T01:05:00.000Z', why: 'ci' }) }) });
  assert.deepEqual([holdFail.outcome, holdFail.phase], ['hold-failed', 'ci-wait']);
  assert.match(holdFail.reason, /may already be in draft or held on the host/i);
  saveRun(cfg, 'BUG-17C', { status: 'finished', outcome: holdFail.outcome, phase: holdFail.phase, pr: prC, readyAt: holdFail.readyAt, holds: holdFail.holds, branch: 'feat/bug-17c', worktree: wt });
  const [pC] = plan(cfg, [writeTicketFixture(r.dir, 'BUG-17C')], { base: 'main', reopenDeps: { prIsOpen: () => true } });
  assert.deepEqual([pC.resume, pC.ciResume], [true, prC]);
  let holdTries = 0;
  let step = 0;
  const resumedHold = await afterOpenCall(cfg, r.dir, 'BUG-17C', prC, { readyAt: holdFail.readyAt, holds: holdFail.holds, io: baseIo([], { gate: async (o) => (++step === 1 ? red : (assert.ok(o.fixRounds > 0), GREEN)), hold: () => (++holdTries, { mode: 'draft', label: 'work-in-progress', ok: true, from: '2026-11-20T01:10:00.000Z', why: 'ci' }), release: () => true }) });
  assert.deepEqual([holdTries, resumedHold.outcome], [1, 'done']);
});

test('ADV-18 & ADV-29: confirmPrState retries bounded 3 attempts; draft-first hold re-reads and falls back to label', async (t) => {
  let reads = 0;
  const sleeps = [];
  assert.equal(confirmPrState({ pr: { get: () => ({ draft: ++reads >= 3, state: 'open', labels: [] }) } }, 7, { mode: 'draft', held: true, delayMs: 250, sleep: (ms) => sleeps.push(ms) }), true);
  assert.deepEqual([reads, sleeps], [3, [250, 250]]);
  let stale = 0;
  assert.equal(confirmPrState({ pr: { get: () => (++stale, { draft: false, state: 'open', labels: [] }) } }, 7, { mode: 'draft', held: true, delayMs: 100, sleep: () => {} }), false);
  assert.equal(stale, 3);

  const r = tmpRepo();
  t.after(() => fs.rmSync(r.dir, { recursive: true, force: true }));
  const actions = [];
  const out = await deliverFinished(r.config, r.config, {
    id: 'BUG-29', keys: ['BUG-29'], label: 'BUG-29', branch: 'feat/bug-29', worktree: r.dir, base: 'main', title: 'BUG-29: fix', body: 'Implements BUG-29.\n', isBug: false, result: { outcome: 'done' }, save: () => {}, load: () => ({}),
    io: baseIo([], {
      gate: async (o) => (o.pr.startsWith('http') ? GREEN : { state: 'none', names: [], failing: [], pending: [], rounds: 0 }),
      confirmHold: (_pr, o) => (actions.push(['confirmHold', o.mode]), false),
      hold: (_pr, o) => (actions.push(['hold', o.mode]), { mode: o.mode, label: 'work-in-progress', ok: true, from: '2026-11-20T01:00:00.000Z', why: o.why }),
      release: (_pr, o) => (actions.push(['release', o.mode]), true),
    }),
    open: async ({ draft }) => (actions.push(['open', draft]), { pushed: true, url: 'https://github.com/acme/shop/pull/29', draft: true }),
  });
  // ADV-31: the unconfirmed draft is recorded (ok: false) and released too, not only the label.
  assert.deepEqual(actions, [['open', true], ['confirmHold', 'draft'], ['hold', 'label'], ['release', 'label'], ['release', 'draft']]);
  assert.deepEqual(out.holds.map((h) => [h.mode, h.ok, Boolean(h.to)]), [['draft', false, true], ['label', true, true]]);
  assert.equal(out.outcome, 'done');
});

test('Bitbucket close-reopen: a warning from config validation and factory doctor, not a problem; draft is used', (t) => {
  const bb = createBitbucketHost({ url: 'https://bitbucket.org', repo: 'ws/repo' }, { token: 'bb-tok' });
  const cfg = { implement: { preOpen: { afterOpen: 'close-reopen' } } };
  assert.deepEqual(preOpenProblems(cfg), [], 'the setting is valid: it runs as draft');
  const warnings = preOpenWarnings(cfg, { host: bb });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /close-reopen.*not supported on Bitbucket.*"draft" is used instead/i);

  const r = tmpRepo();
  t.after(() => fs.rmSync(r.dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(r.dir, '.factory'), { recursive: true });
  fs.writeFileSync(path.join(r.dir, '.factory/config.json'), JSON.stringify({ host: { type: 'bitbucket', url: 'https://bitbucket.org', repo: 'ws/repo' }, implement: { preOpen: { afterOpen: 'close-reopen' } } }));
  // Config validation: the setting loads, with the warning on stderr.
  const loaded = loadConfig('implement', r.dir);
  assert.equal(loaded.warnings.length, 1);
  assert.match(loaded.warnings[0], /close-reopen.*not supported on Bitbucket.*"draft" is used instead/i);
  const factoryCli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../factory/factory.mjs');
  // No host token reaches the doctor this test runs against a Bitbucket config (other-38; the runner strips them too).
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(GH|GITHUB|GITLAB|AZURE_DEVOPS|BITBUCKET)_.*TOKEN$|^SYSTEM_ACCESSTOKEN$/.test(k)));
  const doc = sh(process.execPath, [factoryCli, 'doctor'], { cwd: r.dir, encoding: 'utf8', timeout: 60_000, env });
  assert.doesNotMatch(doc.stdout, /MISSING\s+PR delivery settings \(implement\.preOpen\)/);
  assert.match(doc.stdout, /WARN\s+PR delivery settings \(implement\.preOpen\)\s+\(implement\.preOpen\.afterOpen "close-reopen" is not supported on Bitbucket/);
  // A host that can reopen: no warning.
  assert.deepEqual(preOpenWarnings(cfg, { host: { label: 'GitHub', capabilities: { drafts: true } } }), []);
  assert.deepEqual(configWarnings({ ...cfg, implement: { preOpen: { afterOpen: 'draft' } } }), []);
});

// A simulated code host for the real holdPr / releasePr / confirmPrState: `getFails` reads throw first.
function simHost({ draft = false, labels = [], getFails = 0 } = {}) {
  const st = { draft, labels: new Set(labels), state: 'open', comments: [] };
  const log = [];
  let fails = getFails;
  return {
    st,
    log,
    capabilities: { drafts: true, labels: true },
    repo: { ensureLabel: () => {} },
    pr: {
      get: () => {
        log.push('get');
        if (fails > 0) {
          fails -= 1;
          throw new Error('ETIMEDOUT');
        }
        return { draft: st.draft, labels: [...st.labels], state: st.state };
      },
      update: (_pr, u) => {
        log.push(`update ${JSON.stringify(u)}`);
        if (u.draft !== undefined) st.draft = u.draft;
        for (const l of u.labels?.add ?? []) st.labels.add(l);
        for (const l of u.labels?.remove ?? []) st.labels.delete(l);
        if (u.state) st.state = u.state;
      },
      // Comments edited in place by marker (the hold ledger is one).
      comments: () => st.comments,
      comment: (_pr, body, o = {}) => {
        const i = o.marker ? st.comments.findIndex((c) => c.body.includes(o.marker)) : -1;
        if (i >= 0) st.comments[i] = { body };
        else st.comments.push({ body });
      },
    },
  };
}
const nosleep = () => {};
const simIo = (host, extra = {}) => baseIo([], {
  hold: (pr, { mode = 'draft', why } = {}) => holdPr(host, pr, { mode, why, sleep: nosleep }),
  confirmHold: (pr, { mode = 'draft', label = 'work-in-progress' } = {}) => confirmPrState(host, pr, { mode, label, held: true, sleep: nosleep }),
  release: (pr, { mode, label }) => releasePr(host, pr, { mode, label, sleep: nosleep }),
  ...extra,
});
const RED = { state: 'failure', names: ['CI'], failing: ['unit'], pending: [], rounds: 0 };

test('ADV-30 (D3): after release-unconfirmed, a resumed red CI holds again and confirms before the fixing round', async (t) => {
  const r = tmpRepo();
  t.after(() => fs.rmSync(r.dir, { recursive: true, force: true }));
  const pr = 'https://github.com/acme/shop/pull/30';
  // First run: the host applies the release but every re-read fails, so the release is unconfirmed.
  const h1 = simHost({ draft: true, getFails: 3 });
  const first = await afterOpenCall(r.config, r.dir, 'BUG-30', pr, { readyAt: null, holds: [{ mode: 'draft', label: 'work-in-progress', ok: true, from: '2026-11-20T01:00:00.000Z', why: 'draft-first' }], io: simIo(h1) });
  assert.deepEqual([first.outcome, first.phase, h1.st.draft, first.holds.at(-1).releaseConfirmed], ['release-unconfirmed', 'ci-wait', false, false]);
  // Resume: CI is red. The PR is ready on the host; it must be held (and confirmed) before the fixing agent runs.
  const h2 = simHost({ draft: h1.st.draft });
  const rounds = [];
  let n = 0;
  const resumed = await afterOpenCall(r.config, r.dir, 'BUG-30', pr, {
    readyAt: first.readyAt,
    holds: first.holds,
    io: simIo(h2, { gate: async (o) => {
      if (o.fixRounds > 0) rounds.push({ hostDraft: h2.st.draft });
      n += 1;
      return n === 1 ? RED : GREEN;
    } }),
  });
  assert.deepEqual(rounds, [{ hostDraft: true }], 'the fixing round runs only while the PR is confirmed in draft');
  assert.equal(resumed.outcome ?? 'done', 'done');
  assert.equal(h2.st.draft, false, 'released at the end');
  assert.ok(resumed.readyAt);
  assert.ok(resumed.holds.every((h) => h.to), 'every hold released');
});

test('ADV-31 (D3): a green resume after an after-open hold-failed releases the hold the host may have applied', async (t) => {
  const r = tmpRepo();
  t.after(() => fs.rmSync(r.dir, { recursive: true, force: true }));
  const pr = 'https://github.com/acme/shop/pull/31';
  // First run: red CI, the host applies the draft but every re-read fails, so the hold is recorded ok: false.
  const h1 = simHost({ getFails: 3 });
  const first = await afterOpenCall(r.config, r.dir, 'BUG-31', pr, { readyAt: '2026-11-20T01:00:00.000Z', holds: [], io: simIo(h1, { gate: async () => RED }) });
  assert.deepEqual([first.outcome, first.phase, h1.st.draft, first.holds[0].ok], ['hold-failed', 'ci-wait', true, false]);
  // Resume with green CI: the PR is still a draft on the host; done must not be recorded until it is released.
  const h2 = simHost({ draft: h1.st.draft });
  const resumed = await afterOpenCall(r.config, r.dir, 'BUG-31', pr, { readyAt: first.readyAt, holds: first.holds, io: simIo(h2) });
  assert.equal(h2.st.draft, false, 'the draft is released');
  assert.ok(h2.log.includes('update {"draft":false}'));
  assert.equal(resumed.outcome ?? 'done', 'done');
  assert.ok(resumed.holds[0].to);
  // When that release cannot be confirmed either, the run is not done.
  const h3 = simHost({ draft: true, getFails: 9 });
  const unconfirmed = await afterOpenCall(r.config, r.dir, 'BUG-31', pr, { readyAt: first.readyAt, holds: first.holds.map((h) => ({ ...h, to: undefined })), io: simIo(h3) });
  assert.equal(unconfirmed.outcome, 'release-unconfirmed');
});

test('ADV-31 (D3/ADV-29): draft-first whose draft was applied but not confirmed releases the draft too, never done on a draft', async (t) => {
  const r = tmpRepo();
  t.after(() => fs.rmSync(r.dir, { recursive: true, force: true }));
  const host = simHost({ getFails: 3 });
  const out = await deliverFinished(r.config, r.config, {
    id: 'BUG-129', keys: ['BUG-129'], label: 'BUG-129', branch: 'feat/bug-129', worktree: r.dir, base: 'main', title: 'BUG-129: fix', body: 'Implements BUG-129.\n', isBug: false, result: { outcome: 'done' }, save: () => {}, load: () => ({}),
    io: simIo(host, { gate: async (o) => (String(o.pr).startsWith('http') ? GREEN : { state: 'none', names: [], failing: [], pending: [], rounds: 0 }) }),
    open: async ({ draft }) => {
      host.st.draft = Boolean(draft);
      return { pushed: true, url: 'https://github.com/acme/shop/pull/129', draft: Boolean(draft) };
    },
  });
  assert.deepEqual(out.holds.map((h) => [h.mode, h.ok, Boolean(h.to)]), [['draft', false, true], ['label', true, true]]);
  assert.equal(host.st.draft, false, 'the PR is not left in draft');
  assert.deepEqual([...host.st.labels], []);
  assert.equal(out.outcome, 'done');
  assert.ok(out.readyAt);
});

test('ADV-33 (D3/ADV-15): plan() fails closed when the PR state cannot be read, and --dry-run does not read it', (t) => {
  const r = tmpRepo();
  t.after(() => fs.rmSync(r.dir, { recursive: true, force: true }));
  const cfg = { ...r.config, baseRef: 'main', implement: { branchPrefix: 'feat/', worktreeDir: path.join(r.dir, '.wts') } };
  const storyFile = writeTicketFixture(r.dir, 'BUG-33', []);
  const prUrl = 'https://github.com/acme/shop/pull/33';
  saveRun(cfg, 'BUG-33', { status: 'finished', outcome: 'not-delivered', phase: null, pr: prUrl, branch: 'feat/bug-33-fix' });
  const [unknown] = plan(cfg, [storyFile], { base: 'main', reopenDeps: { prIsOpen: () => 'unknown' } });
  assert.equal(unknown.reopenedPr, prUrl, 'an unreadable PR state is treated as open, so the worker holds it first');
  const [closed] = plan(cfg, [storyFile], { base: 'main', reopenDeps: { prIsOpen: () => false } });
  assert.equal(closed.reopenedPr ?? null, null);
  let reads = 0;
  const [dry] = plan(cfg, [storyFile], { base: 'main', checkPrState: false, reopenDeps: { prIsOpen: () => (reads += 1, true) } });
  assert.deepEqual([reads, dry.reopenedPr ?? null, dry.prUnchecked], [0, null, prUrl]);
  assert.match(describePlan([dry]), /PR state not checked: https:\/\/github\.com\/acme\/shop\/pull\/33/);
  // The real read: a host error is 'unknown', never "not open".
  const noHost = { ...cfg, host: { type: 'no-such-host' } };
  assert.equal(prIsOpen(noHost, prUrl), 'unknown');
});

test('ADV-36 (ADV-15): without --pr, a reopened ticket with an open PR has its reopened label cleared at start', () => {
  const stories = [{ key: 'BUG-36', reopened: true, skip: null, reopenedPr: 'https://github.com/acme/shop/pull/36', branch: 'feat/bug-36-fix' }];
  const without = [];
  startResolvedReruns({ root: '/nonexistent' }, stories, { pr: false, event: (_root, key, args) => without.push([key, ...args]) });
  assert.deepEqual(without, [['BUG-36', 'clear-reopened', 'BUG-36']]);
  const withPr = [];
  startResolvedReruns({ root: '/nonexistent' }, stories, { pr: true, event: (_root, key, args) => withPr.push([key, ...args]) });
  assert.deepEqual(withPr, [], 'with --pr the worker clears it once the hold is confirmed');
});

// A rating that failed on a PR already open and on hold started the whole ticket over (planning, coding, verification,
// review, tests, PR check) on the next run, or the adoption path released the PR unrated.
test('a rating that fails on a PR open and on hold keeps the resume point at the rating, with the PR still on hold', async (t) => {
  const r = tmpRepo();
  t.after(() => fs.rmSync(r.dir, { recursive: true, force: true }));
  const cfg = { ...r.config, baseRef: 'main', implement: { branchPrefix: 'feat/', worktreeDir: path.join(r.dir, '.wts') } };
  const wt = path.join(r.dir, '.wts', 'wt-held');
  fs.mkdirSync(wt, { recursive: true });
  const pr = 'https://github.com/acme/shop/pull/181';
  const holds = [{ mode: 'draft', label: 'work-in-progress', ok: true, from: '2026-11-20T01:00:00.000Z', why: 'reopened' }];
  const saves = [];
  const out = await deliverFinished(cfg, cfg, { id: 'BUG-18', keys: ['BUG-18'], label: 'BUG-18', branch: 'feat/bug-18', worktree: r.dir, base: 'main', title: 'BUG-18: fix', body: 'Implements BUG-18.\n', isBug: true, existingPr: pr, holds, openedAt: '2026-11-19T00:00:00.000Z', readyAt: null, save: (s) => saves.push(s), io: baseIo([], { assess: () => null, updateBody: () => assert.fail('the held PR is not updated before it is rated') }), open: async () => assert.fail('never opened again') });
  const head = sh('git', ['rev-parse', 'HEAD'], { cwd: r.dir, encoding: 'utf8' }).stdout.trim();
  assert.deepEqual([out.outcome, out.phase, out.pr, out.provenHead], ['gate-assessment-failed', 'pre-open', pr, head]);
  assert.match(out.reason, /stays on hold/);
  const last = saves.at(-1);
  assert.deepEqual([last.phase, last.pr, last.provenHead, last.holds], ['pre-open', pr, head, holds], 'the record keeps the resume point, not phase null');
  saveRun(cfg, 'BUG-18', { status: 'finished', outcome: out.outcome, reason: out.reason, ...last, branch: 'feat/bug-18', worktree: wt });
  assert.equal(openPending(loadRun(cfg, 'BUG-18')), true);
  const [p] = plan(cfg, [writeTicketFixture(r.dir, 'BUG-18')], { base: 'main', reopenDeps: { prIsOpen: () => true } });
  assert.equal(p.resume, true, 'the next run resumes at the rating');
  // A PR that is not on hold any more is not rated and updated behind a person's back.
  assert.equal(openPending({ ...loadRun(cfg, 'BUG-18'), holds: [{ ...holds[0], to: '2026-11-20T02:00:00.000Z' }] }), false);
});

test('a resume continues at the delivery only while the branch is at the head CI proved, here and on the remote', (t) => {
  const r = tmpRepo();
  t.after(() => fs.rmSync(r.dir, { recursive: true, force: true }));
  const g = (cwd, ...a) => sh('git', a, { cwd, encoding: 'utf8' });
  const origin = `${r.dir}-origin.git`;
  t.after(() => fs.rmSync(origin, { recursive: true, force: true }));
  g(r.dir, 'init', '-q', '--bare', origin);
  g(r.dir, 'remote', 'add', 'origin', origin);
  g(r.dir, 'checkout', '-qb', 'feat/bug-19');
  g(r.dir, 'push', '-q', 'origin', 'feat/bug-19');
  const proven = g(r.dir, 'rev-parse', 'HEAD').stdout.trim();
  const rec = { provenHead: proven, pr: 'https://github.com/acme/shop/pull/19' };
  assert.equal(headMovedSince(r.dir, 'feat/bug-19', rec), null);
  const why = (x) => x?.why ?? '';
  // A person pushed to the PR's branch in between: their commit is reviewed, never skipped.
  const other = `${r.dir}-other`;
  t.after(() => fs.rmSync(other, { recursive: true, force: true }));
  g(r.dir, 'clone', '-q', '-b', 'feat/bug-19', origin, other);
  fs.writeFileSync(path.join(other, 'fix.txt'), 'a person\'s change\n');
  g(other, '-c', 'user.email=p@example.com', '-c', 'user.name=P', 'commit', '-qam', 'x', '--allow-empty');
  g(other, 'push', '-q', 'origin', 'feat/bug-19');
  assert.match(why(headMovedSince(r.dir, 'feat/bug-19', rec)), /pushed in between/);
  // The remote's own answer counts, not a tracking ref: with the ref gone and the fetch narrowed, the move is still seen.
  g(r.dir, 'config', 'remote.origin.fetch', '+refs/heads/main:refs/remotes/origin/main');
  g(r.dir, 'update-ref', '-d', 'refs/remotes/origin/feat/bug-19');
  assert.match(why(headMovedSince(r.dir, 'feat/bug-19', rec)), /pushed in between/);
  // A local commit after the proof: moved. A remote that cannot be read: unreadable (the resume stops, Sol 23).
  assert.match(why(headMovedSince(r.dir, 'feat/bug-19', { ...rec, provenHead: 'f'.repeat(40) })), /not f{7} that CI proved/);
  g(r.dir, 'remote', 'set-url', 'origin', path.join(r.dir, 'no-such-remote'));
  assert.deepEqual(headMovedSince(r.dir, 'feat/bug-19', rec), { why: 'origin/feat/bug-19 could not be read', unreadable: true });
  // A record from before the proven head was kept: an open PR could have moved, so no resume; no PR resumes as before.
  assert.match(why(headMovedSince(r.dir, 'feat/bug-19', { pr: rec.pr })), /not recorded/);
  // A record from before the proven head with no PR still reads the remote (round 4): unreadable here.
  assert.deepEqual(headMovedSince(r.dir, 'feat/bug-19', {}), { why: 'origin/feat/bug-19 could not be read', unreadable: true });
});

test('a resume records and narrates the demo again only when this commit has no stored media from a finished step', async (t) => {
  const r = tmpRepo();
  t.after(() => fs.rmSync(r.dir, { recursive: true, force: true }));
  const head = sh('git', ['rev-parse', 'HEAD'], { cwd: r.dir, encoding: 'utf8' }).stdout.trim();
  const stateDir = path.join(r.dir, '.factory/state/pr-check');
  fs.mkdirSync(stateDir, { recursive: true });
  const deliver = async (record, media) => {
    if (record) fs.writeFileSync(path.join(stateDir, 'FEAT-2-demo-video.json'), JSON.stringify(record));
    const order = [];
    await deliverFinished(r.config, r.config, { id: 'FEAT-2', keys: ['FEAT-2'], label: 'FEAT-2', branch: 'feat/feat-2', worktree: r.dir, base: 'main', title: 'FEAT-2: x', body: 'Implements FEAT-2.\n', isBug: false, resumed: true, save: () => {}, io: baseIo(order, { demoVideo: async () => (order.push('demo-video'), { exit: 0 }), media: () => media }), open: async () => ({ url: 'https://github.com/acme/shop/pull/2', pushed: true }) });
    return order.includes('demo-video');
  };
  const stored = { video: 'the stored section', notes: [] };
  assert.equal(await deliver({ head, exit: 0 }, stored), false, 'stored media of this commit: no recording, no narration');
  assert.equal(await deliver({ head, exit: 0, block: 'the reproduction could not be shown' }, stored), true, 'a step that blocked runs again');
  assert.equal(await deliver({ head: 'f'.repeat(40), exit: 0 }, stored), true, 'another commit');
  assert.equal(await deliver({ head, exit: 0 }, { notes: [] }), true, 'nothing stored');
});

test('a ticket delivered earlier whose local branch was removed after delivery is still done (its remote branch counts)', (t) => {
  const r = tmpRepo();
  t.after(() => fs.rmSync(r.dir, { recursive: true, force: true }));
  const g = (...a) => sh('git', a, { cwd: r.dir, encoding: 'utf8' });
  const cfg = { ...r.config, baseRef: 'main', implement: { branchPrefix: 'feat/', worktreeDir: path.join(r.dir, '.wts') } };
  saveRun(cfg, 'BUG-20', { status: 'finished', outcome: 'done', pr: 'https://github.com/acme/shop/pull/20', branch: 'feat/bug-20', worktree: path.join(r.dir, '.wts', 'gone') });
  g('update-ref', 'refs/remotes/origin/feat/bug-20', 'HEAD');
  const [p] = plan(cfg, [writeTicketFixture(r.dir, 'BUG-20')], { base: 'main', reopenDeps: { prIsOpen: () => true } });
  assert.match(p.skip ?? '', /done in a previous run/);
});

// ADV2-15: a bug PR was released without its rating when the run stopped between the open and the publication.
test('the open is recorded at once, and a rating that cannot be published holds the PR instead of releasing it', async (t) => {
  const r = tmpRepo();
  t.after(() => fs.rmSync(r.dir, { recursive: true, force: true }));
  const saves = [];
  const actions = [];
  const out = await deliverFinished(r.config, r.config, { id: 'BUG-21', keys: ['BUG-21'], label: 'BUG-21', branch: 'feat/bug-21', worktree: r.dir, base: 'main', title: 'BUG-21: fix', body: 'Implements BUG-21.\n', isBug: true, save: (s0) => saves.push(s0), io: baseIo([], { publishGate: () => (actions.push('publish'), { status: 1, stderr: 'no host' }), hold: (pr, o) => (actions.push(['hold', pr]), { mode: 'draft', label: 'work-in-progress', ok: true, from: new Date().toISOString(), why: o.why }), release: () => actions.push('release') }), open: async () => ({ pushed: true, url: 'https://github.com/acme/shop/pull/21' }) });
  const recorded = saves.findIndex((s0) => s0.pr === 'https://github.com/acme/shop/pull/21' && s0.opened);
  assert.ok(recorded >= 0, 'the open is recorded before the publication');
  // A bug PR opens held (Sol 22): never ready before its rating; the failed publication keeps that hold.
  assert.deepEqual(actions, [['hold', 'https://github.com/acme/shop/pull/21'], 'publish']);
  assert.equal(saves.at(-1).readyAt, null);
  assert.deepEqual([out.outcome, out.phase, out.pr], ['gate-assessment-failed', 'pre-open', 'https://github.com/acme/shop/pull/21']);
  assert.match(out.reason, /could not be published.*stays on hold/);
  assert.equal(openPending({ ...saves.at(-1), outcome: out.outcome }), true, 'a resume publishes it again');
});

test('publishing the rating on an open PR uses the rating of this head only, else a result that needs a person', (t) => {
  const r = tmpRepo();
  t.after(() => fs.rmSync(r.dir, { recursive: true, force: true }));
  const head = sh('git', ['rev-parse', 'HEAD'], { cwd: r.dir, encoding: 'utf8' }).stdout.trim();
  const dir = path.join(r.dir, '.factory/state/pr-check');
  fs.mkdirSync(dir, { recursive: true });
  const calls = [];
  const o = { id: 'BUG-22', keys: ['BUG-22'], label: 'BUG-22', branch: 'feat/bug-22', worktree: r.dir, base: 'main', isBug: true, save: () => {}, io: baseIo([], { publishGate: (x) => (calls.push(x.assessment), { status: 0 }) }) };
  for (const headSha of [head, 'f'.repeat(40)]) {
    fs.writeFileSync(path.join(dir, 'BUG-22-gate-assessment.json'), JSON.stringify({ headSha, tickets: [] }));
    assert.equal(publishRatingOrHold(r.config, r.config, o, { prUrl: 'https://github.com/acme/shop/pull/22' }), null);
  }
  assert.deepEqual(calls, [path.join(dir, 'BUG-22-gate-assessment.json'), null]);
});

// ADV2-17: a recorded hold was trusted on resume although a person could have released it.
test('a recorded hold is confirmed on the host before agents work on its PR again', () => {
  const rec = { pr: 'https://github.com/acme/shop/pull/23', holds: [{ mode: 'close-reopen', ok: true, from: '2026-11-20T00:00:00Z', why: 'reopened' }] };
  const seen = [];
  assert.equal(confirmRecordedHold({}, rec, { io: { confirmHold: (pr, o) => (seen.push(o.mode), true) } }).ok, true);
  assert.deepEqual(seen, ['close-reopen']);
  const gone = confirmRecordedHold({}, rec, { io: { confirmHold: () => false } });
  assert.equal(gone.ok, false);
  assert.match(gone.reason, /not confirmed on the host/);
  assert.equal(confirmRecordedHold({}, { ...rec, holds: [] }, { io: { confirmHold: () => true } }).ok, false, 'no recorded hold: nothing to trust');
});

test('a resume whose branch moved keeps its known PR, a closed hold included, as the PR to hold and update', () => {
  const opts = { key: 'BUG-24', pr: false };
  assert.deepEqual(carryHeldPr(opts, { pr: 'https://github.com/acme/shop/pull/24', holds: [{ mode: 'close-reopen', ok: true }] }), { key: 'BUG-24', pr: true, reopenedPr: 'https://github.com/acme/shop/pull/24', fromRemote: true });
  assert.equal(carryHeldPr(opts, { pr: null }), opts);
});

// ---- round 3: both reviews' reproductions --------------------------------------------------------------------------

test('the PR is recorded the moment the host returns it, before any follow-up call; a bug PR opens held, never ready before its rating (Sol 21, Sol 22)', async (t) => {
  const r = tmpRepo();
  t.after(() => fs.rmSync(r.dir, { recursive: true, force: true }));
  const saves = [];
  const seen = [];
  await deliverFinished(r.config, r.config, {
    id: 'BUG-61', keys: ['BUG-61'], label: 'BUG-61', branch: 'feat/bug-61', worktree: r.dir, base: 'main', title: 'BUG-61: fix', body: 'Implements BUG-61.\n', isBug: true, save: (s0) => saves.push(s0),
    io: baseIo([], { publishGate: () => (seen.push(['publish', saves.at(-1)?.readyAt ?? null]), { status: 0 }) }),
    // The host returned the PR; posting the left-out sections then stalls (a crash here must not lose the PR).
    open: async ({ draft, onOpened }) => {
      seen.push(['draft', draft]);
      await onOpened('https://github.com/acme/shop/pull/61');
      seen.push(['recorded before the follow-ups', saves.some((s0) => s0.pr === 'https://github.com/acme/shop/pull/61' && s0.opened)]);
      return { pushed: true, url: 'https://github.com/acme/shop/pull/61' };
    },
  });
  assert.deepEqual(seen.slice(0, 2), [['draft', true], ['recorded before the follow-ups', true]]);
  // Recorded with the draft hold it asked for, not yet confirmed (never `holds: []` for a PR opened held).
  const first = saves.find((s0) => s0.pr && s0.opened);
  assert.deepEqual(first.holds.map((h) => [h.mode, h.ok]), [['draft', false]]);
  assert.deepEqual(seen.find((x) => x[0] === 'publish'), ['publish', null], 'not ready when the rating is published');
});

test('a resumed checkout takes a person\'s commits from the remote, or stops: unreadable, diverged (Sol 23, Sol 24)', (t) => {
  const r = tmpRepo();
  t.after(() => fs.rmSync(r.dir, { recursive: true, force: true }));
  const g = (cwd, ...a) => sh('git', ['-c', 'user.email=p@example.com', '-c', 'user.name=P', ...a], { cwd, encoding: 'utf8' });
  const origin = `${r.dir}-origin.git`;
  const other = `${r.dir}-other`;
  t.after(() => fs.rmSync(origin, { recursive: true, force: true }));
  t.after(() => fs.rmSync(other, { recursive: true, force: true }));
  g(r.dir, 'init', '-q', '--bare', origin);
  g(r.dir, 'remote', 'add', 'origin', origin);
  g(r.dir, 'checkout', '-qb', 'feat/bug-62');
  g(r.dir, 'push', '-q', 'origin', 'feat/bug-62');
  assert.deepEqual(takeRemoteHead(r.dir, 'feat/bug-62').moved, false);
  g(r.dir, 'clone', '-q', '-b', 'feat/bug-62', origin, other);
  g(other, 'commit', '-q', '--allow-empty', '-m', 'a person\'s fix');
  g(other, 'push', '-q', 'origin', 'feat/bug-62');
  const pushed = g(other, 'rev-parse', 'HEAD').stdout.trim();
  assert.deepEqual(takeRemoteHead(r.dir, 'feat/bug-62'), { head: pushed, moved: true });
  assert.equal(g(r.dir, 'rev-parse', 'HEAD').stdout.trim(), pushed, 'the stages that run again review the person\'s commit');
  // Diverged: a local commit the remote does not have, and another pushed meanwhile.
  g(r.dir, 'commit', '-q', '--allow-empty', '-m', 'local');
  g(other, 'commit', '-q', '--allow-empty', '-m', 'remote');
  g(other, 'push', '-q', 'origin', 'feat/bug-62');
  assert.match(takeRemoteHead(r.dir, 'feat/bug-62').stop, /diverged/);
  g(r.dir, 'remote', 'set-url', 'origin', path.join(r.dir, 'no-such-remote'));
  assert.match(takeRemoteHead(r.dir, 'feat/bug-62').stop, /could not be read/);
  // The resume routes stop on these, never continue into the stages or the CI wait.
  const src = fs.readFileSync(new URL('../lib/implement.mjs', import.meta.url), 'utf8');
  assert.match(src, /if \(moved\?\.unreadable\) return stop\(moved\.why\);\s+if \(moved\) \{\s+\/\/[^\n]*\n\s+const taken = takeRemoteHead\(worktree, branch\);\s+if \(taken\.stop\) return stop\(taken\.stop\);/);
  assert.match(src, /const m = movedAfterOpen\('at the CI wait', saved\.deliveredHead \?\? null\);\s+if \(m\?\.stop\) \{\s+log\(`\$\{key\}: not resumed at the CI wait/);
});

test('a recorded hold is confirmed on the host again before a CI fixing round; one a person released is held again first (Sol 26)', async (t) => {
  const r = tmpRepo();
  t.after(() => fs.rmSync(r.dir, { recursive: true, force: true }));
  const actions = [];
  let n = 0;
  const out = await afterOpen(r.config, r.config, {
    id: 'BUG-63', keys: ['BUG-63'], label: 'BUG-63', prUrl: 'https://github.com/acme/shop/pull/63', branch: 'feat/bug-63', worktree: r.dir, base: 'main', isBug: false, result: { outcome: 'done' }, readyAt: null,
    holds: [{ mode: 'draft', label: 'work-in-progress', ok: true, from: '2026-11-20T01:00:00.000Z', why: 'draft-back' }],
    save: () => {}, load: () => ({}),
    io: baseIo([], {
      gate: async (o) => (actions.push(['gate', o.fixRounds]), n++ ? GREEN : { state: 'failure', names: ['CI'], failing: ['x'], pending: [], rounds: 0 }),
      confirmHold: () => (actions.push('confirm'), false),
      hold: () => (actions.push('hold'), { mode: 'draft', label: 'work-in-progress', ok: true, from: new Date().toISOString(), why: 'ci' }),
    }),
  });
  assert.deepEqual(actions.slice(0, 3), [['gate', 0], 'confirm', 'hold'], 'confirmed (it was not), held again, then the fixing round');
  assert.equal(out.holds[0].unconfirmed, true);
});

// ---- round 4 -----------------------------------------------------------------------------------------------------------

test('a bug PR is released only on a head whose rating the host shows: after a fixing commit the new head is rated while held (resuming-22)', async (t) => {
  const r = tmpRepo();
  t.after(() => fs.rmSync(r.dir, { recursive: true, force: true }));
  const rated = sh('git', ['rev-parse', 'HEAD'], { cwd: r.dir, encoding: 'utf8' }).stdout.trim();
  const order = [];
  let n = 0;
  await afterOpen(r.config, r.config, {
    id: 'BUG-71', keys: ['BUG-71'], label: 'BUG-71', prUrl: 'https://github.com/acme/shop/pull/71', branch: 'feat/bug-71', worktree: r.dir, base: 'main', isBug: true, result: { outcome: 'done' }, readyAt: null, ratedHead: rated,
    holds: [{ mode: 'draft', label: 'work-in-progress', ok: true, from: '2026-11-20T01:00:00.000Z', why: 'opened held' }],
    save: () => {}, load: () => ({}),
    io: baseIo([], {
      // The CI fixer commits a fix in the fixing round; then CI is green on the new head.
      gate: async (o) => {
        if (o.fixRounds > 0) sh('git', ['-c', 'user.email=f@example.com', '-c', 'user.name=F', 'commit', '-q', '--allow-empty', '-m', 'ci fix'], { cwd: r.dir });
        return n++ === 0 ? { state: 'failure', names: ['CI'], failing: ['x'], pending: [], rounds: 0 } : GREEN;
      },
      confirmHold: () => true,
      publishGate: (o) => (order.push(['publish', sh('git', ['rev-parse', 'HEAD'], { cwd: o.worktree, encoding: 'utf8' }).stdout.trim() !== rated]), { status: 0 }),
      release: () => (order.push('release'), true),
    }),
  });
  assert.deepEqual(order, [['publish', true], 'release'], 'the new head is rated (published and shown) before the release');
  // A publication that fails keeps it held and stops.
  n = 0;
  const actions = [];
  const out = await afterOpen(r.config, r.config, {
    id: 'BUG-72', keys: ['BUG-72'], label: 'BUG-72', prUrl: 'https://github.com/acme/shop/pull/72', branch: 'feat/bug-72', worktree: r.dir, base: 'main', isBug: true, result: { outcome: 'done' }, readyAt: null, ratedHead: rated,
    holds: [{ mode: 'draft', label: 'work-in-progress', ok: true, from: '2026-11-20T01:00:00.000Z', why: 'opened held' }],
    save: () => {}, load: () => ({}),
    io: baseIo([], { gate: async () => GREEN, confirmHold: () => true, publishGate: () => (actions.push('publish'), { status: 3, stderr: 'not shown' }), release: () => (actions.push('release'), true) }),
  });
  assert.deepEqual(actions, ['publish']);
  assert.equal(out.outcome, 'gate-assessment-failed');
});

test('a record from before the proven head was kept still reads the remote: unreadable stops (resuming-23)', () => {
  const calls = [];
  const gitImpl = (cwd, args) => (calls.push(args[0]), args[0] === 'rev-parse' ? { status: 0, stdout: `${'a'.repeat(40)}\n` } : { status: 128, stdout: '', stderr: 'unreachable' });
  assert.deepEqual(headMovedSince('/w', 'feat/x', {}, { gitImpl }), { why: 'origin/feat/x could not be read', unreadable: true });
  assert.ok(calls.includes('ls-remote'));
  const moved = (cwd, args) => (args[0] === 'rev-parse' ? { status: 0, stdout: 'a'.repeat(40) } : { status: 0, stdout: `${'b'.repeat(40)}\trefs/heads/feat/x\n` });
  assert.match(headMovedSince('/w', 'feat/x', {}, { gitImpl: moved }).why, /pushed in between/);
});

test('a resume after the open whose branch a person moved runs the stages again on it with the PR held, never only the steps after the open (resuming-24)', () => {
  const src = fs.readFileSync(new URL('../lib/implement.mjs', import.meta.url), 'utf8');
  const fn = src.slice(src.indexOf('async function implementStoryInner('));
  // The CI-wait route and the opened-but-unpublished route both go through movedAfterOpen, which routes a moved head to
  // the reopened PR route (held first, stages again) and stops when the remote head cannot be taken.
  assert.match(fn, /const movedAfterOpen = \(where, ours = null\) => \{[\s\S]*?opts = carryHeldPr\(opts, saved\);\s*rerun = true;/);
  assert.match(fn, /const m = movedAfterOpen\('at the CI wait', saved\.deliveredHead \?\? null\);\s*if \(m\?\.stop\)/);
  assert.match(fn, /&& fs\.existsSync\(worktree\) && !rerun\) \{\s*log\(`\$\{key\}: resuming at the CI wait/);
  assert.match(fn, /saved\.pr && saved\.opened && movedAfterOpen\('after the open', saved\.provenHead \?\? null\)\?\.stop/);
});

// ---- round 5 -----------------------------------------------------------------------------------------------------------

test('the release reads the PR\'s change from the host, not this checkout: a head pushed there is rated before the release (resuming-22, ADV2-R4-01)', async (t) => {
  const r = tmpRepo();
  t.after(() => fs.rmSync(r.dir, { recursive: true, force: true }));
  const order = [];
  // The host's change is not the one rated (a person pushed B; this checkout and its rating stayed on A).
  await afterOpen(r.config, r.config, {
    id: 'BUG-81', keys: ['BUG-81'], label: 'BUG-81', prUrl: 'https://github.com/acme/shop/pull/81', branch: 'feat/bug-81', worktree: r.dir, base: 'main', isBug: true, result: { outcome: 'done' }, readyAt: null, ratedDiff: 'a'.repeat(24),
    holds: [{ mode: 'draft', label: 'work-in-progress', ok: true, from: '2026-11-20T01:00:00.000Z', why: 'opened held' }],
    save: () => {}, load: () => ({}),
    io: baseIo([], { gate: async () => GREEN, confirmHold: () => true, prDiffKey: () => 'b'.repeat(24), publishGate: () => (order.push('publish'), { status: 0 }), release: () => (order.push('release'), true) }),
  });
  assert.deepEqual(order, ['publish', 'release']);
  // The same change as rated (the pipeline's base merge since): released without publishing again.
  const same = [];
  await afterOpen(r.config, r.config, {
    id: 'BUG-82', keys: ['BUG-82'], label: 'BUG-82', prUrl: 'https://github.com/acme/shop/pull/82', branch: 'feat/bug-82', worktree: r.dir, base: 'main', isBug: true, result: { outcome: 'done' }, readyAt: null, ratedDiff: 'a'.repeat(24),
    holds: [{ mode: 'draft', label: 'work-in-progress', ok: true, from: '2026-11-20T01:00:00.000Z', why: 'opened held' }],
    save: () => {}, load: () => ({}),
    io: baseIo([], { gate: async () => GREEN, confirmHold: () => true, prDiffKey: () => 'a'.repeat(24), publishGate: () => (same.push('publish'), { status: 0 }), release: () => (same.push('release'), true) }),
  });
  assert.deepEqual(same, ['release']);
});

// A delivery resumed on a repository with a real remote: what the resume did before anything else, from its log.
async function resumeOf(t, setup) {
  const r = tmpRepo();
  const g = (cwd, ...a) => sh('git', ['-c', 'user.email=p@example.com', '-c', 'user.name=P', ...a], { cwd, encoding: 'utf8' });
  const origin = `${r.dir}-origin.git`;
  const other = `${r.dir}-other`;
  t.after(() => [r.dir, origin, other].forEach((d) => fs.rmSync(d, { recursive: true, force: true })));
  g(r.dir, 'init', '-q', '--bare', origin);
  g(r.dir, 'remote', 'add', 'origin', origin);
  const wt = path.join(r.dir, '.wts', 'bug-70');
  g(r.dir, 'worktree', 'add', '-q', '-b', 'feat/bug-70', wt, 'main');
  g(wt, 'commit', '-q', '--allow-empty', '-m', 'the fix');
  g(wt, 'push', '-q', 'origin', 'feat/bug-70');
  const pushed = g(wt, 'rev-parse', 'HEAD').stdout.trim();
  const config = { ...r.config, baseRef: 'main', implement: { branchPrefix: 'feat/', worktreeDir: path.join(r.dir, '.wts') } };
  const person = () => {
    g(r.dir, 'clone', '-q', '-b', 'feat/bug-70', origin, other);
    g(other, 'commit', '-q', '--allow-empty', '-m', 'a person\'s commit');
    g(other, 'push', '-q', 'origin', 'feat/bug-70');
    return g(other, 'rev-parse', 'HEAD').stdout.trim();
  };
  setup({ config, wt, pushed, person, g, dir: r.dir });
  const { implementStory } = await import('../lib/implement.mjs');
  const logged = [];
  const write = process.stderr.write;
  process.stderr.write = (s0) => (logged.push(String(s0)), true);
  let out;
  try {
    out = await implementStory(config, { key: 'BUG-70', base: 'main', branch: 'feat/bug-70', worktree: wt, resume: true, pr: true });
  } catch (error) {
    out = { threw: String(error?.message ?? error) };
  } finally {
    process.stderr.write = write;
  }
  return { out, log: logged.join('') };
}

test('a branch-CI resume reads the remote first: unreadable stops before the checkout is prepared (resuming-23)', async (t) => {
  const { out, log } = await resumeOf(t, ({ config, wt, pushed, g, dir }) => {
    saveRun(config, 'BUG-70', { phase: 'branch-ci', branch: 'feat/bug-70', worktree: wt, base: 'main', pushedHead: pushed });
    g(wt, 'remote', 'set-url', 'origin', path.join(dir, 'no-such-remote'));
  });
  assert.equal(out.outcome, 'error');
  assert.match(out.reason, /not resumed at the branch CI of feat\/bug-70: origin\/feat\/bug-70 could not be read/);
  assert.doesNotMatch(log, /reusing worktree/, 'stopped before the checkout was prepared');
});

test('a resume compares the remote with the commit the run itself pushed, not with a checkout already brought forward (resuming-24)', async (t) => {
  // At the CI wait: a person pushed B, and an earlier resume already fast-forwarded the checkout to B.
  const ciWait = await resumeOf(t, ({ config, wt, pushed, person, g }) => {
    person();
    g(wt, 'pull', '-q', '--ff-only', 'origin', 'feat/bug-70');
    saveRun(config, 'BUG-70', { phase: 'ci-wait', branch: 'feat/bug-70', worktree: wt, base: 'main', pr: 'https://github.com/acme/shop/pull/70', preOpen: true, deliveredHead: pushed, holds: [] });
  });
  assert.match(ciWait.log, /was pushed to feat\/bug-70 while the run was stopped: the stages run again on it, with https:\/\/github\.com\/acme\/shop\/pull\/70 held first/);
  assert.doesNotMatch(ciWait.log, /resuming at the CI wait/);
  // Before the open, no rating pending and no PR recorded: the same, from the head CI proved.
  const preOpen = await resumeOf(t, ({ config, wt, pushed, person, g }) => {
    person();
    g(wt, 'pull', '-q', '--ff-only', 'origin', 'feat/bug-70');
    saveRun(config, 'BUG-70', { phase: 'pre-open', branch: 'feat/bug-70', worktree: wt, base: 'main', greenAt: '2026-11-20T01:00:00.000Z', provenHead: pushed, outcome: 'error' });
  });
  assert.match(preOpen.log, /was pushed to feat\/bug-70 while the run was stopped: the stages run again on it/);
  assert.doesNotMatch(preOpen.log, /continuing after the open/);
  // Nothing moved: the CI wait resumes as before.
  const same = await resumeOf(t, ({ config, wt, pushed }) => {
    saveRun(config, 'BUG-70', { phase: 'ci-wait', branch: 'feat/bug-70', worktree: wt, base: 'main', pr: 'https://github.com/acme/shop/pull/70', preOpen: true, deliveredHead: pushed, holds: [] });
  });
  assert.match(same.log, /resuming at the CI wait of https:\/\/github\.com\/acme\/shop\/pull\/70/);
});
