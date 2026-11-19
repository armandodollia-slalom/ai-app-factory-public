import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentTrailer, producerOf, shipRetroRecords } from '../lib/lessons.mjs';
import { factoryChanges } from '../lib/digest.mjs';

// Council C1 (Opus minors): the video findings became implementer lessons and none reached test-automation;
// the retro did not know a later release had fixed something; its own records stayed off the store.
test('PR-check findings teach the agent that produced what they are about', () => {
  assert.equal(producerOf({ lens: 'video', evidence: 'videos/02/frame-002.png' }), 'test-automation');
  assert.equal(producerOf({ lens: 'style', evidence: 'tests/Ordering.FunctionalTests/OrderingApiFixture.cs:12' }), 'test-automation');
  assert.equal(producerOf({ lens: 'style', evidence: '`e2e/teststack/cat-1.spec.ts:148`' }), 'test-automation');
  assert.equal(producerOf({ lens: 'flow', evidence: 'src/WebApp/Components/Pages/Item/ItemPage.razor:129' }), 'implementer');
});

test('the digest lists the factory commits since the window opened, without release commits', () => {
  const changes = factoryChanges('2026-11-13T00:00:00Z');
  assert.ok(Array.isArray(changes));
  for (const c of changes) {
    assert.match(c.sha, /^[0-9a-f]{7,}$/);
    assert.doesNotMatch(c.subject, /^release \d/);
  }
  assert.deepEqual(factoryChanges(null, '/nonexistent-dir-for-test'), []);
});

test('the retro ships its records when it ends; a store failure is logged, not thrown; the trailer follows the agent CLI', async () => {
  const config = { root: '/tmp', metrics: { sink: { type: 'directory', path: '/tmp' } } };
  assert.deepEqual(await shipRetroRecords(config, async () => ({ shipped: 2 })), { shipped: 2 });
  assert.equal(await shipRetroRecords(config, async () => { throw new Error('down'); }), null);
  assert.match(agentTrailer('claude'), /Claude <noreply@anthropic\.com>/);
  assert.match(agentTrailer('copilot'), /Copilot/);
  assert.equal(agentTrailer('codex'), null);
});

// Dogfood C2: the retro's new lessons files began at `## L1`; CI's markdownlint (MD041) failed the lessons PR.
test('a lessons file gets its top-level heading; one that has it is left alone', async () => {
  const { ensureLessonsHeading, parseRules } = await import('../lib/lessons.mjs');
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lessons-')), 'test-automation.md');
  fs.writeFileSync(file, '## L1: Use exactly the inputs the case specifies\n<!-- category: x; subtype: ; added: 2026-11-13 -->\n\nBody.\n');
  assert.equal(ensureLessonsHeading(file, 'test-automation'), true);
  const text = fs.readFileSync(file, 'utf8');
  assert.match(text, /^# Lessons: test-automation\n/);
  assert.equal(parseRules(text).length, 1);
  assert.equal(ensureLessonsHeading(file, 'test-automation'), false);
});
