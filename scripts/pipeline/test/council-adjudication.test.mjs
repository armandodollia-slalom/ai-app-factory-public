// A scope objection on lines a fixer declared for an earlier upheld finding is never settled by the harness alone
// (council C11 and C12, Sol 1: a sealed declaration proves the fixer wrote the line, not that the remedy needed it). It
// stands unless every blocking member, asked fresh and read-only "does the agreed fix of <finding> require this
// behaviour?", answers yes with evidence (council.mjs adjudicate). Everything here goes through the real councilMemory,
// mergeCouncil and adjudicate; the members' answers are scripted. The attack list in STATUS.md (C23) maps to these tests.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { adjudicate, adjudicationTask, councilMemory, fixesFile, memoryFile, mergeCouncil, nameFindings } from '../lib/council.mjs';

const STATE = '.factory/state';
const OPUS = { name: 'opus', cli: 'claude', model: 'opus', lens: 'acceptance', blocking: true };
const SOL = { name: 'sol', cli: 'codex', model: 'sol', lens: 'correctness', blocking: true };
const COUNCIL = { stage: 'review', rounds: 3, passScore: 9, blockOn: 'any', onUnavailable: 'fail', members: [OPUS, SOL] };
const FILE = 'src/Ordering.API/Service.cs';
const LINES = 40;
const base = (extra = {}) => Array.from({ length: LINES }, (_, i) => extra[i + 1] ?? `        var step${i + 1} = Compute(${i + 1}, input);`).join('\n') + '\n';
const PARSE = '        if (!decimal.TryParse(raw, out var price)) throw new RpcException(new Status(StatusCode.InvalidArgument, "bad price"));';
const LIMIT = '        if (quantity > 9999) throw new ArgumentOutOfRangeException(nameof(quantity));';
const PRICE = { id: 'PRICE', severity: 'blocking', action: 'fix', lens: 'correctness', file: FILE, line: 1, text: 'Malformed price crashes parsing', fix: 'Validate the price and return InvalidArgument for malformed input.' };

function repo() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'council-adjudication-')));
  const git = (...a) => spawnSync('git', a, { cwd: dir, encoding: 'utf8' });
  const write = (rel, text) => (fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }), fs.writeFileSync(path.join(dir, rel), text));
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 'T');
  write('.gitignore', '.factory/state/\n');
  write(FILE, base());
  git('add', '-A');
  git('commit', '-qm', 'implementation');
  return { dir, write };
}
// Round 1 upheld `finding`; the fixer writes `after` and declares `hunks` for it; round 2's memory.
function sitting({ after, hunks, finding = PRICE }) {
  const r = repo();
  const file = memoryFile(r.dir, STATE, { stage: 'review', story: 'S-1' });
  const fixes = fixesFile(r.dir, STATE, { stage: 'review', story: 'S-1' });
  councilMemory({ file, cwd: r.dir, round: 1, fixes }).remember([finding]);
  r.write(FILE, base(after));
  fs.mkdirSync(path.dirname(fixes), { recursive: true });
  fs.writeFileSync(fixes, JSON.stringify({ fixes: [{ id: finding.id, hunks }] }));
  return { ...r, file, fixes, memory: councilMemory({ file, cwd: r.dir, round: 2, fixes }) };
}
// Sol objects (scope) at each line; opus approves.
const objections = (...at) => [
  { member: OPUS, status: 'ok', score: 9, findings: [] },
  { member: SOL, status: 'ok', score: 6, findings: at.map(([line, text, fix], i) => ({ id: `sol-${i + 1}`, severity: 'blocking', action: 'fix', lens: 'correctness', kind: 'scope', file: FILE, line, text, fix, evidence: `${FILE}:${line}`, member: 'sol' })) },
];
const LIMIT_OBJECTION = [2, 'Adds a 9999 quantity limit no ticket line asks for', 'Remove the unauthorized 9999 limit.'];
const items = (task) => [...task.matchAll(/^## Item \d+: `([^`]+)`/gm)].map((m) => m[1]);
const reply = (answers) => ({ status: 0, output: `AGENT_RESULT: ${JSON.stringify({ answers })}` });
const EVIDENCE = 'src/Ordering.API/Service.cs:1: the agreed fix asks for exactly this InvalidArgument check';
// Scripted members: `script[name](task, keys)` returns the member's answer list (or a raw result); the asked tasks are kept.
function members(script) {
  const asked = {};
  const run = async (m, task) => {
    (asked[m.name] ??= []).push(task);
    const s = script[m.name];
    if (!s) return { status: 0, output: 'no result' };
    const a = s(task, items(task));
    return Array.isArray(a) ? reply(a) : a;
  };
  return { run, asked };
}
const all = (answer, evidence = EVIDENCE) => (task, keys) => keys.map((key) => ({ key, answer, evidence }));
const settle = (results, memory, script, council = COUNCIL, extra = {}) => {
  const m = members(script);
  return adjudicate({ council, merged: mergeCouncil(council, results, { earlier: memory }), remerge: (adjudications) => mergeCouncil(council, results, { earlier: memory, adjudications }), run: m.run, stage: 'review', story: 'S-1', round: 2, log: () => {}, ...extra }).then((merged) => ({ merged, asked: m.asked }));
};
const counterexample = () => sitting({ after: { 1: PARSE, 2: LIMIT }, hunks: [{ file: FILE, start: 1, end: 2 }] });

test('the reviewer\'s same-file counterexample (PRICE, 9999 limit): the harness alone never settles it (v0.2.83 passed it)', () => {
  const s = counterexample();
  const m = mergeCouncil(COUNCIL, objections(LIMIT_OBJECTION), { earlier: s.memory });
  assert.equal(m.pass, false, 'v0.2.83: {"pass":true,"sanctionedBy":["PRICE"]}');
  assert.equal(m.earlierRound.length, 0);
  assert.equal(m.adjudicate.length, 1, 'a candidate for adjudication, standing until it is held');
  assert.equal(m.adjudicate[0].finding.id, 'PRICE');
  assert.ok(m.adjudicate[0].declared.lines.some((l) => l.includes('9999')), 'the members see the declared lines');
});

test('attack 1, over-attribution: the members say the remedy does not need the limit, and it stands with an instruction', async () => {
  const { merged, asked } = await settle(objections(LIMIT_OBJECTION), counterexample().memory, { opus: all('no', 'the agreed fix validates the price; it says nothing about quantity'), sol: all('no', 'a quantity cap is not price validation') });
  assert.equal(merged.pass, false);
  const f = merged.findings.find((x) => x.line === 2);
  assert.equal(f.adjudication.outcome, 'stands');
  assert.deepEqual(f.adjudication.rejectedBy, ['opus', 'sol']);
  assert.match(f.fix, /Take out that behaviour \(Remove the unauthorized 9999 limit\.\), and keep the change that carries out PRICE's agreed fix: Validate the price/);
  // Each blocking member was asked once, fresh, with the earlier finding, its fix, the declared hunk and the objection.
  for (const n of ['opus', 'sol']) {
    assert.equal(asked[n].length, 1);
    assert.match(asked[n][0], /Earlier finding `PRICE`[\s\S]*Its agreed fix: Validate the price[\s\S]*9999[\s\S]*The objection, at src\/Ordering\.API\/Service\.cs:2/);
  }
});

test('attack 2, an unrelated change on the line next to a legitimate fix: the fix is covered, the neighbour stands', async () => {
  const s = counterexample();
  // Two objections in one sitting, one per line: the members accept the price check and reject the limit.
  const results = objections([1, 'Answers InvalidArgument, an error no ticket line names', 'Remove it.'], LIMIT_OBJECTION);
  // Items are asked in the merge's order (line 1, then line 2) under short labels.
  const byLine = (task, keys) => [{ key: keys[0], answer: 'yes', evidence: EVIDENCE }, { key: keys[1], answer: 'no', evidence: 'the limit is about quantity' }];
  const { merged } = await settle(results, s.memory, { opus: byLine, sol: byLine });
  assert.deepEqual(merged.adjudicated.map((a) => [a.line, a.outcome]).sort(), [[1, 'covered'], [2, 'stands']]);
  assert.equal(merged.pass, false);
  assert.deepEqual(merged.findings.map((f) => f.line), [2]);
  assert.deepEqual(merged.earlierRound.map((e) => [e.line, e.earlier[0], e.acceptedBy.join('+')]), [[1, 'PRICE', 'opus+sol']]);
});

test('attack 3, a declaration covering more than the remedy needs: the extra lines are judged one objection at a time', async () => {
  const s = sitting({ after: { 10: PARSE, 11: '        _cache.Set(raw, price, TimeSpan.FromMinutes(5));', 12: '        _log.LogInformation("price {Price} parsed", price);' }, hunks: [{ file: FILE, start: 10, end: 12 }] });
  const { merged } = await settle(objections([11, 'Adds a price cache no ticket line asks for', 'Remove the cache.']), s.memory, { opus: all('no', 'caching is not validation'), sol: all('no', 'caching is not validation') });
  assert.equal(merged.pass, false);
  assert.match(merged.findings[0].fix, /Take out that behaviour \(Remove the cache\.\), and keep the change that carries out PRICE's agreed fix/);
});

test('a correct declaration accepted by every blocking member: a note crediting that one finding, with who accepted it', async () => {
  const s = sitting({ after: { 1: PARSE }, hunks: [{ file: FILE, start: 1, end: 1 }] });
  const { merged } = await settle(objections([1, 'Answers InvalidArgument, an error no ticket line names', 'Remove it.']), s.memory, { opus: all('yes'), sol: all('yes') });
  assert.equal(merged.pass, true, JSON.stringify(merged.findings));
  assert.deepEqual(merged.notes[0].sanctionedBy, ['PRICE']);
  assert.deepEqual(merged.adjudication.items[0].acceptedBy, ['opus', 'sol']);
  assert.match(merged.notes[0].notUpheld, /every blocking member \(opus, sol\) accepted, on adjudication/);
});

test('a split vote, and attack 4, one yes from the member that raised nothing: the objection stands', async () => {
  const s = sitting({ after: { 1: PARSE }, hunks: [{ file: FILE, start: 1, end: 1 }] });
  const { merged } = await settle(objections([1, 'Answers an error no ticket line names', 'Remove it.']), s.memory, { opus: all('yes'), sol: all('no', 'the fix could log instead') });
  assert.equal(merged.pass, false);
  assert.deepEqual(merged.adjudicated[0].acceptedBy, ['opus']);
  assert.deepEqual(merged.adjudicated[0].rejectedBy, ['sol']);
  assert.match(merged.findings[0].fix, /\(sol said no\)/);
});

test('a missing answer, and attack 5, an unavailable or unparsable member: the objection stands', async () => {
  const s = sitting({ after: { 1: PARSE }, hunks: [{ file: FILE, start: 1, end: 1 }] });
  const obj = objections([1, 'Answers an error no ticket line names', 'Remove it.']);
  const none = await settle(obj, s.memory, { opus: all('yes') });
  assert.equal(none.merged.pass, false);
  assert.deepEqual(none.merged.adjudicated[0].missing, ['sol']);
  const gone = await settle(obj, s.memory, { opus: all('yes'), sol: () => ({ status: 1, output: '', unavailable: true, error: "You've hit your usage limit" }) });
  assert.equal(gone.merged.pass, false);
  assert.ok(gone.merged.adjudicated[0].missing.includes('sol') || gone.merged.adjudicated[0].ambiguous.includes('sol'));
});

test('attack 6, answers that are not a clear yes with evidence: no evidence, hedged words, the template echoed, two answers', async () => {
  const s = sitting({ after: { 1: PARSE }, hunks: [{ file: FILE, start: 1, end: 1 }] });
  const obj = objections([1, 'Answers an error no ticket line names', 'Remove it.']);
  const cases = {
    'no evidence': (t, keys) => keys.map((key) => ({ key, answer: 'yes', evidence: '' })),
    hedged: (t, keys) => keys.map((key) => ({ key, answer: 'Yes, mostly', evidence: EVIDENCE })),
    'template echoed': (t, keys) => keys.map((key) => ({ key, answer: 'yes|no', evidence: EVIDENCE })),
    'two answers': (t, keys) => keys.flatMap((key) => [{ key, answer: 'yes', evidence: EVIDENCE }, { key, answer: 'no', evidence: EVIDENCE }]),
  };
  for (const [name, sol] of Object.entries(cases)) {
    const { merged } = await settle(obj, s.memory, { opus: all('yes'), sol });
    assert.equal(merged.pass, false, name);
    assert.deepEqual(merged.adjudicated[0].ambiguous, ['sol'], name);
  }
});

test('attack 7, an answer for another key or another item does not cover this objection', async () => {
  const s = counterexample();
  const results = objections([1, 'Answers an error no ticket line names', 'Remove it.'], LIMIT_OBJECTION);
  // Each member answers yes, but only for the first item (and once under a made-up key).
  const first = (t, keys) => [{ key: keys[0], answer: 'yes', evidence: EVIDENCE }, { key: 'I9', answer: 'yes', evidence: EVIDENCE }, { key: `${FILE}:2|made-up`, answer: 'yes', evidence: EVIDENCE }];
  const { merged } = await settle(results, s.memory, { opus: first, sol: first });
  assert.deepEqual(merged.adjudicated.map((a) => [a.line, a.outcome]).sort(), [[1, 'covered'], [2, 'stands']]);
  assert.deepEqual(merged.adjudicated.find((a) => a.line === 2).missing, ['opus', 'sol']);
});

test('attack 8, a non-blocking member is never asked, and its yes cannot outweigh a blocking no', async () => {
  const s = sitting({ after: { 1: PARSE }, hunks: [{ file: FILE, start: 1, end: 1 }] });
  const helper = { name: 'helper', cli: 'claude', model: 'haiku', lens: 'style', blocking: false };
  const council = { ...COUNCIL, members: [OPUS, SOL, helper] };
  const results = [...objections([1, 'Answers an error no ticket line names', 'Remove it.']), { member: helper, status: 'ok', score: 10, findings: [] }];
  const { merged, asked } = await settle(results, s.memory, { opus: all('yes'), sol: all('no', 'not required'), helper: all('yes') }, council);
  assert.equal(merged.pass, false);
  assert.equal(asked.helper, undefined);
});

test('attack 9, a member that changes the tree while adjudicating: every answer is void and the objection stands', async () => {
  const s = sitting({ after: { 1: PARSE }, hunks: [{ file: FILE, start: 1, end: 1 }] });
  const writer = (t, keys) => (fs.writeFileSync(path.join(s.dir, 'planted.txt'), 'x'), keys.map((key) => ({ key, answer: 'yes', evidence: EVIDENCE })));
  const { merged } = await settle(objections([1, 'Answers an error no ticket line names', 'Remove it.']), s.memory, { opus: writer, sol: all('yes') }, COUNCIL, { readOnly: { cwd: s.dir, exclude: [STATE] } });
  assert.equal(merged.pass, false);
  assert.deepEqual(merged.adjudicated[0].missing, ['opus', 'sol']);
});

test('attack 10, "fix: none required" cannot hide a request: a scope objection or a second member asking for a change keeps it', () => {
  const r = repo();
  r.write(FILE, base({ 5: LIMIT }));
  const one = (fix, text = 'Adds a 9999 quantity limit no ticket line asks for', kind = 'scope') => [{ member: OPUS, status: 'ok', score: 9, findings: [] }, { member: SOL, status: 'ok', score: 6, findings: [{ id: 's1', severity: 'blocking', action: 'fix', lens: 'correctness', kind, file: FILE, line: 5, text, fix, evidence: `${FILE}:5`, member: 'sol' }] }];
  // A scope objection whose fix says "none required" is still a request to take the behaviour out: it stands, with an instruction.
  const scope = mergeCouncil(COUNCIL, one('None required.'));
  assert.equal(scope.pass, false);
  assert.match(scope.findings[0].fix, /Take out the behaviour at src\/Ordering\.API\/Service\.cs:5 that no ticket line asks for/);
  // "None required" followed by a request is a request.
  assert.equal(mergeCouncil(COUNCIL, one('None required; remove the limit.', 'The cap rejects valid bulk orders', '')).pass, false);
  // Two members on one defect: one says none required, the other asks for a change: it stands.
  const cluster = [
    { member: OPUS, status: 'ok', score: 6, findings: [{ id: 'o1', severity: 'blocking', action: 'fix', lens: 'acceptance', file: FILE, line: 5, text: 'The cap rejects valid bulk orders', fix: 'None required.', evidence: `${FILE}:5`, member: 'opus' }] },
    { member: SOL, status: 'ok', score: 6, findings: [{ id: 's1', severity: 'blocking', action: 'fix', lens: 'correctness', file: FILE, line: 5, text: 'The cap rejects valid bulk orders over 9999', fix: 'Remove the cap.', evidence: `${FILE}:5`, member: 'sol' }] },
  ];
  assert.equal(mergeCouncil(COUNCIL, cluster).pass, false);
  // A plain remark that asks for nothing is still a note.
  assert.equal(mergeCouncil(COUNCIL, one('None required; keep it.', 'The cap is documented in the README', '')).pass, true);
});

test('attack 11, deadlock: after an objection stood on adjudication, the council demanding the earlier finding again is one owner question', async () => {
  const s = counterexample();
  const { merged } = await settle(objections(LIMIT_OBJECTION), s.memory, { opus: all('no', 'quantity is not price'), sol: all('no', 'quantity is not price') });
  s.memory.remember(nameFindings(merged.findings, 'review-r2'));
  // The implementer takes the limit out; round 3's member says PRICE is not resolved (needs the limit after all).
  s.write(FILE, base({ 1: PARSE }));
  const round3 = councilMemory({ file: s.file, cwd: s.dir, round: 3, fixes: s.fixes });
  assert.equal(round3.rejected.length, 1);
  const again = mergeCouncil(COUNCIL, [{ member: OPUS, status: 'ok', score: 9, findings: [] }, { member: SOL, status: 'ok', score: 5, findings: [{ id: 'PRICE', severity: 'blocking', action: 'fix', lens: 'correctness', file: FILE, line: 1, text: 'Malformed price still crashes parsing for huge quantities', fix: 'Restore the quantity limit.', evidence: `${FILE}:1`, member: 'sol' }] }], { earlier: round3 });
  assert.equal(again.pass, false);
  assert.equal(again.contradictions.length, 1);
  const c = again.contradictions[0];
  assert.equal(c.escalate, true, 'asked at once, not after another round');
  assert.equal(c.positions.length, 2);
  assert.match(c.positions[0].action, /requires PRICE: Validate the price/);
  assert.match(c.positions[1].action, /take out the behaviour at src\/Ordering\.API\/Service\.cs:2/);
  assert.match(c.subject, /contradicts itself on PRICE/);
});

test('attack 12, the task carries nothing of the fixer\'s argument beyond the declaration', () => {
  const text = adjudicationTask([{ key: 'k', finding: { id: 'PRICE', text: 'Malformed price', fix: 'Validate', round: 1 }, declared: { file: FILE, lines: [PARSE] }, objection: { file: FILE, line: 1, text: 'out of scope', fix: 'Remove it.', members: ['sol'], evidence: `${FILE}:1` } }]);
  assert.match(text, /The declaration is the fixer's claim, not evidence that the fix needs the line/);
  assert.match(text, /A behaviour that is merely near the fix, in the same file, convenient, or a reasonable extra is `no`/);
  assert.doesNotMatch(text, /dispute|implementer says|because the fixer/i);
});
