// Council r4 (sol-11): a non-blocking (shadow) member never changes a council's verdict. For every combination of the
// deciding members' results (score, a finding with or without evidence, its severity and action) and the shadow's
// (none, the same finding with evidence, with its own id, the same finding asking the opposite action, another blocking finding, only a
// low score; on time or late), mergeCouncil decides exactly what it decides without the shadow: pass, score, and every
// standing finding with its severity, evidence and whether it is contested.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { councilFor, mergeCouncil, normalizeFinding } from '../lib/council.mjs';

const F1 = 'the order total ignores the discount';
const withEvidence = { severity: 'major', issue: F1, file: 'src/Basket/Total.cs', line: 3, evidence: 'Total() never reads Discount (src/Basket/Total.cs:3)', fix: 'apply the discount' };
const noEvidence = { severity: 'major', issue: F1, evidence: '', fix: 'apply the discount' };
const DECIDING = [
  [],
  [withEvidence],
  [noEvidence],
  [{ ...noEvidence, severity: 'minor' }],
  [{ ...noEvidence, action: 'delete-test', test: 'TC-SHOP-1-01-total', file: 'tests/Total.cs' }],
  [{ severity: 'blocking', issue: 'Saving the basket throws for an empty cart', file: 'src/Basket/Save.cs', line: 9, evidence: 'Save() indexes items[0] (src/Basket/Save.cs:9)', fix: 'guard the empty cart' }],
];
const SHADOW = [
  null,
  { score: 2, findings: [withEvidence] },
  { score: 2, findings: [{ ...withEvidence, id: 'SHADOW-F1' }] },
  { score: 2, findings: [{ ...withEvidence, action: 'delete-test', test: 'TC-SHOP-1-01-total' }] },
  { score: 2, findings: [{ severity: 'blocking', issue: 'Saving returns HTTP 500', file: 'src/Basket/Save.cs', line: 12, evidence: 'POST /basket answers 500 (src/Basket/Save.cs:12)', fix: 'handle the save' }] },
  { score: 2, findings: [] },
];

const base = councilFor({}, 'architectureReview');
const member = (name, blocking) => ({ ...base.members[0], name, lens: 'all', blocking, ...(blocking ? {} : { shadow: true }) });
// As runCouncil hands them over: each finding normalized and attributed to its member.
const result = (m, score, findings) => ({ member: m, status: 'ok', score, verdict: findings.length ? 'CHANGES_REQUESTED' : 'APPROVED', summary: '', findings: findings.map((f) => normalizeFinding(f, m)) });
const project = (merged) => ({
  pass: merged.pass,
  score: merged.score,
  findings: merged.findings.map((f) => [f.id ?? null, f.severity, f.text, f.file ?? null, f.line ?? null, f.action, f.evidence, Boolean(f.contested), Boolean(f.noEvidence)]),
});

function check(council, deciders) {
  const shadow = council.members.find((m) => !m.blocking);
  let n = 0;
  const combos = Array.from({ length: deciders }).reduce((acc) => acc.flatMap((xs) => [10, 8, null].flatMap((score) => DECIDING.map((findings) => [...xs, { score, findings }]))), [[]]);
  for (const decided of combos) {
    const own = decided.map((d, i) => result(council.members[i], d.score, d.findings));
    const alone = project(mergeCouncil(council, own));
    for (const s of SHADOW.filter(Boolean)) {
      n += 1;
      const onTime = project(mergeCouncil(council, [...own, result(shadow, s.score, s.findings)]));
      assert.deepEqual(onTime, alone, `on time: ${JSON.stringify({ decided, shadow: s })}`);
      const late = project(mergeCouncil(council, [...own, { member: shadow, status: 'late' }], { feedback: [result(shadow, s.score, s.findings)] }));
      assert.deepEqual(late, alone, `late: ${JSON.stringify({ decided, shadow: s })}`);
    }
  }
  return n;
}

test('a sole deciding member with a shadow: every combination decides as the member alone', () => {
  const council = { ...base, sole: false, shadow: 'sh', members: [member('verifier', true), member('sh', false)], intercom: { ...base.intercom, enabled: false } };
  assert.equal(check(council, 1), 18 * 5);
});

test('two deciding members with a shadow: every combination decides as the two alone', () => {
  const council = { ...base, sole: false, shadow: 'sh', members: [member('d1', true), member('d2', true), member('sh', false)], intercom: { ...base.intercom, enabled: false } };
  assert.equal(check(council, 2), 18 * 18 * 5);
});
