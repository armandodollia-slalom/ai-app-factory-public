// Council C6: a judge turned a ticket line the acceptance critic still rated partial into a follow-up and scored
// PASS 10/10; the gate then rated the ticket high confidence. The harness keeps open acceptance lines open.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { scoreRound } from '../lib/loop.mjs';
import { confidence, ticketSignals } from '../../review-gate/lib/confidence.mjs';
import { decideGate } from '../../review-gate/lib/gate.mjs';
import { needsDecision, ownerDecisionBlock } from '../../implement/lib/implement.mjs';

const lenses = ['acceptance', 'flow'];
const acc = { id: 'ACC-1-1', lens: 'acceptance', severity: 'major', title: 'No error page after sign-in', detail: '', requirement: 'Expected: lands on the home page; no error page is shown', status: 'open' };
const partialRow = { acceptance: { coverage: [{ ref: 'Expected: lands on the home page; no error page is shown', status: 'partial', evidence: '/ answers 404 in Production' }] } };

test('an acceptance line dismissed as a follow-up is an owner question, never a follow-up or a 10', () => {
  const r = scoreRound({ lenses, findings: [acc], rulings: [{ id: 'ACC-1-1', ruling: 'dismissed', questionKind: 'impossible', severity: 'minor', reason: 'the ticket asks for a page Production does not serve', followUp: 'Ask the owner what sign-in should land on' }], judgeLensScores: { acceptance: 10, flow: 10 }, coverage: partialRow });
  assert.deepEqual(r.followUps, []);
  assert.equal(r.questions.length, 1);
  assert.equal(r.lensScores.acceptance, 9);
  assert.ok(r.score < 10);
  const q = scoreRound({ lenses, findings: [acc], rulings: [{ id: 'ACC-1-1', ruling: 'dismissed', questionKind: 'impossible', question: 'Which page should sign-in land on in Production?' }], coverage: partialRow });
  assert.equal(q.questions[0].question, 'Which page should sign-in land on in Production?');
});

// Council C7 (Sol 2): #119's body kept "done … PASS 10/10" and the question as a follow-up after the check ended QUESTION.
test('the PR body states the decision, the ticket\'s current outcome and verdict, and drops the follow-up that became a question', async () => {
  const { withDecision } = await import('../lib/decision-body.mjs');
  const body = ['Implements BUG-34.', '', '| Story | Outcome | Orchestration | PR check |', '| --- | --- | --- | --- |', '| BUG-34 (#116): sign-in | done | self | PASS 10/10 |', '', '## Follow-ups (not in this PR)', '', '- Home page answers 404 (PR check before this PR FLOW-1-1: withdrawn)', '- Confirm with the owner (PR check ACC-1-1: the code meets it)', ''].join('\n');
  const next = withDecision(body, { keys: ['BUG-34'], outcome: 'needs-decision', reason: 'needs an owner decision: No error page', issues: [116], prCheck: 'QUESTION 9/10', dropIds: ['ACC-1-1'] });
  assert.match(next, /^<!-- pipeline-decision:start -->\n> \*\*Needs a person's decision: not delivered\.\*\* BUG-34: needs an owner decision: No error page\. The options are on the ticket \(#116\)/);
  assert.match(next, /\| BUG-34 \(#116\): sign-in \| needs-decision \| self \| QUESTION 9\/10 \|/);
  assert.doesNotMatch(next, /PASS 10\/10|Confirm with the owner/);
  assert.match(next, /Home page answers 404/);
  assert.equal(withDecision(next, { keys: ['BUG-34'], outcome: 'needs-decision', reason: 'needs an owner decision: No error page', issues: [116], prCheck: 'QUESTION 9/10', dropIds: ['ACC-1-1'] }), next, 'idempotent');
});

test('an open acceptance line with no upheld finding and no question is upheld by the harness, with a real title', () => {
  const r = scoreRound({ lenses, findings: [acc], rulings: [{ id: 'ACC-1-1', ruling: 'dismissed', reason: 'out of scope' }], coverage: partialRow });
  assert.equal(r.upheld.length, 1);
  assert.equal(r.upheld[0].raisedBy, 'harness');
  assert.match(r.upheld[0].title, /^Criterion not met: Expected: lands on the home page/);
  assert.equal(r.lensScores.acceptance, 8);
  const met = scoreRound({ lenses, findings: [], rulings: [], coverage: { acceptance: { coverage: [{ ref: 'x', status: 'met' }] } } });
  assert.equal(met.score, 10);
  const gap = scoreRound({ lenses, findings: [], rulings: [{ id: 'flow-coverage-1', ruling: 'upheld', severity: 'minor', reason: 'The retry path is never exercised. More text.' }] });
  assert.equal(gap.upheld[0].title, 'Coverage gap: The retry path is never exercised.');
  const other = scoreRound({ lenses, findings: [{ ...acc, id: 'FLOW-1-1', lens: 'flow' }], rulings: [{ id: 'FLOW-1-1', ruling: 'dismissed', followUp: 'Log levels' }] });
  assert.equal(other.followUps.length, 1, 'a finding outside the ticket lines can still be a follow-up');
});

test('a question makes the ticket not high confidence, and the gate never auto-merges it, even when Low', () => {
  const prChecks = [{ ts: '1', story: 'BUG-1', score: 10 }, { ts: '2', story: 'BUG-1', score: 9, questions: [{ id: 'ACC-1-1', title: 't', question: 'Which landing page?' }] }];
  const s = ticketSignals('BUG-1', { prChecks }, { ci: 'success', agent: 100 });
  const c = confidence(s);
  assert.equal(c.high, false);
  assert.match(c.reasons[0], /needs an owner decision: Which landing page\?/);
  const a = { tickets: [{ key: 'BUG-1', severity: { level: 'Low' }, confidence: c }], severity: { level: 'Low' }, ci: 'success', class: 'bug' };
  const d = decideGate(a, { settings: { approvals: { bug: { Low: 0, Medium: 1, High: 1, Severe: 1 } } }, autoMerge: { enabled: true } });
  assert.notEqual(d.action, 'auto-merge');
  assert.match(d.triggers.join(' '), /BUG-1 needs an owner decision/);
});

test('the PR body states the owner decision first; the ticket is not done', () => {
  const qs = [{ id: 'ACC-1-1', title: 'No error page after sign-in', question: 'Which page should sign-in land on?' }];
  assert.match(ownerDecisionBlock(qs), /^> \*\*Needs an owner decision\.\*\*/);
  assert.equal(ownerDecisionBlock([]), '');
  const nd = needsDecision(qs);
  assert.equal(nd.outcome, 'needs-decision');
  assert.deepEqual(nd.findings.map((f) => f.severity), ['question']);
});

// Council C7 (Sol 1): each open line is reconciled on its own; a finding or question about another line never covers it.
const rows = { acceptance: { coverage: [{ ref: 'AC 1: a valid coupon gives 10% off', status: 'partial' }, { ref: 'AC 2: an expired coupon is rejected with 400', status: 'unmet' }] } };
const f1 = { id: 'ACC-1-1', lens: 'acceptance', severity: 'major', title: 'Discount uses the net price', requirement: 'AC 1: a valid coupon gives 10% off', status: 'open' };
const f2 = { id: 'ACC-1-2', lens: 'acceptance', severity: 'minor', title: 'Test case label is imprecise', requirement: 'AC 1', status: 'open' };

test('per line: an upheld finding on one open line does not cover another open line', () => {
  const r = scoreRound({ lenses, findings: [f1], rulings: [{ id: 'ACC-1-1', ruling: 'upheld', severity: 'major' }], coverage: rows });
  assert.deepEqual(r.upheld.map((f) => f.id), ['ACC-1-1', 'acceptance-criterion-2']);
  assert.ok(r.upheld.every((f) => f.criterion));
});

test('per line: a question on one line and a separate unmet line: the question stands and the unmet line is upheld', () => {
  const r = scoreRound({ lenses, findings: [f1], rulings: [{ id: 'ACC-1-1', ruling: 'dismissed', questionKind: 'two-readings', question: 'Net or gross?' }], coverage: rows });
  assert.deepEqual(r.questions.map((q) => q.id), ['ACC-1-1']);
  assert.deepEqual(r.upheld.map((f) => [f.id, f.severity]), [['acceptance-criterion-2', 'major']]);
  assert.equal(r.lensScores.acceptance, 8);
});

test('per line: a minor finding on an open line is raised to major; a minor on a met line is not', () => {
  const r = scoreRound({ lenses, findings: [f2], rulings: [{ id: 'ACC-1-2', ruling: 'upheld', severity: 'minor' }], coverage: rows });
  assert.deepEqual(r.upheld.map((f) => [f.id, f.severity]), [['ACC-1-2', 'major'], ['acceptance-criterion-2', 'major']]);
  const met = { acceptance: { coverage: rows.acceptance.coverage.map((c) => ({ ...c, status: 'met' })) } };
  const m = scoreRound({ lenses, findings: [f2], rulings: [{ id: 'ACC-1-2', ruling: 'upheld', severity: 'minor' }], coverage: met });
  assert.deepEqual(m.upheld.map((f) => [f.id, f.severity, Boolean(f.criterion)]), [['ACC-1-2', 'minor', false]]);
  assert.equal(m.score, 9);
});

test('per line: a critic that rated no line cannot score 10; a failed critic scores 0', () => {
  const r = scoreRound({ lenses, findings: [], rulings: [], coverage: { acceptance: { coverage: [] } } });
  assert.equal(r.upheld[0].id, 'acceptance-criterion-0');
  assert.equal(r.score, 8);
  assert.equal(scoreRound({ lenses, findings: [], rulings: [], failedLenses: ['acceptance'], coverage: {} }).score, 0);
});

test('addressesRow: the quoted line, AC labels, or most of the line\'s words', async () => {
  const { addressesRow } = await import('../lib/loop.mjs');
  const row = { ref: 'AC 2: an expired coupon is rejected with 400' };
  assert.ok(addressesRow(row, { requirement: 'AC 2: an expired coupon is rejected with 400' }));
  assert.ok(addressesRow(row, { requirement: 'AC2' }));
  assert.ok(!addressesRow(row, { requirement: 'AC 1', title: 'expired coupon rejected with 400' }), 'a different AC label never matches');
  assert.ok(addressesRow({ ref: 'Expected: an expired coupon is rejected with 400' }, { title: 'Expired coupon is not rejected', detail: 'answers 200 instead of 400' }));
  assert.ok(!addressesRow({ ref: 'Expected: an expired coupon is rejected with 400' }, { title: 'Test case label is imprecise' }));
});

// Council C7 live (#119 re-check on 0.2.53): the question on the Expected lines left the umbrella row "Then the result
// matches Expected" to the harness, a duplicate major that in fix mode sends the fixer at a contradiction.
test('the umbrella row is covered while another open line is reconciled on its own; alone, it is upheld', () => {
  const real = { acceptance: { coverage: [
    { ref: 'Alice is signed in', status: 'met' },
    { ref: "and lands on Identity.API's home page.", status: 'partial' },
    { ref: "The other site's address is never followed.", status: 'met' },
    { ref: 'No error page is shown.', status: 'partial' },
    { ref: 'Given the test stack is running When the steps above are repeated Then the result matches Expected', status: 'partial' },
  ] } };
  const q = { id: 'ACC-1-1', lens: 'acceptance', severity: 'major', status: 'open', title: "Owner question: the redirect lands on an empty 404 at '/', which may not meet 'No error page is shown'", requirement: "lands on Identity.API's home page. No error page is shown." };
  const r = scoreRound({ lenses, findings: [q], rulings: [{ id: 'ACC-1-1', ruling: 'dismissed', questionKind: 'impossible', question: 'Does an empty 404 at / meet the home page line?' }], coverage: real });
  assert.deepEqual(r.upheld, [], JSON.stringify(r.upheld.map((f) => f.id)));
  assert.equal(r.questions.length, 1);
  // An open Expected line nothing addresses is still upheld on its own; the umbrella adds nothing.
  const none = scoreRound({ lenses, findings: [], rulings: [], coverage: real });
  assert.deepEqual(none.upheld.map((f) => f.id), ['acceptance-criterion-2', 'acceptance-criterion-4']);
  // The umbrella alone open: upheld.
  const alone = { acceptance: { coverage: real.acceptance.coverage.map((c) => (c.ref.startsWith('Given') ? c : { ...c, status: 'met' })) } };
  assert.deepEqual(scoreRound({ lenses, findings: [], rulings: [], coverage: alone }).upheld.map((f) => f.id), ['acceptance-criterion-5']);
});

test('a re-check of an open PR rewrites the verdict its body states (table column and PR check line)', async () => {
  const { withCheckVerdict } = await import('../lib/decision-body.mjs');
  const group = '| Story | Outcome | Orchestration | PR check |\n| --- | --- | --- | --- |\n| BUG-37 (#127): x | done | self | PASS 10/10 |\n';
  assert.match(withCheckVerdict(group, { keys: ['BUG-37'], verdict: 'ACCEPTED', score: 9 }), /\| BUG-37 \(#127\): x \| done \| self \| ACCEPTED 9\/10 \|/);
  const single = 'Implements BUG-38.\n\n- PR check (fix mode, before this PR: …): PASS 10/10\n- Test stack: leased\n';
  const next = withCheckVerdict(single, { keys: ['BUG-38'], verdict: 'ACCEPTED', score: 9, openFindings: [{ severity: 'minor', lens: 'style', title: 'nit' }], when: '2026-11-15' });
  assert.match(next, /- PR check \(latest full check of this PR, 2026-11-15\): ACCEPTED 9\/10, open findings:\n {2}- minor \[style\] nit\n- Test stack: leased/);
  assert.equal(withCheckVerdict(next, { keys: ['BUG-38'], verdict: 'ACCEPTED', score: 9, openFindings: [{ severity: 'minor', lens: 'style', title: 'nit' }], when: '2026-11-15' }), next, 'idempotent');
});

// Council C9 (#196): the check after a CI fixing round judged the fix only, scored style 10 while a style finding of the
// full check (a redundant using) was still in the code, and its "PASS 10/10" replaced the full check's ACCEPTED 9/10.
test('a check after a CI fixing round gets its own line and never replaces the full check\'s verdict', async () => {
  const { withScopedCheck } = await import('../lib/decision-body.mjs');
  const body = ['Implements CANC-1.', '', '- PR check (fix mode, before this PR: the report round scored 6/10 with 7 finding(s) to fix, then 2 fixing round(s) and 2 fix commit(s)): ACCEPTED 9/10, open findings:', '  - minor [style] Redundant using System.Threading', '- Whole test projects run before this PR, as CI runs them:', '  - `tests/Ordering.FunctionalTests`: passed', '## Follow-ups (not in this PR)', '- Redundant `using System.Threading;` (PR check before this PR STY-3-1, style, minor: not fixed in this PR)'].join('\n');
  const next = withScopedCheck(body, { verdict: 'PASS', score: 10, ids: ['CI-1'], when: '2026-11-16', head: 'cec4a604833b' });
  assert.match(next, /: ACCEPTED 9\/10, open findings:\n {2}- minor \[style\] Redundant using System.Threading\n- Check after the CI fixing round \(2026-11-16, head cec4a60\): PASS 10\/10 on the fix for CI-1 only\. It does not replace the full check above/);
  assert.match(next, /Whole test projects run before this PR, as CI runs them \(CI then failed on the PR; see "Changed by the PR check"\):/);
  assert.match(next, /STY-3-1, style, minor: not fixed in this PR/, 'the full check\'s open finding stays listed');
  const again = withScopedCheck(next, { verdict: 'PASS', score: 10, ids: ['CI-1'], when: '2026-11-17', head: 'abc1234' });
  assert.equal(again.match(/Check after the CI fixing round/g).length, 1, 'one scoped line, the latest');
  assert.equal(again.match(/CI then failed on the PR/g).length, 1);
});

// Owner, dogfood C15: "The implementation did something the ticket did not ask for" is not a question (BUG-46's 9999 limit).
test('a question that names no ticket ambiguity, contradiction or second reading is an upheld acceptance finding', () => {
  const limit = { ...acc, title: 'Quantities above 9999 are now refused' };
  const r = scoreRound({ lenses, findings: [limit], rulings: [{ id: 'ACC-1-1', ruling: 'dismissed', severity: 'minor', reason: 'a judgement call', question: 'Is a 9999 per-item limit acceptable?' }], judgeLensScores: { acceptance: 10, flow: 10 }, coverage: partialRow });
  assert.deepEqual(r.questions, []);
  const up = r.upheld.find((f) => f.id === 'ACC-1-1');
  assert.equal(up.severity, 'major');
  assert.equal(up.raisedBy, 'harness');
  assert.match(up.reason, /Not a question for the owner .* the ticket is the answer\. Is a 9999/);
  for (const kind of ['ambiguous', 'contradiction', 'two-readings', 'impossible']) {
    const q = scoreRound({ lenses, findings: [acc], rulings: [{ id: 'ACC-1-1', ruling: 'dismissed', questionKind: kind, question: 'Which reading?' }], coverage: partialRow });
    assert.equal(q.questions[0].kind, kind);
  }
});
