// PR body sections fed by records (council C3): what the run went without or waited for, and follow-ups the PR check
// already resolved.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { planEpic } from '../lib/epic.mjs';
import { resolvedByPrCheck, runConditionsSection, withoutResolved } from '../lib/implement.mjs';

test('the PR body says which language servers a story went without and how the stack slots went', () => {
  const recs = [
    { story: 'BUG-12', kind: 'lsp', worktree: 'bug-12', missing: ['csharp (all 3 leased language server slots are in use)'] },
    { story: 'BUG-12', kind: 'stack-slot', stage: 'automation agent', slot: 1, waitedSec: 240, outcome: 'leased' },
    { story: 'BUG-12', kind: 'stack-slot', stage: 'precheck', slot: 1, waitedSec: 2, outcome: 'leased' },
  ];
  const text = runConditionsSection(recs);
  assert.match(text, /Code intelligence: the run went without BUG-12 \(bug-12\): csharp \(all 3 leased language server slots are in use\)/);
  assert.match(text, /waited for a slot: BUG-12 automation agent, 240 s for slot 1/);
  assert.match(text, /every stack run the harness recorded \(feature verification, UI verifiers, PR check fixers\) used a leased slot built from this change; agents are refused slot 0 under implement run \(1\)/);
  assert.match(runConditionsSection([{ story: 'X-1', kind: 'stack-slot', stage: 'precheck', waitedSec: 1800, outcome: 'none' }]), /no free slot for X-1 precheck \(after 1800 s\); those tests did not run/);
  assert.equal(runConditionsSection([]), '');
});

test('an implementer follow-up the PR check fixed in the same PR is dropped; others stay', () => {
  // #81: the implementer's follow-up and the PR check's FLOW-1-1, fixed in the loop.
  const resolved = [{ id: 'FLOW-1-1', title: "Cart page doesn't handle NOT_FOUND from save/move/remove", detail: 'A stale double-submit throws RpcException NotFound and breaks the cart page.' }];
  const nf = { title: 'Handle NOT_FOUND from save/move/remove on the cart page', reason: 'A stale double-submit throws an unhandled RpcException instead of reloading the cart.' };
  const redis = { title: 'Make RedisBasketRepository.DeleteBasketAsync atomic when saved items exist', reason: 'Its separate read and write can lose a concurrent cart update.' };
  assert.equal(resolvedByPrCheck(nf, resolved), true);
  assert.equal(resolvedByPrCheck(redis, resolved), false);
  assert.deepEqual(withoutResolved([nf, redis], [{ resolvedFindings: resolved }, null]), [redis]);
});

test('a bug epic\'s planner releases the main checkout\'s language servers when planning ends, even when it fails', async () => {
  const released = [];
  const deps = { lsp: { release: async (w) => released.push(w) }, runAgent: async () => { throw new Error('agent down'); } };
  await assert.rejects(planEpic({ planConfig: { implement: { timeoutsSec: { epicPlanner: 1 }, epic: {} }, agent: { cli: 'claude', models: {} } }, cwd: '/repo/main', epic: { key: 'E-1' }, stories: [], deps, log: () => {}, groups: true }), /agent down|Cannot/);
  assert.deepEqual(released, ['/repo/main']);
});
