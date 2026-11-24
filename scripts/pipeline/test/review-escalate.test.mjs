// The review stage's policy step: blocking findings only a person can clear (a project no classification convention
// fits) are an escalation, not a fix loop; findings the agent can fix are CHANGES_REQUESTED as before.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { policyReview } from '../../review/lib/review.mjs';

const INSTALL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

function config(response) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'review-esc-')));
  fs.mkdirSync(path.join(root, '.factory/metrics'), { recursive: true });
  fs.mkdirSync(path.join(root, '.factory/state'), { recursive: true });
  const script = path.join(root, 'policy.mjs');
  fs.writeFileSync(script, `process.stdout.write(${JSON.stringify(JSON.stringify(response))});`);
  return { root, installRoot: INSTALL, stateDir: '.factory/state', metricsDir: '.factory/metrics', architectureReview: { policy: { enabled: true, agent: script, command: [process.execPath, script], requester: 'implementer', timeoutSec: 30, categories: {} } } };
}
const item = (extra) => ({ finding_id: 'ARCH-001-x', rule_id: 'ARCH-001', rule_title: 'Layers', category: 'architecture', outcome: 'BLOCK', status: 'fail', file: 'src/Odd/Odd.csproj', message: 'Project is not classified: it fits none of the conventions.', fix: 'a person must extend the policy profile', ...extra });

test('only person-only blocking findings: ESCALATE; any fixable one: CHANGES_REQUESTED; no BLOCK: APPROVED', () => {
  const story = { key: 'SHOP-9', file: 'story.md' };
  let r = policyReview(config({ decision: 'BLOCK', action_items: [item({ needs_person: true })], summary: 'blocked' }), story, 1, { files: ['src/Odd/Odd.csproj'] });
  assert.equal(r.verdict, 'ESCALATE');
  assert.ok(r.findings[0].needsPerson);
  r = policyReview(config({ decision: 'BLOCK', action_items: [item({ needs_person: true }), item({ rule_id: 'ERR-001', needs_person: false, file: 'src/A.cs' })], summary: 'blocked' }), story, 1, { files: ['src/A.cs'] });
  assert.equal(r.verdict, 'CHANGES_REQUESTED', 'the agent fixes what it can first');
  r = policyReview(config({ decision: 'WARN', action_items: [], summary: 'ok' }), story, 1, { files: [] });
  assert.equal(r.verdict, 'APPROVED');
});

test("the architecture reviewer's task lists every derived class; the review gate floors a pull request that adds a project", async () => {
  const { derivedClassesBlock } = await import('../../review/lib/review.mjs');
  const block = derivedClassesBlock([{ summary: 'Derived class of src/Reviews.API: api/presentation, service reviews, by the convention api/presentation (from SDK Microsoft.NET.Sdk.Web, not a test project, output Exe).' }]).join('\n');
  assert.match(block, /### New projects and their derived classes[\s\S]*Check that each class matches what the project is[\s\S]*Derived class of src\/Reviews\.API: api\/presentation/);
  assert.deepEqual(derivedClassesBlock([]), []);
  const { floorReasons } = await import('../../review-gate/lib/severity.mjs');
  const none = { overridePathsHit: () => [] };
  assert.deepEqual(floorReasons({ files: ['src/Reviews.API/Reviews.API.csproj', 'src/Reviews.API/Program.cs'], added: ['src/Reviews.API/Reviews.API.csproj'] }, {}, none), ['new project src/Reviews.API/Reviews.API.csproj']);
  assert.deepEqual(floorReasons({ files: ['src/Up.API/Up.API.CSPROJ'], added: ['src/Up.API/Up.API.CSPROJ'] }, {}, none), ['new project src/Up.API/Up.API.CSPROJ'], 'an upper-case extension is a project too (council A7)');
  assert.deepEqual(floorReasons({ files: ['src/Catalog.API/Catalog.API.csproj'], added: [] }, {}, none), [], 'changing an existing project is not a new one');
});
