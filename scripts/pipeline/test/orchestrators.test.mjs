// GEN-10: every stage is led by an orchestrator on a pool entry, with one global setting and per-stage overrides. The
// decision runs themselves are tested where each stage runs them: pipeline/test/e2e.test.mjs (test plan, architecture
// review) and pr-check/test/pr-check.test.mjs (PR check).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { loadConfig } from '../lib/config.mjs';
import { decide, orchestratorOf, producerRun } from '../lib/orchestrator.mjs';
import { ORCHESTRATED, entryFor } from '../lib/pool.mjs';
import { readJsonl } from '../lib/util.mjs';

const POOL = [
  { name: 'opus', cli: 'claude', model: 'claude-opus-5-5', effort: 'high' },
  { name: 'sonnet', cli: 'claude', model: 'claude-sonnet-5-5', effort: 'medium' },
  { name: 'sol', cli: 'codex', model: 'gpt-6.1-sol', effort: 'xhigh' },
];
const repo = (t, settings) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orchestrators-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  fs.mkdirSync(path.join(dir, '.factory'));
  fs.writeFileSync(path.join(dir, '.factory/config.json'), JSON.stringify(settings));
  return dir;
};

test('with only orchestrator.model set, every stage\'s orchestrator runs on that entry, the implement stage\'s implementer too', (t) => {
  const config = loadConfig(null, repo(t, { models: { pool: POOL, agents: { default: 'sonnet' } }, orchestrator: { model: 'sol' } }));
  for (const section of ORCHESTRATED) assert.deepEqual(orchestratorOf(config, section), { entry: 'sol', family: 'OpenAI', effort: 'xhigh' }, section);
  assert.equal(entryFor(config, { name: 'implementer' }).name, 'sol');
  assert.equal(entryFor(config, { name: 'pair-verifier' }).name, 'sonnet', 'the stage agents keep their own entries');
});

test('testPlan.orchestrator.effort applies to the test plan orchestrator only; a section\'s model overrides the global one', (t) => {
  const config = loadConfig(null, repo(t, { models: { pool: POOL, agents: { default: 'sonnet' } }, orchestrator: { model: 'opus' }, testPlan: { orchestrator: { effort: 'max' } }, implement: { orchestrator: { model: 'sonnet', effort: 'low' } } }));
  assert.deepEqual(orchestratorOf(config, 'testPlan'), { entry: 'opus', family: 'Anthropic', effort: 'max' });
  for (const section of ['architectureReview', 'testAutomation', 'prCheck']) assert.equal(orchestratorOf(config, section).effort, 'high', section);
  assert.deepEqual([entryFor(config, { name: 'implementer' }).name, entryFor(config, { name: 'implementer' }).effort], ['sonnet', 'low']);
});

test('an orchestrator setting that names no pool entry fails the load; so do the removed switch and its environment variable', (t) => {
  assert.throws(() => loadConfig(null, repo(t, { orchestrator: { model: 'gpt-9' } })), /orchestrator\.model must name a models\.pool entry \(entries: opus, sonnet, sol\)/);
  assert.throws(() => loadConfig(null, repo(t, { prCheck: { orchestrator: { model: 'gpt-9' } } })), /prCheck\.orchestrator\.model is "gpt-9", which is not in models\.pool/);
  assert.throws(() => loadConfig(null, repo(t, { implement: { orchestrate: false } })), /implement\.orchestrate was removed: the implement stage's orchestrator decides/);
  assert.throws(() => loadConfig(null, repo(t, { implement: { orchestrator: { enabled: false } } })), /implement\.orchestrator\.enabled was removed: the implement stage's orchestrator decides/);
});

test('a decision is logged with its reason and the orchestrator\'s entry; an unreadable one delegates and says so; work kept is run by the orchestrator', async (t) => {
  const dir = repo(t, { models: { pool: POOL, agents: { default: 'sonnet' } } });
  const saved = { shard: process.env.FACTORY_METRICS_SHARD, spool: process.env.FACTORY_METRICS_SPOOL };
  Object.assign(process.env, { FACTORY_METRICS_SHARD: '0', FACTORY_METRICS_SPOOL: '0' });
  t.after(() => { for (const [k, v] of Object.entries({ FACTORY_METRICS_SHARD: saved.shard, FACTORY_METRICS_SPOOL: saved.spool })) if (v === undefined) delete process.env[k]; else process.env[k] = v; });
  const config = { ...loadConfig(null, dir), root: dir };
  const runs = [];
  const answer = (out) => async (o) => (runs.push(o), { ok: true, output: out, version: 'v1' });
  const self = await decide(config, { section: 'testPlan', stage: 'test plan', story: 'K-1', work: 'the plan', delegateTo: 'the test planner', run: answer('AGENT_RESULT: {"decision": "self", "reason": "three cases, one endpoint"}') });
  assert.deepEqual([self.decision, self.entry, runs[0].name, runs[0].mode, runs[0].entry], ['self', 'opus', 'stage-orchestrator', 'read', 'opus']);
  const lost = await decide(config, { section: 'prCheck', stage: 'PR check', story: 'K-1', work: 'fixing', delegateTo: 'the fixer', run: answer('no result') });
  assert.equal(lost.decision, 'delegate');
  const rows = readJsonl(path.join(dir, '.factory/metrics/decisions.jsonl'));
  assert.deepEqual(rows.map((r) => [r.stage, r.decision, r.entry, r.reason]), [['testPlan-orchestrator', 'self', 'opus', 'three cases, one endpoint'], ['prCheck-orchestrator', 'delegate', 'opus', 'the orchestrator gave no readable decision: the stage goes on as usual']]);
  const kept = producerRun(config, { agent: 'test-planner', task: 'Plan DEMO-1', selfDo: self });
  assert.equal(kept.name, 'stage-orchestrator', 'the test planner is not started');
  assert.equal(kept.entry, 'opus');
  assert.equal(kept.work, 'test-planner', 'the guards of the planner\'s work hold for it (council r3, sol-22)');
  assert.match(kept.task, /^# You are doing the test-planner work yourself[\s\S]*# Test planner[\s\S]*Plan DEMO-1$/);
  assert.deepEqual(producerRun(config, { agent: 'test-planner', task: 'Plan DEMO-1' }), { name: 'test-planner', task: 'Plan DEMO-1', work: 'test-planner' });
});
