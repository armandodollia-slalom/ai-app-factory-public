// A council remembers what it upheld across the rounds of a sitting (council.mjs councilMemory): later members read the
// earlier rounds' upheld findings with their agreed fixes, and the merge settles a scope objection to such a fix.
// The replay is the recorded review of the dogfood C16 held-out feature ticket (fixtures/council-contradiction-run.json):
// round 1 upheld "a bad price crashes the cast; answer InvalidArgument", round 2 blocked that validation as "an error
// response no ticket line names" with "fix: none required", and the story ended unresolved.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../lib/config.mjs';
import { adjudicate, councilFor, councilMemory, fixesFile, memberTask, mergeCouncil, memoryFile } from '../lib/council.mjs';
import { readJsonl } from '../lib/util.mjs';
import { councilArchitectureReview } from '../../review/lib/review.mjs';
import { councilVerifier } from '../../feature-verification/lib/verify.mjs';
import { isResolvesQuestion, RESOLVES_ANSWER } from './fixtures/resolves-question.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const RECORDED = JSON.parse(fs.readFileSync(path.join(here, 'fixtures', 'council-contradiction-run.json'), 'utf8'));
const SERVICE = 'src/Basket.API/Grpc/BasketService.cs';
const PROTO = 'src/Basket.API/Proto/basket.proto';

const lines = (n, f) => Array.from({ length: n }, (_, i) => f(i + 1)).join('\n') + '\n';
// The service as the branch had it in round 1: lines 101-130 are the change, line 112 the unchecked cast.
const round1Service = () => lines(130, (i) => (i === 112 ? '            PriceAtAdding = (decimal)item.PriceAtAdding,' : i > 100 ? `            // change ${i}` : `// base ${i}`));
// After the fix of round 1's findings: lines 112-124 validate the price and line 120 answers InvalidArgument.
const round2Service = () => lines(142, (i) => (i === 120 ? '                throw new RpcException(new Status(StatusCode.InvalidArgument, "price_at_adding is not a valid price"));' : i >= 112 && i <= 124 ? `            // validation ${i}` : i === 125 ? '            PriceAtAdding = price,' : i > 100 ? `            // change ${i}` : `// base ${i}`));

function repo(council) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'council-memory-')));
  const git = (...a) => spawnSync('git', a, { cwd: dir, encoding: 'utf8' });
  const write = (rel, text) => (fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }), fs.writeFileSync(path.join(dir, rel), text));
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 'T');
  write('.gitignore', '.factory/state/\n.factory/metrics/\n');
  write('.factory/config.json', JSON.stringify({ baseRef: 'main', agent: { modelIds: { codex: { sol: 'gpt-6.1-sol' } } }, council }));
  write('story.md', '# PCHG-1: Tell the shopper when a product\'s price changed\n\n## Acceptance Criteria\n\n- AC1: a bag line whose price changed since it was added shows the old price\n- AC2: a bag line whose price did not change shows no note\n');
  write(SERVICE, lines(100, (i) => `// base ${i}`));
  write(PROTO, lines(20, (i) => `// proto ${i}`));
  git('add', '-A');
  git('commit', '-qm', 'init');
  git('checkout', '-qb', 'feat/pchg-1');
  write(SERVICE, round1Service());
  write(PROTO, lines(30, (i) => (i === 24 ? '  optional double price_at_adding = 4;' : i > 20 ? `  // proto change ${i}` : `// proto ${i}`)));
  git('commit', '-qam', 'change');
  return { dir, write };
}

// Metrics are sharded per branch unless FACTORY_METRICS_SHARD is 0 (npm test sets it): read either.
const metrics = (dir, name) => [path.join(dir, '.factory/metrics', `${name}.jsonl`), path.join(dir, '.factory/metrics', `${name}.jsonl.d`, 'feat__pchg-1.jsonl')].flatMap((f) => readJsonl(f));
const out = (o) => ({ status: 0, output: `AGENT_RESULT: ${JSON.stringify(o)}` });
// What the fixing agent writes after its run (council.mjs fixDeclarationText).
const declareFix = (dir, stage, story, fixes) => {
  const file = fixesFile(dir, '.factory/state', { stage, story });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ fixes }));
};
const MEMBERS = [
  { name: 'opus', cli: 'claude', model: 'opus', lens: 'acceptance' },
  { name: 'sol', cli: 'codex', model: 'sol', lens: 'correctness' },
];
const COUNCIL = { passScore: 9, blockOn: 'any', members: MEMBERS, stages: { review: {}, testAutomation: {}, pairVerify: {} } };

// A recorded round as the members' answers: each member returns its verdict, score and the items it raised.
function answers(rec, change = (f) => f) {
  return Object.fromEntries(rec.members.map((m) => [m.name, out({
    verdict: m.verdict,
    score: m.score,
    findings: rec.items.filter((it) => it.members.includes(m.name)).map((it, i) => change({ id: `${m.name}-r${rec.round}-${i + 1}`, severity: it.severity, action: it.action, lens: it.lens, category: it.lens, file: it.file, line: it.line, issue: it.reason, fix: it.fix, evidence: `${it.file}:${it.line}` }, m.name)),
  })]));
}

// A member's scripted answer to an adjudication task (council.mjs adjudicationTask): every item answered `vote`.
const ADJ = /^# Council adjudication/;
const vote = (task, answer, evidence = 'src/Basket.API/Grpc/BasketService.cs:120: the agreed fix says answer InvalidArgument for a bad price') => out({ answers: [...task.matchAll(/^## Item \d+: `([^`]+)`/gm)].map((m) => ({ key: m[1], answer, evidence })) });

// Round 2's members answer an adjudication with `votes` ({ opus: 'yes', sol: 'no' }; a missing name gives no parsable answer).
async function replay({ round2 = (f) => f, declare = true, votes = { opus: 'yes', sol: 'yes' } } = {}) {
  const { dir, write } = repo(COUNCIL);
  const config = loadConfig('review', dir);
  const story = { key: 'PCHG-1', file: 'story.md' };
  const tasks = {};
  const [r1rec, r2rec] = RECORDED.rounds;
  const r1 = await councilArchitectureReview(config, story, 1, { runMember: async (m, task) => isResolvesQuestion(task) ? { status: 0, output: RESOLVES_ANSWER } : ((tasks[`1:${m.name}`] = task), answers(r1rec)[m.name]) });
  // The implementer answers round 1's upheld findings: the price is validated and a bad one answers InvalidArgument,
  // and it declares the validation's lines as its fix of the price finding (the review's fix declaration).
  write(SERVICE, round2Service());
  if (declare) declareFix(dir, 'review', 'PCHG-1', [{ id: r1.findings.find((f) => f.line === 112).id, hunks: [{ file: SERVICE, start: 112, end: 125 }] }]);
  const r2 = await councilArchitectureReview(config, story, 2, { runMember: async (m, task) => isResolvesQuestion(task) ? { status: 0, output: RESOLVES_ANSWER } : (ADJ.test(task) ? ((tasks[`adj:${m.name}`] = task), votes[m.name] ? vote(task, votes[m.name]) : { status: 0, output: 'no answer' }) : ((tasks[`2:${m.name}`] = task), answers(r2rec, round2)[m.name])) });
  return { dir, config, r1, r2, tasks, write };
}

test('replay of the recorded contradiction: round 2\'s objection to the fix round 1 upheld is settled, and the review approves', async () => {
  assert.deepEqual(RECORDED.rounds.map((r) => [r.round, r.items.length, r.items.map((i) => i.members.join('+')).join(',')]), [[1, 2, 'sol,sol'], [2, 1, 'opus+sol']], 'the recorded run');
  const { dir, r1, r2, tasks } = await replay();
  assert.equal(r1.verdict, 'CHANGES_REQUESTED');
  assert.equal(r1.findings.filter((f) => f.severity === 'blocking').length, 2);
  // Round 1's members see no earlier rounds; round 2's see both upheld findings with their agreed fixes.
  assert.doesNotMatch(tasks['1:opus'], /Findings the council upheld in earlier rounds/);
  for (const m of ['opus', 'sol']) {
    assert.match(tasks[`2:${m}`], /### Findings the council upheld in earlier rounds[\s\S]*round 1[\s\S]*src\/Basket\.API\/Grpc\/BasketService\.cs:112[\s\S]*Agreed fix: Validate and convert the optional price[\s\S]*StatusCode\.InvalidArgument/);
    assert.match(tasks[`2:${m}`], /or a finding the council upheld in an earlier round \(listed below when there is one\), requires it/);
  }
  // Now settled by adjudication: both blocking members, asked fresh, accepted that the agreed fix requires the validation.
  for (const m of ['opus', 'sol']) {
    assert.match(tasks[`adj:${m}`], /does the agreed fix of the earlier finding require this specific behaviour/);
    assert.match(tasks[`adj:${m}`], /Its agreed fix: Validate and convert the optional price/);
    assert.match(tasks[`adj:${m}`], /StatusCode\.InvalidArgument, "price_at_adding is not a valid price"/, 'the declared lines');
    assert.match(tasks[`adj:${m}`], /The objection, at src\/Basket\.API\/Grpc\/BasketService\.cs:120/);
  }
  assert.equal(r2.verdict, 'APPROVED', JSON.stringify(r2.findings));
  const note = r2.findings.find((f) => /no ticket line names/.test(f.issue));
  assert.equal(note.severity, 'minor');
  assert.deepEqual(r2.council.earlierRound[0].acceptedBy, ['opus', 'sol']);
  const rounds = metrics(dir, 'council-rounds');
  assert.deepEqual(rounds.map((r) => [r.kind ?? 'round', r.round, r.pass ?? null, r.standing ?? r.covered]), [['round', 1, false, 2], ['adjudication', 2, null, 1], ['round', 2, true, 0]]);
});

test('the earlier ruling settles the objection on its own: the same objection asking to remove the validation still does not block', async () => {
  const { dir, r2 } = await replay({ round2: (f) => ({ ...f, fix: 'Remove the InvalidArgument path; no ticket line asks for it.' }) });
  assert.equal(r2.verdict, 'APPROVED', JSON.stringify(r2.findings));
  const settled = r2.council.earlierRound;
  assert.equal(settled.length, 1);
  assert.equal(settled[0].file, SERVICE);
  assert.equal(settled[0].line, 120);
  // Only the finding whose declared fix made the line is credited, not every finding of round 1 (council C11, Sol 1).
  assert.equal(settled[0].earlier.length, 1);
  assert.match(r2.council.notes[0].notUpheld, /every blocking member \(opus, sol\) accepted, on adjudication, that the agreed fix of \S+ \(upheld in round 1: Validate and convert[^)]*\) requires this behaviour/);
  assert.doesNotMatch(r2.council.notes[0].notUpheld, /optional representation/);
  assert.equal(metrics(dir, 'council-rounds').at(-1).earlierRound, 1);
  const decision = metrics(dir, 'decisions').filter((d) => d.stage === 'council-review').at(-1);
  assert.equal(decision.items.find((i) => i.sanctionedBy).sanctionedBy.length, 1);
  const adj = metrics(dir, 'decisions').filter((d) => d.decision === 'adjudicated');
  assert.deepEqual(adj.map((d) => d.items.map((i) => [i.outcome, i.acceptedBy.join('+')])), [[['covered', 'opus+sol']]]);
});

test('a real defect in the fix still blocks: a correctness finding on the validation line is not a scope objection', async () => {
  const { r2 } = await replay({ round2: (f) => ({ ...f, issue: 'The validation accepts negative prices, so a negative price_at_adding is stored and the note shows a negative old price.', fix: 'Reject negative values too.', lens: 'correctness' }) });
  assert.equal(r2.verdict, 'CHANGES_REQUESTED');
  assert.equal(r2.council.earlierRound.length, 0);
});

test('without the fixer\'s declaration nothing is settled: the same objection goes to the council', async () => {
  const { r2, tasks } = await replay({ declare: false, round2: (f) => ({ ...f, fix: 'Remove the InvalidArgument path; no ticket line asks for it.' }) });
  assert.equal(r2.verdict, 'CHANGES_REQUESTED');
  assert.equal(tasks['adj:opus'], undefined, 'nothing to adjudicate');
  assert.equal(r2.council.earlierRound.length, 0);
});

test('a scope objection outside the fix still blocks: a line round 1 already judged is not sanctioned by a later fix', async () => {
  const { r2 } = await replay({ round2: (f) => ({ ...f, line: 105, evidence: `${SERVICE}:105`, fix: 'Remove the logging no ticket line asks for.' }) });
  assert.equal(r2.verdict, 'CHANGES_REQUESTED');
  assert.equal(r2.council.earlierRound.length, 0);
});

test('a blocking finding that asks for no change is a note even with no earlier round', () => {
  const council = { stage: 'review', rounds: 3, passScore: 9, blockOn: 'any', onUnavailable: 'fail', members: MEMBERS.map((m) => ({ ...m, blocking: true })) };
  const finding = (fix) => ({ id: 'x', severity: 'blocking', action: 'fix', lens: 'correctness', file: SERVICE, line: 120, text: 'a thing', fix, member: 'sol' });
  const results = (fix) => [{ member: council.members[0], status: 'ok', score: 9, verdict: 'APPROVED', findings: [] }, { member: council.members[1], status: 'ok', score: 8, verdict: 'CHANGES_REQUESTED', findings: [finding(fix)] }];
  for (const fix of ['None required; keep it as validation of the new field.', 'None.', 'No change needed', 'nothing']) {
    const m = mergeCouncil(council, results(fix));
    assert.equal(m.pass, true, fix);
    assert.equal(m.notes[0].noChange, true);
  }
  for (const fix of ['None of the callers check it: add the check.', 'No validation exists; add it.', '']) assert.equal(mergeCouncil(council, results(fix)).pass, false, fix);
});

test('a new sitting starts with an empty memory', async () => {
  const { dir } = await replay();
  const file = memoryFile(dir, '.factory/state', { stage: 'review', story: 'PCHG-1' });
  assert.equal(councilMemory({ file, cwd: dir, round: 3 }).upheld.length, 2, 'round 2 upheld nothing; round 1 is still this sitting');
  const again = councilMemory({ file, cwd: dir, round: 1 });
  assert.ok(again.upheld.length && again.upheld.every((u) => u.earlierSitting), 'the old sitting\'s rulings are history, not this sitting');
});

test('replay, a later stage: the PR check\'s council does not block the validation the review upheld, after later changes moved it', async () => {
  const { dir, write } = await replay();
  // The review passed at round 2, which recorded round 1's fix by its lines. Later work adds lines above the validation.
  write(SERVICE, round2Service().replace('// base 50\n', '// base 50\n// later 1\n// later 2\n// later 3\n// later 4\n// later 5\n'));
  const council = { stage: 'prCheck', rounds: 3, passScore: 9, blockOn: 'any', onUnavailable: 'fail', members: MEMBERS.map((m) => ({ ...m, blocking: true })) };
  const memory = councilMemory({ file: memoryFile(dir, '.factory/state', { stage: 'prCheck', story: 'PCHG-1' }), cwd: dir, round: 1 });
  assert.match(memory.text, /review, round 1[\s\S]*Agreed fix: Validate and convert the optional price/);
  const objection = (line, text = 'Adds an InvalidArgument response no ticket line names') => [{ member: council.members[0], status: 'ok', score: 6, findings: [{ id: 'o1', severity: 'blocking', action: 'fix', lens: 'acceptance', file: SERVICE, line, text, fix: 'remove it', member: 'opus' }] }, { member: council.members[1], status: 'ok', score: 9, findings: [] }];
  const settle = (results) => adjudicate({ council, merged: mergeCouncil(council, results, { earlier: memory }), remerge: (adjudications) => mergeCouncil(council, results, { earlier: memory, adjudications }), run: async (m, task) => vote(task, 'yes'), stage: 'prCheck', story: 'PCHG-1', round: 1, log: () => {} });
  assert.equal(mergeCouncil(council, objection(125), { earlier: memory }).pass, false, 'not settled by the harness alone');
  const moved = await settle(objection(125));
  assert.equal(moved.pass, true, JSON.stringify(moved.findings));
  assert.equal(moved.earlierRound[0].line, 125);
  assert.equal(mergeCouncil(council, objection(125)).pass, false, 'without the memory it blocks');
  assert.equal(mergeCouncil(council, objection(30, 'Adds a log line no ticket line asks for'), { earlier: memory }).pass, false, 'a line the fix did not make');
});

test('memberTask: the earlier-rounds block reaches every member, after the scope rule', () => {
  const council = { stage: 'pairVerify', rounds: 3, passScore: 9, members: MEMBERS.map((m) => ({ ...m, blocking: true })) };
  const text = memberTask('task', { council, member: council.members[0], round: 2, earlier: '### Findings the council upheld in earlier rounds\n\n- round 1: X', skill: '' });
  assert.match(text, /`kind` "scope"[\s\S]*### Findings the council upheld in earlier rounds/);
});

test('test automation council: an objection to a test an earlier round required is settled the same way', async () => {
  const { dir, write } = repo(COUNCIL);
  const config = loadConfig('feature-verification', dir);
  const council = councilFor(config, 'testAutomation');
  const spec = 'tests/Basket.FunctionalTests/PriceTests.cs';
  write(spec, lines(10, (i) => `// test ${i}`));
  const gap = { case: 'TC-PCHG-1-01-03', category: 'missing-case', detail: 'no test sends a NaN price; the upheld review fix answers InvalidArgument for it', location: `${spec}:5`, fix: 'add a test that a NaN price answers InvalidArgument' };
  const r1 = await councilVerifier(config, { stage: 'automation', story: { key: 'PCHG-1' }, round: 1, task: 't', producerVersion: 'p', council, runMember: async (m) => (m.name === 'sol' ? out({ score: 6, gaps: [{ ...gap, severity: 'blocking' }] }) : out({ score: 9, gaps: [] })) });
  assert.equal(r1.passed, false);
  write(spec, lines(22, (i) => (i >= 11 ? `// NaN price test ${i}` : `// test ${i}`)));
  declareFix(dir, 'testAutomation', 'PCHG-1', [{ id: r1.gaps[0].id, hunks: [{ file: spec, start: 11, end: 22 }] }]);
  const objection = { case: 'TC-PCHG-1-01-03', category: 'other', detail: 'asserts an InvalidArgument response no ticket line names', location: `${spec}:15`, severity: 'blocking', kind: 'scope' };
  const tasks = {};
  const r2 = await councilVerifier(config, { stage: 'automation', story: { key: 'PCHG-1' }, round: 2, task: 't', producerVersion: 'p', council, runMember: async (m, t) => isResolvesQuestion(t) ? { status: 0, output: RESOLVES_ANSWER } : (ADJ.test(t) ? vote(t, 'yes', `${spec}:15 asserts the InvalidArgument the upheld gap asks a test for`) : ((tasks[m.name] = t), m.name === 'opus' ? out({ score: 6, gaps: [objection] }) : out({ score: 10, gaps: [] }))) });
  assert.match(tasks.opus, /Findings the council upheld in earlier rounds[\s\S]*no test sends a NaN price/);
  assert.equal(r2.passed, true, JSON.stringify(r2));
});

test('the C16 replay, a split vote: the objection stands with a concrete instruction, never unresolved with nothing to do', async () => {
  const { r2 } = await replay({ votes: { opus: 'yes', sol: 'no' } });
  assert.equal(r2.verdict, 'CHANGES_REQUESTED');
  const stood = r2.council.findings.find((f) => f.adjudication);
  assert.equal(stood.adjudication.outcome, 'stands');
  assert.deepEqual(stood.adjudication.rejectedBy, ['sol']);
  // The recorded objection said "fix: none required": the implementer still gets something to do.
  assert.match(stood.fix, /did not accept that \S+'s agreed fix requires the behaviour at src\/Basket\.API\/Grpc\/BasketService\.cs:120 \(sol said no\)\. Take out that behaviour, and keep the change that carries out \S+'s agreed fix: Validate and convert/);
});

test('the C16 replay, a missing answer: the objection stands', async () => {
  const { r2 } = await replay({ votes: { opus: 'yes' } });
  assert.equal(r2.verdict, 'CHANGES_REQUESTED');
  assert.deepEqual(r2.council.findings.find((f) => f.adjudication).adjudication.missing, ['sol']);
});
