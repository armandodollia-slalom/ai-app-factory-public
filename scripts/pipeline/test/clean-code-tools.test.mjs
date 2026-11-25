// GEN-17: jscpd and lizard run by default in the analysis gate, report only the duplication and complexity a change
// adds, and hand it to the clean-code reviewer as evidence that never blocks by itself; each run records the counts.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { changeRepo, runGate, tmp, write } from './gate-repo.mjs';

process.env.FACTORY_CACHE_DIR = tmp('fcache-');
for (const k of ['FACTORY_METRICS_SHARD', 'FACTORY_METRICS_SPOOL']) process.env[k] = '0';
const { evidenceText, toolFindings } = await import('../lib/analysis/report.mjs');
const { recordAnalysis } = await import('../lib/analysis/fixloop.mjs');
const { councilFor, memberTask, mergeCouncil } = await import('../lib/council.mjs');
const { readJsonl } = await import('../lib/util.mjs');

const INSTALL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
// lizard is a Python tool the factory does not ship: the repository's own virtual environment, PATH, or FACTORY_LIZARD.
const LIZARD = [process.env.FACTORY_LIZARD, path.join(INSTALL, '.venv/bin/lizard')].find((p) => p && fs.existsSync(p)) ?? (spawnSync('lizard', ['--version']).status === 0 ? 'lizard' : null);

const TOTAL = `export function total(items, discount) {
  let sum = 0;
  for (const item of items) {
    if (item.quantity > 0 && item.price > 0) {
      sum += item.price * item.quantity;
    }
  }
  const after = sum - sum * discount;
  return Math.round(after * 100) / 100;
}
`;
// A repository on main, a branch with the change, and the gate of the given tools.
function gateRepo(t, { base, change, tools, analysis = {} }) {
  const root = changeRepo(t, { base, change, prefix: 'cc-tools-' });
  const config = { root, mainRoot: root, stateDir: '.factory/state', metricsDir: '.factory/metrics', project: { languages: [] }, featureVerification: { precheck: {} }, analysis: { stages: { story: tools }, ...analysis } };
  return { root, config, run: () => runGate(config) };
}

test('a change that copies a block from an existing file: jscpd reports the clone at the new copy, with both places', async (t) => {
  const r = gateRepo(t, { base: { 'src/order.js': `// order\n${TOTAL}`, 'src/cart.js': '// cart\n' }, change: { 'src/cart.js': `// cart\nconst x = 1;\n${TOTAL.replace('total', 'cartTotal')}` }, tools: ['jscpd'] });
  const report = await r.run();
  assert.deepEqual(report.cleanCode.map((f) => [f.tool, f.rule, f.file, f.line]), [['jscpd', 'code-clone', 'src/cart.js', 3]], JSON.stringify(report.tools));
  assert.match(report.cleanCode[0].message, /duplicated between src\/order\.js:2-11 and src\/cart\.js:3-12|duplicated between src\/cart\.js:3-12 and src\/order\.js:2-11/);
  // Evidence, never a harness finding: no fix bounce, nothing blocks on the tool alone.
  assert.deepEqual([report.findings, toolFindings(report)], [[], []]);
});

test('old duplication the change does not touch is not reported', async (t) => {
  const r = gateRepo(t, { base: { 'src/order.js': `// order\n${TOTAL}`, 'src/legacy.js': `// legacy\n${TOTAL.replace('total', 'legacyTotal')}`, 'src/cart.js': '// cart\n' }, change: { 'src/cart.js': '// cart\nexport const empty = [];\n' }, tools: ['jscpd'] });
  const report = await r.run();
  assert.equal(report.tools.find((x) => x.id === 'jscpd').status, 'ok');
  assert.deepEqual(report.cleanCode, []);
});

// Council r1 (cc-9): the tool scripts judge the lines the change adds or edits since the base, not the files it touches.
test('an edit elsewhere in a file with an old clone or an old over-limit function reports neither', async (t) => {
  if (LIZARD) {
    process.env.FACTORY_LIZARD = LIZARD;
    t.after(() => delete process.env.FACTORY_LIZARD);
  }
  const branchy = ['export function grade(score) {', ...[1, 2, 3, 4, 5].map((n) => `  if (score === ${n}) return 'g${n}';`), "  return 'none';", '}', ''].join('\n');
  const legacy = `// legacy\n${TOTAL.replace('total', 'legacyTotal')}${branchy}`;
  const tools = LIZARD ? ['jscpd', 'lizard'] : ['jscpd'];
  const r = gateRepo(t, { base: { 'src/order.js': `// order\n${TOTAL}`, 'src/legacy.js': legacy }, change: { 'src/legacy.js': `${legacy}export const empty = [];\n` }, tools, analysis: { complexity: { maxCyclomatic: 3 } } });
  const report = await r.run();
  assert.deepEqual(report.tools.map((x) => [x.id, x.status]), tools.map((id) => [id, 'ok']));
  assert.deepEqual(report.cleanCode, [], JSON.stringify(report.cleanCode));
});

// Council r1 (cc-8): the generator's report reads the gate's tool scripts' `--json` output through a pipe; output over
// 8 KB came back cut (process.exit right after the write).
test('complexity.mjs --json gives every item whole through a pipe, past 8 KB', { skip: LIZARD ? false : 'lizard is not installed (pip install lizard, or FACTORY_LIZARD)' }, (t) => {
  const root = tmp('cc-json-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const fn = (i) => [`export function grade${i}(score) {`, ...[1, 2, 3, 4, 5].map((n) => `  if (score === ${n}) return 'g${n}';`), "  return 'none';", '}'].join('\n');
  write(root, 'src/grades.js', `${Array.from({ length: 80 }, (_, i) => fn(i)).join('\n')}\n`);
  const r = spawnSync(process.execPath, [path.join(INSTALL, 'packs/security/analysis/complexity.mjs'), '--max-cyclomatic', '3', '--max-lines', '100', '--json', 'src/grades.js'], { cwd: root, encoding: 'utf8', env: { ...process.env, FACTORY_LIZARD: LIZARD } });
  assert.equal(r.status, 1, r.stderr);
  assert.ok(r.stdout.length > 8192, `${r.stdout.length} bytes`);
  const items = JSON.parse(r.stdout);
  assert.equal(items.length, 80);
  assert.deepEqual(Object.keys(items[0]).filter((k) => ['name', 'start', 'end', 'ccn', 'length'].includes(k)).sort(), ['ccn', 'end', 'length', 'name', 'start']);
});

test('a function the change adds above analysis.complexity.maxCyclomatic: lizard reports it; one under the limit is not', { skip: LIZARD ? false : 'lizard is not installed (pip install lizard, or FACTORY_LIZARD)' }, async (t) => {
  process.env.FACTORY_LIZARD = LIZARD;
  t.after(() => delete process.env.FACTORY_LIZARD);
  const branchy = ['export function grade(score) {', ...[1, 2, 3, 4, 5].map((n) => `  if (score === ${n}) return 'g${n}';`), "  return 'none';", '}', ''].join('\n');
  const r = gateRepo(t, { base: { 'src/grade.js': '// grade\n' }, change: { 'src/grade.js': `// grade\n${branchy}export const one = (a) => a + 1;\n` }, tools: ['lizard'], analysis: { complexity: { maxCyclomatic: 4, maxFunctionLines: 100 } } });
  const report = await r.run();
  assert.deepEqual(report.cleanCode.map((f) => [f.tool, f.rule, f.file]), [['lizard', 'high-complexity', 'src/grade.js']], JSON.stringify(report.tools));
  assert.match(report.cleanCode[0].message, /grade \(src\/grade\.js:2-9\) has a cyclomatic complexity of 6, over 4/);
});

test('the clean-code member\'s task carries the reports as evidence; dismissed with a reason, nothing blocks', async (t) => {
  const r = gateRepo(t, { base: { 'src/order.js': `// order\n${TOTAL}`, 'src/cart.js': '// cart\n' }, change: { 'src/cart.js': `// cart\nconst x = 1;\n${TOTAL.replace('total', 'cartTotal')}` }, tools: ['jscpd'] });
  const report = await r.run();
  const council = councilFor({}, 'architectureReview');
  const seat = council.members.find((m) => m.fixed);
  // The stage's task carries the analysis evidence (review.mjs, the pair verifier and the PR check add evidenceText).
  const task = memberTask(`REVIEW TASK\n\n${evidenceText(report)}`, { council, member: seat, round: 1, skill: '' });
  assert.match(task, /Clean-code evidence \(tool reports on this change; not findings[\s\S]*- jscpd code-clone src\/cart\.js:3: /);
  assert.match(task, /uphold each item as your own finding, or list it in `dismissed`\s+\(`\[{"evidence": "<the tool item>", "reason": "<why it is not a problem>"}\]`/);
  // The member dismisses it: no finding of its own, so the round passes on the tool's report.
  const ok = (m, extra = {}) => ({ member: m, status: 'ok', score: 10, verdict: 'APPROVED', summary: '', findings: [], ...extra });
  const merged = mergeCouncil(council, [ok(council.members[0]), ok(seat, { dismissed: [{ evidence: 'jscpd code-clone src/cart.js:3', reason: 'the cart and the order total change for different reasons' }] })]);
  assert.deepEqual([merged.pass, merged.findings], [true, []]);
});

test('each run records the clean-code counts per ticket', (t) => {
  const root = tmp('cc-counts-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = { root, mainRoot: root, stateDir: '.factory/state', metricsDir: '.factory/metrics' };
  const item = (tool, rule) => ({ tool, rule, file: 'src/a.js', line: 1, message: 'm' });
  const report = { slot: 'story', sha: 'abc', tools: [], findings: [], preexisting: [], cleanCode: [item('jscpd', 'code-clone'), item('jscpd', 'code-clone'), item('lizard', 'high-complexity'), item('lizard', 'long-function'), item('repeated-values-typescript', 'repeated-default')] };
  recordAnalysis(config, { story: 'S-1', stage: 'story', report });
  assert.deepEqual(readJsonl(path.join(root, '.factory/metrics/analysis-runs.jsonl')).map((x) => [x.story, x.cleanCode]), [['S-1', { clones: 2, breaches: 2, repeats: 1 }]]);
});

test('the settings reference lists the three limits with their defaults and allowed values', () => {
  const reference = fs.readFileSync(path.join(INSTALL, 'docs/configuration.md'), 'utf8');
  for (const [name, def, allowed] of [['analysis.duplication.minTokens', '`50`', 'from 10 to 1000 tokens'], ['analysis.complexity.maxCyclomatic', '`15`', 'from 1 to 100'], ['analysis.complexity.maxFunctionLines', '`100`', 'from 5 to 2000 lines']]) {
    const row = reference.split('\n').find((l) => l.startsWith(`| \`${name}\` |`));
    assert.ok(row?.includes(def) && row.includes(allowed), `${name}: ${row}`);
  }
});

// Council r1 (sol-06): a lizard that cannot run, or fails, is a tool failure, never "no findings".
test('sol-06: a lizard that fails is reported as the tool\'s error in the gate', async (t) => {
  const r = gateRepo(t, { base: { 'src/grade.js': '// grade\n' }, change: { 'src/grade.js': '// grade\nexport const one = (a) => a + 1;\n' }, tools: ['lizard'] });
  for (const bin of ['/usr/bin/false', path.join(r.root, 'not-executable.txt')]) {
    fs.writeFileSync(path.join(r.root, 'not-executable.txt'), 'x');
    process.env.FACTORY_LIZARD = bin;
    try {
      const report = await r.run();
      const tool = report.tools.find((x) => x.id === 'lizard');
      assert.equal(tool.status, 'error', `${bin}: ${JSON.stringify(tool)}`);
    } finally {
      delete process.env.FACTORY_LIZARD;
    }
  }
});

// Council r1 (sol-09): the duplication scanner leaves no report folder behind, with findings or without.
test('sol-09: jscpd\'s report folder is removed after every run', async (t) => {
  const tmpdir = tmp('cc-tmpdir-');
  t.after(() => fs.rmSync(tmpdir, { recursive: true, force: true }));
  const r = gateRepo(t, { base: { 'src/order.js': `// order\n${TOTAL}`, 'src/cart.js': '// cart\n' }, change: { 'src/cart.js': `// cart\nconst x = 1;\n${TOTAL.replace('total', 'cartTotal')}` }, tools: ['jscpd'] });
  for (const files of [['src/cart.js'], []]) {
    const run = spawnSync(process.execPath, [path.join(INSTALL, 'packs/security/analysis/duplication.mjs'), '--min-tokens', '50', '--base', 'main', ...files], { cwd: r.root, encoding: 'utf8', env: { ...process.env, TMPDIR: tmpdir } });
    assert.ok([0, 1].includes(run.status), run.stderr);
    assert.deepEqual(fs.readdirSync(tmpdir).filter((f) => f.startsWith('factory-jscpd-')), [], `after a run on ${files.join(', ') || 'nothing'}`);
  }
});

// Council r1 (test-value follow-up): lizard's CSV and the two limits, with no lizard installed (a fixture of its output).
test('parseLizardCsv reads lizard\'s rows (a quoted long name with commas too); breachesInChange reports each limit a changed function is over', async () => {
  const { parseLizardCsv, breachesInChange } = await import('../lib/analysis/clean-code-tools.mjs');
  const csv = [
    'NLOC,CCN,token,PARAM,length,location,file,function,long_name,start,end', // a header, if lizard prints one
    '110,3,900,2,120,"render@10-129@src/a.js","src/a.js","render","render( items , opts )",10,129',
    '40,22,300,1,45,"route@140-184@src/a.js","src/a.js","route","route( req )",140,184',
    '130,30,1200,0,140,"main@200-339@src/a.js","src/a.js","main","main( )",200,339',
    '12,2,80,1,12,"small@350-361@src/a.js","src/a.js","small","small( x )",350,361',
    '95,15,700,0,100,"edge@400-499@src/a.js","src/a.js","edge","edge( )",400,499', // at both limits: not over
    '105,4,700,0,110,"legacy@5-114@src/old.js","src/old.js","legacy","legacy( )",5,114',
    'WARNING: could not parse src/broken.js',
  ].join('\n');
  const fns = parseLizardCsv(csv);
  assert.deepEqual(fns.map((f) => [f.name, f.file, f.ccn, f.length, f.start, f.end]), [
    ['render', 'src/a.js', 3, 120, 10, 129], ['route', 'src/a.js', 22, 45, 140, 184], ['main', 'src/a.js', 30, 140, 200, 339], ['small', 'src/a.js', 2, 12, 350, 361], ['edge', 'src/a.js', 15, 100, 400, 499], ['legacy', 'src/old.js', 4, 110, 5, 114],
  ]);
  // The change touches lines 50, 150, 250, 355 and 450 of src/a.js; src/old.js not at all.
  const changed = new Map([['src/a.js', new Set([50, 150, 250, 355, 450])], ['src/old.js', new Set()]]);
  const found = breachesInChange(fns, changed, { maxCyclomatic: 15, maxFunctionLines: 100 });
  assert.deepEqual(found.map((f) => [f.rule, f.file, f.line, f.name]), [
    ['long-function', 'src/a.js', 50, 'render'],
    ['high-complexity', 'src/a.js', 150, 'route'],
    ['high-complexity', 'src/a.js', 250, 'main'],
    ['long-function', 'src/a.js', 250, 'main'],
  ]);
  assert.match(found[0].message, /render \(src\/a\.js:10-129\) is 120 lines long, over 100 \(CC-5/);
  // A file the base does not have is the change's whole: its functions over a limit are reported at their first line.
  assert.deepEqual(breachesInChange(fns, new Map([['src/old.js', null]]), { maxCyclomatic: 15, maxFunctionLines: 100 }).map((f) => [f.rule, f.line]), [['long-function', 5]]);
});
