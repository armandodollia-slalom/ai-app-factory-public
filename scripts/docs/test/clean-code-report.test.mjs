// GEN-19: the closing check of the generator's clean-code report. Every baseline item is fixed or kept with a reason,
// copy by copy: a key triaged fix with copies left passes only for the copies its `keep` names with a reason.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { closingProblems, functionProblems, functionRows, markdown } from '../clean-code-report.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const doc = (name) => JSON.parse(fs.readFileSync(path.join(ROOT, 'docs/clean-code', name), 'utf8'));

const CLONE = 'clone a.mjs ~ b.mjs (7 lines)';
const clone = (n) => ({ kind: 'clone', key: CLONE, area: 'x', files: ['a.mjs', 'b.mjs'], where: `a.mjs:${n} and b.mjs:${n}` });
const LONG = { kind: 'complexity', key: 'complexity c.mjs run', area: 'x', files: ['c.mjs'], where: 'c.mjs:1-90' };
const fixTriage = (entry = {}) => ({ items: { [CLONE]: { decision: 'fix', batch: 'duplication', how: 'one helper', ...entry }, [LONG.key]: { decision: 'fix', batch: 'complexity' } } });

// Council r1 (sol-08): the member's reproducer. Two copies of one clone and a long function, all triaged fix; the
// function is split and one copy is removed. The copy left has no disposition, so the check must say so.
test('sol-08: a copy of a key triaged fix that is still there fails the check unless a keep entry with a reason covers it', () => {
  const baseline = [clone(1), clone(20), LONG];
  const closing = [clone(20)];
  assert.deepEqual(closingProblems(baseline, fixTriage(), closing), [`triaged fix but 1 of 2 left with no kept entry: ${CLONE}`]);
  assert.deepEqual(closingProblems(baseline, fixTriage({ keep: { count: 1, reason: 'the call shape every adapter writes' } }), closing), [], 'the copy left is kept with a reason');
  assert.equal(closingProblems(baseline, fixTriage({ keep: { count: 1 } }), closing).length, 1, 'a keep without a reason disposes of nothing');
  // Each copy is counted: a keep for one copy does not cover two.
  const three = [clone(1), clone(20), clone(40), LONG];
  assert.deepEqual(closingProblems(three, fixTriage({ keep: { count: 1, reason: 'r' } }), [clone(20), clone(40)]), [`triaged fix but 1 of 3 left with no kept entry: ${CLONE}`]);
  // The report shows what is left and why.
  assert.match(markdown(baseline, fixTriage({ keep: { count: 1, reason: 'the call shape every adapter writes' } }), closing), /partly fixed \(1 of 2 left, 1 kept: the call shape every adapter writes\)/);
});

test('the committed closing report passes its own check, and README.md is what the report renders', () => {
  const [baseline, triage, closing, functions] = ['baseline.json', 'triage.json', 'closing.json', 'functions.json'].map(doc);
  // Council r4 (TV-11): with the files the branch changed, so the F13 guard runs on the real data.
  assert.ok(Array.isArray(functions.changed) && functions.changed.length, 'functions.json records the changed files');
  assert.deepEqual(closingProblems(baseline, triage, closing, { changed: functions.changed }), []);
  assert.deepEqual(functionProblems(functions.rows, functions.limits), []);
  assert.equal(fs.readFileSync(path.join(ROOT, 'docs/clean-code/README.md'), 'utf8'), markdown(baseline, triage, closing, functions), 'regenerate with node scripts/docs/clean-code-report.mjs --markdown');
});

// Council r1 (cc-6): no function the branch changed may end over a limit it was under at the base, and none over a limit
// may get worse than at the base. Functions are matched by file and name; an anonymous one by its first line, whatever
// moved around it.
test('cc-6: the function rule flags a function newly over a limit, a new one over it, and one over it that got worse', () => {
  const limits = { maxCyclomatic: 15, maxFunctionLines: 100 };
  const fn = (name, ccn, length, line = null) => ({ file: 'a.mjs', name, start: 1, ccn, length, line });
  const base = [fn('attempt', 14, 30), fn('merge', 96, 266), fn('steady', 40, 50), fn('better', 30, 20), fn('(anonymous)', 1, 1, 'x.map(() => 1)'), fn('(anonymous)', 50, 98, 'clusters.map((c) => {')];
  const head = [fn('attempt', 16, 30), fn('merge', 96, 291), fn('steady', 40, 50), fn('better', 25, 20), fn('fresh', 20, 10), fn('(anonymous)', 54, 98, 'clusters.map((c) => {')];
  const rows = functionRows(base, head, new Set(['a.mjs']), limits);
  assert.deepEqual(functionProblems(rows, limits), [
    'a.mjs attempt: cyclomatic complexity 16, over 15, was 14 at the base',
    'a.mjs merge: lines 291, worse than 266 at the base',
    'a.mjs fresh: cyclomatic complexity 20, over 15, was not there at the base',
    'a.mjs (anonymous) `clusters.map((c) => {`: cyclomatic complexity 54, worse than 50 at the base',
  ]);
  // Held: no worse than at the base, or better; a function of a file the branch did not change is not judged.
  assert.deepEqual(functionRows(base, head, new Set(['b.mjs']), limits), []);
});

// Council r1 (cc-7): a kind's reason was written for the baseline's items; an item the branch adds is kept only on an
// entry of its own.
test('cc-7: a new item under a kind-level kept reason fails the closing check; its own kept entry with a reason passes', () => {
  const repeat = (where) => ({ kind: 'repeat', key: 'repeat a.mjs repeated-constant 600 repeats the constant LIMIT', area: 'x', files: ['a.mjs'], where });
  const triage = { kinds: { repeat: { decision: 'kept', reason: 'another purpose' } }, items: {} };
  // The baseline's clone and long function are fixed: only the new repeat is in question.
  const baseline = [LONG, clone(1)];
  const closing = [repeat('a.mjs:3')];
  const rule = fixTriage().items;
  assert.deepEqual(closingProblems(baseline, { ...triage, items: rule }, closing), [`new and not kept on its own entry with a reason: ${closing[0].key}`]);
  assert.deepEqual(closingProblems(baseline, { ...triage, items: { ...rule, [closing[0].key]: { decision: 'kept', reason: 'a fetch limit' } } }, closing), []);
  assert.equal(closingProblems(baseline, { ...triage, items: { ...rule, [closing[0].key]: { decision: 'kept' } } }, closing).length, 1, 'no reason, no disposition');
  // The page lists it with its reason.
  assert.match(markdown(baseline, { ...triage, items: { ...rule, [closing[0].key]: { decision: 'kept', reason: 'a fetch limit' } } }, closing), /a fetch limit[\s\S]*a\.mjs:3/);
});

// Council r2 (sol-08): a kept copy is a specific occurrence, named by its digest, not a count any copy of the key can
// use. The member's reproducer: the two baseline clones of a.mjs ~ b.mjs go, one kept by count; a new six-line clone in
// the same files (same key) is left. It is a new occurrence and needs a disposition of its own.
test('sol-08 r2: a new clone with an old key is not covered by the kept copy of another occurrence', () => {
  const key = 'clone a.mjs ~ b.mjs (6 lines)';
  const occ = (a, b, digest) => ({ kind: 'clone', key, area: 'x', files: ['a.mjs', 'b.mjs'], where: `a.mjs:${a}-${a + 5} and b.mjs:${b}-${b + 5}`, digest });
  const baseline = [occ(10, 20, 'd-old-1'), occ(30, 40, 'd-old-2'), LONG];
  const triage = (keep) => ({ items: { [key]: { decision: 'fix', batch: 'duplication', how: 'one helper', keep }, [LONG.key]: { decision: 'fix', batch: 'complexity' } } });
  const fresh = occ(100, 120, 'd-new');
  assert.deepEqual(closingProblems(baseline, triage({ count: 1, reason: 'the adapter call shape' }), [fresh]), [`new and not kept on its own entry with a reason: ${key} (a.mjs:100-105 and b.mjs:120-125)`]);
  // The surviving old copy, kept by its digest (its lines moved): fine. The other old copy left without a keep: not.
  assert.deepEqual(closingProblems(baseline, triage({ digests: ['d-old-1'], reason: 'the adapter call shape' }), [occ(12, 22, 'd-old-1')]), []);
  assert.deepEqual(closingProblems(baseline, triage({ digests: ['d-old-1'], reason: 'the adapter call shape' }), [occ(32, 42, 'd-old-2')]), [`triaged fix but 1 of 2 left with no kept entry: ${key}`]);
  // A key kept as a whole: a new occurrence under it needs its own reason (`occurrences`), not the key's.
  // (Two more baseline clones, fixed, keep the clone count falling.)
  const gone = [clone(1), clone(20)];
  const keptKey = { items: { [key]: { decision: 'kept', reason: 'two adapters' }, [CLONE]: { decision: 'fix', batch: 'duplication' }, [LONG.key]: { decision: 'fix', batch: 'complexity' } } };
  assert.deepEqual(closingProblems([...baseline, ...gone], keptKey, [occ(10, 20, 'd-old-1'), occ(30, 40, 'd-old-2'), fresh]), [`new and not kept on its own entry with a reason: ${key} (a.mjs:100-105 and b.mjs:120-125)`]);
  keptKey.items[key].occurrences = { 'd-new': 'a third adapter, the same interface' };
  assert.deepEqual(closingProblems([...baseline, ...gone], keptKey, [occ(10, 20, 'd-old-1'), occ(30, 40, 'd-old-2'), fresh]), []);
});

// Council r2 (opus F11, cc-7): a string literal that repeats a constant is the same knowledge until its own entry says
// why not. The repeat kind's reason (written for numbers: a timeout, a limit) does not dispose of it, at the base or at
// the head; a number keeps the kind's reason.
test('F11: a string-literal repeat is not kept by the repeat kind\'s reason; it is fixed or kept on its own entry', () => {
  const repeat = (literal, constant) => ({ kind: 'repeat', key: `repeat a.mjs repeated-constant ${literal} repeats the constant ${constant}, which b.mjs`, area: 'x', files: ['a.mjs'], where: 'a.mjs:3' });
  const text = repeat("'lsp'", 'LSP_SERVER');
  const number = repeat('600', 'LIMIT');
  const triage = (items = {}) => ({ kinds: { repeat: { decision: 'kept', reason: 'another purpose' } }, items: { ...fixTriage().items, ...items } });
  const baseline = [LONG, clone(1), text, number];
  // Left at the head under the kind's reason only: the string is a problem, the number is not.
  assert.deepEqual(closingProblems(baseline, triage(), [text, number]), [`no decision with a reason: ${text.key}`]);
  assert.deepEqual(closingProblems(baseline, triage({ [text.key]: { decision: 'kept', reason: 'the state folder, not the server' } }), [text, number]), []);
  assert.deepEqual(closingProblems(baseline, triage({ [text.key]: { decision: 'fix', batch: 'council r2', how: 'uses LSP_SERVER' } }), [number]), [], 'fixed: it uses the constant');
  // The page does not list it under the kind's reason.
  assert.doesNotMatch(markdown(baseline, triage({ [text.key]: { decision: 'fix', batch: 'council r2', how: 'uses LSP_SERVER' } }), [number]), /another purpose[^\n]*\n[\s\S]*?'lsp'[\s\S]*?<\/details>/);
});

// Council r2 (test-value follow-ups): a key with more copies at the head than at the base has new copies (an item
// without a digest is new past its key's baseline count), and the head must have fewer clones and fewer functions over
// the limits than the base (AC4): equal is not fewer.
test('a baseline key grown past its count has a new item; equal clone or complexity counts fail the AC4 check', () => {
  const repeat = { kind: 'repeat', key: 'repeat a.mjs repeated-constant 600 repeats the constant LIMIT, which b.mjs', area: 'x', files: ['a.mjs'], where: 'a.mjs:3' };
  const triage = { kinds: { repeat: { decision: 'kept', reason: 'a timeout, not the limit' } }, items: fixTriage().items };
  const baseline = [LONG, clone(1), repeat];
  assert.deepEqual(closingProblems(baseline, triage, [repeat]), [], 'the same count: nothing new');
  assert.deepEqual(closingProblems(baseline, triage, [repeat, { ...repeat, where: 'a.mjs:9' }]), [`new and not kept on its own entry with a reason: ${repeat.key}`]);
  // AC4: the clone and the long function are fixed above; here one of each is left, as many as the base had.
  const other = { ...LONG, key: 'complexity d.mjs walk', where: 'd.mjs:1-90' };
  const kept = { ...triage, items: { ...triage.items, [CLONE]: { decision: 'kept', reason: 'two adapters' }, [LONG.key]: { decision: 'kept', reason: 'tested, splits later' } } };
  assert.deepEqual(closingProblems(baseline, kept, [clone(1), LONG, repeat]), ['no fewer clone items than the baseline', 'no fewer complexity items than the baseline']);
  assert.deepEqual(closingProblems([...baseline, clone(30), other], { ...kept, items: { ...kept.items, [other.key]: { decision: 'fix', batch: 'complexity' } } }, [clone(1), clone(30), LONG, repeat]), ['no fewer clone items than the baseline']);
});

// Council r3 (sol-08): the member's two fixtures. A clone is the baseline's only in its own file pair, and each baseline
// occurrence covers one copy at the head: the same six lines moved to a new pair, or a second copy in a kept pair, need
// a disposition of their own.
test('sol-08 r3: a baseline clone\'s code in another file pair, or a second copy in its own pair, is new', () => {
  const six = (a, b, n, digest) => ({ kind: 'clone', key: `clone ${a} ~ ${b} (6 lines)`, area: 'x', files: [a, b], where: `${a}:${n}-${n + 5} and ${b}:${n}-${n + 5}`, digest });
  const ab = six('a.mjs', 'b.mjs', 10, 'd-ab');
  const cd = six('c.mjs', 'd.mjs', 10, 'd-cd');
  const kept = { decision: 'kept', reason: 'two adapters' };
  // 1. Both baseline pairs are kept; the head has only the a/b code, now in e.mjs ~ f.mjs, with no entry.
  const triage = { items: { [ab.key]: kept, [cd.key]: kept, [LONG.key]: { decision: 'fix', batch: 'complexity' } } };
  const moved = six('e.mjs', 'f.mjs', 30, 'd-ab');
  assert.deepEqual(closingProblems([ab, cd, LONG], triage, [moved]), [`new and not kept on its own entry with a reason: ${moved.key} (${moved.where})`]);
  // 2. Four baseline clones (two fixed, so clones still fall) and the long function; the head has the a/b clone twice,
  // at two places in a.mjs ~ b.mjs. One is the baseline's; the other is new.
  const ef = six('e.mjs', 'f.mjs', 1, 'd-ef');
  const gh = six('g.mjs', 'h.mjs', 1, 'd-gh');
  const four = { items: { ...triage.items, [ef.key]: { decision: 'fix', batch: 'duplication' }, [gh.key]: { decision: 'fix', batch: 'duplication' } } };
  const again = six('a.mjs', 'b.mjs', 50, 'd-ab');
  assert.deepEqual(closingProblems([ab, cd, ef, gh, LONG], four, [ab, again, cd]), [`new and not kept on its own entry with a reason: ${ab.key} (${again.where})`]);
  // Its own reason under `occurrences` covers it; the baseline's copies stay covered by the key's entry.
  four.items[ab.key] = { ...kept, occurrences: { 'd-ab': 'a second adapter of the same interface' } };
  assert.deepEqual(closingProblems([ab, cd, ef, gh, LONG], four, [ab, again, cd]), []);
});

// Council r3 (opus F13): the azure-pipelines repeat left the measurement when the constant it repeats stopped being a
// literal, while its own file was unchanged; the report called it fixed. A fix item gone from the head counts as fixed
// only if the branch changed one of its files, or the changed file its entry names as `fixedIn`.
test('F13: a fix item gone from the measurement while none of its files changed is not fixed, unless fixedIn names a changed file', () => {
  const repeat = { kind: 'repeat', key: "repeat ci/azure.mjs repeated-constant 'https://dev.azure.com' repeats the constant DEFAULT_URL, which hosts/azure.mjs", area: 'x', files: ['ci/azure.mjs'], where: 'ci/azure.mjs:20' };
  const baseline = [LONG, clone(1), repeat];
  const triage = (entry = {}) => ({ items: { ...fixTriage().items, [repeat.key]: { decision: 'fix', batch: 'r2', how: 'reads DEFAULT_URL', ...entry } } });
  // The long function and the clone are fixed in files the branch changed.
  const others = ['c.mjs', 'a.mjs', 'b.mjs'];
  const gone = `triaged fix and gone from the measurement, but none of its files changed: ${repeat.key}`;
  assert.deepEqual(closingProblems(baseline, triage(), [], { changed: [...others, 'hosts/azure.mjs'] }), [gone]);
  assert.deepEqual(closingProblems(baseline, triage(), [], { changed: [...others, 'ci/azure.mjs'] }), [], 'its file changed: fixed');
  assert.deepEqual(closingProblems(baseline, triage({ fixedIn: 'hosts/azure.mjs' }), [], { changed: [...others, 'hosts/azure.mjs'] }), [], 'fixed in the other declaration\'s file, which changed');
  assert.deepEqual(closingProblems(baseline, triage({ fixedIn: 'gate.mjs' }), [], { changed: [...others, 'hosts/azure.mjs'] }), [gone], 'a fixedIn that did not change proves nothing');
  // The page says so instead of "fixed", and its closing check lists it (council r4, TV-11).
  const page = markdown(baseline, triage(), [], { rows: [], limits: { maxCyclomatic: 15, maxFunctionLines: 100 }, changed: [...others, 'hosts/azure.mjs'] });
  assert.match(page, /reads DEFAULT_URL \| not measured: its files are unchanged since the base/);
  assert.ok(page.includes(`## Closing check\n\n- ${gone}`), 'the closing check on the page');
});

// Council r3 (opus F14): the literal is found after the rule's own words, so a string fallback (`repeated-default the
// fallback '<literal>'`) has no kind-level decision either; a number keeps the kind's reason.
test('F14: a string fallback is not kept by the repeat kind\'s reason; a number fallback is', () => {
  const fallback = (literal) => ({ kind: 'repeat', key: `repeat a.mjs repeated-default the fallback ${literal} repeats the default of implement:autoMerge:method, which config.json`, area: 'x', files: ['a.mjs'], where: 'a.mjs:9' });
  const squash = fallback("'squash'");
  const number = fallback('900');
  const triage = { kinds: { repeat: { decision: 'kept', reason: 'a number for another purpose' } }, items: fixTriage().items };
  assert.deepEqual(closingProblems([LONG, clone(1), squash, number], triage, [squash, number]), [`no decision with a reason: ${squash.key}`]);
});

// Council r3 (test-value follow-ups): a baseline key kept without a reason has no disposition; and a clone left of a
// key triaged fix is kept only by its digest, never by `keep.count` (which is for items without one).
test('a kept entry without a reason fails the check; keep.count does not cover a clone, its digest does', () => {
  const repeat = { kind: 'repeat', key: 'repeat a.mjs repeated-constant 600 repeats the constant LIMIT, which b.mjs', area: 'x', files: ['a.mjs'], where: 'a.mjs:3' };
  const baseline = [LONG, clone(1), repeat];
  assert.deepEqual(closingProblems(baseline, { items: { ...fixTriage().items, [repeat.key]: { decision: 'kept' } } }, [repeat]), [`no decision with a reason: ${repeat.key}`]);
  assert.deepEqual(closingProblems(baseline, { items: { ...fixTriage().items, [repeat.key]: { decision: 'kept', reason: 'a fetch limit' } } }, [repeat]), []);
  const a = { ...clone(1), digest: 'd-1' };
  const b = { ...clone(20), digest: 'd-2' };
  const twoClones = [a, b, LONG];
  assert.deepEqual(closingProblems(twoClones, fixTriage({ keep: { count: 1, reason: 'the adapter shape' } }), [b]), [`triaged fix but 1 of 2 left with no kept entry: ${CLONE}`], 'a count keeps no clone');
  assert.deepEqual(closingProblems(twoClones, fixTriage({ keep: { digests: ['d-2'], reason: 'the adapter shape' } }), [b]), []);
});

// Council r4 (sol-08 follow-up): the member's reproducer. A kept baseline clone at line 10 and an identical new
// occurrence at line 90, each with its reason: the page lists each under its own reason.
test('sol-08 r4: the page lists a new occurrence under its own reason and the baseline copy under the key\'s', () => {
  const key = 'clone a.mjs ~ b.mjs (6 lines)';
  const occ = (n) => ({ kind: 'clone', key, area: 'x', files: ['a.mjs', 'b.mjs'], where: `a.mjs:${n}-${n + 5} and b.mjs:${n}-${n + 5}`, digest: 'd-1' });
  const baseline = [occ(10), clone(1), clone(20), LONG];
  const triage = { items: { [key]: { decision: 'kept', reason: 'the adapters keep their own copy', occurrences: { 'd-1': 'a third adapter of the same interface' } }, [CLONE]: { decision: 'fix', batch: 'duplication' }, [LONG.key]: { decision: 'fix', batch: 'complexity' } } };
  const closing = [occ(10), occ(90)];
  assert.deepEqual(closingProblems(baseline, triage, closing), []);
  const page = markdown(baseline, triage, closing);
  assert.match(page, /the adapters keep their own copy\.\n\n<details>\n\n- `a\.mjs:10-15 and b\.mjs:10-15`/);
  assert.match(page, /a third adapter of the same interface\.\n\n<details>\n\n- `a\.mjs:90-95 and b\.mjs:90-95`/);
});
