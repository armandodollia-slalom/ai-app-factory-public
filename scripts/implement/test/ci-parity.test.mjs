import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CI_PARITY, parityFindings, parityGate, paritySection } from '../lib/ci-parity.mjs';
import { afterFixChecks } from '../../pr-check/lib/loop.mjs';
import { ciFixBudget } from '../lib/ci-wait.mjs';

const budget = () => ciFixBudget({ ci: { maxFixRounds: 2 } }, {}, {});

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const workflows = path.join(root, 'templates/ci/github-actions/workflows');
const jobsOf = (text) => [...(/^jobs:\n([\s\S]*)/m.exec(text)?.[1] ?? '').matchAll(/^ {2}([A-Za-z0-9_-]+):/gm)].map((m) => m[1]);
const triggersOf = (text) => [...(/^on:\n([\s\S]*?)^\S/m.exec(text)?.[1] ?? '').matchAll(/^ {2}([a-z_]+):/gm)].map((m) => m[1]);

// Dogfood C4: CI's lint found what no pre-PR step checked. Every job of the factory's CI workflows is listed with its
// pre-PR equivalent (or why it has none), in the code and in the docs, and the three stay in step.
test('every job of the factory CI workflows has a pre-PR equivalent, or says why not; code and docs list the same', () => {
  const fromTemplates = fs.readdirSync(workflows).filter((f) => f.endsWith('.yml')).flatMap((f) => jobsOf(fs.readFileSync(path.join(workflows, f), 'utf8')).map((j) => `${f} ${j}`)).sort();
  const fromCode = Object.entries(CI_PARITY).flatMap(([w, jobs]) => Object.keys(jobs).map((j) => `${w} ${j}`)).sort();
  assert.deepEqual(fromCode, fromTemplates);
  for (const f of fs.readdirSync(workflows).filter((x) => x.endsWith('.yml'))) {
    const text = fs.readFileSync(path.join(workflows, f), 'utf8');
    const prTime = triggersOf(text).some((t) => ['pull_request', 'workflow_call'].includes(t));
    for (const j of jobsOf(text)) {
      const p = CI_PARITY[f][j];
      assert.ok(p.prePr || p.why, `${f} ${j}: a pre-PR equivalent or a reason`);
      if (prTime && !p.prePr) assert.match(p.why, /people|after the PR closes/, `${f} ${j} runs on pull requests: only approvals and after-close cleanup may have no pre-PR step`);
    }
  }
  const doc = fs.readFileSync(path.join(root, 'docs/ai-pipeline/ci-parity.md'), 'utf8');
  const rows = [...doc.matchAll(/^\| `([^`]+)` \| `([^`]+)` \|/gm)].map((m) => `${m[1]} ${m[2]}`).sort();
  assert.deepEqual(rows, fromCode);
});

test('parityGate: failing checks go through the fixing loop as findings, then run again; the PR body says how it ended', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'parity-'));
  let round = 0;
  const checks = () => (round++ === 0 ? [{ check: 'gate.yml lint', ok: false, output: 'src/A.cs(4,2): error WHITESPACE' }, { check: 'gate.yml pipeline: factory check', ok: true, output: '' }] : [{ check: 'gate.yml lint', ok: true, output: '' }, { check: 'gate.yml pipeline: factory check', ok: true, output: '' }]);
  const all = [];
  let changed = 'tests/A.Tests/ATests.cs\n.factory/metrics/x.jsonl\n';
  const run = (cmd, args) => {
    all.push([cmd, ...args]);
    if (cmd === 'git' && args[0] === 'rev-parse') return { status: 0, stdout: 'before\n' };
    if (cmd === 'git' && args[0] === 'diff') return { status: 0, stdout: changed };
    return { status: 0, stdout: JSON.stringify({ verdict: 'ACCEPTED', rounds: 1, commits: ['abc'], score: 10, openFindings: [] }) };
  };
  const pcCalls = () => all.filter((a) => a[1] === 'pr-check.mjs').map((a) => a.slice(1));
  const seedFile = path.join(dir, 'seed.json');
  const r = parityGate({ cwd: dir, base: 'origin/main', targetArgs: ['--story', 'S-1'], seedFile, prCheckCli: 'pr-check.mjs', budget: budget(), run, checks });
  assert.deepEqual(r.fixRun, { verdict: 'ACCEPTED', rounds: 1, commits: ['abc'] });
  assert.ok(r.results.every((x) => x.ok));
  const calls = pcCalls();
  assert.deepEqual(calls[0].slice(0, 4), ['pr-check.mjs', 'run', '--story', 'S-1']);
  assert.ok(calls[0].includes('--fix-first') && calls[0].includes(seedFile));
  // Council C3 (cost): a fix that touched only tests and records is verified by the checks, with no critic round.
  assert.ok(!calls[0].includes('--max-rounds'), 'the round limit is prCheck.maxCouncilRounds, as in every caller');
  assert.equal(calls.length, 1, 'no review round after a test-only fix');
  // A fix that changed production code gets one report-only round of the code lenses.
  round = 0;
  all.length = 0;
  changed = 'src/Api/Orders.cs\n';
  const r2 = parityGate({ cwd: dir, base: 'origin/main', targetArgs: ['--story', 'S-1'], seedFile, prCheckCli: 'pr-check.mjs', budget: budget(), run, checks });
  const review = pcCalls()[1];
  assert.ok(review.includes('--no-fix') && review.includes('acceptance,flow,style'), review.join(' '));
  assert.equal(r2.fixRun.review.score, 10);
  const seed = JSON.parse(fs.readFileSync(seedFile, 'utf8'));
  assert.deepEqual(seed.upheldFindings.map((f) => [f.id, f.severity, f.title]), [['CI-1', 'major', 'CI check fails before the PR: gate.yml lint']]);
  assert.equal(paritySection(r.results), '- CI checks run before this PR: all 2 passed (lint; pipeline: factory check)\n');
  assert.match(paritySection([{ check: 'gate.yml lint', ok: false }]), /1 of 1 still fail \(gate.yml lint\)/);
  assert.deepEqual(parityGate({ cwd: dir, base: 'b', targetArgs: [], seedFile, prCheckCli: 'x', budget: budget(), run: () => assert.fail('no fix run'), checks: () => [{ check: 'c', ok: true }] }).fixRun, null);
  assert.equal(parityFindings([{ check: 'c', ok: true }]).length, 0);
});

test('afterFixChecks: the fix\'s formatting-only hunks and CI lint problems become findings for the fixer', () => {
  const ctx = { workRoot: '/r', baseRev: 'base' };
  const out = afterFixChecks(ctx, 'before', { hunks: () => [{ file: 'src/A.cs', lines: '3-4' }], lint: () => ['src/A.cs(9,1): error WHITESPACE'] });
  assert.deepEqual(out.map((f) => [f.id, f.evidence]), [['HYG-1', 'src/A.cs: lines 3-4'], ['LINT-1', 'src/A.cs(9,1): error WHITESPACE']]);
  assert.deepEqual(afterFixChecks(ctx, 'before', { hunks: () => [], lint: () => [] }), []);
});
