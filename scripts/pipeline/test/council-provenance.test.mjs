// A later scope objection is settled only through recorded provenance (council C11, Sol 1): the agent that fixed an
// upheld finding declared the lines it changed for that finding, the harness sealed the declaration against that
// fixing step's diff, and the objected line is one of those new lines, under exactly one finding whose agreed fix
// covers the file. Timing, proximity, file identity, matching text and the objection's own citations settle nothing.
// The replay is the recorded GIFT-1 PR check of dogfood C17 (fixtures/council-settlement-run.json), where an objection
// to trimming the gift message (a line of the original implementation commit) was credited to three unrelated fixes.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { adjudicate, councilMemory, councilReviewSection, fixDeclarationText, fixesFile, memoryFile, mergeCouncil, sealPendingFixes } from '../lib/council.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const STATE = '.factory/state';
const MEMBERS = [
  { name: 'opus', cli: 'claude', model: 'opus', lens: 'acceptance', blocking: true },
  { name: 'sol', cli: 'codex', model: 'sol', lens: 'correctness', blocking: true },
];
const COUNCIL = { stage: 'prCheck', maxCouncilRounds: 3, councilPassScore: 9, blockQuorum: 'any', onUnavailable: 'fail', members: MEMBERS };
const lines = (n, f) => Array.from({ length: n }, (_, i) => f(i + 1)).join('\n') + '\n';

function repo(files) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'council-provenance-')));
  const git = (...a) => spawnSync('git', a, { cwd: dir, encoding: 'utf8' });
  const write = (all) => {
    for (const [rel, text] of Object.entries(all)) {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), text);
    }
  };
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 'T');
  write({ '.gitignore': '.factory/state/\n', ...files });
  git('add', '-A');
  git('commit', '-qm', 'implementation');
  return { dir, write, git };
}
const ledger = (dir, stage, step = null) => ({ file: memoryFile(dir, STATE, { stage, story: 'S-1', step }), fixes: fixesFile(dir, STATE, { stage, story: 'S-1', step }) });
const declare = (fixes, list) => (fs.mkdirSync(path.dirname(fixes), { recursive: true }), fs.writeFileSync(fixes, JSON.stringify({ fixes: list })));
const upheld = (id, file, fix, extra = {}) => ({ id, severity: 'blocking', action: 'fix', lens: 'correctness', file, line: 1, text: `finding ${id}`, fix, ...extra });
// One scope objection by opus (the other member approves), at file:line, optionally citing other lines.
const objection = (file, line, extra = {}) => [
  { member: MEMBERS[0], status: 'ok', score: 6, findings: [{ id: 'o1', severity: 'blocking', action: 'fix', lens: 'acceptance', kind: 'scope', file, line, text: 'Adds behaviour no ticket line asks for', fix: 'Remove it.', evidence: `${file}:${line}`, member: 'opus', ...extra }] },
  { member: MEMBERS[1], status: 'ok', score: 9, findings: [] },
];
// A sitting: round 1 upheld `findings` on the committed tree; the fixer changes `after` and declares `fixes`; round 2.
function sitting({ files, findings, after, fixes, stage = 'pairVerify', step = 'api' }) {
  const r = repo(files);
  const l = ledger(r.dir, stage, step);
  councilMemory({ file: l.file, cwd: r.dir, round: 1, fixes: l.fixes }).remember(findings);
  r.write(after);
  if (fixes) declare(l.fixes, fixes);
  return { ...r, ...l, memory: councilMemory({ file: l.file, cwd: r.dir, round: 2, fixes: l.fixes }) };
}
// The real merge, then the real adjudication with scripted member answers (every item answered by `votes[member]`).
const answerAll = (task, answer) => ({ status: 0, output: `AGENT_RESULT: ${JSON.stringify({ answers: [...task.matchAll(/^## Item \d+: `([^`]+)`/gm)].map((m) => ({ key: m[1], answer, evidence: 'the agreed fix names this exact check at this line' })) })}` });
const settle = (results, earlier, votes = { opus: 'yes', sol: 'yes' }) => adjudicate({ council: COUNCIL, merged: mergeCouncil(COUNCIL, results, { earlier }), remerge: (adjudications) => mergeCouncil(COUNCIL, results, { earlier, adjudications }), run: async (m, task) => (votes[m.name] ? answerAll(task, votes[m.name]) : { status: 0, output: '' }), stage: 'prCheck', story: 'S-1', round: 2, log: () => {} });
const SERVICE = 'src/Api/Service.cs';
const SPEC = 'e2e/demo.spec.ts';
const service = (extra = {}) => lines(60, (i) => extra[i] ?? `        var step${i} = Compute(${i}, input);`);
const spec = (extra = {}) => lines(20, (i) => extra[i] ?? `  await page.click('#step-${i}');`);

test('the C11 counterexample: an unrelated limit added in the same fixing step as a caption fix is not settled', async () => {
  const caption = upheld('fix-caption', SPEC, `Add a caption to the demo in ${SPEC} before the checkout step.`);
  const s = sitting({
    files: { [SERVICE]: service(), [SPEC]: spec() },
    findings: [caption],
    after: { [SERVICE]: service({ 50: '        if (quantity > 9999) throw new ArgumentOutOfRangeException(nameof(quantity));' }), [SPEC]: spec({ 12: "  await demo.caption('Checkout with a gift message');" }) },
    fixes: [{ id: 'fix-caption', hunks: [{ file: SPEC, start: 12, end: 12 }] }],
  });
  const limit = mergeCouncil(COUNCIL, objection(SERVICE, 50, { text: 'Adds a 9999 quantity limit no ticket line asks for', fix: 'Remove the unauthorized 9999 limit.' }), { earlier: s.memory });
  assert.equal(limit.pass, false, JSON.stringify(limit.notes));
  assert.equal(limit.earlierRound.length, 0);
  // The caption line itself is the fix's: an objection to it is settled, crediting only that finding.
  const own = await settle(objection(SPEC, 12), s.memory);
  assert.equal(own.pass, true, JSON.stringify(own.findings));
  assert.deepEqual(own.earlierRound[0].earlier, ['fix-caption']);
});

test('an over-broad declaration does not stretch a remedy: the limit declared under the caption finding still stands', () => {
  const s = sitting({
    files: { [SERVICE]: service(), [SPEC]: spec() },
    findings: [upheld('fix-caption', SPEC, 'Add a caption to the demo before the checkout step.')],
    after: { [SERVICE]: service({ 50: '        if (quantity > 9999) throw new ArgumentOutOfRangeException(nameof(quantity));' }), [SPEC]: spec({ 12: "  await demo.caption('Checkout');" }) },
    fixes: [{ id: 'fix-caption', hunks: [{ file: SPEC, start: 12, end: 12 }, { file: SERVICE, start: 50, end: 50 }] }],
  });
  assert.equal(mergeCouncil(COUNCIL, objection(SERVICE, 50), { earlier: s.memory }).pass, false);
});

test('neighbouring and generic lines are not the fix: a line next to it, a brace in it, a line repeated in the file', async () => {
  const s = sitting({
    files: { [SERVICE]: service() },
    findings: [upheld('F1', SERVICE, 'Validate the price and answer InvalidArgument.')],
    after: { [SERVICE]: service({ 20: '        if (!decimal.TryParse(raw, out var price)) {', 21: '            throw new RpcException(new Status(StatusCode.InvalidArgument, "bad price"));', 22: '        }', 30: '        var step21 = Compute(21, input);' }) },
    fixes: [{ id: 'F1', hunks: [{ file: SERVICE, start: 20, end: 22 }] }],
  });
  assert.equal((await settle(objection(SERVICE, 21), s.memory)).pass, true, 'the declared new line, accepted on adjudication');
  assert.equal(mergeCouncil(COUNCIL, objection(SERVICE, 21), { earlier: s.memory }).pass, false, 'never by the harness alone');
  for (const line of [19, 23, 18]) assert.equal(mergeCouncil(COUNCIL, objection(SERVICE, line), { earlier: s.memory }).pass, false, `neighbour ${line}`);
  assert.equal(mergeCouncil(COUNCIL, objection(SERVICE, 22), { earlier: s.memory }).pass, false, 'a closing brace names no fix');
});

test('original code moved during a fix is not the fix: the moved trim stands, the new line beside it is the fix\'s', async () => {
  const trim = '        var trimmed = giftMessage?.Trim();';
  const s = sitting({
    files: { [SERVICE]: service({ 10: trim }) },
    findings: [upheld('F1', SERVICE, 'Answer InvalidArgument for a message over 60 characters.')],
    after: { [SERVICE]: service({ 10: '        var step10 = Compute(10, input);', 40: trim, 41: '        if (trimmed?.Length > 60) throw new RpcException(new Status(StatusCode.InvalidArgument, "too long"));' }) },
    fixes: [{ id: 'F1', hunks: [{ file: SERVICE, start: 40, end: 41 }] }],
  });
  assert.equal(mergeCouncil(COUNCIL, objection(SERVICE, 40), { earlier: s.memory }).pass, false, 'moved original code');
  assert.equal((await settle(objection(SERVICE, 41), s.memory)).pass, true, 'the new validation');
  assert.equal((await settle(objection(SERVICE, 40), s.memory)).adjudicated.length, 0, 'moved code never reaches adjudication');
  // A declaration of nothing but original lines is rejected and recorded.
  const t = sitting({
    files: { [SERVICE]: service({ 10: trim }) },
    findings: [upheld('F1', SERVICE, 'Answer InvalidArgument for a long message.')],
    after: { [SERVICE]: service({ 10: trim, 11: '        if (trimmed?.Length > 60) throw new ArgumentException("too long");' }) },
    fixes: [{ id: 'F1', hunks: [{ file: SERVICE, start: 10, end: 10 }] }, { id: 'NOT-UPHELD', hunks: [{ file: SERVICE, start: 11, end: 11 }] }],
  });
  assert.equal(mergeCouncil(COUNCIL, objection(SERVICE, 10), { earlier: t.memory }).pass, false);
  const saved = JSON.parse(fs.readFileSync(t.file, 'utf8'));
  assert.deepEqual(saved.rounds[0].rejected.map((r) => r.id), ['F1', 'NOT-UPHELD']);
  assert.equal(fs.existsSync(t.fixes), false, 'the declaration is consumed');
});

test('an evidence citation of a sanctioned line settles nothing: only the objection\'s own line counts', () => {
  const s = sitting({
    files: { [SERVICE]: service() },
    findings: [upheld('F1', SERVICE, 'Validate the price and answer InvalidArgument.')],
    after: { [SERVICE]: service({ 21: '            throw new RpcException(new Status(StatusCode.InvalidArgument, "bad price"));', 45: '        var normalized = input.Trim().ToLowerInvariant();' }) },
    fixes: [{ id: 'F1', hunks: [{ file: SERVICE, start: 21, end: 21 }] }],
  });
  const cited = mergeCouncil(COUNCIL, objection(SERVICE, 45, { evidence: `${SERVICE}:45; ${SERVICE}:21` }), { earlier: s.memory });
  assert.equal(cited.pass, false);
});

test('two findings claiming one line is ambiguous, and stands', () => {
  const s = sitting({
    files: { [SERVICE]: service() },
    findings: [upheld('F1', SERVICE, 'Validate the price.'), upheld('F2', SERVICE, 'Log a rejected price.')],
    after: { [SERVICE]: service({ 21: '            throw new RpcException(new Status(StatusCode.InvalidArgument, "bad price"));' }) },
    fixes: [{ id: 'F1', hunks: [{ file: SERVICE, start: 21, end: 21 }] }, { id: 'F2', hunks: [{ file: SERVICE, start: 21, end: 21 }] }],
  });
  assert.equal(mergeCouncil(COUNCIL, objection(SERVICE, 21), { earlier: s.memory }).pass, false);
});

test('cross-stage coincident text: the same text in another file, or repeated in the fix\'s file, is not the fix', async () => {
  const OTHER = 'src/Api/Other.cs';
  const line = '        return Results.BadRequest("quantity must be positive");';
  const r = repo({ [SERVICE]: service(), [OTHER]: service() });
  const review = ledger(r.dir, 'review');
  councilMemory({ file: review.file, cwd: r.dir, round: 1, fixes: review.fixes }).remember([upheld('R1', SERVICE, 'Answer 400 for a non-positive quantity.')]);
  r.write({ [SERVICE]: service({ 30: line }) });
  declare(review.fixes, [{ id: 'R1', hunks: [{ file: SERVICE, start: 30, end: 30 }] }]);
  councilMemory({ file: review.file, cwd: r.dir, round: 2, fixes: review.fixes }).remember([]);
  // Later, unrelated work adds the same text in another file.
  r.write({ [OTHER]: service({ 12: line }) });
  const pr = ledger(r.dir, 'prCheck', null);
  const memory = councilMemory({ file: pr.file, cwd: r.dir, round: 1, fixes: pr.fixes });
  assert.equal((await settle(objection(SERVICE, 30), memory)).pass, true, 'the review fix itself, in the later stage');
  assert.equal(mergeCouncil(COUNCIL, objection(OTHER, 12), { earlier: memory }).pass, false, 'same text, other file');
  // And a second copy in the fix's own file makes either copy ambiguous.
  r.write({ [SERVICE]: service({ 30: line, 55: line }) });
  const again = councilMemory({ file: pr.file, cwd: r.dir, round: 1, fixes: pr.fixes });
  for (const at of [30, 55]) assert.equal(mergeCouncil(COUNCIL, objection(SERVICE, at), { earlier: again }).pass, false, `copy at ${at}`);
});

test('the implementer\'s declaration for a PR check return is sealed against its own run, before later runs move lines', async () => {
  const r = repo({ [SERVICE]: service() });
  const pr = ledger(r.dir, 'prCheck', null);
  councilMemory({ file: pr.file, cwd: r.dir, round: 1, fixes: pr.fixes }).remember([upheld('FLOW-1', SERVICE, 'Keep the stored message when an older client omits it.')]);
  const before = r.git('rev-parse', 'HEAD').stdout.trim();
  r.write({ [SERVICE]: service({ 33: '        var kept = request.HasGiftMessage ? request.GiftMessage : stored?.GiftMessage;' }) });
  declare(pr.fixes, [{ id: 'FLOW-1', hunks: [{ file: SERVICE, start: 33, end: 33 }] }]);
  const sealed = sealPendingFixes({ cwd: r.dir, stateDir: STATE, root: r.dir, before });
  assert.equal(sealed[0].provenance.length, 1);
  // A later pair round inserts lines above it; the next PR check sitting still finds the fix by its line.
  r.write({ [SERVICE]: service({ 5: '        var extra = 1 + 2 + input.Length;', 34: '        var kept = request.HasGiftMessage ? request.GiftMessage : stored?.GiftMessage;' }) });
  const memory = councilMemory({ file: pr.file, cwd: r.dir, round: 1, fixes: pr.fixes });
  const m = await settle(objection(SERVICE, 34), memory);
  assert.equal(m.pass, true, JSON.stringify(m.findings));
  assert.deepEqual(m.earlierRound[0].earlier, ['FLOW-1']);
});

test('the fixer is told where and how to declare, by finding id', () => {
  const text = fixDeclarationText('/w/.factory/state/council/fixes/prCheck--S-1.json', [{ id: 'FLOW-1' }, { id: 'SOL-2' }, { id: '' }]);
  assert.match(text, /\/w\/\.factory\/state\/council\/fixes\/prCheck--S-1\.json/);
  assert.match(text, /`FLOW-1`, `SOL-2`\)/);
  assert.match(text, /only for new lines listed here under exactly one finding, and only when every council member, asked separately, agrees/);
  assert.equal(fixDeclarationText('/x.json', [{ id: '' }]), '');
});

test('replay of the recorded GIFT-1 PR check: the whitespace-trim objection stands at every sitting, however the fixes are declared', () => {
  const R = JSON.parse(fs.readFileSync(path.join(here, 'fixtures', 'council-settlement-run.json'), 'utf8'));
  const SVC = 'src/Basket.API/Grpc/BasketService.cs';
  const STATE_CS = 'src/WebApp/Services/BasketState.cs';
  // What v0.2.77 decided: the same objection settled three times, credited to fixes of other findings.
  assert.deepEqual(R.decisions.map((d) => [d.file, d.line, d.sanctionedBy.join('+')]).sort(), [[SVC, 118, 'ui-phone-overflow+SOL-1'], [SVC, 118, 'ui-phone-overflow+SOL-1+FLOW-1-1'], [SVC, 148, 'ui-phone-overflow+SOL-1+FLOW-1-1']].sort());
  // The trim is in the original implementation commit.
  assert.equal(R.files.original[SVC].split('\n')[117].trim(), 'var trimmed = giftMessage?.Trim();');
  const r = repo(R.files.original);
  const webapp = ledger(r.dir, 'pairUiVerify', 'webapp');
  const pr = ledger(r.dir, 'prCheck', null);
  const asFinding = (u) => ({ ...u, severity: 'blocking', action: 'fix', text: u.text, fix: u.fix });
  // Changed line ranges of a file between two texts (what a maximally generous fixer could declare).
  const changedRanges = (rel) => {
    const d = r.git('diff', '-U0', 'HEAD', '--', rel).stdout;
    return [...d.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)].map((m) => ({ file: rel, start: Number(m[1]), end: Number(m[1]) + Math.max(Number(m[2] ?? 1), 1) - 1 }));
  };
  const commit = (msg) => (r.git('add', '-A'), r.git('commit', '-qm', msg));
  // Pair UI round 1 upheld ui-phone-overflow and SOL-1; the pair implementer's fix; every changed hunk declared for both,
  // and the trim region of the Basket API under SOL-1 on top.
  councilMemory({ file: webapp.file, cwd: r.dir, round: 1, fixes: webapp.fixes }).remember(R.upheld.webappRound1.map(asFinding));
  r.write(R.files.webappRound2);
  const all = [...changedRanges(STATE_CS), ...changedRanges('src/WebApp/Components/Pages/Cart/CartPage.razor.css')];
  declare(webapp.fixes, [{ id: 'SOL-1', hunks: [...all, { file: SVC, start: 110, end: 125 }] }, { id: 'ui-phone-overflow', hunks: all }]);
  councilMemory({ file: webapp.file, cwd: r.dir, round: 2, fixes: webapp.fixes }).remember([]);
  commit('pair fix');
  // The declaration was honoured where the fix made new lines, and refused for the Basket API, which the step never touched.
  const sealed = JSON.parse(fs.readFileSync(webapp.file, 'utf8')).rounds[0];
  assert.ok(sealed.provenance.some((p) => p.id === 'SOL-1' && p.file === STATE_CS), JSON.stringify(sealed.provenance));
  assert.ok(sealed.rejected.some((x) => x.id === 'SOL-1' && x.file === SVC));
  const sol = R.solSitting3;
  const object = (line) => [
    { member: MEMBERS[1], status: 'ok', score: 8, findings: [{ ...sol, id: '', file: SVC, line, where: `${SVC}:${line}`, text: sol.title, evidence: sol.evidence.replace(':148', `:${line}`), member: 'sol' }] },
    { member: MEMBERS[0], status: 'ok', score: 10, findings: [] },
  ];
  const sittingAt = (files, line, upheldNow) => {
    r.write(files);
    const memory = councilMemory({ file: pr.file, cwd: r.dir, round: 1, fixes: pr.fixes });
    const m = mergeCouncil(COUNCIL, object(line), { earlier: memory });
    assert.equal(m.pass, false, `the objection at ${SVC}:${line} must stand: ${JSON.stringify(m.notes.map((n) => n.notUpheld))}`);
    assert.equal(m.earlierRound.length, 0);
    assert.ok(m.findings.some((f) => f.file === SVC && f.line === line));
    memory.remember(upheldNow);
    return memory;
  };
  // Sitting 1 (08:52), then FLOW-1-1's fix with all its Basket API hunks declared, sitting 2 (10:10), the same again, sitting 3 (11:12).
  sittingAt(R.files.prCheck1, 118, R.upheld.prCheck1.map(asFinding));
  commit('sitting 1');
  r.write(R.files.prCheck2);
  declare(pr.fixes, [{ id: 'FLOW-1-1', hunks: changedRanges(SVC).length ? changedRanges(SVC) : [{ file: SVC, start: 100, end: 131 }] }]);
  sittingAt({}, 118, R.upheld.prCheck2.map(asFinding));
  commit('sitting 2');
  r.write(R.files.prCheck3);
  declare(pr.fixes, [{ id: 'FLOW-1-1', hunks: [...changedRanges(SVC), { file: SVC, start: 140, end: 155 }] }]);
  sittingAt({}, 148, []);
});

test('the PR body counts every settled objection, per sitting', () => {
  const m = (score) => [{ name: 'sol', cli: 'codex', blocking: true, score, status: 'ok' }];
  const rec = (ts, round, pass, earlierRound = 0) => ({ ts, stage: 'prCheck', story: 'S-1', round, pass, members: m(pass ? 10 : 6), ...(earlierRound ? { earlierRound } : {}) });
  const text = councilReviewSection([rec('1', 1, false, 1), rec('2', 2, true), rec('3', 1, true, 1), rec('4', 1, false, 2)]);
  assert.match(text, /- 4 scope objections accepted as a note, on adjudication by every blocking member, as required by the agreed fix of an earlier upheld finding \(Sitting 1, round 1, Sitting 2, round 1, Sitting 3, round 1 ×2\)\./);
  assert.doesNotMatch(councilReviewSection([rec('1', 1, true)]), /accepted as a note/);
  // Adjudication sittings are listed with each outcome and counted, and never start a sitting or a round of their own.
  const adj = (ts, round, items) => ({ ts, kind: 'adjudication', stage: 'prCheck', story: 'S-1', round, members: [{ name: 'opus', attempts: 1 }, { name: 'sol', attempts: 2 }], items });
  const withAdj = councilReviewSection([rec('1', 1, false), adj('1b', 2, [{ file: 'a.cs', line: 3, earlier: 'F1', outcome: 'covered', acceptedBy: ['opus', 'sol'] }]), rec('2', 2, true, 1), adj('2b', 2, [{ file: 'a.cs', line: 9, earlier: 'F1', outcome: 'stands', acceptedBy: ['opus'], rejectedBy: ['sol'], missing: [] }])]);
  assert.match(withAdj, /Rounds: 2\n/);
  assert.match(withAdj, /- 2 adjudication sittings \(6 member executions\): round 2, a\.cs:3 against F1: covered \(yes: opus, sol\); round 2, a\.cs:9 against F1: stands \(no: sol\)\./);
});
