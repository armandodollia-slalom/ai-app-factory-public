// GEN-19: a rule several agents follow lives in one shared file (agents/shared/), and the built instructions of every
// agent that includes it still carry it: the pipeline's prompts and the agent files `factory render` writes.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { agentDefinition } from '../lib/agents.mjs';
import { loadConfig } from '../lib/config.mjs';

const INSTALL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const sharedText = (name) => fs.readFileSync(path.join(INSTALL, 'agents/shared', name), 'utf8').replace(/^<!-- markdownlint-[^\n]*-->\n/, '').trim();
// Each agent that includes a shared file, by the include line in its definition.
const including = fs.readdirSync(path.join(INSTALL, 'agents')).filter((f) => f.endsWith('.agent.md')).flatMap((f) => [...fs.readFileSync(path.join(INSTALL, 'agents', f), 'utf8').matchAll(/^<!-- include: shared\/([\w-]+\.md) -->$/gm)].map((m) => [f.replace('.agent.md', ''), m[1]]));

test('every agent that includes a shared section gets it whole in its pipeline prompt and in its rendered agent file', (t) => {
  assert.ok(including.length >= 10, including.map((x) => x.join(' ')).join(', '));
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'includes-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  fs.writeFileSync(path.join(root, 'package.json'), '{}\n');
  const r = spawnSync(process.execPath, [path.join(INSTALL, 'bin/factory.mjs'), 'init', '--tools', 'claude'], { cwd: root, encoding: 'utf8', env: { ...process.env, PIPELINE_ROOT: '' } });
  assert.equal(r.status, 0, r.stderr);
  const config = loadConfig('implement', root);
  for (const [name, shared] of including) {
    const body = agentDefinition(config, name).body;
    assert.ok(body.includes(sharedText(shared)), `${name}: ${shared} in its prompt`);
    assert.doesNotMatch(body, /<!-- include:|markdownlint-disable/, name);
    const rendered = fs.readFileSync(path.join(root, '.claude/agents', `${name}.md`), 'utf8');
    assert.ok(rendered.includes(sharedText(shared)), `${name}: ${shared} in .claude/agents/${name}.md`);
  }
  // Council r3 (cc-17): the rendered agent file and the pipeline's prompt read one clean-code depth, for every agent.
  for (const file of fs.readdirSync(path.join(INSTALL, 'agents')).filter((f) => f.endsWith('.agent.md'))) {
    const name = file.slice(0, -'.agent.md'.length);
    const rendered = fs.readFileSync(path.join(root, '.claude/agents', `${name}.md`), 'utf8');
    const depth = agentDefinition(config, name).cleanCode;
    assert.equal(/^## Clean code$/m.test(rendered), Boolean(depth), `${name}: ${depth ?? 'no depth'}`);
    if (depth === 'writer') assert.match(rendered, /writer core of the `clean-code` skill/, name);
    if (depth === 'full') assert.match(rendered, /every rule of the `clean-code` skill/, name);
  }
});

// Council r1 (cc-1): the clean-code seat's duties are written once; the seat's task on every council stage and the PR
// check's clean-code critic both carry them.
test('cc-1: the clean-code seat\'s task and pr-check-clean-code carry the same shared duties', async () => {
  const { cleanCodeDuty } = await import('../lib/council.mjs');
  const [search, arbiter] = ['clean-code-search.md', 'clean-code-arbiter.md'].map(sharedText);
  assert.ok(including.some(([name, shared]) => name === 'pr-check-clean-code' && shared === 'clean-code-arbiter.md'));
  assert.ok(including.some(([name, shared]) => name === 'pr-check-clean-code' && shared === 'clean-code-search.md'));
  assert.ok(cleanCodeDuty('architectureReview').includes(search) && cleanCodeDuty('architectureReview').includes(arbiter));
  // The test plan seat reviews cases: no code search, the same arbiter duties.
  assert.ok(!cleanCodeDuty('testPlan').includes(search) && cleanCodeDuty('testPlan').includes(arbiter));
  // Council r3 (cc-1 follow-up): the critic's own text does not restate them (each sentence once in its instructions).
  const critic = fs.readFileSync(path.join(INSTALL, 'agents/pr-check-clean-code.agent.md'), 'utf8').replace(/^<!-- include: shared\/clean-code-arbiter\.md -->$/m, arbiter);
  assert.equal(critic.split('starting point, not a finding').length - 1, 1);
});
