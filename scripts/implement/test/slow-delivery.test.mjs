// The delivery path with every agent 10 times slower (PIPELINE_AGENT_SLOW=10) ends exactly as it does at normal speed
// (council C12, D-C12-2: slow agents must make a run slower, never change its outcome). `implement run --pr` runs with
// the Stop hook's PR check on, scripted fake agents, a local origin and a fake gh. The PR check's usual budget
// (implement.waitSec.prCheck) is 1 second, far shorter than the check takes: the old fixed wait opened the PR with
// "PR check: running" (BUG-41); now the run follows the check to its end and the PR states its verdict.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { seedTicket } from '../../pipeline/test/fixtures/tickets.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = path.resolve(here, '..', '..', '..');
const fakeAgent = path.join(source, 'scripts/pipeline/test/fixtures/fake-agent.mjs');
let tmp;

const sh = (cwd, cmd, args) => {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed:\n${r.stdout}\n${r.stderr}`);
  return r.stdout.trim();
};
const write = (root, rel, text) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), text);
};
const editJson = (file, fn) => {
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  fn(j);
  fs.writeFileSync(file, JSON.stringify(j, null, 2));
};

const rows = [{ ref: 'Rule: a valid coupon gives 10% off', status: 'met', evidence: 'src/Basket/Coupons.cs:1' }, { ref: 'Rule: an expired coupon is rejected with 400', status: 'met', evidence: 'src/Basket/Coupons.cs:1' }];
const clean = (lens) => ({ result: { lens, score: 10, summary: 'ok', coverage: lens === 'acceptance' ? rows : [], findings: [], sideEffects: lens === 'flow' ? ['Coupons are now applied before tax'] : [] } });
const SCRIPT = {
  implementer: [{ writeImpl: 'src/Basket/Coupons.cs', result: { status: 'done', reason: 'coupon applied' } }],
  'architecture-reviewer': [{ result: { score: 10, verdict: 'APPROVED', summary: 'ok', findings: [] } }],
  'test-planner': [{ writePlan: [{ title: 'Valid coupon applies', type: 'happy' }, { title: 'Expired coupon rejected', type: 'sad' }] }],
  'test-plan-verifier': [{ result: { score: 10, summary: 'ok', gaps: [] } }],
  'test-automation': [{ writeTests: [1, 2], result: { status: 'done' } }],
  'test-automation-verifier': [{ result: { score: 10, gaps: [] } }],
  'pr-check-acceptance': [clean('acceptance')],
  'pr-check-flow': [clean('flow')],
  'pr-check-style': [clean('style')],
  'pr-check-video': [clean('video')],
  'pr-check-design': [clean('design')],
  'pr-check-defender': [{ result: { responses: [] } }],
  'pr-check-judge': [{ result: { score: 10, lensScores: {}, summary: 'all met', rulings: [] } }],
};

// One repository per speed, so the two runs share nothing.
function setup(name) {
  const root = path.join(tmp, name);
  const repo = path.join(root, 'shop');
  const origin = path.join(root, 'origin.git');
  const bin = path.join(root, 'bin');
  for (const dir of ['scripts/pipeline', 'scripts/review', 'scripts/feature-verification', 'scripts/implement', 'scripts/pr-check', 'scripts/board', 'scripts/models', 'scripts/pr-video', 'scripts/review-gate', 'scripts/retro', 'scripts/factory', 'scripts/stack', 'scripts/teststack'].filter((d) => fs.existsSync(path.join(source, d)))) {
    fs.cpSync(path.join(source, dir), path.join(repo, dir), { recursive: true, filter: (p) => !p.startsWith(path.join(source, dir, 'test')) });
  }
  // Every section's defaults and descriptions: a stage reads the others' (scripts/pipeline/lib/settings.mjs).
  for (const d of fs.readdirSync(path.join(source, 'scripts'))) for (const f of ['config.json', 'settings.json']) if (fs.existsSync(path.join(source, 'scripts', d, f)) && !fs.existsSync(path.join(repo, 'scripts', d, f))) {
    fs.mkdirSync(path.join(repo, 'scripts', d), { recursive: true });
    fs.copyFileSync(path.join(source, 'scripts', d, f), path.join(repo, 'scripts', d, f));
  }
  fs.cpSync(path.join(source, 'agents'), path.join(repo, 'agents'), { recursive: true });
  editJson(path.join(repo, 'scripts/feature-verification/config.json'), (j) => (j.featureVerification.precheck.runTests = false));
  // As an installed repository has it: the tests are not the implementation the review and the PR check hash.
  editJson(path.join(repo, 'scripts/pipeline/config.json'), (j) => (j.implExclude = ['.factory', 'graphify-out', 'e2e']));
  editJson(path.join(repo, 'scripts/implement/config.json'), (j) => {
    Object.assign(j.implement, { pollSec: { featureVerification: 0.2 }, maxParallel: 1, ci: { ...j.implement.ci, parity: { enabled: false } }, waitSec: { ...j.implement.waitSec, prCheck: 1 } });
  });
  editJson(path.join(repo, 'scripts/pr-check/config.json'), (j) => {
    Object.assign(j.prCheck.hook, { enabled: true, pollSec: 0.2 });
  });
  write(repo, '.gitignore', '.factory/state/\n');
  write(repo, 'src/Basket/Coupons.cs', '// coupons\n');
  seedTicket(repo, { key: 'DEMO-1', slug: 'DEMO-1-apply-coupon', text: '# DEMO-1 Apply coupon\n\nRule: a valid coupon gives 10% off; an expired coupon is rejected with 400.\n' });
  sh(root, 'git', ['init', '-q', '--bare', '-b', 'main', origin]);
  sh(repo, 'git', ['init', '-q', '-b', 'main']);
  sh(repo, 'git', ['config', 'user.email', 'fv@example.com']);
  sh(repo, 'git', ['config', 'user.name', 'Slow Test']);
  sh(repo, 'git', ['add', '-A']);
  sh(repo, 'git', ['commit', '-qm', 'init']);
  sh(repo, 'git', ['remote', 'add', 'origin', origin]);
  sh(repo, 'git', ['push', '-q', 'origin', 'main']);
  // gh: `pr create` records the PR body and prints its URL; every other call answers empty.
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(
    path.join(bin, 'gh'),
    `#!/usr/bin/env node
const fs = require('fs');
const a = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(path.join(root, 'gh.log'))}, a.join(' ').slice(0, 200) + '\\n');
if (a[0] === 'pr' && a[1] === 'create') { fs.writeFileSync(${JSON.stringify(path.join(root, 'pr-body.md'))}, a[a.indexOf('--body') + 1]); process.stdout.write('https://github.com/acme/shop/pull/1\\n'); }
`,
    { mode: 0o755 },
  );
  return { root, repo, bin };
}

function implement(ctx, slow) {
  const scriptFile = path.join(ctx.root, 'agent.json');
  fs.writeFileSync(scriptFile, JSON.stringify(SCRIPT));
  const env = {
    ...process.env,
    PATH: `${ctx.bin}${path.delimiter}${process.env.PATH}`,
    PIPELINE_AGENT_CMD: `"${process.execPath}" "${fakeAgent}"`,
    PIPELINE_FAKE_SCRIPT: scriptFile,
    PIPELINE_BASE_REF: 'main',
    PIPELINE_AGENT_SLOW: String(slow),
    PIPELINE_FAKE_SLEEP_MS: '1000',
    // The usual budget (1 s) is far exceeded; the ceiling is not.
    PIPELINE_CEILING_FACTOR: '600',
    PIPELINE_SUPERVISOR_POLL_MS: '200',
  };
  for (const k of ['PIPELINE_CHILD', 'PIPELINE_DISABLE', 'PIPELINE_ROOT', 'PIPELINE_BOARD']) delete env[k];
  const started = Date.now();
  const r = spawnSync(process.execPath, ['scripts/pipeline/pipeline.mjs', 'implement', 'run', 'DEMO-1', '--pr'], { cwd: ctx.repo, encoding: 'utf8', env, timeout: 1_800_000 });
  const usage = fs.readdirSync(path.join(ctx.root, 'shop-worktrees', 'demo-1', '.factory', 'metrics')).filter((f) => f.startsWith('token-usage'));
  const rows = usage.flatMap((f) => { const p = path.join(ctx.root, 'shop-worktrees', 'demo-1', '.factory', 'metrics', f); return fs.statSync(p).isFile() ? fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []; });
  const checkSeconds = rows.filter((x) => /^pr-check-/.test(x.agent)).reduce((n, x) => n + (x.seconds ?? 0), 0);
  const agentSeconds = rows.reduce((n, x) => n + (x.seconds ?? 0), 0);
  return { ...r, seconds: (Date.now() - started) / 1000, agentSeconds, checkSeconds, body: fs.existsSync(path.join(ctx.root, 'pr-body.md')) ? fs.readFileSync(path.join(ctx.root, 'pr-body.md'), 'utf8') : null };
}

before(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'slow-delivery-')));
});
after(() => (process.env.SLOW_DELIVERY_KEEP ? console.log(`kept ${tmp}`) : fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })));

test('the delivery path with agents 10x slower ends as it does at normal speed: same outcome, the PR states the check\'s verdict', { timeout: 3_600_000 }, () => {
  const normal = implement(setup('normal'), 1);
  assert.match(normal.stdout, /DEMO-1 +done +feat\/demo-1-apply-coupon/, `${normal.stdout}\n${normal.stderr}`);
  assert.ok(normal.body, 'a PR was opened');
  const slow = implement(setup('slow'), 10);
  assert.match(slow.stdout, /DEMO-1 +done +feat\/demo-1-apply-coupon/, `${slow.stdout}\n${slow.stderr}`);
  // The agents' own recorded time: about 10 times longer, and the PR check alone far past its 1-second usual budget.
  // At least 3 times: machine load inflates the normal run's few seconds far more, relatively, than the slow run's (a
  // full suite run measured 170 s against 35 s, 4.9 times).
  assert.ok(slow.agentSeconds >= normal.agentSeconds * 3, `agents slower (${slow.agentSeconds} s vs ${normal.agentSeconds} s)`);
  assert.ok(slow.checkSeconds >= 20, `the PR check took ${slow.checkSeconds} s against a 1 s budget`);
  for (const run of [normal, slow]) {
    // The check's own verdict, never "running" or "did not complete" (BUG-41's PR said "PR check: running").
    assert.match(run.body, /- PR check \([^)]*\): PASS 10\/10/);
    assert.doesNotMatch(run.body, /PR check: (running|waiting|did not complete)/);
    assert.match(run.body, /Coupons are now applied before tax/, 'the check\'s side effects reach the PR body');
    assert.doesNotMatch(run.body, /Not delivered: waits for a person/);
  }
  const line = (b) => b.match(/- PR check[^\n]*/)[0];
  assert.equal(line(slow.body), line(normal.body), 'the same PR check line at both speeds');
});
