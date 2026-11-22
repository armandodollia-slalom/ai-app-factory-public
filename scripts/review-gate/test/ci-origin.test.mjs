// Council C3: a red CI run in a test the pipeline wrote (#49's Bug16Tests) was re-run and called infrastructure.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { failedTestsIn, originLine, pipelineOrigin } from '../lib/ci-origin.mjs';
import { decideGate } from '../lib/gate.mjs';

// Lines as they appear in the eShop pr-validation `test` job (run 43613159780, attempt 1).
const LOG = [
  'test\tTest\t2026-11-14T16:01:01.4207377Z \u001b[31mfailed\u001b[m eShop.Webhooks.FunctionalTests.Bug16Tests.TC_BUG_16_01_NumericEvent99IsRejected \u001b[90m(0ms)\u001b[m',
  "test\tTest\t2026-11-14T16:01:01.4359166Z \u001b[31m  Xunit.MicrosoftTestingPlatform.XunitException: Class fixture type 'eShop.Webhooks.FunctionalTests.WebhooksApiFixture' threw in InitializeAsync",
  'test\tTest\t2026-11-14T16:01:31.4231371Z \u001b[31mfailed\u001b[m [Test Class Cleanup Failure (eShop.Webhooks.FunctionalTests.Bug16Tests.TC_BUG_16_08_EventNameIsMatchedCaseInsensitively)]',
  'test\tTest\t2026-11-14T16:00:58.4089323Z \u001b[32mpassed\u001b[m TC_CAT_1_18_GetBrandMates (156ms)',
].join('\n');

test('the failing test classes are read from a .NET test log, passed tests are not', () => {
  const f = failedTestsIn(LOG);
  assert.deepEqual(f.classes.sort(), ['Bug16Tests', 'fixture:WebhooksApiFixture']);
  assert.deepEqual(failedTestsIn('  ✘  3 [scenarios] › e2e/teststack/bug-5.spec.ts:12:3 › TC-BUG-5-01 failed').specs, ['e2e/teststack/bug-5.spec.ts']);
});

test('a failure in a test class the pipeline wrote names its story and says it is not infrastructure', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-origin-'));
  const g = (...a) => execFileSync('git', a, { cwd: root, encoding: 'utf8' });
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 't@t');
  g('config', 'user.name', 't');
  fs.mkdirSync(path.join(root, 'tests/W'), { recursive: true });
  fs.writeFileSync(path.join(root, 'tests/W/Bug16Tests.cs'), '[Trait("Story", "BUG-16")]\npublic sealed class Bug16Tests : IClassFixture<WebhooksApiFixture> {}');
  fs.writeFileSync(path.join(root, 'tests/W/WebhooksApiFixture.cs'), 'public sealed class WebhooksApiFixture {}');
  g('add', '.');
  g('commit', '-q', '-m', 'x');
  const origins = pipelineOrigin(root, failedTestsIn(LOG));
  assert.deepEqual(origins.find((o) => o.file === 'tests/W/Bug16Tests.cs').story, 'BUG-16');
  assert.equal(origins.find((o) => o.file === 'tests/W/WebhooksApiFixture.cs').story, null);
  const line = originLine(origins);
  assert.match(line, /^failing tests the pipeline wrote \(BUG-16: Bug16Tests in tests\/W\/Bug16Tests\.cs\)/);
  assert.match(line, /not an infrastructure failure to re-run/);
  assert.match(originLine([{ test: 'X', file: 'a.cs', story: null }]), /no story tag: not written by the pipeline/);
});

test('failing checks hold a Low PR in review only while they fail', () => {
  const t = { key: 'BUG-3', severity: { level: 'Low' }, confidence: { high: true, reasons: [] }, reopens: [], rejectionChecked: true };
  const settings = { approvals: { Low: 1 } };
  const red = decideGate({ tickets: [t], severity: { level: 'Low' }, class: 'Low', ci: 'failure', ciOrigin: 'failing tests the pipeline wrote (BUG-16: …)' }, { settings, autoMerge: { enabled: true } });
  assert.equal(red.action, 'review');
  assert.match(red.triggers[0], /checks are failing: failing tests the pipeline wrote/);
  const green = decideGate({ tickets: [t], severity: { level: 'Low' }, class: 'Low', ci: 'success', headSha: 'h1', deliveryChecked: 'h1' }, { settings, autoMerge: { enabled: true }, prior: { required: true, triggers: red.triggers } });
  assert.equal(green.action, 'auto-merge');
});
