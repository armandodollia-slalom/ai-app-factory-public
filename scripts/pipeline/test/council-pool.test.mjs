// GEN-9: one model pool for every agent, and member counts per stage. The planner's pick per subtask is tested in
// scripts/implement/test/plan.test.mjs, an entry's family and every agent's resolution in models.test.mjs.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { loadConfig } from '../lib/config.mjs';
import { councilFor, memberCount } from '../lib/council.mjs';
import { settingsProblems } from '../lib/settings.mjs';

const POOL = [
  { name: 'opus', cli: 'claude', model: 'claude-opus-5-5', effort: 'high' },
  { name: 'sonnet', cli: 'claude', model: 'claude-sonnet-5-5', effort: 'medium' },
  { name: 'sol', cli: 'codex', model: 'gpt-6.1-sol', effort: 'high' },
  { name: 'gem', cli: 'custom', cmd: 'gemini-cli --json', effort: 'high' },
];
const repo = (t, settings) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'council-pool-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  fs.mkdirSync(path.join(dir, '.factory'));
  fs.writeFileSync(path.join(dir, '.factory/config.json'), JSON.stringify(settings));
  return dir;
};

test('a pool of three families and council.members 2: a stage seats two entries from two families', () => {
  const three = [POOL[0], POOL[2], POOL[3]];
  const c = councilFor({ models: { pool: three, agents: { default: 'opus' } }, council: { members: 2 } }, 'architectureReview');
  // The clean-code seat beside them takes the family no counted seat has.
  assert.deepEqual(c.members.map((m) => [m.entry, m.family, m.lens === 'clean-code']), [['opus', 'Anthropic', false], ['sol', 'OpenAI', false], ['gem', 'gem', true]]);
  // Two Anthropic entries listed first still give two families.
  const c2 = councilFor({ models: { pool: POOL, agents: { default: 'opus' } }, council: { members: 2 } }, 'architectureReview');
  assert.deepEqual(c2.members.filter((m) => !m.fixed).map((m) => m.family), ['Anthropic', 'OpenAI']);
});

test('prCheck.councilMembers 3 with council.members 1: the PR check seats three, the test plan one', () => {
  const config = { models: { pool: POOL, agents: { default: 'sonnet' } }, council: { members: 1 }, prCheck: { councilMembers: 3 } };
  assert.deepEqual([memberCount(config, 'prCheck'), memberCount(config, 'testPlan'), memberCount(config, 'pairVerify')], [3, 1, 1]);
  // Three counted seats, one per family, and the clean-code seat (every family seated: the first entry no seat runs on).
  assert.deepEqual(councilFor(config, 'prCheck').members.map((m) => m.entry), ['opus', 'sol', 'gem', 'sonnet']);
  const plan = councilFor(config, 'testPlan');
  assert.deepEqual([plan.sole, plan.members[0].entry, plan.members.length], [true, 'sonnet', 2], "a council of one: the stage's own verifier on its own entry, beside the clean-code seat");
  // implement.councilMembers sets both pair verifiers.
  const pairs = { ...config, implement: { councilMembers: 2 } };
  assert.deepEqual([memberCount(pairs, 'pairVerify'), memberCount(pairs, 'pairUiVerify')], [2, 2]);
});

test('more seats than entries: every entry sits once before any repeats', () => {
  const c = councilFor({ models: { pool: [POOL[0], POOL[2]], agents: { default: 'opus' } }, architectureReview: { councilMembers: 3 } }, 'architectureReview');
  assert.deepEqual(c.members.filter((m) => !m.fixed).map((m) => [m.name, m.entry]), [['opus', 'opus'], ['sol', 'sol'], ['opus-2', 'opus']]);
});

test('a one-family pool loads, with a warning that councils cannot be diverse', (t) => {
  const dir = repo(t, { models: { pool: POOL.slice(0, 2), agents: { default: 'sonnet', 'pair-ui-verifier': 'opus' } } });
  const config = loadConfig(null, dir);
  assert.ok(config.warnings.includes('models.pool has one model family (Anthropic): councils cannot be diverse'), config.warnings.join('\n'));
  assert.deepEqual(loadConfig(null, repo(t, { models: { pool: POOL, agents: { default: 'sonnet' } } })).warnings.filter((w) => /model family/.test(w)), []);
});

test('a settings file with a replaced model setting fails to load and names the pool', (t) => {
  const cases = [
    [{ agent: { allowedModels: ['opus'] } }, /agent\.allowedModels was renamed: use models\.pool/],
    [{ agent: { modelIds: { claude: { opus: 'claude-opus-5-5' } } } }, /agent\.modelIds was renamed: use models\.pool/],
    [{ agent: { models: { reviewer: 'opus' } } }, /agent\.models\.reviewer was renamed: use models\.agents\.architecture-reviewer/],
    [{ agent: { cli: 'copilot' } }, /agent\.cli was removed: each models\.pool entry names its CLI/],
    [{ modelClasses: { large: 'opus' } }, /modelClasses was removed: [^;]*models\.pool entry per subtask/],
    [{ implement: { roles: { verifier: { cli: 'codex' } } } }, /implement\.roles was removed: [^;]*models\.pool entry/],
    [{ prCheck: { models: { claude: { judge: 'opus' } } } }, /prCheck\.models was removed: [^;]*models\.pool entry in models\.agents/],
    [{ council: { stages: { prCheck: {} } } }, /council\.stages was removed: council members come from models\.pool/],
    [{ council: { members: [{ name: 'opus', cli: 'claude', model: 'opus', lens: 'correctness' }] } }, /council\.members is now how many members a council seats[\s\S]*models\.pool entries/],
  ];
  for (const [settings, re] of cases) assert.throws(() => loadConfig(null, repo(t, settings)), re, JSON.stringify(settings));
  assert.match(settingsProblems({}, { env: { PR_CHECK_MODEL_JUDGE: 'opus' } }).join('\n'), /PR_CHECK_MODEL_JUDGE was removed: name the models\.pool entry in models\.agents\.pr-check-judge/);
});

test('a stage\'s seats, once chosen for a ticket, are kept: the same members and lenses sit again; a pick naming a gone entry is not used', (t) => {
  const dir = repo(t, { models: { pool: POOL, agents: { default: 'sonnet' } } });
  const config = { ...loadConfig(null, dir), root: dir };
  const file = path.join(dir, '.factory/state/council/seats/architectureReview--SHOP-1.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ members: [{ name: 'sol', entry: 'sol', lens: 'security' }, { name: 'gem', entry: 'gem', lens: 'rewrite', blocking: false }] }));
  const kept = councilFor(config, 'architectureReview', { subject: 'SHOP-1' });
  // A kept file from before the clean-code seat: the default seat joins it.
  assert.deepEqual(kept.members.map((m) => [m.name, m.cli, m.lens, m.blocking]), [['sol', 'codex', 'security', true], ['gem', 'custom', 'rewrite', false], ['clean-code', 'claude', 'clean-code', true]]);
  assert.equal(councilFor(config, 'architectureReview', { subject: 'SHOP-2' }).sole, true, 'another ticket: the usual seating');
  fs.writeFileSync(file, JSON.stringify({ members: [{ name: 'gone', entry: 'gone', lens: 'security' }] }));
  assert.equal(councilFor(config, 'architectureReview', { subject: 'SHOP-1' }).sole, true);
});
