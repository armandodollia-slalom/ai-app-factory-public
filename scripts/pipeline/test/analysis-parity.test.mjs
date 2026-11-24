// Local and CI analysis reach the same verdict on the same tree: the local slot (runSlot, what the pair, story, PR check
// and delivery slots run) and the generated CI job script (.factory/bin/analysis/ci.mjs as `factory render` writes it,
// the file every CI system calls) run on the same fixture trees, and any disagreement on a finding fails the test.
// Trees: a new secret, a base value copied (EVT-1), a new value sharing the match span with a base value (HINT-1, C20),
// an allow-listed value, a placeholder with the factory's marker, a base that moved on and fixed a finding after the
// branch started, and a finding off the changed lines of a changed file.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const tmp = (p) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));
process.env.FACTORY_CACHE_DIR = tmp('fcache-');
const INSTALL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const { runSlot } = await import('../lib/analysis/runner.mjs');
const { resolveAnalysis } = await import('../lib/analysis/config.mjs');
const { ciOutputs } = await import('../lib/analysis/ci.mjs');

// Fake values only. GUID_MAIN: a sample token on main; USER: a user id on main (a scenario row); NEW_TOKEN: a new one.
const GUID_MAIN = '0f0e0d0c-1111-4222-8333-944445555666';
const USER = '7a6b5c4d-2222-4333-8444-a55556666777';
const NEW_TOKEN = 'tok_Q8w2Er4Ty6Ui8Op0';
const ALLOWED = 'tok_demoAllowed000001';
const MARKED = 'tok_factoryfake0001x';

const gitIn = (cwd) => (...args) => {
  const r = spawnSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', '-c', 'core.hooksPath=/dev/null', ...args], { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};
const write = (root, rel, text) => (fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }), fs.writeFileSync(path.join(root, rel), text));

// A secret scanner in the shape of Betterleaks: git mode reads the added lines of the commits of {range}, dir mode the
// given files; the secret is the last token-like value on the line, the span runs from the line's start to its end;
// values holding a word of FAKE_ALLOW (its allow-list, from the tool's env) are not reported. SARIF, value redacted.
const SCANNER = `import fs from 'node:fs'; import { execSync } from 'node:child_process';
const [mode, out, ...rest] = process.argv.slice(2);
const RX = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|tok_[A-Za-z0-9]{12,}/g;
const allow = (process.env.FAKE_ALLOW ?? '').split(',').filter(Boolean);
const results = [];
const add = (file, line, text, commit) => { const all = [...text.matchAll(RX)]; if (!all.length) return; const m = all.at(-1); if (allow.some((w) => m[0].includes(w))) return; results.push({ ruleId: 'generic-api-key', level: 'error', message: { text: 'generic-api-key has detected secret for file ' + file }, locations: [{ physicalLocation: { artifactLocation: { uri: file }, region: { startLine: line, startColumn: 1, endLine: line, endColumn: m.index + m[0].length + 1, snippet: { text: 'REDACTED' } } } }], partialFingerprints: { commitSha: commit } }); };
if (mode === 'git') {
  for (const c of execSync('git rev-list ' + rest[0], { encoding: 'utf8' }).split('\\n').filter(Boolean)) {
    let file = null; let ln = 0;
    for (const l of execSync('git show --format= -U0 ' + c, { encoding: 'utf8' }).split('\\n')) {
      if (l.startsWith('+++ ')) { file = l.startsWith('+++ b/') ? l.slice(6) : null; continue; }
      const h = /^@@ -\\S+ \\+(\\d+)/.exec(l); if (h) { ln = Number(h[1]); continue; }
      if (l.startsWith('+') && file) { add(file, ln, l.slice(1), c); ln++; }
    }
  }
} else for (const f of rest) fs.readFileSync(f, 'utf8').split('\\n').forEach((t, i) => add(f, i + 1, t, ''));
fs.writeFileSync(out, JSON.stringify({ version: '2.1.0', runs: [{ tool: { driver: { name: 'fake', rules: [] } }, results }] }));
`;
// A line-rule linter: every line of the given files holding TODO-SEC.
const MARKS = `import fs from 'node:fs';
const [out, ...files] = process.argv.slice(2);
const results = [];
for (const f of files) { try { fs.readFileSync(f, 'utf8').split('\\n').forEach((t, i) => { if (t.includes('TODO-SEC')) results.push({ ruleId: 'todo-sec', level: 'error', message: { text: 'TODO-SEC left in' }, locations: [{ physicalLocation: { artifactLocation: { uri: f }, region: { startLine: i + 1 } } }] }); }); } catch {} }
fs.writeFileSync(out, JSON.stringify({ version: '2.1.0', runs: [{ tool: { driver: { name: 'marks', rules: [] } }, results }] }));
`;

function setup() {
  const root = tmp('parity-');
  const git = gitIn(root);
  const scan = path.join(root, '..', `scan-${path.basename(root)}.mjs`);
  const marks = path.join(root, '..', `marks-${path.basename(root)}.mjs`);
  fs.writeFileSync(scan, SCANNER);
  fs.writeFileSync(marks, MARKS);
  const leaks = { licence: 'MIT', run: [process.execPath, scan, 'git', '{out}', '{range}'], worktreeRun: [process.execPath, scan, 'dir', '{out}', '{files}'], output: '{out}', parse: 'sarif', scope: 'repo', baseline: 'native', lens: 'security', block: { rules: ['*'] }, okExit: [0], env: { FAKE_ALLOW: `${ALLOWED},factoryfake` } };
  const lint = { licence: 'MIT', run: [process.execPath, marks, '{out}', '{files}'], output: '{out}', parse: 'sarif', scope: 'changed-lines', baseline: 'lines', lens: 'security', block: { rules: ['*'] }, okExit: [0] };
  const analysis = { tools: { leaks, lint }, stages: { story: ['leaks', 'lint'] }, ci: { jobs: [{ id: 'secrets', name: 'Secret scan', tools: ['leaks'] }, { id: 'lint', name: 'Line rules', tools: ['lint'] }] } };
  const config = { root, mainRoot: root, stateDir: '.factory/state', metricsDir: '.factory/metrics', baseRef: 'main', project: { languages: [] }, featureVerification: { precheck: {} }, analysis };
  git('init', '-q', '-b', 'main');
  write(root, '.gitignore', '.factory/state/\n');
  write(root, 'src/Client/appsettings.json', `{ "ClientOptions": { "Token": "${GUID_MAIN}" } }\n`);
  write(root, 'scenarios/users.sql', `INSERT INTO users VALUES ('${USER}', 'alice');\n`);
  write(root, 'src/shared.txt', 'one\nTODO-SEC old\nthree\n');
  const resolved = resolveAnalysis(config, { installRoot: INSTALL });
  for (const o of ciOutputs(config, { provider: 'github-actions', installRoot: INSTALL, resolved })) if (o.path) write(root, o.path, o.content);
  git('add', '-A');
  git('commit', '-qm', 'base');
  return { root, git, config, resolved };
}

// Both verdicts on the checked-out tree: { local, ci } as sorted lists of "verdict tool rule file:line".
async function both(s, base = 'main') {
  const report = await runSlot(s.config, 'story', { cwd: s.root, base, resolved: s.resolved });
  assert.equal(report.tree.state, 'clean', 'parity is judged on committed trees (what is pushed)');
  const local = [
    ...report.findings.map((f) => `${f.severity === 'blocking' ? 'blocking' : 'introduced'} ${f.tool} ${f.rule} ${f.file}:${f.line}`),
    ...report.preexisting.map((f) => `preexisting ${f.tool} ${f.rule} ${f.file}:${f.line}`),
  ].sort();
  const ci = [];
  let failed = false;
  for (const job of ['secrets', 'lint']) {
    const out = path.join(s.root, '..', `ci-${path.basename(s.root)}-${job}.json`);
    const r = spawnSync(process.execPath, ['.factory/bin/analysis/ci.mjs', '--job', job, '--base', base, '--json', out], { cwd: s.root, encoding: 'utf8' });
    const j = JSON.parse(fs.readFileSync(out, 'utf8'));
    assert.ok(!j.findings.some((f) => f.verdict === 'error'), `${job} ran: ${r.stdout}${r.stderr}`);
    assert.equal(r.status !== 0, j.failed, 'exit status and verdict agree');
    failed ||= j.failed;
    ci.push(...j.findings.map((f) => `${f.verdict} ${f.tool} ${f.rule} ${f.file}:${f.line}`));
  }
  const text = JSON.stringify({ local, ci });
  assert.ok(![GUID_MAIN, USER, NEW_TOKEN].some((v) => text.includes(v)), 'no value in a verdict');
  return { local, ci: ci.sort(), failed, report };
}

function onBranch(s, name, files, { from = 'main' } = {}) {
  s.git('checkout', '-q', '-B', name, from);
  for (const [rel, text] of Object.entries(files)) write(s.root, rel, text);
  s.git('add', '-A');
  s.git('commit', '-qm', name);
}

test('local slot and CI script agree on every fixture tree, finding by finding', async () => {
  const s = setup();
  const cases = [
    { name: 'new-secret', files: { 'src/Client/other.json': `{ "Token": "${NEW_TOKEN}" }\n` }, expect: ['blocking leaks generic-api-key src/Client/other.json:1'], failed: true },
    { name: 'base-value-copied', files: { 'docs/plan.md': `Use ClientOptions__Token: ${GUID_MAIN} as configured.\n` }, expect: ['preexisting leaks generic-api-key docs/plan.md:1'], failed: false },
    { name: 'shares-span-hint-1', files: { 'scenarios/hint-1.sql': `INSERT INTO webhooks VALUES ('${USER}', '${NEW_TOKEN}');\n` }, expect: ['blocking leaks generic-api-key scenarios/hint-1.sql:1'], failed: true },
    // The recorded HINT-1 line (held-out C20): the scanner's keyword came from a hand-made fake value and its matched
    // secret is the user id that main already holds; pre-existing on both sides (CI blocked it before: no value rule).
    { name: 'hint-1-recorded-shape', files: { 'scenarios/hint-1b.sql': `INSERT INTO webhooks VALUES (1, 'https://example.test/hook', 'fake-token-1a2b', '${USER}'),\n` }, expect: ['preexisting leaks generic-api-key scenarios/hint-1b.sql:1'], failed: false },
    { name: 'allow-listed', files: { 'tests/seed.sql': `INSERT INTO webhooks VALUES ('${ALLOWED}');\n` }, expect: [], failed: false },
    { name: 'factory-marker', files: { 'tests/seed2.sql': `INSERT INTO webhooks VALUES ('${MARKED}');\n` }, expect: [], failed: false },
    { name: 'off-changed-line', files: { 'src/shared.txt': 'one changed\nTODO-SEC old\nthree\n' }, expect: ['preexisting lint todo-sec src/shared.txt:2'], failed: false },
    { name: 'new-on-changed-line', files: { 'src/shared.txt': 'one\nTODO-SEC old\nTODO-SEC new\n' }, expect: ['blocking lint todo-sec src/shared.txt:3', 'preexisting lint todo-sec src/shared.txt:2'], failed: true },
  ];
  for (const c of cases) {
    onBranch(s, `feat/${c.name}`, c.files);
    const v = await both(s);
    assert.deepEqual(v.local, v.ci, `${c.name}: local and CI disagree`);
    assert.deepEqual(v.ci, [...c.expect].sort(), `${c.name}: the verdict`);
    assert.equal(v.failed, c.failed, `${c.name}: the job's exit`);
  }
});

test('a base that moved on after the branch started is judged from the merge-base on both sides', async () => {
  const s = setup();
  onBranch(s, 'feat/moved', { 'src/new.txt': 'clean\n' });
  // main fixes the old TODO-SEC line after the branch started: measured from main's tip, the branch's untouched line
  // would look changed (and its finding introduced); from the merge-base it is not.
  s.git('checkout', '-q', 'main');
  write(s.root, 'src/shared.txt', 'one\nfixed\nthree\n');
  s.git('commit', '-qam', 'main fixes it');
  s.git('checkout', '-q', 'feat/moved');
  const v = await both(s);
  assert.deepEqual(v.local, v.ci);
  assert.deepEqual(v.ci, []);
  assert.equal(v.failed, false);
});

test('the rendered CI data carries each tool\'s scope and whether its findings are secret values; the decision file is rendered', () => {
  const s = setup();
  const data = JSON.parse(fs.readFileSync(path.join(s.root, '.factory/bin/analysis/jobs.json'), 'utf8'));
  assert.equal(data.tools.leaks.scope, 'repo');
  assert.equal(data.tools.leaks.secretValues, true);
  assert.equal(data.tools.lint.scope, 'changed-lines');
  assert.equal(data.tools.lint.secretValues, undefined);
  const decide = fs.readFileSync(path.join(s.root, '.factory/bin/analysis/decide.mjs'), 'utf8');
  assert.equal(decide.replace(/^\/\/ Generated by `factory render`\. Do not edit\.\n/, ''), fs.readFileSync(path.join(INSTALL, 'scripts/pipeline/lib/analysis/decide.mjs'), 'utf8'), 'CI runs the same decision file');
  const ci = fs.readFileSync(path.join(s.root, '.factory/bin/analysis/ci.mjs'), 'utf8');
  assert.match(ci, /import \{ changedMap, decide \} from '\.\/decide\.mjs'/);
  assert.doesNotMatch(ci, /classify\(/, 'no second classification in the CI script');
});

// ---- SAST in a repository that installs git hooks (held-out C21) ---------------------------------------------------------
// A SAST tool in the shape of Opengrep's --baseline-commit: it checks the baseline out in its own git worktree (under the
// temporary folder), compares, then removes that worktree without --force. The repository installs hooks
// (core.hooksPath) whose post-checkout writes a file: run with the repository's hooks, the tool's worktree is dirty, the
// remove fails ("Could not remove git worktree") and no SARIF is written, so the job could not run. LEAVE=1: the tool
// leaves its worktree behind.
const GREP = `import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import { execFileSync } from 'node:child_process';
const [out, baseline] = process.argv.slice(2);
const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'og-'));
fs.rmSync(wt, { recursive: true, force: true });
execFileSync('git', ['worktree', 'add', '--detach', '--quiet', wt, baseline]);
const hits = (dir) => { const r = []; const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { if (e.name === '.git' || e.name === '.factory') continue; const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else fs.readFileSync(p, 'utf8').split('\\n').forEach((t, i) => { if (t.includes('EVAL(')) r.push(path.relative(dir, p) + ':' + (i + 1) + ':' + t.trim()); }); } }; walk(dir); return r; };
const before = new Set(hits(wt).map((h) => h.split(':').slice(2).join(':') + '@' + h.split(':')[0]));
const results = hits(process.cwd()).filter((h) => !before.has(h.split(':').slice(2).join(':') + '@' + h.split(':')[0])).map((h) => { const [file, line] = h.split(':'); return { ruleId: 'eval-call', level: 'error', message: { text: 'eval' }, locations: [{ physicalLocation: { artifactLocation: { uri: file }, region: { startLine: Number(line) } } }] }; });
if (process.env.LEAVE !== '1') { try { execFileSync('git', ['worktree', 'remove', wt], { stdio: 'pipe' }); } catch { console.error('Could not remove git worktree ' + wt); process.exit(2); } }
fs.writeFileSync(out, JSON.stringify({ version: '2.1.0', runs: [{ tool: { driver: { name: 'grep', rules: [] } }, results }] }));
`;

function setupSast({ leave = false } = {}) {
  const root = tmp('parity-sast-');
  const git = gitIn(root);
  const grep = path.join(root, '..', `grep-${path.basename(root)}.mjs`);
  fs.writeFileSync(grep, GREP);
  const sast = { licence: 'MIT', run: [process.execPath, grep, '{out}', '{mergeBase}'], output: '{out}', parse: 'sarif', scope: 'repo', baseline: 'native', lens: 'security', block: { rules: ['*'] }, okExit: [0], ...(leave ? { env: { LEAVE: '1' } } : {}) };
  const analysis = { tools: { sast }, stages: { story: ['sast'] }, ci: { jobs: [{ id: 'sast', name: 'Security patterns (SAST)', tools: ['sast'] }] } };
  const config = { root, mainRoot: root, stateDir: '.factory/state', metricsDir: '.factory/metrics', baseRef: 'main', project: { languages: [] }, featureVerification: { precheck: {} }, analysis };
  git('init', '-q', '-b', 'main');
  write(root, '.gitignore', '.factory/state/\n');
  write(root, 'src/app.js', 'EVAL(old)\n');
  write(root, '.githooks/post-checkout', '#!/bin/sh\necho hook > hook-was-here.txt\n');
  fs.chmodSync(path.join(root, '.githooks/post-checkout'), 0o755);
  const resolved = resolveAnalysis(config, { installRoot: INSTALL });
  for (const o of ciOutputs(config, { provider: 'github-actions', installRoot: INSTALL, resolved })) if (o.path) write(root, o.path, o.content);
  git('add', '-A');
  git('commit', '-qm', 'base');
  // The repository installs its hooks, as the test repository does (core.hooksPath .factory/githooks).
  spawnSync('git', ['config', 'core.hooksPath', '.githooks'], { cwd: root });
  onBranch({ root, git }, 'feat/sast', { 'src/app.js': 'EVAL(old)\nEVAL(new)\n' });
  return { root, git, config, resolved };
}
const worktrees = (root) => spawnSync('git', ['worktree', 'list', '--porcelain'], { cwd: root, encoding: 'utf8' }).stdout.split('\n').filter((l) => l.startsWith('worktree ')).length;

test('SAST with the repository\'s hooks installed: the local slot, CI\'s script and the pre-push gate run it and agree', async () => {
  const s = setupSast();
  const report = await runSlot(s.config, 'story', { cwd: s.root, base: 'main', resolved: s.resolved });
  assert.ok(!(report.errors ?? []).length && !(report.tools ?? []).some((t) => /error|missing/.test(t.status ?? '')), `the local slot ran the tool: ${JSON.stringify(report.tools ?? report.errors)}`);
  const local = report.findings.map((f) => `${f.tool} ${f.rule} ${f.file}:${f.line}`).sort();
  const out = path.join(s.root, '..', `ci-${path.basename(s.root)}-sast.json`);
  const r = spawnSync(process.execPath, ['.factory/bin/analysis/ci.mjs', '--job', 'sast', '--base', 'main', '--json', out], { cwd: s.root, encoding: 'utf8' });
  const j = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.ok(!j.findings.some((f) => f.verdict === 'error'), `CI's job ran: ${r.stdout}${r.stderr}`);
  const ci = j.findings.filter((f) => f.verdict === 'blocking').map((f) => `${f.tool} ${f.rule} ${f.file}:${f.line}`).sort();
  assert.deepEqual(local, ['sast eval-call src/app.js:2']);
  assert.deepEqual(ci, local, 'local and CI agree on SAST');
  // The pre-push gate runs CI's job on a clean checkout of HEAD: it ran (not "could not run here") and blocks the finding.
  const { runAnalysisJobs } = await import('../../implement/lib/analysis-gate.mjs');
  const [gate] = runAnalysisJobs(s.root, 'main', { cacheDir: process.env.FACTORY_CACHE_DIR });
  assert.equal(gate.unverified, undefined, `the gate ran SAST: ${gate.output}`);
  assert.equal(gate.ok, false);
  assert.deepEqual(gate.findings.filter((f) => f.verdict === 'blocking').map((f) => `${f.file}:${f.line}`), ['src/app.js:2']);
  assert.equal(worktrees(s.root), 1, 'no worktree left behind');
});

test('a tool that leaves its own worktree behind: it is removed after the tool, here and in CI\'s script', async () => {
  const s = setupSast({ leave: true });
  await runSlot(s.config, 'story', { cwd: s.root, base: 'main', resolved: s.resolved });
  assert.equal(worktrees(s.root), 1, 'the local slot removed it');
  const out = path.join(s.root, '..', `ci-leave-${path.basename(s.root)}.json`);
  const r = spawnSync(process.execPath, ['.factory/bin/analysis/ci.mjs', '--job', 'sast', '--base', 'main', '--json', out], { cwd: s.root, encoding: 'utf8' });
  assert.match(r.stdout, /removed the git worktree it left behind/);
  assert.equal(worktrees(s.root), 1, 'CI\'s script removed it');
});
