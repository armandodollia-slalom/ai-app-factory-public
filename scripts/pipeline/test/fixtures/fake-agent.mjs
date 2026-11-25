#!/usr/bin/env node
// Scripted stand-in for an agent CLI, used by the end-to-end tests through PIPELINE_AGENT_CMD.
// Behavior per agent comes from PIPELINE_FAKE_SCRIPT (JSON: { "<agent>": [response, response, ...] });
// each call consumes the next response for that agent (the last one repeats).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { isResolvesQuestion, RESOLVES_ANSWER } from './resolves-question.mjs';

if (!process.env.PIPELINE_FAKE_SCRIPT) process.exit(0); // not a test file; only runs under the e2e tests

const prompt = fs.readFileSync(0, 'utf8');
// Every verifier is a council member: the harness's follow-up question for a finding's missing `resolves` is answered
// here, outside the script, so a script's steps stay the agent's review rounds (fixtures/resolves-question.mjs).
// A stage orchestrator's council pick (selection.mjs selectionTask) is answered here, outside the script and uncounted:
// with no pick the harness seats the council (the stage's own verifier for one seat), so a script's steps stay the
// orchestrator's decisions.
if (/^# Pick the .+ council$/m.test(prompt)) {
  fs.appendFileSync(`${process.env.PIPELINE_FAKE_SCRIPT}.prompts.log`, `\n=== stage-orchestrator (council pick, answered by the fake) ===\n${prompt}\n`);
  process.stdout.write('AGENT_RESULT: {"seats": []}\n');
  process.exit(0);
}
if (isResolvesQuestion(prompt)) {
  process.stdout.write(`${RESOLVES_ANSWER}\n`);
  process.exit(0);
}
const script = JSON.parse(fs.readFileSync(process.env.PIPELINE_FAKE_SCRIPT, 'utf8'));
// PIPELINE_FAKE_RECORD_ENV (names, comma-separated): each agent's value of those variables, one JSON line per call, in
// `<script>.env.jsonl`, so a test sees what the run handed its agents.
if (process.env.PIPELINE_FAKE_RECORD_ENV) {
  const names = process.env.PIPELINE_FAKE_RECORD_ENV.split(',').filter(Boolean);
  fs.appendFileSync(`${process.env.PIPELINE_FAKE_SCRIPT}.env.jsonl`, `${JSON.stringify({ agent: process.env.PIPELINE_AGENT_NAME, ...Object.fromEntries(names.map((n) => [n, process.env[n] ?? null])) })}\n`);
}
// The implement stage's orchestrator always plans first (GEN-10). A script written for a lone implementer (its steps
// change code, none returns a plan) gets a self-mode plan here, outside the script and its count, and the pair
// verifier with no steps approves; a script that plans or scripts the verifier answers as written.
const agentName = process.env.PIPELINE_AGENT_NAME;
const scriptedCalls = (() => {
  try {
    return JSON.parse(fs.readFileSync(`${process.env.PIPELINE_FAKE_SCRIPT}.calls.json`, 'utf8'));
  } catch {
    return {};
  }
})();
const planning = agentName === 'implementer' && /^Plan story \S+:/m.test(prompt);
const nextStep = (script[agentName] ?? [])[Math.min(scriptedCalls[agentName] ?? 0, (script[agentName] ?? []).length - 1)];
if (planning && !nextStep?.result?.mode) {
  fs.appendFileSync(`${process.env.PIPELINE_FAKE_SCRIPT}.prompts.log`, `\n=== implementer (plan, answered by the fake) ===\n${prompt}\n`);
  process.stdout.write(`Planned.\nAGENT_RESULT: ${JSON.stringify({ mode: 'self', modeReason: 'one change, small enough to make in one pass', features: { services: [], estimatedSize: 'small' }, subtasks: [{ goal: 'Implement the ticket.', acceptance: ['Every acceptance criterion of the ticket'], verify: 'code', modelReason: 'the orchestrator itself', verifyReason: 'code change', expectedFiles: 1, expectedLoc: 10, confidence: 0.8, alternatives: [] }] })}\n`);
  process.exit(0);
}
if (['pair-verifier', 'pair-ui-verifier'].includes(agentName) && !script[agentName] && !Object.keys(script).some((k) => k.startsWith(`${agentName}@`))) {
  process.stdout.write(`AGENT_RESULT: ${JSON.stringify({ verdict: 'APPROVED', summary: 'the change does what the subtask asks', score: 10, findings: [] })}\n`);
  process.exit(0);
}
// A council member (PIPELINE_COUNCIL_MEMBER) answers from `<agent>@<member>` when the script has that key.
const member = process.env.PIPELINE_COUNCIL_MEMBER;
// The clean-code seat (GEN-16) sits on every council: unscripted (no `pr-check-clean-code` key, no `<agent>@<seat>` key),
// it finds nothing and is not counted, like an unscripted pair verifier.
const cleanCodeKey = agentName === 'pr-check-clean-code' ? agentName : process.env.PIPELINE_COUNCIL_LENS === 'clean-code' ? `${agentName}@${member}` : null;
if (cleanCodeKey && !script[cleanCodeKey]) {
  process.stdout.write(`AGENT_RESULT: ${JSON.stringify({ lens: 'clean-code', verdict: 'APPROVED', score: 10, summary: 'nothing breaks the clean-code rules', coverage: [], findings: [], gaps: [] })}\n`);
  process.exit(0);
}
const agent = member && script[`${process.env.PIPELINE_AGENT_NAME}@${member}`] ? `${process.env.PIPELINE_AGENT_NAME}@${member}` : process.env.PIPELINE_AGENT_NAME;
const counterFile = `${process.env.PIPELINE_FAKE_SCRIPT}.calls.json`;
// Agents can run in parallel (the PR check's critics), so the shared counter update is locked.
const lock = `${counterFile}.lock`;
for (let i = 0; ; i++) {
  try {
    fs.writeFileSync(lock, String(process.pid), { flag: 'wx' });
    break;
  } catch {
    if (i > 2000) break;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
  }
}
const calls = fs.existsSync(counterFile) ? JSON.parse(fs.readFileSync(counterFile, 'utf8')) : {};
const n = calls[agent] ?? 0;
calls[agent] = n + 1;
fs.writeFileSync(counterFile, JSON.stringify(calls));
fs.rmSync(lock, { force: true });
fs.appendFileSync(`${process.env.PIPELINE_FAKE_SCRIPT}.prompts.log`, `\n=== ${agent} #${n + 1} (child=${process.env.PIPELINE_CHILD}) ===\n${prompt}\n`);

// PIPELINE_FAKE_SLEEP_MS: each call takes that long, like a real agent's work (the slow-delivery test).
if (Number(process.env.PIPELINE_FAKE_SLEEP_MS) > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(process.env.PIPELINE_FAKE_SLEEP_MS));

const steps = script[agent] ?? [];
const step = steps[Math.min(n, steps.length - 1)] ?? {};
const field = (name) => new RegExp(`^${name}: (\\S+)`, 'm').exec(prompt)?.[1];

if (step.writePlan) {
  const dir = field('Plan directory');
  const key = field('Story');
  fs.mkdirSync(dir, { recursive: true });
  const indexFile = path.join(dir, '_index.md');
  const existing = fs.existsSync(indexFile) ? fs.readFileSync(indexFile, 'utf8') : '';
  const frontMatter = /^---\n[\s\S]*?\n---\n/.exec(existing)?.[0] ?? '';
  const ids = step.writePlan.map((_, i) => `TC-${key}-0${i + 1}`);
  const rows = step.writePlan.map((c, i) => `| ${ids[i]} | ${c.title} | ${c.type} | functional | rule |`).join('\n');
  fs.writeFileSync(indexFile, `${frontMatter}# Test plan: ${key}\n\n| ID | Title | Type | Layer | Covers |\n| --- | --- | --- | --- | --- |\n${rows}\n`);
  for (const f of fs.readdirSync(dir).filter((f) => f.startsWith('TC-'))) fs.rmSync(path.join(dir, f));
  step.writePlan.forEach((c, i) => {
    const sad = c.type === 'sad' ? '\nsad-path: validation' : '';
    fs.writeFileSync(
      path.join(dir, `${ids[i]}-case.md`),
      `---\nid: ${ids[i]}\ntype: ${c.type}${sad}\nlayer: functional\ncovers: ["Rule, part 1"]\n---\n\n# ${ids[i]}: ${c.title}\n\n## Why\n\n- ${c.why ?? 'covers the rule'}\n\n## Preconditions\n\n- data\n\n## Steps\n\n1. call\n\n## Expected result\n\n- ${c.expected ?? '200'}\n`,
    );
  });
}

if (step.writeTests) {
  const key = field('Story');
  const scenario = /\(name: (\S+)\)/.exec(prompt)[1];
  fs.mkdirSync(`.factory/stack/scenarios/${scenario}`, { recursive: true });
  fs.writeFileSync(`.factory/stack/scenarios/${scenario}/scenario.yaml`, 'extends: default\n');
  fs.mkdirSync('e2e/teststack', { recursive: true });
  const tests = step.writeTests.map((i) => `test('TC-${key}-0${i} works', async () => {});`).join('\n');
  fs.writeFileSync(`e2e/teststack/${scenario}.spec.ts`, `${tests}\n`);
}

if (step.writeImpl) {
  fs.mkdirSync(path.dirname(step.writeImpl), { recursive: true });
  fs.writeFileSync(step.writeImpl, `// fixed ${n}\n`);
}

for (const [file, content] of Object.entries(step.writeFiles ?? {})) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}
for (const file of step.deleteFiles ?? []) fs.rmSync(file, { force: true });
// Language-server searches, logged as the lsp MCP server logs them: <git-dir>/lsp/calls.jsonl, with this run's agent and seat.
if (step.search?.length) {
  const dir = path.join(path.resolve(spawnSync('git', ['rev-parse', '--git-dir'], { encoding: 'utf8' }).stdout.trim()), 'lsp');
  fs.mkdirSync(dir, { recursive: true });
  for (const tool of step.search) fs.appendFileSync(path.join(dir, 'calls.jsonl'), `${JSON.stringify({ ts: new Date().toISOString(), agent: process.env.PIPELINE_AGENT_NAME ?? null, member: process.env.PIPELINE_COUNCIL_MEMBER ?? null, tool })}\n`);
}

if (step.screenshot) {
  const dir = /Save every screenshot under (\S+?) \(/.exec(prompt)?.[1];
  if (dir) fs.writeFileSync(path.join(dir, step.screenshot), 'png');
}

// `pidFile`: this run's process id, written before any delay, so a test can tell whether the run was stopped.
if (step.pidFile) fs.writeFileSync(step.pidFile, String(process.pid));
if (step.delayMs) await new Promise((r) => setTimeout(r, step.delayMs));
// Holds this answer until another agent has been called `waitForCalls` times (default 1): a member that must be late
// answers only after the round's judge ran, however slow the machine. Gives up after a minute.
if (step.waitForCall) {
  const until = Date.now() + 60_000;
  const called = () => {
    try {
      return (JSON.parse(fs.readFileSync(counterFile, 'utf8'))[step.waitForCall] ?? 0) >= (step.waitForCalls ?? 1);
    } catch {
      return false;
    }
  };
  while (!called() && Date.now() < until) await new Promise((r) => setTimeout(r, 100));
}

// Simulates a crash of the feature verification runner that called this agent: SIGKILL, so nothing gets cleaned up.
if (step.killRunner) {
  const state = JSON.parse(fs.readFileSync(`.factory/state/stories/${field('Story')}.json`, 'utf8'));
  process.kill(state[step.killRunner].pid, 'SIGKILL');
}
// The same for a run that records its pid in a JSON file (a manual PR check's progress.json).
if (step.killPidIn) process.kill(JSON.parse(fs.readFileSync(step.killPidIn, 'utf8')).pid, 'SIGKILL');

process.stdout.write(`Working...\n${step.result ? `AGENT_RESULT: ${JSON.stringify(step.result)}\n` : ''}`);
process.exit(step.exit ?? 0);
