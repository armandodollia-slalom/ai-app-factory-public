// The story guard and mockups: an agent may open the handed tickets' own mockups (and an epic run's epic
// mockups) in any checkout's ticket cache, and nothing else in any cache.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { allowedSources, storyGuard, ticketOf, ticketWriteGuard } from '../lib/story-guard.mjs';
import { CACHE, seedTicket } from './fixtures/tickets.mjs';

const checkout = (root) => {
  for (const [key, over] of [
    ['epic-coupons', { type: 'epic', text: '# Epic: Coupons\n', mockups: { 'epic-coupons-journey/Journey.dc.html': '<x-dc></x-dc>' } }],
    ['epic-gifts', { type: 'epic', text: '# Epic: Gifts\n', mockups: { 'epic-gifts-journey/Journey.dc.html': '<x-dc></x-dc>' } }],
    ['DEMO-1', { text: '# DEMO-1 Coupon\n', parent: 'epic-coupons', mockups: { 'DEMO-1-coupon/README.md': '# r', 'DEMO-1-coupon/Main.dc.html': '<x-dc></x-dc>', 'DEMO-1-coupon/Main.png': 'png' } }],
    ['DEMO-2', { text: '# DEMO-2 Wrap\n', parent: 'epic-gifts', mockups: { 'DEMO-2-wrap/Main.png': 'png' } }],
  ])
    seedTicket(root, { key, ...over });
  return { root, stateDir: '.factory/state', tickets: { dir: CACHE }, storyGuard: { folders: [CACHE, 'legacy-stories'] }, abs: (p) => path.join(root, p) };
};

const main = checkout(fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'guard-main-'))));
const worktree = checkout(fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'guard-wt-'))));
const verdict = (config, tool_name, tool_input, env = {}) => (storyGuard(config, { tool_name, tool_input, cwd: config.root }, env) ? 'deny' : 'allow');
const own = `${CACHE}/DEMO-1/mockups/DEMO-1-coupon/Main.dc.html`;
const other = `${CACHE}/DEMO-2/mockups/DEMO-2-wrap/Main.png`;
const epic = `${CACHE}/epic-coupons/mockups/epic-coupons-journey/Journey.dc.html`;
const otherEpic = `${CACHE}/epic-gifts/mockups/epic-gifts-journey/Journey.dc.html`;

test('ticketOf finds the ticket in any checkout\'s cache', () => {
  assert.equal(ticketOf(path.join('/x/repo', own), CACHE), 'DEMO-1');
  assert.equal(ticketOf(path.join('/x/repo-worktrees/demo-1', CACHE), CACHE), '');
  assert.equal(ticketOf('/x/repo/src/WebApp/Main.razor', CACHE), null);
});

test('nothing handed: no mockups at all', () => {
  for (const p of [own, other, epic]) assert.equal(verdict(main, 'Read', { file_path: p }), 'deny', p);
});

test('a handed story opens its own mockups only', () => {
  const env = { PIPELINE_STORY_SOURCES: 'DEMO-1' };
  assert.equal(verdict(main, 'Read', { file_path: own }, env), 'allow');
  assert.equal(verdict(main, 'Read', { file_path: `${CACHE}/DEMO-1/mockups/DEMO-1-coupon/README.md` }, env), 'allow');
  assert.equal(verdict(main, 'Glob', { pattern: `${CACHE}/DEMO-1/mockups/**/*.dc.html` }, env), 'allow');
  assert.equal(verdict(main, 'Bash', { command: `cat ${own} && ls ${CACHE}/DEMO-1/mockups` }, env), 'allow');
  assert.equal(verdict(main, 'Read', { file_path: other }, env), 'deny', "another story's mockups");
  assert.equal(verdict(main, 'Read', { file_path: epic }, env), 'deny', "the epic's mockups were not handed");
  assert.equal(verdict(main, 'Glob', { pattern: `${CACHE}/*/mockups/**` }, env), 'deny', 'every ticket\'s mockups');
  assert.equal(verdict(main, 'Bash', { command: `cat ${own} ${other}` }, env), 'deny');
  assert.equal(verdict(main, 'Grep', { pattern: 'x', path: `${CACHE}/DEMO-2/mockups` }, env), 'deny');
});

test('an epic run opens the epic\'s mockups too, and no other epic\'s', () => {
  const env = { PIPELINE_STORY_SOURCES: ['DEMO-1', main.abs(`${CACHE}/epic-coupons`)].join(path.delimiter) };
  assert.equal(verdict(main, 'Read', { file_path: epic }, env), 'allow');
  assert.equal(verdict(main, 'Read', { file_path: own }, env), 'allow');
  assert.equal(verdict(main, 'Read', { file_path: otherEpic }, env), 'deny');
  assert.equal(verdict(main, 'Read', { file_path: other }, env), 'deny');
});

test('a ticket handed as the main checkout\'s folder opens its copy in a worktree; other checkouts\' caches stay closed', () => {
  const env = { PIPELINE_STORY_SOURCES: main.abs(`${CACHE}/DEMO-1`) };
  assert.equal(verdict(worktree, 'Read', { file_path: own }, env), 'allow', "the worktree's copy of the handed story's mockups");
  assert.equal(verdict(worktree, 'Read', { file_path: main.abs(own) }, env), 'allow', 'the main checkout copy');
  assert.equal(verdict(worktree, 'Read', { file_path: other }, env), 'deny');
  assert.equal(verdict(worktree, 'Read', { file_path: main.abs(other) }, env), 'deny', "another checkout's cache is guarded too");
  assert.equal(verdict(worktree, 'Bash', { command: `cat ${main.abs(other)}` }, env), 'deny');
  assert.ok(allowedSources(worktree, env).includes(worktree.abs(`${CACHE}/DEMO-1`)));
});

test('a symlink in a handed ticket cannot reach another ticket\'s mockups', () => {
  const link = main.abs(`${CACHE}/DEMO-1/mockups/DEMO-1-coupon/stolen.png`);
  fs.symlinkSync(main.abs(other), link);
  try {
    assert.equal(verdict(main, 'Read', { file_path: link }, { PIPELINE_STORY_SOURCES: 'DEMO-1' }), 'deny');
  } finally {
    fs.rmSync(link);
  }
});

test('handed folders outside the cache (the legacy story folder) still work as folders', () => {
  fs.mkdirSync(main.abs('legacy-stories/SHOP-1-x'), { recursive: true });
  const env = { PIPELINE_STORY_SOURCES: main.abs('legacy-stories/SHOP-1-x') };
  assert.equal(verdict(main, 'Read', { file_path: 'legacy-stories/SHOP-1-x/story.md' }, env), 'allow');
  assert.equal(verdict(main, 'Read', { file_path: 'legacy-stories/SHOP-2-y/story.md' }, env), 'deny');
});

// Council C4 (D-C7-1): the PR check fixer edited the story file; the plan was re-stamped from that copy and the
// published text differed, so CI's plan check went red. A PR check agent never writes the ticket cache.
test('a PR check agent cannot write the story; other agents and reads are not affected', () => {
  const pr = { PIPELINE_CHILD: '1', PIPELINE_AGENT_NAME: 'pr-check-fixer' };
  const story = `${CACHE}/DEMO-1/story.md`;
  const w = (tool_name, tool_input, env = pr) => (ticketWriteGuard(main, { tool_name, tool_input, cwd: main.root }, env) ? 'deny' : 'allow');
  assert.equal(w('Edit', { file_path: main.abs(story), old_string: 'a', new_string: 'b' }), 'deny');
  assert.equal(w('Write', { file_path: story, content: 'x' }), 'deny');
  assert.equal(w('Bash', { command: `echo '- catalog scope unused for now' >> ${story}` }), 'deny');
  assert.equal(w('Bash', { command: `sed -i '' s/a/b/ ${story}` }), 'deny');
  assert.equal(w('Read', { file_path: main.abs(story) }), 'allow');
  assert.equal(w('Bash', { command: `cat ${story}` }), 'allow');
  assert.equal(w('Edit', { file_path: main.abs('src/Api.cs'), old_string: 'a', new_string: 'b' }), 'allow');
  assert.equal(w('Edit', { file_path: main.abs(story), old_string: 'a', new_string: 'b' }, { PIPELINE_CHILD: '1', PIPELINE_AGENT_NAME: 'implementer' }), 'allow');
  assert.equal(w('Edit', { file_path: main.abs(story), old_string: 'a', new_string: 'b' }, {}), 'allow');
});

// Council C4: a PR check fixer rewrote two other stories' verified specs.
test('the PR check fixer cannot change another story\'s tests; its own stay open', async () => {
  const { foreignTestGuard } = await import('../lib/story-guard.mjs');
  const env = { PIPELINE_CHILD: '1', PIPELINE_AGENT_NAME: 'pr-check-fixer', PIPELINE_STORY_KEYS: 'BUG-4' };
  const g = (tool_name, tool_input, e = env) => (foreignTestGuard(main, { tool_name, tool_input, cwd: main.root }, e) ? 'deny' : 'allow');
  assert.equal(g('Edit', { file_path: 'e2e/teststack/bug-15.spec.ts', old_string: 'a', new_string: 'b' }), 'deny');
  assert.equal(g('Edit', { file_path: 'e2e/teststack/bug-4.spec.ts', old_string: 'a', new_string: 'b' }), 'allow');
  assert.equal(g('Edit', { file_path: 'tests/Catalog.FunctionalTests/CatalogApiTests.cs', old_string: '[Fact] // TC-BUG-16-02 keeps', new_string: 'x' }), 'deny');
  assert.equal(g('Edit', { file_path: 'tests/Catalog.FunctionalTests/CatalogApiTests.cs', old_string: '[Fact] // TC-BUG-4-01', new_string: 'x' }), 'allow');
  assert.equal(g('Edit', { file_path: 'src/Catalog.API/Apis/bug-15-notes.cs', old_string: 'a', new_string: 'b' }), 'allow');
  const file = main.abs('e2e/teststack/catalog.spec.ts');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "test('TC-BUG-16-01 lists items', () => {});\ntest('TC-BUG-4-01 refuses', () => {});\n");
  assert.equal(g('Write', { file_path: file, content: "test('TC-BUG-16-01 lists items', () => {});\ntest('TC-BUG-4-01 refuses a write', () => {});\n" }), 'allow');
  assert.equal(g('Write', { file_path: file, content: "test('TC-BUG-4-01 refuses', () => {});\n" }), 'deny');
  assert.equal(g('Edit', { file_path: 'e2e/teststack/bug-15.spec.ts', old_string: 'a', new_string: 'b' }, { ...env, PIPELINE_AGENT_NAME: 'test-automation' }), 'allow');
});

// D-C8-4: two PR check fixers built and used slot 0 (shared by every checkout) during a concurrent round.
test('under implement run an agent runs e2e specs and stack commands only on its leased slot', async () => {
  const { stackGuard } = await import('../lib/story-guard.mjs');
  const { slotZeroRefusal } = await import('../../teststack/teststack.mjs');
  const run = { PIPELINE_CHILD: '1', PIPELINE_AGENT_NAME: 'pr-check-fixer', IMPLEMENT_PARALLEL: '2' };
  const bash = (command, env) => (stackGuard(main, { tool_name: 'Bash', tool_input: { command }, cwd: main.root }, env) ? 'deny' : 'allow');
  assert.equal(bash('factory teststack up; E2E_KEEP_VIDEOS=1 npx playwright test -c playwright.teststack.config.ts cart-1', run), 'deny');
  assert.equal(bash('npx playwright test -c playwright.teststack.config.ts cart-1', { ...run, TESTSTACK_SLOT: '3' }), 'allow');
  assert.equal(bash('TESTSTACK_SLOT=0 npx playwright test cart-1', { ...run, TESTSTACK_SLOT: '3' }), 'deny');
  assert.equal(bash('node scripts/teststack.mjs --slot 0 up', { ...run, TESTSTACK_SLOT: '3' }), 'deny');
  assert.equal(bash('dotnet test tests/Basket.UnitTests', run), 'allow');
  assert.equal(bash('factory teststack up', { PIPELINE_CHILD: '1', PIPELINE_AGENT_NAME: 'implementer' }), 'allow', 'a developer checkout keeps slot 0');
  assert.match(slotZeroRefusal('up', 0, run), /refused for pipeline agents/);
  assert.equal(slotZeroRefusal('validate', 0, run), null);
  assert.equal(slotZeroRefusal('up', 2, run), null);
  assert.equal(slotZeroRefusal('up', 0, { IMPLEMENT_PARALLEL: '2' }), null, 'the harness itself is not an agent');
});

// Council r3 (sol-22): the stage's orchestrator doing the fixer's work ran as itself, and the fixer's test guard (keyed
// on the agent's name) let it change another story's test. Guards hold for the work, whoever does it.
test('the orchestrator doing the PR check fixer\'s work is held by the fixer\'s test guard', async (t) => {
  const { foreignTestGuard } = await import('../lib/story-guard.mjs');
  const { producerRun } = await import('../lib/orchestrator.mjs');
  const { runAgentAsync } = await import('../lib/agents.mjs');
  const { loadConfig } = await import('../lib/config.mjs');
  const edit = { tool_name: 'Edit', tool_input: { file_path: 'e2e/teststack/bug-15.spec.ts', old_string: 'a', new_string: 'b' }, cwd: main.root };
  const env = { PIPELINE_CHILD: '1', PIPELINE_STORY_KEYS: 'BUG-4' };
  assert.ok(foreignTestGuard(main, edit, { ...env, PIPELINE_AGENT_NAME: 'pr-check-fixer' }), 'the fixer is refused');
  assert.ok(foreignTestGuard(main, edit, { ...env, PIPELINE_AGENT_NAME: 'stage-orchestrator', PIPELINE_AGENT_WORK: 'pr-check-fixer' }), 'so is the orchestrator doing its work');
  assert.equal(foreignTestGuard(main, edit, { ...env, PIPELINE_AGENT_NAME: 'stage-orchestrator', PIPELINE_AGENT_WORK: 'stage-orchestrator' }), null, 'its own work is not the fixer\'s');
  // The ticket guard too: the orchestrator doing a PR check agent's work does not write the story.
  const story = { tool_name: 'Edit', tool_input: { file_path: main.abs(`${CACHE}/DEMO-1/story.md`), old_string: 'a', new_string: 'b' }, cwd: main.root };
  assert.ok(ticketWriteGuard(main, story, { PIPELINE_CHILD: '1', PIPELINE_AGENT_NAME: 'stage-orchestrator', PIPELINE_AGENT_WORK: 'pr-check-fixer' }));
  assert.equal(ticketWriteGuard(main, story, { PIPELINE_CHILD: '1', PIPELINE_AGENT_NAME: 'stage-orchestrator', PIPELINE_AGENT_WORK: 'implementer' }), null);
  // The run carries the work: the orchestrator's self-work run gets PIPELINE_AGENT_WORK of the agent it stands in for.
  const base = loadConfig();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-work-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const cfg = { ...base, root: tmp, agent: { ...base.agent, cmd: `"${process.execPath}" -e "console.log('WORK=' + process.env.PIPELINE_AGENT_WORK + ' NAME=' + process.env.PIPELINE_AGENT_NAME)"` } };
  const run = producerRun(cfg, { agent: 'pr-check-fixer', task: 't', selfDo: { entry: null, effort: null } });
  const r = await runAgentAsync(cfg, { ...run, mode: 'read', cwd: tmp, timeoutSec: 30 });
  assert.match(r.output, /WORK=pr-check-fixer NAME=stage-orchestrator/);
});
