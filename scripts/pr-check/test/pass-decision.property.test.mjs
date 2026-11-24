// Council r4 (sol-01): the PR check's one pass decision (scoreRound, then decidePass), against the rule written out
// independently, for every combination of the judge's overall score (valid, out of range, unreadable, missing), its
// lens scores (given, missing, invalid, for a lens that is not the round's), a failed critic, an upheld finding and an
// open question, and whether the overall score caps the round (not when the CI wait took rulings out of it); for the
// one-seat panel and for a three-member council. The lens scores the round reports are checked too.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decidePass, scoreRound } from '../lib/loop.mjs';

const PASS = 9.5;
const config = { prCheck: { councilPassScore: PASS } };
const CAP = { minor: 9, major: 8 };
const OVERALL = [10, 9.6, 9.5, 9.4, 0, '9.7', 11, -1, 'x', null, 'no verdict'];
const LENS_A = ['missing', 10, 9.4, 11, 'n/a', null];
const LENS_B = ['missing', 10, 9.4];
const valid = (v) => (typeof v === 'number' || (typeof v === 'string' && v.trim() !== '')) && Number.isFinite(Number(v)) && Number(v) >= 0 && Number(v) <= 10;

// The rule: judged only with a verdict whose overall score is valid and whose lens scores for the round's lenses are
// valid; each lens is the judge's score for it, else the overall, capped by its upheld findings (a failed critic is 0);
// pass when judged, no critic failed, the lowest lens and the overall reach the pass score, nothing non-minor is upheld
// and no owner question is open.
const severity = (c) => (c.upheld === 'excused' ? 'major' : c.upheld);
const cap = (c) => ({ A: c.upheld ? CAP[severity(c)] : 10, B: 10 });
// Council r5 (sol-01): lens A is "lifted" when the council excused its finding or the CI wait took its ruling out
// (`caps` false: in these cases A's ruling is the one removed). A lifted lens the judge left out takes its cap; every
// other lens the judge left out takes the overall score, in every path. The overall score caps the round only when no
// lens is lifted and nothing was taken out.
const lifted = (c, l) => l === 'A' && (c.upheld === 'excused' || !c.caps);
const counts = (c) => c.caps && c.upheld !== 'excused';
const lensValue = (c, l) => {
  const given = c.overall === 'no verdict' ? 'missing' : { A: c.a, B: c.b }[l];
  if (c.failed === l) return 0;
  if (!c.caps && l === 'A') return cap(c)[l];
  const usable = valid(given) ? Number(given) : !lifted(c, l) && valid(c.overall) ? Number(c.overall) : null;
  return Math.min(cap(c)[l], usable ?? cap(c)[l]);
};
const judgedOk = (c) => c.overall !== 'no verdict' && valid(c.overall) && [c.a, c.b].every((v) => v === 'missing' || v === null || valid(v));
// The panel knows no excusal: any non-minor upheld finding holds it.
function expected(c) {
  if (!judgedOk(c)) return false;
  return !c.failed && Math.min(lensValue(c, 'A'), lensValue(c, 'B'), counts(c) ? Number(c.overall) : 10) >= PASS && !['major', 'excused'].includes(c.upheld) && !c.question;
}
// A council: a lens whose upheld findings were all excused counts as 10; an excused finding never blocks. The score it
// reports is that same lowest effective score.
const councilScore = (c) => Math.min(c.upheld === 'excused' && c.failed !== 'A' ? 10 : lensValue(c, 'A'), lensValue(c, 'B'), counts(c) && valid(c.overall) ? Number(c.overall) : 10);
function expectedCouncil(c) {
  if (!judgedOk(c)) return false;
  return !c.failed && councilScore(c) >= PASS && c.upheld !== 'major' && !c.question;
}

function* cases() {
  for (const overall of OVERALL) for (const a of LENS_A) for (const b of LENS_B) for (const extra of [false, true]) for (const caps of [true, false]) {
    for (const failed of [null, 'B']) for (const upheld of [null, 'minor', 'major', 'excused']) for (const question of [false, true]) yield { overall, a, b, extra, caps, failed, upheld, question };
  }
}

function scored(c) {
  const judgeLensScores = { ...(c.a === 'missing' ? {} : { A: c.a }), ...(c.b === 'missing' ? {} : { B: c.b }), ...(c.extra ? { typo: 3 } : {}) };
  const findings = c.upheld ? [{ id: 'A-1-1', lens: 'A', severity: severity(c), status: 'open', title: 't', detail: '', evidence: '', requirement: '', fix: 'f', thread: [], ...(c.upheld === 'excused' ? { notUpheld: 'outvoted' } : {}) }] : [];
  const rulings = c.upheld ? [{ id: 'A-1-1', ruling: 'upheld', severity: severity(c) }] : [];
  const verdict = c.overall !== 'no verdict';
  const r = scoreRound({ lenses: ['A', 'B'], findings, rulings, judgeLensScores: verdict ? judgeLensScores : {}, judgeScore: verdict ? c.overall : null, overallCaps: c.caps, filteredLenses: c.caps ? [] : ['A'], judged: verdict, failedLenses: c.failed ? [c.failed] : [], acceptanceLenses: [] });
  return { ...r, failedLenses: c.failed ? [c.failed] : [], questions: c.question ? [{ id: 'Q-1' }] : [] };
}

test('every combination of judge scores, failed critics, upheld findings and questions: the panel passes exactly when the rule says', () => {
  let n = 0;
  for (const c of cases()) {
    n += 1;
    const r = scored(c);
    assert.deepEqual(r.lensScores, { A: lensValue(c, 'A'), B: lensValue(c, 'B') }, JSON.stringify(c));
    assert.equal(decidePass(config, null, r).pass, expected(c), JSON.stringify(c));
  }
  assert.equal(n, 12672);
});

test('every combination: a three-member council (every lens a blocking member) passes exactly when the rule says', () => {
  const member = (name) => ({ name, blocking: true });
  const ctx = { councilLenses: { A: { member: member('A') }, B: { member: member('B') } } };
  for (const c of cases()) {
    const r = scored(c);
    const d = decidePass(config, ctx, r, { merged: {}, failedLenses: r.failedLenses });
    assert.equal(d.pass, expectedCouncil(c), JSON.stringify(c));
    if (judgedOk(c)) assert.equal(d.score, councilScore(c), `score: ${JSON.stringify(c)}`);
  }
});

// Council r5 (sol-01): sol's exact case. At 9.5, lenses opus and acceptance, overall 9.4, only opus scored (10), a major
// finding on opus upheld by the judge but excused by the council: acceptance takes 9.4, so the round does not pass, and
// the score shown is the one decided.
test('sol r5: an excused finding on one lens never turns another, unscored lens into a 10', () => {
  const findings = [{ id: 'OPUS-1-1', lens: 'opus', severity: 'major', notUpheld: 'outvoted', status: 'open', title: 't', detail: '', evidence: '', requirement: '', fix: 'f', thread: [] }];
  const r = scoreRound({ lenses: ['opus', 'acceptance'], findings, rulings: [{ id: 'OPUS-1-1', ruling: 'upheld', severity: 'major' }], judgeLensScores: { opus: 10 }, judgeScore: 9.4, acceptanceLenses: [] });
  const ctx = { councilLenses: { opus: { member: { name: 'opus', blocking: true } }, acceptance: { member: { name: 'acceptance', blocking: true } } } };
  assert.equal(r.lensScores.acceptance, 9.4);
  assert.deepEqual(decidePass(config, ctx, { ...r, failedLenses: [] }, { merged: {}, failedLenses: [] }), { score: 9.4, pass: false });
  // The CI path: the CI wait took the opus ruling out; acceptance, unscored, still takes the overall score.
  const ci = scoreRound({ lenses: ['opus', 'acceptance'], findings: [], rulings: [], judgeLensScores: { opus: 10 }, judgeScore: 9.4, overallCaps: false, filteredLenses: ['opus'], acceptanceLenses: [] });
  assert.deepEqual([ci.lensScores.acceptance, decidePass(config, null, { ...ci, failedLenses: [] }).pass], [9.4, false]);
});
