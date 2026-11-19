import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scoreRound } from '../lib/loop.mjs';
import { followUpsOf } from '../pr-check.mjs';
import { followUpsSection, prCheckFollowUps } from '../../implement/lib/implement.mjs';
import { followUpsFromPrBody, mergeEpicEvidence, renderEpicEvidence } from '../../board/lib/epics.mjs';

// Council C2: the judge dismissed a real, pre-existing 500 as belonging "in a follow-up bug", and nothing filed it.
const findings = [
  { id: 'FLOW-1-1', lens: 'flow', severity: 'minor', title: 'Pre-existing seed defect' },
  { id: 'FLOW-1-2', lens: 'flow', severity: 'major', title: 'Contract mismatch' },
  { id: 'STY-1-1', lens: 'style', severity: 'minor', title: 'nit' },
];
const rulings = [
  { id: 'FLOW-1-1', ruling: 'dismissed', reason: 'real, but the same on main', followUp: 'Move the id counter past the seeded ids' },
  { id: 'FLOW-1-2', ruling: 'upheld', severity: 'major', reason: 'r', fix: 'f' },
  { id: 'STY-1-1', ruling: 'dismissed', reason: 'not a convention here' },
];

test('a dismissal with a follow-up is kept as a follow-up; a plain dismissal is not', () => {
  const r = scoreRound({ lenses: ['flow', 'style'], findings, rulings });
  assert.deepEqual(r.followUps, [{ id: 'FLOW-1-1', lens: 'flow', title: 'Move the id counter past the seeded ids', reason: 'real, but the same on main' }]);
  assert.deepEqual(r.upheld.map((f) => f.id), ['FLOW-1-2']);
});

test('the PR check summary lists each follow-up once across rounds', () => {
  const u = { id: 'FLOW-1-1', lens: 'flow', title: 't', reason: 'r' };
  assert.deepEqual(followUpsOf([{ followUps: [u] }, { followUps: [u] }, {}]), [u]);
});

test('the PR body gets a Follow-ups section from the implementer and the PR check; the board reads it back', () => {
  const prc = { status: 'done', followUps: [{ id: 'FLOW-1-1', title: 'Move the id counter past the seeded ids', reason: 'same on main' }] };
  const section = followUpsSection([{ title: 'Handle concurrent duplicate creates', reason: 'race' }, ...prCheckFollowUps([prc, prc])]);
  assert.match(section, /^\n## Follow-ups \(not in this PR\)\n\n- Handle concurrent duplicate creates \(race\)\n- Move the id counter past the seeded ids \(PR check before this PR FLOW-1-1: same on main\)\n$/);
  assert.equal(followUpsSection([]), '');
  const body = `Implements B-1.\n${section}\nThe demo video is added below.\n\nCloses #3\n`;
  assert.equal(followUpsFromPrBody(body), '- Handle concurrent duplicate creates (race)\n- Move the id counter past the seeded ids (PR check before this PR FLOW-1-1: same on main)');
  assert.equal(followUpsFromPrBody('Implements B-1.'), '');
});

test('the epic evidence comment lists a group\'s follow-ups under its PR', () => {
  const data = mergeEpicEvidence({}, { group: { id: 'catalog', pr: 'https://x/pull/1', title: 'Catalog', tickets: ['B-1'], followUps: ['B-1: Move the id counter past the seeded ids'] } });
  const text = renderEpicEvidence({ board: { columns: {} } }, data);
  assert.match(text, /- `catalog` Catalog \(B-1\): \[pull request\]\(https:\/\/x\/pull\/1\)\n  - Follow-up to file: B-1: Move the id counter past the seeded ids/);
});
