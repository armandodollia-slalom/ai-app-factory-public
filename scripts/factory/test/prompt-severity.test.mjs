import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const agent = (name) => fs.readFileSync(path.join(root, 'agents', `${name}.agent.md`), 'utf8');
const AGENTS = ['architecture-reviewer', 'pr-check-judge', 'pr-check-flow'];

// Council C2: the severity rule's examples paraphrased the defects of the tickets the runs were judged on, so
// later detections of those defects were prompted, not blind. The rule keeps its general principle only.
test('the correctness severity rule states the principle in neutral terms', () => {
  for (const name of AGENTS) {
    const text = agent(name);
    assert.match(text, /wrong result on a path this change touches \(a wrong status, a false success, state written for an operation that did not succeed\)/, name);
    assert.match(text, /regression of behavior that worked before/, name);
  }
});

test('no agent prompt echoes the defects of the dogfood tickets', () => {
  const echoes = [/found nothing/i, /optional call/i, /every item of a category/i, /request recorded/i, /brand/i, /request id/i, /\badmin/i];
  // The definitions and the shared sections they include (agents/shared/).
  for (const file of fs.readdirSync(path.join(root, 'agents'), { recursive: true }).filter((f) => String(f).endsWith('.md'))) {
    const text = fs.readFileSync(path.join(root, 'agents', file), 'utf8');
    for (const re of echoes) assert.doesNotMatch(text, re, `${file} matches ${re}`);
  }
});

// Council C3: a review found an error that broke a whole page with unusual data, called it minor, and it shipped.
test('an error a user can hit is never minor: in the prompts, and raised by the harness when filed as minor', async () => {
  for (const name of AGENTS) assert.match(agent(name), /An error a user can hit .*unhandled exception, an error page or a 5xx response, a page or component that stops rendering/s, name);
  const { describesUserError, raiseUserErrors } = await import('../../pipeline/lib/user-errors.mjs');
  assert.equal(describesUserError('A missing record throws KeyNotFoundException and breaks the whole page/header.'), true);
  assert.equal(describesUserError('The endpoint returns 500 for an empty body.'), true);
  assert.equal(describesUserError('An unhandled RpcException reaches the component.'), true);
  assert.equal(describesUserError('Variable name could be clearer.'), false);
  assert.equal(describesUserError('The handler catches the exception and shows a message.'), false);
  const { findings, raised } = raiseUserErrors([{ severity: 'minor', issue: 'If the record is gone the page crashes.' }, { severity: 'minor', issue: 'Rename this.' }, { severity: 'blocking', issue: 'breaks the page' }], { to: 'blocking' });
  assert.deepEqual(findings.map((f) => f.severity), ['blocking', 'minor', 'blocking']);
  assert.equal(raised.length, 1);
  assert.equal(raised[0].raisedBy, 'harness');
});

// Council C3 (Sol 3): the fix of a known user-visible error shipped without a regression test.
test('the PR check fixer adds a regression test with a correctness fix', () => {
  assert.match(agent('pr-check-fixer'), /When you fix a wrong result or an error a user can hit, add or extend a test .* that fails without your fix/);
});

// Council C4: the critics read the implementer's notes as accepting an authorization rule weaker than the ticket's,
// a lesson told them to skip "deviations the Implementation Notes accept", and the review filed the gap as minor.
test('the notes never waive a criterion: in every reviewing prompt, and in the PR check task', async () => {
  for (const name of ['architecture-reviewer', 'pr-check-acceptance', 'pr-check-flow', 'pr-check-judge']) assert.match(agent(name), /never waive, narrow or reinterpret a criterion/, name);
  assert.match(agent('pr-check-defender'), /never rebuts a finding that a criterion/);
  for (const name of ['test-planner', 'test-automation']) assert.match(agent(name), /behaviour the ticket forbids/, name);
  assert.match(agent('retro'), /Never write a rule that waives a criterion/);
  assert.match(agent('lessons-check'), /Always contradicts/);
  const { CONTRACT_NOTE } = await import('../../pr-check/lib/loop.mjs');
  assert.match(CONTRACT_NOTE, /never a waiver/);
});

test('a finding that says access is weaker than required is blocking, whoever filed it as minor', async () => {
  const { raiseUserErrors, describesWeakerAuthz } = await import('../../pipeline/lib/user-errors.mjs');
  const minor = { severity: 'minor', issue: 'Catalog writes need only an authenticated caller, not an admin role as the story says.' };
  const { findings, raised } = raiseUserErrors([minor, { severity: 'minor', issue: 'Rename the local variable.' }], { to: 'blocking' });
  assert.equal(findings[0].severity, 'blocking');
  assert.match(raised[0].raisedReason, /weaker than required/);
  assert.equal(findings[1].severity, 'minor');
  for (const t of ['Missing role check on the delete endpoint', "Another buyer's order can be cancelled by this endpoint", 'An authorization bypass on PUT']) assert.ok(describesWeakerAuthz(t), t);
  for (const t of ['The admin page header is misaligned', 'Sort order is wrong', 'Uses an authenticated HTTP client']) assert.ok(!describesWeakerAuthz(t), t);
});

// Council C7 pin: a placeholder written as <route or page> in a prompt rendered into the app repository failed its
// markdownlint (MD033 inline HTML). Placeholders in prompt prose go in code spans.
test('agent prompts have no inline-HTML-like text outside code spans, fences and front matter', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const dir = path.join(path.dirname(new URL(import.meta.url).pathname), '..', '..', '..', 'agents');
  const bad = [];
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.md'))) {
    const text = fs.readFileSync(path.join(dir, f), 'utf8').replace(/^---\n[\s\S]*?\n---\n/, '');
    let fence = false;
    text.split('\n').forEach((line, i) => {
      if (/^\s*```/.test(line)) fence = !fence;
      if (fence || /^\s*```/.test(line)) return;
      const m = line.replace(/`[^`]*`/g, '').replace(/<!--.*?-->/g, '').match(/<\/?[A-Za-z][^>]*>/);
      if (m) bad.push(`${f}: ${m[0]}`);
    });
  }
  assert.deepEqual(bad, []);
});
