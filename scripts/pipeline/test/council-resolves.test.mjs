// Council members must fill `resolves` on every finding (dogfood C24: the PR check's members left it out and the harness
// inferred it). A result without it is rejected and the member is asked once, classification only; what is still
// missing is inferred and marked, so the records tell given values from guessed ones.
import assert from 'node:assert/strict';
import test from 'node:test';
import { runCouncil } from '../lib/council.mjs';

const council = { stage: 'pairVerify', members: [{ name: 'opus', blocking: true, lens: 'opus' }] };
const verdict = (findings) => `AGENT_RESULT: ${JSON.stringify({ verdict: 'CHANGES_REQUESTED', score: 6, findings })}`;
const parse = (out) => {
  const m = /AGENT_RESULT: (.*)$/m.exec(out);
  return m ? JSON.parse(m[1]) : null;
};
const quiet = () => {};

test('a member that leaves resolves out is asked once; the values it gives are taken, the rest inferred and marked', async () => {
  const tasks = [];
  const run = async (m, task, o) => {
    tasks.push({ task, o });
    if (tasks.length === 1) return { status: 0, output: verdict([{ id: 'A', issue: 'The handler returns 500.', file: 'src/a.cs' }, { id: 'B', issue: 'The regression is not covered.', file: 'e2e/a.spec.ts' }, { id: 'C', issue: 'Rename X.', resolves: 'code' }]) };
    return { status: 0, output: `AGENT_RESULT: ${JSON.stringify({ resolves: { A: 'code' } })}` };
  };
  const { results } = await runCouncil({ council, run, parse, taskFor: () => 'review', log: quiet });
  assert.equal(tasks.length, 2, 'asked exactly once more');
  assert.equal(tasks[1].o?.purpose, 'resolves');
  assert.match(tasks[1].task, /- A: .*\n- B: /);
  assert.doesNotMatch(tasks[1].task, /- C: /, 'only the findings without it');
  const [r] = results;
  const by = Object.fromEntries(r.findings.map((f) => [f.id, f]));
  assert.deepEqual([by.A.resolves, by.A.resolvesAsked, by.A.resolvesInferred], ['code', true, undefined]);
  assert.deepEqual([by.B.resolves, by.B.resolvesInferred], [['tests'], true]);
  assert.deepEqual([by.C.resolves, by.C.resolvesAsked, by.C.resolvesInferred], ['code', undefined, undefined]);
  assert.deepEqual(r.resolvesReasked, { missing: 2, given: 1, inferred: 1 });
});

test('a member that fills resolves is not asked again; an unparsable answer to the question infers all', async () => {
  let n = 0;
  const full = await runCouncil({ council, run: async () => (n++, { status: 0, output: verdict([{ id: 'A', issue: 'x', resolves: 'tests' }]) }), parse, taskFor: () => 'review', log: quiet });
  assert.equal(n, 1);
  assert.equal(full.results[0].resolvesReasked, undefined);
  let k = 0;
  const bad = await runCouncil({ council, run: async () => (k++ === 0 ? { status: 0, output: verdict([{ id: 'A', issue: 'The handler returns 500.' }]) } : { status: 0, output: 'no result' }), parse, taskFor: () => 'review', log: quiet });
  assert.equal(k, 2);
  assert.deepEqual([bad.results[0].findings[0].resolves, bad.results[0].findings[0].resolvesInferred], [['code'], true]);
});
