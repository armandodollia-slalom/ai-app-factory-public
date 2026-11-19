// PR check: deterministic scoring, and end-to-end runs of the adversarial loop in a throwaway git repo
// with the scripted fake agent standing in for the critics, defender, judge and fixer.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { seedTicket } from '../../pipeline/test/fixtures/tickets.mjs';
import { videoLinks } from '../lib/github.mjs';
import { scoreRound } from '../lib/loop.mjs';
import { trackedStreamFiles } from '../../pipeline/lib/state.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = path.resolve(here, '..', '..', '..');
const fakeAgent = path.join(source, 'scripts', 'pipeline', 'test', 'fixtures', 'fake-agent.mjs');
let repo;
let scriptFile;

const finding = (id, lens, severity, status = 'open') => ({ id, lens, severity, status, title: id, detail: '', evidence: '', requirement: '', fix: 'fix it', thread: [] });

test('scoreRound: nothing upheld scores 10; each upheld severity caps its lens and the PR takes the lowest lens', () => {
  const lenses = ['acceptance', 'flow', 'style'];
  assert.equal(scoreRound({ lenses, findings: [] }).score, 10);
  const r = scoreRound({
    lenses,
    findings: [finding('ACC-1-1', 'acceptance', 'major'), finding('STY-1-1', 'style', 'minor'), finding('FLOW-1-1', 'flow', 'blocking')],
    rulings: [
      { id: 'ACC-1-1', ruling: 'upheld', severity: 'major' },
      { id: 'STY-1-1', ruling: 'upheld', severity: 'minor' },
      { id: 'FLOW-1-1', ruling: 'dismissed' },
    ],
    judgeLensScores: { acceptance: 10, style: 7 },
  });
  assert.deepEqual(r.lensScores, { acceptance: 8, flow: 10, style: 7 });
  assert.equal(r.score, 7);
  assert.deepEqual(r.upheld.map((f) => f.id), ['ACC-1-1', 'STY-1-1']);
});

test('scoreRound: unruled findings stand unless withdrawn, judge coverage gaps count, failed critics score 0', () => {
  const r = scoreRound({
    lenses: ['acceptance', 'flow', 'design'],
    findings: [finding('ACC-1-1', 'acceptance', 'minor'), finding('FLOW-1-1', 'flow', 'blocking', 'withdrawn')],
    rulings: [{ id: 'flow-coverage-1', ruling: 'upheld', severity: 'major', reason: 'AC 2 unverified', fix: 'add it' }],
    failedLenses: ['design'],
  });
  assert.deepEqual(r.lensScores, { acceptance: 9, flow: 8, design: 0 });
  assert.deepEqual(r.upheld.map((f) => [f.id, f.lens]), [['ACC-1-1', 'acceptance'], ['flow-coverage-1', 'flow']]);
});

test('videoLinks finds direct video links and GitHub attachments, once each', () => {
  const body = 'Demo: https://example.com/a/run.webm and ![x](https://github.com/user-attachments/assets/1234-abcd) again https://example.com/a/run.webm. Docs: https://example.com/readme.md';
  assert.deepEqual(videoLinks(body, ['.webm', '.mp4']), ['https://example.com/a/run.webm', 'https://github.com/user-attachments/assets/1234-abcd']);
});

const sh = (cmd, args) => {
  const r = spawnSync(cmd, args, { cwd: repo, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed:\n${r.stdout}\n${r.stderr}`);
  return r.stdout;
};
const write = (rel, text) => {
  fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
  fs.writeFileSync(path.join(repo, rel), text);
};
const calls = () => JSON.parse(fs.readFileSync(`${scriptFile}.calls.json`, 'utf8'));
const prCheck = (args, script) => {
  fs.writeFileSync(scriptFile, JSON.stringify(script));
  for (const suffix of ['.calls.json', '.prompts.log']) fs.rmSync(scriptFile + suffix, { force: true });
  // The default metrics path (per-branch shards, council C6) is the one under test.
  const env = { ...process.env, FACTORY_METRICS_SHARD: '1', PIPELINE_AGENT_CMD: `"${process.execPath}" "${fakeAgent}"`, PIPELINE_FAKE_SCRIPT: scriptFile, PIPELINE_BASE_REF: 'main' };
  delete env.PIPELINE_CHILD;
  delete env.PIPELINE_DISABLE;
  return spawnSync(process.execPath, ['scripts/pr-check/pr-check.mjs', 'run', '--story', 'DEMO-1', ...args], { cwd: repo, encoding: 'utf8', env });
};

// Every PR check record of the fixture repo, from the stream's own file and its branch shards.
const readChecks = () => trackedStreamFiles(path.join(repo, '.factory/metrics'), 'pr-checks.jsonl').filter((f) => fs.existsSync(f)).flatMap((f) => fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))).sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
// The acceptance critic rates every ticket line (council C7: a check with no rated line cannot pass).
const rowsMet = [{ ref: 'AC 1: a valid coupon gives 10% off', status: 'met', evidence: 'src/Basket/Coupons.cs:1' }, { ref: 'AC 2: an expired coupon is rejected with 400', status: 'met', evidence: 'src/Basket/Coupons.cs:1' }];
const rowsAc2Unmet = [rowsMet[0], { ...rowsMet[1], status: 'unmet', evidence: 'no expiry check' }];
const clean = (lens) => ({ result: { lens, score: 10, summary: 'ok', coverage: lens === 'acceptance' ? rowsMet : [], findings: [] } });
const expiredCoupon = { severity: 'blocking', title: 'Expired coupon is accepted', detail: 'AC 2 says 400', evidence: 'src/Basket/Coupons.cs:1', requirement: 'AC 2', fix: 'reject expired coupons' };
const upheldRound = { result: { score: 6, lensScores: { acceptance: 6 }, summary: 'AC 2 unmet', rulings: [{ id: 'ACC-1-1', ruling: 'upheld', severity: 'blocking', reason: 'conceded', fix: 'reject expired coupons' }] } };

before(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-check-e2e-'));
  scriptFile = path.join(repo, '..', `${path.basename(repo)}-agent.json`);
  for (const dir of ['scripts/pipeline', 'scripts/pr-check', 'scripts/board', 'scripts/implement', 'scripts/feature-verification', 'scripts/stack', 'scripts/teststack']) {
    fs.cpSync(path.join(source, dir), path.join(repo, dir), { recursive: true, filter: (p) => !p.startsWith(path.join(source, dir, 'test')) });
  }
  fs.cpSync(path.join(source, 'agents'), path.join(repo, 'agents'), { recursive: true });
  write('.gitignore', '.factory/state/\n.factory/metrics/\n');
  seedTicket(repo, { key: 'DEMO-1', slug: 'DEMO-1-apply-coupon', text: '# DEMO-1 Apply coupon\n\nAC 1: a valid coupon gives 10% off. AC 2: an expired coupon is rejected with 400.\n' });
  sh('git', ['init', '-q', '-b', 'main']);
  sh('git', ['config', 'user.email', 'fv@example.com']);
  sh('git', ['config', 'user.name', 'Feature verification Test']);
  sh('git', ['add', '-A']);
  sh('git', ['commit', '-qm', 'init']);
  sh('git', ['switch', '-q', '-c', 'feature/DEMO-1']);
  write('src/Basket/Coupons.cs', '// coupons\n');
  sh('git', ['add', '-A']);
  sh('git', ['commit', '-qm', 'DEMO-1: coupons']);
});

after(() => {
  fs.rmSync(repo, { recursive: true, force: true });
  for (const suffix of ['', '.calls.json', '.prompts.log']) fs.rmSync(scriptFile + suffix, { force: true });
});

test('report-only (--no-fix) runs one round, never calls the fixer, and fails below 10', () => {
  const r = prCheck(['--no-fix', '--json'], {
    'pr-check-acceptance': [{ result: { lens: 'acceptance', score: 6, summary: 'AC 2', coverage: rowsAc2Unmet, findings: [expiredCoupon] } }],
    'pr-check-flow': [clean('flow')],
    'pr-check-style': [clean('style')],
    'pr-check-defender': [{ result: { responses: [{ id: 'ACC-1-1', position: 'concede', argument: 'true' }] } }],
    'pr-check-judge': [upheldRound],
  });
  assert.equal(r.status, 1, r.stderr);
  const result = JSON.parse(r.stdout);
  assert.deepEqual([result.verdict, result.score, result.rounds], ['FAIL', 6, 1]);
  assert.deepEqual(result.openFindings.map((f) => f.id), ['ACC-1-1']);
  assert.equal(calls()['pr-check-fixer'], undefined);
});

test('a multi-ticket check (--epic, --stories) runs the design lens for every frontend ticket and the epic journey', (t) => {
  // The other tests count this repo's PR check records: leave them as they were.
  const mdir = path.join(repo, '.factory/metrics');
  const snap = fs.mkdtempSync(path.join(os.tmpdir(), 'metrics-snap-'));
  if (fs.existsSync(mdir)) fs.cpSync(mdir, snap, { recursive: true });
  t.after(() => {
    fs.rmSync(mdir, { recursive: true, force: true });
    fs.cpSync(snap, mdir, { recursive: true });
  });
  seedTicket(repo, { key: 'epic-checkout', type: 'epic', text: '# Epic: Checkout\n\nOne journey from cart to order.\n', mockups: { 'epic-checkout-journey/Journey.dc.html': '<x-dc></x-dc>' } });
  seedTicket(repo, { key: 'DEMO-3', parent: 'epic-checkout', text: '# DEMO-3: [FE - WebApp] - Cart coupon box\n', mockups: { 'DEMO-3-cart/Main.dc.html': '<x-dc></x-dc>', 'DEMO-3-cart/README.md': '# Cart' } });
  seedTicket(repo, { key: 'DEMO-4', parent: 'epic-checkout', text: '# DEMO-4: [BE - Ordering.API] - Coupon on the order\n' });
  const run = (args, script) => {
    fs.writeFileSync(scriptFile, JSON.stringify(script));
    for (const suffix of ['.calls.json', '.prompts.log']) fs.rmSync(scriptFile + suffix, { force: true });
    const env = { ...process.env, PIPELINE_AGENT_CMD: `"${process.execPath}" "${fakeAgent}"`, PIPELINE_FAKE_SCRIPT: scriptFile, PIPELINE_BASE_REF: 'main' };
    delete env.PIPELINE_CHILD;
    delete env.PIPELINE_DISABLE;
    return spawnSync(process.execPath, ['scripts/pr-check/pr-check.mjs', 'run', ...args], { cwd: repo, encoding: 'utf8', env });
  };
  const missing = { severity: 'major', title: 'Coupon box has no error state', detail: 'the mockup shows an expired-coupon error', evidence: 'src/Basket/Coupons.cs:1', requirement: 'DEMO-3 Main.dc.html', fix: 'add the error state' };
  const r = run(['--epic', 'checkout', '--lenses', 'design', '--no-fix', '--json'], {
    'pr-check-design': [{ result: { lens: 'design', score: 8, summary: 'one state missing', coverage: [], findings: [missing] } }],
    'pr-check-defender': [{ result: { responses: [{ id: 'UI-1-1', position: 'concede', argument: 'true' }] } }],
    'pr-check-judge': [{ result: { score: 8, lensScores: { design: 8 }, summary: 'state missing', rulings: [{ id: 'UI-1-1', ruling: 'upheld', severity: 'major', reason: 'conceded' }] } }],
  });
  assert.equal(r.status, 1, r.stderr);
  const result = JSON.parse(r.stdout);
  assert.deepEqual([result.id, result.story, result.stories, result.epic, result.lenses], ['epic-checkout', 'DEMO-3', ['DEMO-3', 'DEMO-4'], 'epic-checkout', ['design']]);
  assert.deepEqual(Object.keys(calls()).sort(), ['pr-check-defender', 'pr-check-design', 'pr-check-judge'], 'only the design lens ran');
  const prompt = fs.readFileSync(`${scriptFile}.prompts.log`, 'utf8').split('=== pr-check-design #1')[1].split('\n=== ')[0];
  assert.match(prompt, /### Tickets in this check \(2, epic epic-checkout\)/);
  assert.match(prompt, /- DEMO-3 \(frontend\): DEMO-3: \[FE - WebApp\] - Cart coupon box\n {2}- Story: .*DEMO-3\/story\.md\n {2}- Mockups: .*DEMO-3-cart\/Main\.dc\.html/);
  assert.match(prompt, /- DEMO-4: .*\n {2}- Story: .*\n {2}- Mockups: \(no mockup: use its Outputs and the design system\)/);
  assert.match(prompt, /- Epic epic-checkout: Epic: Checkout \(the journey across the tickets\)\n {2}- Body: .*\n {2}- Mockups: .*epic-checkout-journey\/Journey\.dc\.html/);
  const rec = readChecks().at(-1);
  assert.deepEqual([rec.target, rec.stories, rec.epic, rec.upheld.map((f) => [f.lens, f.requirement])], ['epic-checkout', ['DEMO-3', 'DEMO-4'], 'epic-checkout', [['design', 'DEMO-3 Main.dc.html']]]);

  // --stories names the set without an epic.
  const s = run(['--stories', 'DEMO-3,demo-4', '--lenses', 'design', '--no-fix', '--json'], { 'pr-check-design': [clean('design')], 'pr-check-judge': [{ result: { score: 10, lensScores: { design: 10 }, summary: 'ok', rulings: [] } }] });
  assert.equal(s.status, 0, s.stderr);
  assert.deepEqual([JSON.parse(s.stdout).id, JSON.parse(s.stdout).stories, JSON.parse(s.stdout).epic], ['DEMO-3+1', ['DEMO-3', 'DEMO-4'], null]);
  assert.match(run(['--stories', 'DEMO-3', '--lenses', 'looks', '--no-fix'], {}).stderr, /unknown lens looks/);
});

test('the loop debates, fixes, commits and re-reviews with fresh critics until 10/10', () => {
  const head = sh('git', ['rev-parse', 'HEAD']).trim();
  const r = prCheck(['--json'], {
    'pr-check-acceptance': [
      { result: { lens: 'acceptance', score: 6, summary: 'AC 2', coverage: rowsAc2Unmet, findings: [expiredCoupon] } },
      { result: { responses: [{ id: 'ACC-1-1', action: 'maintain', argument: 'the code has no expiry check' }] } },
      clean('acceptance'),
    ],
    'pr-check-flow': [clean('flow')],
    'pr-check-style': [clean('style')],
    'pr-check-defender': [
      { result: { responses: [{ id: 'ACC-1-1', position: 'rebut', argument: 'expiry is checked upstream', evidence: 'none' }] } },
      { result: { responses: [{ id: 'ACC-1-1', position: 'concede', argument: 'it is not' }] } },
    ],
    'pr-check-judge': [upheldRound, { result: { score: 10, lensScores: {}, summary: 'all met', rulings: [] } }],
    'pr-check-fixer': [{ writeImpl: 'src/Basket/Coupons.cs', result: { fixed: ['ACC-1-1'], notFixed: [], summary: 'reject expired' } }],
  });
  assert.equal(r.status, 0, r.stderr);
  const result = JSON.parse(r.stdout);
  assert.deepEqual([result.verdict, result.score, result.rounds, result.commits.length], ['PASS', 10, 2, 1]);
  assert.deepEqual(calls(), { 'pr-check-acceptance': 3, 'pr-check-flow': 2, 'pr-check-style': 2, 'pr-check-defender': 2, 'pr-check-judge': 2, 'pr-check-fixer': 1 });
  assert.match(sh('git', ['log', '-1', '--format=%s']), /DEMO-1: PR check round 1 fixes/);
  assert.notEqual(sh('git', ['rev-parse', 'HEAD^']).trim(), sh('git', ['rev-parse', 'HEAD']).trim());
  assert.equal(sh('git', ['rev-parse', 'HEAD^']).trim(), head);

  const debate = JSON.parse(fs.readFileSync(path.join(repo, '.factory/state/pr-check/DEMO-1/round-1/debate.json'), 'utf8'));
  assert.deepEqual(debate.findings[0].thread.map((t) => t.position ?? t.action), ['rebut', 'maintain', 'concede']);
  const report = fs.readFileSync(path.join(repo, result.report), 'utf8');
  assert.match(report, /# PR check: PASS 10\/10/);
  assert.match(report, /## Resolved during the loop\n\n- ACC-1-1/);
  const metrics = JSON.parse(spawnSync(process.execPath, ['scripts/pr-check/pr-check.mjs', 'metrics', '--json'], { cwd: repo, encoding: 'utf8', env: { ...process.env, FACTORY_METRICS_SHARD: '1' } }).stdout);
  assert.equal(metrics.perfect, 1);
  const [first] = readChecks();
  assert.deepEqual(
    { ...first.upheld[0], detail: undefined },
    { id: 'ACC-1-1', lens: 'acceptance', severity: first.upheld[0].severity, title: expiredCoupon.title, detail: undefined, requirement: expiredCoupon.requirement ?? '', evidence: expiredCoupon.evidence ?? '', repeat: false },
  );
  assert.deepEqual(first.dismissed, []);
});

// Delivery fix mode (implement.prCheck.mode fix): the loop stops once nothing major or worse is upheld.
test('--until major: a round that upholds only a minor finding ends ACCEPTED without a fix; a major one is fixed first', () => {
  const minorRound = { result: { score: 9, lensScores: { acceptance: 9 }, summary: 'nit', rulings: [{ id: 'ACC-1-1', ruling: 'upheld', severity: 'minor', reason: 'conceded', fix: 'rename' }] } };
  const minorOnly = prCheck(['--json', '--until', 'major'], {
    'pr-check-acceptance': [
      { result: { lens: 'acceptance', score: 9, summary: 'nit', coverage: rowsMet, findings: [{ ...expiredCoupon, severity: 'minor', requirement: 'naming', title: 'Coupon class name is imprecise' }] } },
      { result: { responses: [{ id: 'ACC-1-1', action: 'maintain', argument: 'still' }] } },
    ],
    'pr-check-flow': [clean('flow')],
    'pr-check-style': [clean('style')],
    'pr-check-defender': [{ result: { responses: [{ id: 'ACC-1-1', position: 'concede', argument: 'yes' }] } }],
    'pr-check-judge': [minorRound],
  });
  assert.equal(minorOnly.status, 0, minorOnly.stderr);
  const accepted = JSON.parse(minorOnly.stdout);
  assert.deepEqual([accepted.verdict, accepted.rounds, accepted.commits.length, accepted.openFindings.map((f) => f.severity)], ['ACCEPTED', 1, 0, ['minor']]);
  assert.equal(calls()['pr-check-fixer'] ?? 0, 0);

  const major = prCheck(['--json', '--until', 'major'], {
    'pr-check-acceptance': [
      { result: { lens: 'acceptance', score: 6, summary: 'AC 2', coverage: rowsAc2Unmet, findings: [expiredCoupon] } },
      { result: { responses: [{ id: 'ACC-1-1', action: 'maintain', argument: 'no expiry check' }] } },
      clean('acceptance'),
    ],
    'pr-check-flow': [clean('flow')],
    'pr-check-style': [clean('style')],
    'pr-check-defender': [{ result: { responses: [{ id: 'ACC-1-1', position: 'concede', argument: 'it is not' }] } }],
    'pr-check-judge': [upheldRound, { result: { score: 10, lensScores: {}, summary: 'all met', rulings: [] } }],
    'pr-check-fixer': [{ writeImpl: 'src/Basket/Coupons2.cs', result: { fixed: ['ACC-1-1'], notFixed: [], summary: 'reject expired' } }],
  });
  assert.equal(major.status, 0, major.stderr);
  const fixed = JSON.parse(major.stdout);
  assert.deepEqual([fixed.verdict, fixed.rounds, fixed.commits.length], ['PASS', 2, 1]);
});

// Dogfood C2: the delivery fix mode re-critiqued from scratch, the new critics missed the report round's
// blocking finding, and the loop passed 10/10 without fixing it. --fix-first starts with that round's findings.
test('--fix-first: the fixer works on the report round\'s upheld findings before any new critique', () => {
  const seed = path.join(repo, '..', `${path.basename(repo)}-report.json`);
  fs.writeFileSync(seed, JSON.stringify({ verdict: 'FAIL', score: 6, lensScores: { flow: 6 }, upheldFindings: [{ id: 'FLOW-1-1', lens: 'flow', severity: 'blocking', title: 'Retry returns 200', detail: 'd', fix: 'check existence first' }] }));
  const r = prCheck(['--json', '--until', 'major', '--fix-first', seed], {
    'pr-check-fixer': [{ writeImpl: 'src/Basket/Coupons3.cs', result: { fixed: ['FLOW-1-1'], notFixed: [], summary: 'existence first' } }],
    'pr-check-acceptance': [clean('acceptance')],
    'pr-check-flow': [clean('flow')],
    'pr-check-style': [clean('style')],
    'pr-check-judge': [{ result: { score: 10, lensScores: {}, summary: 'fixed', rulings: [] } }],
  });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.deepEqual([out.verdict, out.rounds, out.commits.length], ['PASS', 2, 1]);
  assert.deepEqual(calls()['pr-check-fixer'], 1);
  assert.deepEqual(calls()['pr-check-judge'], 1, 'one critique, after the fix');
  assert.match(r.stderr, /round 1 \(fix\)/);
  const seeded = readChecks().filter((c) => c.seeded);
  assert.equal(seeded.at(-1).fix.commit != null, true, 'the seeded fix round is recorded with its commit');
});

// Council C7 (Opus 1): the CI gate's fix round on #120 escalated and left no PR check record, so the gate kept reading
// the last 10/10. A seeded fix round that escalates is recorded with the seed's score.
test('--fix-first: a fix round that escalates is recorded in pr-checks with the seed\'s score and the fixer\'s notes', () => {
  const seed = path.join(repo, '..', `${path.basename(repo)}-ci-seed.json`);
  fs.writeFileSync(seed, JSON.stringify({ score: 6, lensScores: {}, upheldFindings: [{ id: 'CI-FLAKY-1', lens: 'flow', severity: 'major', title: 'A test passes only on a retry in CI: TC-06', detail: 'd', fix: 'first attempt' }] }));
  const before = readChecks().length;
  const r = prCheck(['--json', '--until', 'major', '--max-rounds', '1', '--fix-first', seed], {
    'pr-check-fixer': [{ result: { fixed: [], notFixed: [{ id: 'CI-FLAKY-1', reason: 'Headers are read-only: options (a) NotFoundPage (b) drop StreamRendering' }], summary: 'needs a decision' } }],
  });
  const out = JSON.parse(r.stdout);
  assert.equal(out.verdict, 'ESCALATED');
  const recs = readChecks().slice(before);
  assert.equal(recs.length, 1);
  assert.deepEqual([recs[0].seeded, recs[0].escalated, recs[0].score], [true, true, 6]);
  assert.match(recs[0].fix.notFixed[0].reason, /options \(a\) NotFoundPage/);
  assert.equal(calls()['pr-check-judge'] ?? 0, 0);
});

// Council C5: a fix that only corrects the story's notes has no commit; the harness writes the fixer's corrected bullet
// and the next round runs on the corrected story.
test('a notes-only fix: the harness writes the corrected bullet, and the next round reads it', () => {
  const storyFile = path.join(repo, '.factory/state/board/DEMO-1/story.md');
  const before = fs.readFileSync(storyFile, 'utf8');
  fs.writeFileSync(storyFile, `${before.trimEnd()}\n\n## Implementation Notes\n\n* **Deviations:** expired coupons are accepted for a day.\n`);
  const seed = path.join(repo, '..', `${path.basename(repo)}-notes.json`);
  fs.writeFileSync(seed, JSON.stringify({ verdict: 'FAIL', score: 9, lensScores: {}, upheldFindings: [{ id: 'ACC-9-1', lens: 'acceptance', severity: 'minor', title: 'Notes say expired coupons are accepted', detail: 'the code rejects them' }] }));
  const r = prCheck(['--json', '--until', 'minor', '--fix-first', seed], {
    'pr-check-fixer': [{ result: { fixed: ['ACC-9-1'], notFixed: [], notes: [{ field: 'Deviations', text: 'none: expired coupons are rejected.' }], summary: 'notes only' } }],
    'pr-check-acceptance': [clean('acceptance')],
    'pr-check-flow': [clean('flow')],
    'pr-check-style': [clean('style')],
    'pr-check-judge': [{ result: { score: 10, lensScores: {}, summary: 'ok', rulings: [] } }],
  });
  const story = fs.readFileSync(storyFile, 'utf8');
  fs.writeFileSync(storyFile, before);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.deepEqual([out.verdict, out.rounds, out.commits.length], ['PASS', 2, 0]);
  assert.match(story, /^\* \*\*Deviations:\*\* none: expired coupons are rejected\.$/m);
  assert.doesNotMatch(story, /accepted for a day/);
});

// Council C6: a ticket line the critic rates partial, which the ticket's owner must settle, ends the check QUESTION:
// never PASS, never a follow-up, never "resolved".
test('an owner question ends the check QUESTION with the question in the result and the report', () => {
  const partial = { result: { lens: 'acceptance', score: 8, summary: 's', coverage: [{ ref: 'Expected: lands on the home page', status: 'partial', evidence: '/ is a 404 in Production' }], findings: [{ ...expiredCoupon, severity: 'major', title: 'No home page after sign-in' }] } };
  const r = prCheck(['--json', '--until', 'major'], {
    'pr-check-acceptance': [partial, { result: { responses: [{ id: 'ACC-1-1', action: 'maintain', argument: 'still partial' }] } }],
    'pr-check-flow': [clean('flow')],
    'pr-check-style': [clean('style')],
    'pr-check-defender': [{ result: { responses: [{ id: 'ACC-1-1', position: 'rebut', argument: 'the ticket asks for a page Production does not have' }] } }],
    'pr-check-judge': [{ result: { score: 10, lensScores: { acceptance: 10 }, summary: 's', rulings: [{ id: 'ACC-1-1', ruling: 'dismissed', questionKind: 'impossible', reason: 'the ticket contradicts the app', question: 'Which page should sign-in land on in Production?' }] } }],
  });
  assert.equal(r.status, 1, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.verdict, 'QUESTION');
  assert.ok(out.score < 10);
  assert.deepEqual(out.questions.map((q) => q.question), ['Which page should sign-in land on in Production?']);
  assert.deepEqual(out.followUps, []);
  assert.ok(!out.resolvedFindings.some((f) => f.id === 'ACC-1-1'));
  assert.match(fs.readFileSync(path.join(repo, out.report), 'utf8'), /## Needs an owner decision/);
  assert.equal(calls()['pr-check-fixer'] ?? 0, 0, 'the fixer cannot answer an owner question');
  assert.deepEqual(readChecks().at(-1).questions.map((q) => q.id), ['ACC-1-1']);
});

// Council C7 (Sol 1): the backstop for open acceptance lines was lens-wide, so one unrelated minor acceptance finding
// suppressed it: AC 2 unmet, its major finding dismissed as out of scope with no question, a minor label finding upheld,
// and the check ended ACCEPTED 9/10 with exit 0. Reproduced exactly as the reviewer ran it, through the CLI.
const AC1 = rowsMet[0].ref;
const AC2 = rowsMet[1].ref;
const ac2Major = { severity: 'major', title: 'Expired coupon is accepted', detail: 'POST /coupons with an expired code answers 200', evidence: 'src/Basket/Coupons.cs:1', requirement: AC2, fix: 'reject expired coupons with 400' };
const ac1Label = { severity: 'minor', title: 'Test case label is imprecise', detail: 'The case for the 10% discount is labelled "coupon works"', evidence: 'e2e/coupons.spec.ts:3', requirement: AC1, fix: 'rename the case' };
const solJudge = { result: { score: 9, lensScores: { acceptance: 9 }, summary: 'only a label nit', rulings: [{ id: 'ACC-1-1', ruling: 'dismissed', reason: 'out of scope for this PR' }, { id: 'ACC-1-2', ruling: 'upheld', severity: 'minor', reason: 'label is imprecise', fix: 'rename' }] } };
const lastCoverage = (out) => {
  const file = path.join(repo, path.dirname(out.report), `round-${out.rounds}`, 'coverage.json');
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')).acceptance?.coverage ?? [] : null;
};

test('Sol C7 reproduction: an unmet line whose finding is dismissed is not covered by an unrelated upheld minor', () => {
  const r = prCheck(['--until', 'major', '--debate-turns', '0', '--json'], {
    'pr-check-acceptance': [{ result: { lens: 'acceptance', score: 7, summary: 'AC 2 unmet', coverage: rowsAc2Unmet, findings: [ac2Major, ac1Label] } }],
    'pr-check-flow': [clean('flow')],
    'pr-check-style': [clean('style')],
    'pr-check-judge': [solJudge],
    'pr-check-fixer': [{ result: { fixed: [], notFixed: ['acceptance-criterion-2', 'ACC-1-2'], summary: 'cannot without a decision' } }],
  });
  const out = JSON.parse(r.stdout);
  assert.notEqual(r.status, 0, 'the check must not exit 0');
  assert.deepEqual([out.verdict, out.rounds], ['ESCALATED', 1]);
  assert.ok(out.score <= 8, `score ${out.score}`);
  const ac2 = out.openFindings.find((f) => f.id === 'acceptance-criterion-2');
  assert.ok(ac2, JSON.stringify(out.openFindings));
  assert.equal(ac2.severity, 'major');
  assert.match(ac2.title, /^Criterion not met: AC 2: an expired coupon is rejected with 400/);
  assert.equal(calls()['pr-check-fixer'], 1, 'the fixer is asked to meet the line');
});

// Every way the check can end, for features and bugs, report and fix modes: none ends PASS or ACCEPTED while the
// acceptance critic still rates a ticket line open in the round the check ends on.
test('no outcome path ends PASS or ACCEPTED with an open acceptance or Expected line', () => {
  const bugRows = [{ ref: 'Expected: a valid coupon gives 10% off', status: 'met', evidence: 'a' }, { ref: 'Expected: an expired coupon is rejected with 400', status: 'unmet', evidence: 'b' }];
  const acc = (coverage, findings, score = 7) => ({ result: { lens: 'acceptance', score, summary: 's', coverage, findings } });
  const judgeOf = (rulings, score = 10) => ({ result: { score, lensScores: {}, summary: 's', rulings } });
  const passRound = judgeOf([]);
  const scenarios = [
    { name: 'dismissed unmet line + unrelated upheld minor (Sol)', critic: acc(rowsAc2Unmet, [ac2Major, ac1Label]), judge: solJudge },
    { name: 'the same on a bug ticket (Expected lines)', critic: acc(bugRows, [{ ...ac2Major, requirement: bugRows[1].ref }, { ...ac1Label, requirement: bugRows[0].ref }]), judge: solJudge },
    { name: 'unmet line dismissed as a follow-up + unrelated upheld minor', critic: acc(rowsAc2Unmet, [ac2Major, ac1Label]), judge: judgeOf([{ id: 'ACC-1-1', ruling: 'dismissed', reason: 'later', followUp: 'Expiry handling' }, { id: 'ACC-1-2', ruling: 'upheld', severity: 'minor', reason: 'r' }], 9) },
    { name: 'owner question on AC 1 + a separate unmet AC 2 with no finding', critic: acc([{ ...rowsMet[0], status: 'partial' }, rowsAc2Unmet[1]], [{ ...ac1Label, severity: 'major', title: 'Discount is 10% of the net, ticket says gross' }]), judge: judgeOf([{ id: 'ACC-1-1', ruling: 'dismissed', questionKind: 'ambiguous', reason: 'ticket contradicts the app', question: 'Gross or net?' }], 9), question: true },
    { name: 'the finding on the unmet line downgraded to minor', critic: acc(rowsAc2Unmet, [ac2Major]), judge: judgeOf([{ id: 'ACC-1-1', ruling: 'upheld', severity: 'minor', reason: 'small' }], 9) },
    { name: 'an unmet line with no finding at all and a 10 from the judge', critic: acc(rowsAc2Unmet, [], 10), judge: passRound },
    { name: 'a partial line the judge never mentions', critic: acc([rowsMet[0], { ...rowsMet[1], status: 'partial' }], [], 10), judge: passRound },
    { name: 'an unverifiable line', critic: acc([rowsMet[0], { ...rowsMet[1], status: 'unverifiable' }], [], 10), judge: passRound },
    { name: 'the critic rated no ticket line', critic: acc([], [], 10), judge: passRound },
  ];
  const modes = [
    { name: 'report (--no-fix)', args: ['--no-fix'] },
    { name: 'fix until major (features)', args: ['--until', 'major'] },
    { name: 'fix until blocking', args: ['--until', 'blocking'] },
    { name: 'fix to 10', args: [] },
  ];
  const rows = [];
  for (const s of scenarios) {
    for (const m of modes) {
      for (const fixer of ['cannot', 'meets the line']) {
        if (m.args[0] === '--no-fix' && fixer !== 'cannot') continue;
        // The fixer either cannot meet the line (the check escalates), or meets it: the next round's critic rates
        // every line met and the judge awards 10 (only then may the check pass).
        const r = prCheck([...m.args, '--debate-turns', '0', '--max-rounds', '3', '--json'], {
          'pr-check-acceptance': fixer === 'cannot' ? [s.critic] : [s.critic, clean('acceptance')],
          'pr-check-flow': [clean('flow')],
          'pr-check-style': [clean('style')],
          'pr-check-judge': fixer === 'cannot' ? [s.judge] : [s.judge, passRound],
          'pr-check-fixer': [fixer === 'cannot' ? { result: { fixed: [], notFixed: ['all'], summary: 'needs a decision' } } : { writeImpl: `src/Basket/Fix${rows.length}.cs`, result: { fixed: ['all'], notFixed: [], summary: 'met' } }],
        });
        const out = JSON.parse(r.stdout);
        const cov = lastCoverage(out);
        const open = (cov ?? []).filter((c) => c.status !== 'met');
        rows.push({ scenario: s.name, mode: m.name, fixer, verdict: out.verdict, score: out.score, exit: r.status });
        const label = `${s.name} / ${m.name} / fixer ${fixer}: ${out.verdict} ${out.score} exit ${r.status}`;
        if (['PASS', 'ACCEPTED'].includes(out.verdict)) {
          assert.ok(cov && cov.length && !open.length, `${label} ended ${out.verdict} with open lines ${JSON.stringify(open)}`);
          assert.equal(fixer, 'meets the line', label);
        } else {
          assert.notEqual(r.status, 0, label);
        }
        if (s.question && fixer === 'cannot') assert.ok(['QUESTION', 'ESCALATED', 'FAIL'].includes(out.verdict), label);
        if (s.question && m.args[0] === '--no-fix') assert.equal(out.verdict, 'QUESTION', label);
      }
    }
  }
  assert.equal(rows.length, 63, `${rows.length} paths`);
  assert.ok(rows.some((x) => x.verdict === 'PASS'), 'the passing path is exercised');
  assert.ok(rows.some((x) => x.verdict === 'QUESTION') && rows.some((x) => x.verdict === 'ESCALATED') && rows.some((x) => x.verdict === 'FAIL'));
});

test('--fix-lenses video: a minor video finding is fixed, not accepted', () => {
  const minorVideo = { result: { score: 9, lensScores: { acceptance: 9 }, summary: 'video', rulings: [{ id: 'ACC-1-1', ruling: 'upheld', severity: 'minor', reason: 'r', fix: 'show it' }] } };
  const r = prCheck(['--json', '--until', 'major', '--fix-lenses', 'acceptance'], {
    'pr-check-acceptance': [{ result: { lens: 'acceptance', score: 9, summary: 's', coverage: rowsMet, findings: [{ ...expiredCoupon, severity: 'minor', requirement: 'naming', title: 'Coupon class name is imprecise' }] } }, { result: { responses: [{ id: 'ACC-1-1', action: 'maintain', argument: 'a' }] } }, clean('acceptance')],
    'pr-check-flow': [clean('flow')],
    'pr-check-style': [clean('style')],
    'pr-check-defender': [{ result: { responses: [{ id: 'ACC-1-1', position: 'concede', argument: 'yes' }] } }],
    'pr-check-judge': [minorVideo, { result: { score: 10, lensScores: {}, summary: 'ok', rulings: [] } }],
    'pr-check-fixer': [{ writeImpl: 'src/Basket/Coupons4.cs', result: { fixed: ['ACC-1-1'], notFixed: [], summary: 'shown' } }],
  });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.deepEqual([out.verdict, out.rounds, out.commits.length], ['PASS', 2, 1]);
});

test('the loop escalates when the fixer cannot fix the upheld findings', () => {
  const r = prCheck(['--json'], {
    'pr-check-acceptance': [{ result: { lens: 'acceptance', score: 6, summary: 'AC 2', coverage: rowsAc2Unmet, findings: [expiredCoupon] } }],
    'pr-check-flow': [clean('flow')],
    'pr-check-style': [clean('style')],
    'pr-check-defender': [{ result: { responses: [{ id: 'ACC-1-1', position: 'concede', argument: 'true' }] } }],
    'pr-check-judge': [upheldRound],
    'pr-check-fixer': [{ result: { fixed: [], notFixed: [{ id: 'ACC-1-1', reason: 'needs a product decision' }], summary: 'blocked' } }],
  });
  assert.equal(r.status, 1, r.stderr);
  const result = JSON.parse(r.stdout);
  assert.deepEqual([result.verdict, result.rounds], ['ESCALATED', 1]);
  assert.match(fs.readFileSync(path.join(repo, '.factory/state/escalations/DEMO-1-pr-check.md'), 'utf8'), /ACC-1-1/);
});

// Stop-hook flow: the check waits in the background for feature verification, then hands its findings back to the agent.
const env = () => {
  const e = { ...process.env, PIPELINE_AGENT_CMD: `"${process.execPath}" "${fakeAgent}"`, PIPELINE_FAKE_SCRIPT: scriptFile, PIPELINE_BASE_REF: 'main' };
  delete e.PIPELINE_CHILD;
  delete e.PIPELINE_DISABLE;
  delete e.PR_CHECK_SKIP;
  return e;
};
const hook = (args, payload = {}) => {
  const r = spawnSync(process.execPath, ['scripts/pr-check/pr-check.mjs', 'hook', ...args], { cwd: repo, encoding: 'utf8', input: JSON.stringify(payload), env: env() });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
};
const stop = (payload) => {
  const out = hook(['stop'], payload);
  return out ? JSON.parse(out) : null;
};
const stateFile = () => path.join(repo, '.factory/state/stories/DEMO-1.json');
const stateOf = () => JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
const setState = (patch) => {
  const s = fs.existsSync(stateFile()) ? stateOf() : { story: 'DEMO-1' };
  for (const [k, v] of Object.entries(patch)) s[k] = v && typeof v === 'object' && !Array.isArray(v) ? { ...s[k], ...v } : v;
  fs.writeFileSync(stateFile(), JSON.stringify(s, null, 2));
};
const implHash = () => {
  const code = "import { loadConfig } from './scripts/pipeline/lib/config.mjs'; import { implChanges } from './scripts/pipeline/lib/git.mjs'; console.log(implChanges(loadConfig('pr-check')).hash);";
  return spawnSync(process.execPath, ['--input-type=module', '-e', code], { cwd: repo, encoding: 'utf8', env: env() }).stdout.trim();
};
const waitFor = async (predicate, timeoutMs = 120_000) => {
  for (const start = Date.now(); Date.now() - start < timeoutMs; ) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`timed out; state: ${JSON.stringify(stateOf().prCheck)}`);
};
// Approve the code now on disk, as the review stage does, with feature verification in the given state.
const approve = (automation) => {
  const hash = implHash();
  setState({ done: new Date().toISOString(), review: { lastVerdict: 'APPROVED', approvedHash: hash }, automation: automation(hash) });
  return hash;
};

test('Stop hook: waits for feature verification to verify the tests, checks in the background, then blocks the agent with the findings', async () => {
  const config = JSON.parse(fs.readFileSync(path.join(repo, 'scripts/pr-check/config.json'), 'utf8'));
  config.prCheck.hook.pollSec = 0.2;
  write('scripts/pr-check/config.json', JSON.stringify(config, null, 2));
  write('.factory/state/active-story', 'DEMO-1\n');
  fs.writeFileSync(scriptFile, JSON.stringify({
    'pr-check-acceptance': [{ result: { lens: 'acceptance', score: 6, summary: 'AC 2', coverage: rowsAc2Unmet, findings: [expiredCoupon] } }],
    'pr-check-flow': [clean('flow')],
    'pr-check-style': [clean('style')],
    'pr-check-defender': [{ result: { responses: [{ id: 'ACC-1-1', position: 'concede', argument: 'true' }] } }],
    'pr-check-judge': [upheldRound],
  }));
  for (const suffix of ['.calls.json', '.prompts.log']) fs.rmSync(scriptFile + suffix, { force: true });
  hook(['story-start', 'DEMO-1']);
  write('src/Basket/Coupons.cs', '// coupons v3, uncommitted\n');

  assert.equal(stop(), null, 'no check until the review approves the code on disk');
  const hash = approve(() => ({ status: 'running', verifiedHash: null }));
  assert.equal(stop({ hook_event_name: 'SubagentStop', agent_type: 'Explore' }), null, 'only code agents trigger it');
  assert.match(stop().systemMessage, /DEMO-1 will be checked against its story in the background once feature verification has verified the tests/);
  assert.deepEqual([stateOf().prCheck.status, stateOf().prCheck.hash], ['waiting', hash]);
  assert.equal(stop(), null, 'one waiter per implementation');
  await new Promise((r) => setTimeout(r, 1000));
  assert.equal(fs.existsSync(`${scriptFile}.calls.json`), false, 'no agent runs while feature verification is still working');

  setState({ automation: { status: 'verified', verifiedHash: hash } });
  await waitFor(() => stateOf().prCheck.status === 'done');
  assert.deepEqual(calls()['pr-check-fixer'], undefined, 'report only: the agent is the fixer');
  const first = stop();
  assert.equal(first.decision, 'block');
  assert.match(first.reason, /PR check of DEMO-1 scored 6\/10[\s\S]*1\. \[blocking\] ACC-1-1 \(acceptance\) Expired coupon is accepted[\s\S]*Fix them, then finish your turn/);
  assert.match(stop().reason, /still open and nothing has changed/);
  assert.match(stop({ stop_hook_active: true }).systemMessage, /still has 1 open finding/);
  assert.equal(stop(), null);
  assert.match(hook(['session-start']), /PR check for DEMO-1: FAIL 6\/10[\s\S]*ACC-1-1/);
  const record = readChecks().at(-1);
  assert.deepEqual([record.target, record.round, record.upheld.map((u) => u.id)], ['DEMO-1', 1, ['ACC-1-1']], 'hook runs feed the lessons like any other check');

  // The agent fixes the finding; once review and feature verification pass the new code, the check runs again and passes.
  write('src/Basket/Coupons.cs', '// coupons v4, rejects expired coupons\n');
  fs.writeFileSync(scriptFile, JSON.stringify({
    'pr-check-acceptance': [clean('acceptance')],
    'pr-check-flow': [clean('flow')],
    'pr-check-style': [clean('style')],
    'pr-check-judge': [{ result: { score: 10, lensScores: {}, summary: 'all met', rulings: [] } }],
  }));
  approve((h) => ({ status: 'verified', verifiedHash: h }));
  assert.match(stop().systemMessage, /checked against its story in the background/);
  await waitFor(() => stateOf().prCheck.status === 'done');
  assert.match(stop().systemMessage, /DEMO-1 scored 10\/10 against its story/);
  assert.equal(stop(), null);
  assert.equal(stateOf().prCheck.runs, 0, 'a pass resets the run count');
});

test('Stop hook: escalates instead of checking again once the run limit is reached', () => {
  write('src/Basket/Coupons.cs', '// coupons v5\n');
  approve((h) => ({ status: 'verified', verifiedHash: h }));
  setState({ prCheck: { status: 'done', hash: 'older', verdict: 'FAIL', score: 6, runs: 3, openFindings: [{ id: 'ACC-1-1', lens: 'acceptance', severity: 'blocking', title: 'x' }], report: 'r.md' } });
  const skipped = spawnSync(process.execPath, ['scripts/pr-check/pr-check.mjs', 'hook', 'stop'], { cwd: repo, encoding: 'utf8', input: '{}', env: { ...env(), PR_CHECK_SKIP: '1' } });
  assert.equal(skipped.stdout, '', 'PR_CHECK_SKIP=1 turns the hook off');
  assert.match(stop().systemMessage, /still failed after 3 checks\. A human needs to decide/);
  assert.match(fs.readFileSync(path.join(repo, '.factory/state/escalations/DEMO-1-pr-check.md'), 'utf8'), /still failing after 3 PR checks/);
  assert.equal(stateOf().prCheck.status, 'escalated');
  assert.equal(stop(), null);
});
test('a manual check killed during a fix resumes from that fix, not from the start', async () => {
  sh('git', ['add', '-A']);
  sh('git', ['commit', '-qm', 'DEMO-1: coupons v6']);
  const progress = () => JSON.parse(fs.readFileSync(path.join(repo, '.factory/state/pr-check/DEMO-1/progress.json'), 'utf8'));
  const r = prCheck(['--json'], {
    'pr-check-acceptance': [{ result: { lens: 'acceptance', score: 6, summary: 'AC 2', coverage: rowsAc2Unmet, findings: [expiredCoupon] } }, clean('acceptance')],
    'pr-check-flow': [clean('flow')],
    'pr-check-style': [clean('style')],
    'pr-check-defender': [{ result: { responses: [{ id: 'ACC-1-1', position: 'concede', argument: 'true' }] } }],
    'pr-check-judge': [upheldRound, { result: { score: 10, lensScores: {}, summary: 'all met', rulings: [] } }],
    'pr-check-fixer': [
      { writeImpl: 'src/Basket/Coupons.cs', killPidIn: '.factory/state/pr-check/DEMO-1/progress.json' },
      { writeImpl: 'src/Basket/Coupons.cs', result: { fixed: ['ACC-1-1'], notFixed: [], summary: 'reject expired' } },
    ],
  });
  assert.equal(r.signal, 'SIGKILL');
  assert.deepEqual([progress().finishedAt, progress().loop.round, progress().loop.phase], [null, 1, 'fix']);
  assert.match(hook(['session-start']), /PR check DEMO-1 \(DEMO-1\) was interrupted at round 1/);

  const resumed = spawnSync(process.execPath, ['scripts/pr-check/pr-check.mjs', 'resume'], { cwd: repo, encoding: 'utf8', env: env() });
  assert.match(resumed.stdout, /DEMO-1: resumed the interrupted PR check from round 1 \(fix\) \(attempt 1\/3/, resumed.stderr);
  await waitFor(() => progress().finishedAt);
  assert.equal(progress().error ?? null, null);
  const result = JSON.parse(fs.readFileSync(path.join(repo, '.factory/state/pr-check/DEMO-1/result.json'), 'utf8'));
  assert.deepEqual([result.verdict, result.rounds, result.commits.length], ['PASS', 2, 1]);
  assert.deepEqual([calls()['pr-check-judge'], calls()['pr-check-fixer']], [2, 2], 'round 1 was not reviewed again');
  assert.match(sh('git', ['log', '-1', '--format=%s']), /DEMO-1: PR check round 1 fixes/);
  assert.equal(progress().recoveries, 0);
});

test('a background check whose process died is restarted, escalated after repeated crashes, and retried with --force', async () => {
  write('.factory/state/active-story', 'DEMO-1\n');
  write('src/Basket/Coupons.cs', '// coupons v8\n');
  const hash = approve((h) => ({ status: 'verified', verifiedHash: h }));
  fs.writeFileSync(scriptFile, JSON.stringify({
    'pr-check-acceptance': [clean('acceptance')],
    'pr-check-flow': [clean('flow')],
    'pr-check-style': [clean('style')],
    'pr-check-judge': [{ result: { score: 10, lensScores: {}, summary: 'all met', rulings: [] } }],
  }));
  const dead = (fields = {}) => setState({ prCheck: { status: 'running', hash, pid: 999999, boot: null, verdict: null, recoveries: 0, retryAt: null, ...fields } });
  const resume = (...args) => spawnSync(process.execPath, ['scripts/pr-check/pr-check.mjs', 'resume', ...args], { cwd: repo, encoding: 'utf8', env: env() }).stdout;

  dead();
  assert.match(hook(['session-start']), /restarted the interrupted PR check of DEMO-1 \(attempt 1\/3/);
  await waitFor(() => stateOf().prCheck.status === 'done');
  assert.equal(stateOf().prCheck.verdict, 'PASS');

  dead({ recoveries: 3 });
  assert.match(resume('DEMO-1'), /died 3 times; escalated/);
  assert.equal(stateOf().prCheck.status, 'crashed');
  assert.match(fs.readFileSync(path.join(repo, '.factory/state/escalations/DEMO-1-pr-check.md'), 'utf8'), /crashed 3 times/);
  assert.equal(stop(), null, 'a crashed check waits for a human');
  assert.match(resume('DEMO-1', '--force'), /restarted the interrupted PR check of DEMO-1 \(attempt 1\/3/);
  await waitFor(() => stateOf().prCheck.status === 'done');
});

test('after fixes, feature verification verifies the stale ticket again before the push, then one commit (dogfood step 5)', async () => {
  const { reverifyAfterFixes } = await import('../pr-check.mjs');
  const calls = [];
  const run = (...args) => {
    calls.push(args.join(' '));
    if (args[0] === 'check') return { status: 1, stdout: 'FAIL BUG-7 plan=unverified automation=unverified plan edited after verification', stderr: '' };
    return { status: 0, stdout: '', stderr: '' };
  };
  const gitCalls = [];
  const git = (cwd, args) => (gitCalls.push(args.join(' ')), { status: args[0] === 'diff' ? 1 : 0, stdout: '', stderr: '' });
  reverifyAfterFixes({}, { workRoot: '/tmp/x', baseRef: 'origin/main', story: { key: 'BUG-7' } }, { run, git });
  assert.deepEqual(calls, ['check --changed-from origin/main', 'plan BUG-7 --verify-first', 'automate BUG-7 --verify-first']);
  // Council C5: after a fix round the check is scoped (plan and tests as they are, no whole projects); one full
  // verification follows before the push.
  const scoped = [];
  let stale = true;
  const ctx = { workRoot: '/tmp/x', baseRef: 'origin/main', story: { key: 'BUG-7' } };
  const run2 = (...args) => (scoped.push(args.join(' ')), args[0] === 'check' ? (stale ? ((stale = false), { status: 1, stdout: 'FAIL BUG-7 plan=unverified', stderr: '' }) : { status: 0, stdout: '', stderr: '' }) : { status: 0, stdout: '', stderr: '' });
  reverifyAfterFixes({}, ctx, { run: run2, git }, { scoped: true });
  reverifyAfterFixes({}, ctx, { run: run2, git });
  assert.deepEqual(scoped, ['check --changed-from origin/main', 'plan BUG-7 --verify-first', 'automate BUG-7 --verify-first --scoped', 'check --changed-from origin/main', 'automate BUG-7 --verify-first']);
  assert.ok(gitCalls.some((c) => /^commit -q -m BUG-7: Re-verified test plan and tests/.test(c)), gitCalls.join('\n'));
  // Nothing stale: nothing re-run, nothing committed.
  const quiet = [];
  reverifyAfterFixes({}, { workRoot: '/tmp/x', baseRef: 'origin/main', story: { key: 'BUG-7' } }, { run: (...a) => (quiet.push(a[0]), { status: 0, stdout: '', stderr: '' }), git: () => ({ status: 0 }) });
  assert.deepEqual(quiet, ['check']);
});

test("the PR check's videos: the e2e video reporter's folder first, narrowed to the story's own cases (dogfood step 5)", async () => {
  const { videoSources } = await import('../lib/video.mjs');
  const fsMod = await import('node:fs');
  const osMod = await import('node:os');
  const pathMod = await import('node:path');
  const root = fsMod.mkdtempSync(pathMod.join(osMod.tmpdir(), 'pr-videos-'));
  const touch = (rel) => {
    fsMod.mkdirSync(pathMod.dirname(pathMod.join(root, rel)), { recursive: true });
    fsMod.writeFileSync(pathMod.join(root, rel), 'v');
  };
  touch('test-results/BrowseItemTest-x/video.webm');
  touch('artifacts/e2e-videos/scenarios/basket-cart--tc-bug-7-01-home.webm');
  touch('artifacts/e2e-videos/e2e-tests-logged-in/CartTest--add.webm');
  const config = { root, prCheck: { video: { extensions: ['.webm'], defaultDirs: ['artifacts/e2e-videos', 'test-results'] } } };
  const { sources } = videoSources(config, { caseIds: ['tc-BUG-7-'] });
  assert.deepEqual(sources.map((s) => s.source), ['artifacts/e2e-videos/scenarios/basket-cart--tc-bug-7-01-home.webm']);
  // Council C4: none of the story's own: no video at all, and the report says why.
  const none = videoSources(config, { caseIds: ['tc-BUG-4-'] });
  assert.deepEqual(none.sources, []);
  assert.match(none.missing[0].reason, /none of the 2 video\(s\) there is of this story's test cases/);
  fsMod.rmSync(root, { recursive: true, force: true });
});

test('a server file of a service that also serves pages does not make a story frontend; its UI files do', async () => {
  const { UI_FILE } = await import('../lib/context.mjs');
  for (const f of ['src/Identity.API/Configuration/Config.cs', 'src/WebApp/Services/BasketService.cs', 'src/Catalog.API/Apis/CatalogApi.cs']) assert.ok(!UI_FILE.test(f), f);
  for (const f of ['src/Identity.API/Views/Account/Login.cshtml', 'src/WebApp/Components/Pages/Cart.razor', 'src/WebApp/wwwroot/app.css', 'src/WebApp/Components/Layout/Header.razor.cs']) assert.ok(UI_FILE.test(f), f);
});

// Cost (dogfood C2): the design and video critics ran again after fixes that could not change what they judge.
test('carryOver: design and video are carried when the fix could not touch them; code lenses always run', async () => {
  const { carryOver } = await import('../lib/loop.mjs');
  const ctx = { workRoot: '/r', frontendHit: (f) => f.startsWith('src/WebApp/'), videoKey: 'v1' };
  const last = (over = {}) => [{ fix: { commit: 'abc' }, lensScores: { acceptance: 8, flow: 10, design: 10, style: 10, video: 10 }, upheld: [{ lens: 'acceptance', id: 'ACC-1-1' }], videoKey: 'v1', ...over }];
  const gitWith = (files) => () => ({ stdout: files.join('\n') });
  assert.deepEqual(carryOver(ctx, last(), gitWith(['src/Catalog.API/Apis/CatalogApi.cs'])), { design: 10, video: 10 });
  assert.deepEqual(carryOver(ctx, last(), gitWith(['src/WebApp/Components/Item.razor'])), {}, 'a UI change: both run');
  assert.deepEqual(carryOver(ctx, last(), gitWith(['e2e/teststack/cat-1.spec.ts'])), { design: 10 }, 'a spec change: video runs');
  assert.deepEqual(carryOver({ ...ctx, videoKey: 'v2' }, last(), gitWith(['src/Catalog.API/a.cs'])), { design: 10 }, 'new recordings: video runs');
  assert.deepEqual(carryOver(ctx, last({ upheld: [{ lens: 'video', id: 'VID-1-1' }], lensScores: { design: 10, video: 9 } }), gitWith(['src/Catalog.API/a.cs'])), { design: 10 }, 'a lens with findings runs');
  assert.deepEqual(carryOver(ctx, last({ fix: { commit: null } }), gitWith(['x'])), {}, 'no fix commit: nothing carried');
});

// Dogfood C14: every council member re-sat every PR check round.
test('carryOver: a council member whose last score passed and whose scope the fix did not touch is carried; acceptance never', async () => {
  const { carryOver } = await import('../lib/loop.mjs');
  const council = { passScore: 9, members: [{ name: 'opus', lens: 'rewrite' }, { name: 'sol', lens: 'test-value' }, { name: 'acc', lens: 'acceptance' }, { name: 'eye', lens: 'ui' }] };
  const ctx = { workRoot: '/r', council, frontendHit: (f) => f.startsWith('src/WebApp/'), videoKey: 'v1' };
  const last = (over = {}) => [{ fix: { commit: 'abc' }, lensScores: { acceptance: 7, flow: 10, opus: 9, sol: 10, acc: 10, eye: 10 }, upheld: [{ lens: 'acceptance', id: 'ACC-1-1', severity: 'major' }], videoKey: 'v1', ...over }];
  const gitWith = (files) => () => ({ stdout: files.join('\n') });
  const prod = carryOver(ctx, last(), gitWith(['src/Catalog.API/Apis/CatalogApi.cs']));
  assert.equal(prod.sol, 10, 'a production fix leaves the test-value member carried');
  assert.equal(prod.eye, 10, 'and the ui member (no frontend file changed)');
  assert.ok(!('opus' in prod), 'the rewrite member judges production code: it sits again');
  assert.ok(!('acc' in prod), 'the acceptance member always sits again');
  const tests = carryOver(ctx, last(), gitWith(['e2e/teststack/x.spec.ts']));
  assert.equal(tests.opus, 9, 'a test-only fix leaves the production members carried with their score');
  assert.ok(!('sol' in tests));
  assert.ok(!('opus' in carryOver(ctx, last({ upheld: [{ lens: 'opus', id: 'OPUS-1-1', severity: 'minor' }] }), gitWith(['e2e/x.spec.ts']))), 'a member with an upheld finding sits again');
  assert.ok(!('opus' in carryOver(ctx, last({ lensScores: { opus: 8 } }), gitWith(['e2e/x.spec.ts']))), 'a member below passScore sits again');
});

// Cost (dogfood C4): after a fix that addressed only minor findings, every lens that had nothing upheld is carried.
test('carryOver: a minor-only fix re-runs only the lenses its findings were on; acceptance always runs again', async () => {
  const { carryOver } = await import('../lib/loop.mjs');
  const ctx = { workRoot: '/r', frontendHit: (f) => f.startsWith('src/WebApp/'), videoKey: 'v1' };
  const history = (upheld) => [{ fix: { commit: 'abc' }, lensScores: { acceptance: 10, flow: 10, design: 9, style: 10, video: 10 }, upheld, videoKey: 'v1' }];
  const gitWith = (files) => () => ({ stdout: files.join('\n') });
  assert.deepEqual(carryOver(ctx, history([{ lens: 'design', id: 'UI-2-1', severity: 'minor' }]), gitWith(['src/WebApp/Components/Pages/User/Orders.razor.css'])), { flow: 10, style: 10 }, 'the UI changed: video runs again, the design lens runs on its finding');
  assert.deepEqual(carryOver(ctx, history([{ lens: 'design', id: 'UI-2-1', severity: 'minor' }]), gitWith(['src/Catalog.API/a.cs'])), { flow: 10, style: 10, video: 10 });
  assert.deepEqual(carryOver(ctx, history([{ lens: 'design', id: 'UI-1-1', severity: 'major' }]), gitWith(['src/Catalog.API/a.cs'])), { video: 10 }, 'a major fix: the code lenses run');
});

// D-C8-1: a fix-mode check changed the fix on an open PR; its body and the ticket kept describing the old one.
test('what the fixer changed goes into a section of the PR body; Follow-ups it resolved are removed', async () => {
  const { fixesOf, fixNote, withFixNote } = await import('../lib/pr-notes.mjs');
  const history = [
    { upheld: [{ id: 'ACC-1-1', severity: 'blocking', title: 'Catalog writes allowed for any signed-in user, not only an admin role' }, { id: 'STY-1-1', severity: 'minor', title: 'Duplicate test' }], fix: { fixed: ['ACC-1-1'], notFixed: [{ id: 'STY-1-1', reason: 'left for later' }], summary: 'Writes need the admin policy.' } },
    { upheld: [{ id: 'ACC-2-1', severity: 'blocking', title: 'PR description is stale' }], fix: { fixed: [], notFixed: [{ id: 'ACC-2-1', reason: 'the fixer may not edit the story' }], summary: '' } },
  ];
  const fixes = fixesOf(history);
  assert.deepEqual(fixes.fixed.map((f) => f.id), ['ACC-1-1']);
  const note = fixNote(fixes, ['abc123']);
  assert.match(note, /## Changed by the PR check/);
  assert.match(note, /Fixed ACC-1-1 \[blocking\]/);
  assert.match(note, /ACC-2-1: the fixer may not edit the story/);
  const body = 'Fix BUG-4.\n\n## Follow-ups (not in this PR)\n\n- BUG-4: Restrict catalog writes to an admin role (any signed-in user can still change products)\n- BUG-4: Log levels\n\n<!-- pr-demo-video:start -->\nvideo\n';
  const out = withFixNote(body, note, fixes.fixed);
  assert.doesNotMatch(out, /Restrict catalog writes/);
  assert.match(out, /- BUG-4: Log levels/);
  assert.ok(out.indexOf('Changed by the PR check') < out.indexOf('pr-demo-video:start'));
  const again = withFixNote(out, note, fixes.fixed);
  assert.equal(again.split('Changed by the PR check').length, 2, 'replaced, not repeated');
});

// Council C5: the fixer may not edit the story; the harness writes what the fix changed into its Implementation Notes,
// and stamps the plan cases the fixer wrote as kept for the findings.
test('the story notes say what the fix changed; the fixer\'s plan cases are kept for the findings', async () => {
  const { withNotesUpdate, stampKeptCases } = await import('../lib/pr-notes.mjs');
  const story = '# BUG-31: x\n\n**Expected:** only webhooks scope.\n\n## Implementation Notes\n\n* **Deviations:** the policy accepts the claim type `scope` and its mapped form.\n';
  const fixes = { fixed: [{ id: 'STY-1-1', severity: 'minor', title: 'Mapped scope claim type is dead code' }], notes: ['HasScope reads only the `scope` claim.'], notFixed: [] };
  const once = withNotesUpdate(story, fixes, ['b79dc9c']);
  assert.match(once, /Changed by the PR check \(b79dc9c\).*this is current/);
  assert.match(once, /HasScope reads only the `scope` claim/);
  assert.equal(withNotesUpdate(once, fixes, ['b79dc9c']), once, 'replaced, not repeated');
  const { ticketSha } = await import('../../pipeline/lib/stories.mjs');
  assert.equal(ticketSha(once), ticketSha(story), 'notes do not make the plan stale');
  // The fixer's corrected bullet replaces the one its fix made untrue.
  const corrected = withNotesUpdate(story, { ...fixes, replacements: [{ field: 'Deviations', text: 'the policy checks only the `scope` claim.' }] }, ['b79dc9c']);
  assert.match(corrected, /^\* \*\*Deviations:\*\* the policy checks only the `scope` claim\.$/m);
  assert.doesNotMatch(corrected, /mapped form/);
  const files = { '.factory/plans/CART-1-x/TC-CART-1-23-missing.md': '---\nid: TC-CART-1-23\ntype: sad\n---\n# x\n', 'src/a.cs': 'x', '.factory/plans/CART-1-x/_index.md': '---\nstory: CART-1\n---\n' };
  const stamped = stampKeptCases(Object.keys(files), ['ACC-SEED-1'], { read: (f) => files[f], write: (f, t) => { files[f] = t; } });
  assert.deepEqual(stamped, ['.factory/plans/CART-1-x/TC-CART-1-23-missing.md']);
  assert.match(files['.factory/plans/CART-1-x/TC-CART-1-23-missing.md'], /^---\nkept-for: ACC-SEED-1\nid: TC-CART-1-23/);
});

// Council C7 (Opus 4): #130's pageSize=0 → 400 and #137's app-wide not-found page were in no PR description.
test('behaviour the flow critic lists outside the ticket\'s lines reaches the result (for the PR body)', async () => {
  const r = prCheck(['--no-fix', '--json'], {
    'pr-check-acceptance': [clean('acceptance')],
    'pr-check-flow': [{ result: { ...clean('flow').result, sideEffects: ['GET /api/catalog/items?pageSize=0: 200 empty page → 400', ' '] } }],
    'pr-check-style': [clean('style')],
    'pr-check-judge': [{ result: { score: 10, lensScores: {}, summary: 'ok', rulings: [] } }],
  });
  const out = JSON.parse(r.stdout);
  assert.deepEqual(out.sideEffects, ['GET /api/catalog/items?pageSize=0: 200 empty page → 400']);
  const { withSideEffects } = await import('../lib/pr-notes.mjs');
  const body = withSideEffects('Implements BUG-36.', out.sideEffects);
  assert.match(body, /## Behaviour changes outside the ticket's lines\n\n.*\n\n- GET \/api\/catalog\/items\?pageSize=0: 200 empty page → 400/);
  assert.equal(withSideEffects(body, out.sideEffects), body);
  assert.equal(withSideEffects(body, []), 'Implements BUG-36.');
});

// Council C7 live (#120 on 0.2.54): the re-verification after the fixes ran the e2e specs on slot 0.
test('the re-verification after fixes leases a stack slot unless slots are turned off', async () => {
  const { reverifyEnv } = await import('../pr-check.mjs');
  const { wantsSlot } = await import('../../feature-verification/lib/slots.mjs');
  assert.equal(wantsSlot({}, reverifyEnv({}, '/w')), true);
  assert.equal(reverifyEnv({}, '/w').PIPELINE_ROOT, '/w');
  assert.equal(wantsSlot({}, reverifyEnv({ FV_USE_SLOTS: '0' }, '/w')), false);
  assert.equal(wantsSlot({ useSlots: false }, reverifyEnv({}, '/w')), false);
});

// Council C11 (#154): round 2 carried the flow lens after a minor-only fix, and the side effects round 1 listed were lost.
test('side effects accumulate across rounds, including those of a lens carried over', () => {
  // Earlier tests leave the fixture's working tree changed; fix mode needs it clean.
  sh('git', ['add', '-A']);
  sh('git', ['commit', '-qm', 'earlier tests', '--allow-empty']);
  const r = prCheck(['--json', '--until', 'minor', '--debate-turns', '0'], {
    'pr-check-acceptance': [{ result: { lens: 'acceptance', score: 9, summary: 's', coverage: rowsMet, findings: [{ ...expiredCoupon, severity: 'minor', requirement: 'naming', title: 'Coupon class name is imprecise' }] } }, clean('acceptance')],
    'pr-check-flow': [{ result: { ...clean('flow').result, sideEffects: ['GET /api/catalog/items: new optional sort parameter'] } }],
    'pr-check-style': [clean('style')],
    'pr-check-judge': [{ result: { score: 9, lensScores: {}, summary: 's', rulings: [{ id: 'ACC-1-1', ruling: 'upheld', severity: 'minor', reason: 'r' }] } }, { result: { score: 10, lensScores: {}, summary: 'ok', rulings: [] } }],
    'pr-check-fixer': [{ writeImpl: 'src/Basket/Rename.cs', result: { fixed: ['ACC-1-1'], notFixed: [], summary: 'renamed' } }],
  });
  assert.ok(r.stdout.trim(), r.stderr.slice(-1500));
  const out = JSON.parse(r.stdout);
  assert.deepEqual([out.verdict, out.rounds], ['PASS', 2], r.stderr.slice(-800));
  assert.equal(calls()['pr-check-flow'], 1, 'flow was carried over in round 2');
  assert.deepEqual(out.sideEffects, ['GET /api/catalog/items: new optional sort parameter']);
});

// Council C8 proof (#167): the check after a CI fix round re-raised the CI finding (a critic cannot see CI), so every
// CI fix ended "not 10/10" and was held for a person. The CI wait verifies it after the push instead.
test('the check after a CI fix round does not re-check the CI finding; it can pass', () => {
  sh('git', ['add', '-A']);
  sh('git', ['commit', '-qm', 'earlier tests', '--allow-empty']);
  const seed = path.join(repo, '..', `${path.basename(repo)}-ci2-seed.json`);
  fs.writeFileSync(seed, JSON.stringify({ score: 6, lensScores: {}, upheldFindings: [{ id: 'CI-1', lens: 'flow', severity: 'major', title: 'CI check fails on the PR: record', detail: 'd', fix: 'make it pass' }] }));
  const r = prCheck(['--json', '--until', 'major', '--max-rounds', '2', '--fix-first', seed, '--debate-turns', '0'], {
    'pr-check-fixer': [{ writeImpl: 'src/Basket/Title.cs', result: { fixed: ['CI-1'], notFixed: [], summary: 'title restored' } }],
    'pr-check-acceptance': [clean('acceptance')],
    'pr-check-flow': [clean('flow')],
    'pr-check-style': [clean('style')],
    'pr-check-judge': [{ result: { score: 8, lensScores: {}, summary: 'ci unverifiable', rulings: [{ id: 'flow-coverage-1', ruling: 'upheld', severity: 'major', title: "Coverage gap: the flow critic rated 'CI-1: record check passes on PR head' unverifiable", reason: 'no evidence CI-1 passes on the head yet' }] } }],
  });
  const out = JSON.parse(r.stdout);
  assert.deepEqual([out.verdict, out.rounds], ['PASS', 2], r.stderr.slice(-600));
  assert.match(fs.readFileSync(`${scriptFile}.prompts.log`, 'utf8'), /CI runs again after the push and the CI wait verifies those checks/);
  const prompts = fs.readFileSync(`${scriptFile}.prompts.log`, 'utf8');
  assert.doesNotMatch(prompts.split('=== pr-check-acceptance')[1] ?? '', /upheld last round[^=]*"id": "CI-1"/, 'the critic is not asked to re-check the CI finding');
});

// Council C8 proof: a standalone CI gate's fixer ran `teststack up` with no leased slot, on slot 0, and left it up.
test('a PR check run turns slot leasing on for its agents and the stack guard, unless slots are off', async () => {
  const fsm = await import('node:fs');
  const src = fsm.readFileSync(new URL('../pr-check.mjs', import.meta.url), 'utf8');
  assert.match(src, /async function main\(\) \{\n[\s\S]{0,400}process\.env\.FV_USE_SLOTS \?\?= '1';/);
  const { stackGuard } = await import('../../pipeline/lib/story-guard.mjs');
  const payload = { tool_name: 'Bash', tool_input: { command: 'factory teststack up' } };
  assert.match(String(stackGuard({}, payload, { PIPELINE_CHILD: '1', PIPELINE_AGENT_NAME: 'pr-check-fixer', FV_USE_SLOTS: '1' })), /Stack guard/);
  assert.equal(stackGuard({}, payload, { PIPELINE_CHILD: '1', PIPELINE_AGENT_NAME: 'pr-check-fixer', FV_USE_SLOTS: '0' }), null);
});
