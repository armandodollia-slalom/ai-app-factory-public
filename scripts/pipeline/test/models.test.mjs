// Model selection (models.pool: every agent run on a pool entry, GEN-9) and the async command runner used to run
// independent test commands side by side.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { runAgent } from '../lib/agents.mjs';
import { loadConfig } from '../lib/config.mjs';
import { entryFor, familyOf } from '../lib/pool.mjs';
import { readJsonl, runAsync } from '../lib/util.mjs';

const POOL = [
  { name: 'opus', cli: 'claude', model: 'claude-opus-5-5', effort: 'high' },
  { name: 'sonnet', cli: 'claude', model: 'claude-sonnet-5-5', effort: 'medium' },
  { name: 'sol', cli: 'codex', model: 'gpt-6.1-sol', effort: 'xhigh', env: { CODEX_HOME: '~/.codex-second' } },
];
const config = { models: { pool: POOL, agents: { default: 'sonnet', 'pr-check-judge': 'opus' } } };

test('every agent runs on a pool entry: its own, else the default; a seat or a subtask names one', () => {
  assert.deepEqual([entryFor(config, { name: 'pr-check-judge' }).name, entryFor(config, { name: 'test-planner' }).name], ['opus', 'sonnet']);
  assert.equal(entryFor(config, { name: 'pair-implementer', entry: 'sol' }).model, 'gpt-6.1-sol');
  assert.equal(entryFor(config, { name: 'x', entry: POOL[2] }).family, 'OpenAI', 'a seat passes its resolved entry');
  assert.throws(() => entryFor(config, { name: 'pair-implementer', entry: 'haiku' }), /agent pair-implementer: "haiku" is not in models\.pool \(entries: opus, sonnet, sol\)/);
});

test('an entry\'s family comes from its model id: Anthropic, OpenAI, Google; anything else, and a custom command, is its own', () => {
  const fam = (cli, model, name = 'e') => familyOf({ name, cli, model });
  assert.deepEqual([fam('claude', 'claude-opus-5-5'), fam('copilot', 'claude-sonnet-5.5'), fam('codex', 'gpt-6.1-sol'), fam('copilot', 'gpt-6-sol'), fam('custom', 'gemini-3-pro'), fam('copilot', 'gemini-3-pro')], ['Anthropic', 'Anthropic', 'OpenAI', 'OpenAI', 'e', 'Google']);
  assert.equal(fam('claude', 'mystery-9', 'mine'), 'mine', 'a model in no known family is a family of its own, named after its entry');
});

test('PIPELINE_MODEL_OVERRIDE names one pool entry for every agent, and is checked too', () => {
  const env = { PIPELINE_MODEL_OVERRIDE: 'sol' };
  assert.equal(entryFor(config, { name: 'pr-check-judge', env }).name, 'sol');
  assert.equal(entryFor(config, { name: 'x', entry: POOL[0], env }).name, 'sol', 'even over a seat');
  assert.throws(() => entryFor(config, { name: 'x', env: { PIPELINE_MODEL_OVERRIDE: 'nope' } }), /"nope" is not in models\.pool/);
});

test('PIPELINE_AGENT_CLI (a CI job with one CLI installed) moves every run onto that CLI\'s entries, the same model first', () => {
  const pool = [...POOL, { name: 'copilot-sonnet', cli: 'copilot', model: 'claude-sonnet-5.5', effort: 'medium' }, { name: 'copilot-opus', cli: 'copilot', model: 'claude-opus-5.5', effort: 'high' }];
  const c = { models: { pool, agents: config.models.agents } };
  const env = { PIPELINE_AGENT_CLI: 'copilot' };
  assert.deepEqual([entryFor(c, { name: 'pr-check-judge', env }).name, entryFor(c, { name: 'test-planner', env }).name, entryFor(c, { name: 'x', entry: 'sol', env }).name], ['copilot-opus', 'copilot-sonnet', 'copilot-sonnet']);
  assert.throws(() => entryFor(config, { name: 'pr-check-judge', env }), /PIPELINE_AGENT_CLI is copilot, and models\.pool has no entry on it \(entries: opus, sonnet, sol\)/);
});

test('a run records its pool entry and family, and the entry\'s env reaches its process (and only its own)', () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pool-run-')));
  spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  fs.mkdirSync(path.join(dir, '.factory'));
  fs.writeFileSync(path.join(dir, '.factory/config.json'), JSON.stringify(config));
  const probe = path.join(dir, 'probe.mjs');
  fs.writeFileSync(probe, "console.log('AGENT_RESULT: ' + JSON.stringify({ home: process.env.CODEX_HOME ?? null, model: process.env.PIPELINE_AGENT_MODEL, effort: process.env.PIPELINE_AGENT_EFFORT }));\n");
  const saved = { cmd: process.env.PIPELINE_AGENT_CMD, home: process.env.CODEX_HOME, shard: process.env.FACTORY_METRICS_SHARD, spool: process.env.FACTORY_METRICS_SPOOL };
  Object.assign(process.env, { PIPELINE_AGENT_CMD: `"${process.execPath}" "${probe}"`, FACTORY_METRICS_SHARD: '0', FACTORY_METRICS_SPOOL: '0' });
  delete process.env.CODEX_HOME;
  try {
    const c = { ...loadConfig(null, dir), root: dir };
    const result = (r) => JSON.parse(r.output.slice(r.output.indexOf('{')));
    const sol = runAgent(c, { name: 'pair-implementer', entry: 'sol', task: 't', cwd: dir, usage: { stage: 'implement-pair', story: 'K-1' } });
    assert.deepEqual(result(sol), { home: path.join(os.homedir(), '.codex-second'), model: 'gpt-6.1-sol', effort: 'xhigh' });
    assert.deepEqual([sol.entry, sol.family, sol.cli], ['sol', 'OpenAI', 'custom']);
    const judge = runAgent(c, { name: 'pr-check-judge', task: 't', cwd: dir, usage: { stage: 'pr-check', story: 'K-1' } });
    assert.deepEqual(result(judge), { home: null, model: 'claude-opus-5-5', effort: 'high' });
    const rows = readJsonl(path.join(dir, '.factory/metrics/token-usage.jsonl'));
    assert.deepEqual(rows.map((r) => [r.agent, r.entry, r.family, r.requested_model]), [['pair-implementer', 'sol', 'OpenAI', 'gpt-6.1-sol'], ['pr-check-judge', 'opus', 'Anthropic', 'claude-opus-5-5']]);
  } finally {
    for (const [k, v] of Object.entries({ PIPELINE_AGENT_CMD: saved.cmd, CODEX_HOME: saved.home, FACTORY_METRICS_SHARD: saved.shard, FACTORY_METRICS_SPOOL: saved.spool })) if (v === undefined) delete process.env[k]; else process.env[k] = v;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('runAsync runs commands side by side and reports status, output and timeouts', async () => {
  const node = process.execPath;
  // Each child writes its own marker and waits (up to 20 s) for the other's. Run side by side, both see the other;
  // run one after the other, the first never can, however slow a loaded machine is to start them.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-async-'));
  const child = (me, other, tail) => `const fs = require('fs'); fs.writeFileSync(${JSON.stringify(path.join(dir, me))}, ''); const t = Date.now(); (function poll() { if (fs.existsSync(${JSON.stringify(path.join(dir, other))})) { console.log('together'); ${tail} } else if (Date.now() - t > 20000) { console.log('alone'); ${tail} } else setTimeout(poll, 20); })();`;
  const [a, b] = await Promise.all([
    runAsync(node, ['-e', child('a', 'b', 'console.log("a");')]),
    runAsync(node, ['-e', child('b', 'a', 'console.error("b"); process.exit(3);')]),
  ]);
  assert.deepEqual([a.stdout.trim().split('\n')[0], b.stdout.trim().split('\n')[0]], ['together', 'together']);
  assert.deepEqual([a.status, a.stdout.trim().split('\n')[1]], [0, 'a']);
  assert.deepEqual([b.status, b.stderr.trim()], [3, 'b']);
  const slow = await runAsync(node, ['-e', 'setTimeout(() => {}, 5000)'], { timeoutSec: 0.3 });
  assert.equal(slow.timedOut, true);
  assert.equal((await runAsync('definitely-not-a-command-xyz', [])).status, 127);
});
