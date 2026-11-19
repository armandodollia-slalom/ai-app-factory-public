// Retro: factory issues for engine-level patterns, and worktree cleanup (council C3).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

// Council C3: the retro named an engine-level pattern and nothing reached the factory.
test('a recurring engine-level root cause is filed once as an issue against the factory, without ticket keys', async () => {
  const { fileFactoryIssues } = await import('../lib/lessons.mjs');
  const calls = [];
  const issues = [];
  const gh = (args) => {
    calls.push(args);
    if (args[0] === 'issue' && args[1] === 'list') return { status: 0, stdout: JSON.stringify(issues) };
    if (args[0] === 'issue' && args[1] === 'create') {
      const title = args[args.indexOf('--title') + 1];
      issues.push({ title, url: `https://github.com/acme/factory/issues/${issues.length + 1}` });
      return { status: 0, stdout: `${issues.at(-1).url}\n` };
    }
    return { status: 1, stdout: '', stderr: 'unexpected' };
  };
  const obs = [
    { about: 'verifier signature check', what: 'Pair verifiers block new signatures (CAT-1, BUG-17, CHK-1).', rootCause: 'The check fires for new members with no callers.', where: 'engine', pattern: 'pattern' },
    { about: 'a codebase quirk', what: 'x', rootCause: 'y', where: 'codebase', pattern: 'pattern' },
    { about: 'once', what: 'x', rootCause: 'y', where: 'engine', pattern: 'one-off' },
  ];
  const config = { root: '/tmp/app', project: { name: 'shop' } };
  const first = fileFactoryIssues(config, obs, { origin: 'https://github.com/acme/factory.git', push: true, gh });
  assert.equal(first.length, 1, 'only the recurring engine-level root cause');
  const create = calls.find((a) => a[1] === 'create');
  assert.deepEqual(create.slice(0, 4), ['issue', 'create', '-R', 'acme/factory']);
  assert.match(create.join(' '), /\(3 tickets\)/);
  assert.doesNotMatch(create.join(' '), /CAT-1|BUG-17|CHK-1/);
  const again = fileFactoryIssues(config, obs, { origin: 'https://github.com/acme/factory.git', push: true, gh });
  assert.equal(again[0].existing, true, 'an open issue with the same title is not filed twice');
  assert.equal(calls.filter((a) => a[1] === 'create').length, 1);
  assert.deepEqual(fileFactoryIssues(config, obs, { origin: 'https://github.com/acme/factory.git', push: false, gh }), [], 'no push: nothing filed');
});

test('a retro worktree with read-only folders is removed without throwing', async () => {
  const { dropWorktree } = await import('../lib/lessons.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'retro-wt-'));
  fs.mkdirSync(path.join(dir, 'graphify-out/cache/semantic/p1'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'graphify-out/cache/semantic/p1/x.json'), '{}');
  fs.chmodSync(path.join(dir, 'graphify-out/cache/semantic/p1'), 0o555);
  fs.chmodSync(path.join(dir, 'graphify-out/cache/semantic'), 0o555);
  dropWorktree({ root: os.tmpdir() }, dir);
  assert.equal(fs.existsSync(dir), false);
});

// Council C4: two lessons taught the critics to skip what the implementer's notes accept.
test('lessons that waive a criterion are removed before the lessons check, and the rest stay', async () => {
  const { dropWaiverLessons, waivesCriteria, ruleTexts } = await import('../lib/lessons.mjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'waiver-'));
  fs.mkdirSync(path.join(root, 'lessons'));
  const flow = [
    '# Lessons: pr-check-flow', '',
    '## L1: Do not flag behavior the diff did not change or the story accepts', '<!-- category: dismissed-finding; subtype: ; added: 2026-11-14 -->', '',
    'Before raising a finding, skip behavior identical on main, races or deviations the Implementation Notes accept, and requirements the story never states.', '',
    '## L2: Leave defects another lens already owns to that lens', '<!-- category: dismissed-finding; subtype: duplicate; added: 2026-11-14 -->', '',
    'A visual defect seen in a recorded frame belongs to the video critic.', '',
  ].join('\n');
  fs.writeFileSync(path.join(root, 'lessons', 'pr-check-flow.md'), flow);
  const removed = dropWaiverLessons({ lessonsDir: 'lessons' }, root);
  assert.deepEqual(removed.map((r) => [r.agent, r.rule]), [['pr-check-flow', 'L1']]);
  const left = fs.readFileSync(path.join(root, 'lessons', 'pr-check-flow.md'), 'utf8');
  assert.doesNotMatch(left, /L1:/);
  assert.match(left, /## L2: Leave defects/);
  assert.ok(waivesCriteria('Check the story text, its Implementation Notes and Deviations: do not report a deviation the story already records.'));
  assert.ok(waivesCriteria('Record the narrower rule under Deviations instead of meeting it.'));
  assert.ok(!waivesCriteria('Fill in the Code map of the Implementation Notes for every criterion.'));
  assert.ok(!waivesCriteria('Do not report formatting the diff did not touch.'));
  assert.equal(ruleTexts(flow).size, 2);
});

// Council C5: the word list let "do not file it as a finding" through. The lessons check judges each rule's meaning and
// lists waivers; the harness removes them. The word list stays as the backstop.
test('a paraphrased waiver is caught by the word list, and the lessons check removes the ones it judges waivers', async () => {
  const { waivesCriteria, checkLessons } = await import('../lib/lessons.mjs');
  assert.ok(waivesCriteria("When the story's Implementation Notes accept a deviation, do not file it as a finding."));
  assert.ok(waivesCriteria('If the Deviations record it, treat it as minor.'));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'waiver-meaning-'));
  fs.mkdirSync(path.join(root, 'lessons'));
  fs.writeFileSync(path.join(root, 'lessons', 'pr-check-flow.md'), [
    '# Lessons: pr-check-flow', '',
    '## L1: Let the decisions section settle disputed behaviour', '<!-- category: dismissed-finding; subtype: ; added: 2026-11-15 -->', '',
    'Where the author already explained a choice, move on to the next item.', '',
    '## L2: Leave defects another lens owns to that lens', '<!-- category: dismissed-finding; subtype: duplicate; added: 2026-11-15 -->', '',
    'A visual defect in a frame belongs to the video critic.', '',
  ].join('\n'));
  assert.ok(!waivesCriteria('Where the author already explained a choice, move on to the next item.'), 'beyond the word list');
  const runAgentImpl = () => ({ ok: true, output: 'AGENT_RESULT: {"contradictions": [], "waivers": [{"agent": "pr-check-flow", "rule": "L1", "why": "it tells the critic to accept the implementer\'s explanation instead of reporting"}]}' });
  const removed = checkLessons({ root, lessonsDir: 'lessons', timeoutsSec: { lessons: 60 } }, root, { runAgentImpl });
  assert.deepEqual(removed.map((r) => [r.agent, r.rule]), [['pr-check-flow', 'L1']]);
  const left = fs.readFileSync(path.join(root, 'lessons', 'pr-check-flow.md'), 'utf8');
  assert.doesNotMatch(left, /## L1:/);
  assert.match(left, /## L2:/);
});

// Owner requirement C18: the lessons PR is a pipeline PR like any other. It goes through the shared delivery: pushed,
// CI proven on its head with no fixing agent, then opened once; a red lessons branch opens no PR.
test('the lessons PR opens finished through the shared delivery; a red lessons branch opens none', async () => {
  const { publish } = await import('../lib/lessons.mjs');
  const { spawnSync } = await import('node:child_process');
  const setup = () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lessons-pr-')));
    const g = (...a) => spawnSync('git', a, { cwd: root, encoding: 'utf8' });
    g('init', '-q', '-b', 'main');
    g('config', 'user.email', 't@example.com');
    g('config', 'user.name', 'T');
    fs.writeFileSync(path.join(root, '.gitignore'), '.factory/state/\n');
    fs.writeFileSync(path.join(root, 'a.md'), 'x\n');
    g('add', '-A');
    g('commit', '-qm', 'init');
    g('branch', 'lessons/2026-11-18');
    return { root, stateDir: '.factory/state', metricsDir: '.factory/metrics', baseRef: 'main', implement: {}, project: { languages: [] } };
  };
  const run = async (ciState) => {
    const config = setup();
    const order = [];
    const io = {
      push: (o) => (order.push(['push', o.commitRecords === false ? 'sync' : 'first']), { pushed: true }),
      repo: () => 'acme/shop',
      gate: async (o) => (order.push([/^https?:/.test(o.pr) ? 'pr-ci' : 'branch-ci', o.fixRounds]), { state: /^https?:/.test(o.pr) ? 'success' : ciState, names: ['CI'], failing: ciState === 'success' ? [] : ['lint'], pending: [], rounds: 0 }),
      media: () => ({ notes: [] }),
      ownsPr: () => true,
      regate: () => {},
      usage: () => [],
      stateDecision: async () => {},
    };
    const open = async ({ draft }) => (order.push(['open', draft]), { pushed: true, url: 'https://github.com/acme/shop/pull/5', draft });
    const out = await publish(config, { branch: 'lessons/2026-11-18', push: true, title: 'Update agent lessons', body: 'b' }, { open, io });
    return { out, order };
  };
  const green = await run('success');
  assert.deepEqual(green.order.map((o) => o[0]), ['push', 'branch-ci', 'push', 'open', 'pr-ci']);
  assert.ok(green.order.filter((o) => o[0].endsWith('-ci')).every((o) => o[1] === 0), 'no fixing agent, before or after the open');
  assert.deepEqual([green.out.status, green.out.url], ['pr', 'https://github.com/acme/shop/pull/5']);
  const red = await run('failure');
  assert.ok(!red.order.some((o) => o[0] === 'open'), 'no PR');
  assert.equal(red.out.status, 'not-delivered');
});
