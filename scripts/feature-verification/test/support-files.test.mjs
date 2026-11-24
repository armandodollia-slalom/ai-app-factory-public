import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { supportFiles } from '../lib/workflows.mjs';

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' });
const write = (root, file, text = 'x\n') => {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), text);
};

// Dogfood BUG-10: the automation added tests/Ordering.FunctionalTests/AssemblyInfo.cs (no case id, no BOM);
// the precheck linted only files with case ids, and CI's lint failed on the PR.
test('support files: changed files beside the story\'s tests and in its scenario, not tests, plans or harness files', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'support-'));
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.email', 't@example.com');
  git(root, 'config', 'user.name', 't');
  write(root, 'tests/Api.Tests/Existing.cs');
  write(root, 'src/Api/Orders.cs');
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'init');
  const base = git(root, 'rev-parse', 'HEAD').trim();

  write(root, 'tests/Api.Tests/OrderTests.cs', '// TC-B-1-01\n');
  write(root, 'tests/Api.Tests/AssemblyInfo.cs');
  write(root, 'tests/Api.Tests/Existing.cs', 'changed\n');
  write(root, 'tests/Api.Tests/graphify-out/graph.json');
  write(root, 'scenarios/b-1/seed.sql');
  write(root, 'src/Api/Orders.cs', 'changed\n');
  write(root, 'tests/plans/B-1/_index.md');
  const config = { root, featureVerification: { plansDir: 'tests/plans' } };
  const files = supportFiles(config, ['tests/Api.Tests/OrderTests.cs'], 'scenarios/b-1', base).sort();
  assert.deepEqual(files, ['scenarios/b-1/seed.sql', 'tests/Api.Tests/AssemblyInfo.cs', 'tests/Api.Tests/Existing.cs']);
  assert.deepEqual(supportFiles(config, [], 'scenarios/b-1', base), [], 'no test files: nothing beside them');
  assert.deepEqual(supportFiles(config, ['tests/Api.Tests/OrderTests.cs'], 'scenarios/b-1', null), [], 'no base: nothing to compare');
});

// Dogfood BUG-10: 12 functional cases became in-process xUnit tests; nothing ran on the stack and the
// scenario the automation wrote was loaded by no test.
test('stack rule: with a stack runner and functional or e2e cases, a story test runs on the stack and loads the scenario', async () => {
  const { stackErrors } = await import('../lib/workflows.mjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stack-rule-'));
  write(root, 'tests/Api.Tests/OrderTests.cs', '// TC-B-1-01\n');
  write(root, 'e2e/teststack/b-1-orders.spec.ts', "loadScenario('b-1'); // TC-B-1-02\n");
  write(root, 'e2e/teststack/b-1-other.spec.ts', '// TC-B-1-02, no scenario\n');
  const runners = [
    { name: 'dotnet', match: ['tests/**/*.cs'] },
    { name: 'playwright', match: ['e2e/teststack/**/*.spec.ts'], stack: true },
  ];
  const config = { root, featureVerification: { precheck: {} } };
  const story = { key: 'B-1', scenario: 'b-1' };
  const plan = (layers) => ({ cases: layers.map((layer) => ({ data: { layer } })) });
  const tests = (...files) => new Map(files.map((f) => [f, new Set()]));

  const none = stackErrors(config, story, plan(['functional']), tests('tests/Api.Tests/OrderTests.cs'), runners, true);
  assert.equal(none.length, 1);
  assert.match(none[0], /None of the story's tests runs on the test stack/);
  assert.match(none[0], /e2e\/teststack\/\*\*\/\*\.spec\.ts/);
  assert.match(stackErrors(config, story, plan(['e2e']), tests('e2e/teststack/b-1-other.spec.ts'), runners, true)[0], /No stack test loads the story's scenario `b-1`/);
  assert.deepEqual(stackErrors(config, story, plan(['functional', 'unit']), tests('tests/Api.Tests/OrderTests.cs', 'e2e/teststack/b-1-orders.spec.ts'), runners, true), []);
  assert.deepEqual(stackErrors(config, story, plan(['unit']), tests('tests/Api.Tests/OrderTests.cs'), runners, true), [], 'unit cases only');
  assert.deepEqual(stackErrors(config, story, plan(['functional']), tests('tests/Api.Tests/OrderTests.cs'), runners.slice(0, 1), true), [], 'no stack runner');
  assert.deepEqual(stackErrors({ root, featureVerification: { precheck: { requireStack: false } } }, story, plan(['functional']), tests('tests/Api.Tests/OrderTests.cs'), runners, true), [], 'turned off');
});

// Council C1: CAT-1's UI videos never showed the section; the precheck now asks for a state keyframe per UI case.
test('UI evidence: a passing UI case needs a highlight or absent keyframe; API-only tests need none', async () => {
  const { uiEvidenceErrors } = await import('../lib/workflows.mjs');
  const ui = (title, labels) => ({ title, ok: true, videos: ['v.webm'], keyframes: labels.map((label) => ({ label, path: 'k.png' })) });
  const errors = uiEvidenceErrors([
    ui('TC-C-1-13 shows four cards', ['Brand-mates - highlight: four cards', 'final']),
    ui('TC-C-1-14 card click', ['step: Open /item/203', 'step: Click the card', 'final']),
    ui('TC-C-1-17 hidden', ['absent: no More from section', 'final']),
    { title: 'TC-C-1-01 api', ok: true, videos: [], keyframes: [] },
    { ...ui('TC-C-1-15 failed', ['final']), ok: false },
  ]);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /^TC-C-1-14 card click: this UI case records no keyframe of the state it asserts/);
  assert.match(errors[0], /demo\.absent\(anchor, label\)/);
});

// Council C1: the automation verifier skipped two of CAT-1's five UI cases and still scored 10.
test('automation verdict: a UI case without an evidence entry, or with ok false, caps the score below the pass mark', async () => {
  const { normalizeVerdict } = await import('../lib/verify.mjs');
  const config = { featureVerification: { categories: { automation: ['visual-mismatch', 'other'] } }, testAutomation: { councilPassScore: 9 } };
  const raw = (evidence) => ({ score: 10, summary: 's', gaps: [], evidence });
  const seen = { case: 'TC-C-1-13', keyframe: 'k/03-highlight.png', shows: 'four cards in the More from section', ok: true };
  const all = normalizeVerdict(config, 'automation', raw([seen, { ...seen, case: 'TC-C-1-14' }]), { uiCases: ['TC-C-1-13', 'TC-C-1-14'] });
  assert.deepEqual([all.score, all.passed, all.gaps.length], [10, true, 0]);
  const skipped = normalizeVerdict(config, 'automation', raw([seen]), { uiCases: ['TC-C-1-13', 'TC-C-1-14'] });
  assert.deepEqual([skipped.score, skipped.passed, skipped.gaps[0].case, skipped.gaps[0].subtype], [8, false, 'TC-C-1-14', 'evidence-not-reviewed']);
  const wrong = normalizeVerdict(config, 'automation', raw([seen, { ...seen, case: 'TC-C-1-14', shows: 'only the page top', ok: false }]), { uiCases: ['TC-C-1-13', 'TC-C-1-14'] });
  assert.deepEqual([wrong.score, wrong.passed, wrong.gaps[0].subtype], [8, false, 'state-not-shown']);
  assert.deepEqual(normalizeVerdict(config, 'automation', raw([]), {}).score, 10, 'no UI cases: nothing to show');
});
