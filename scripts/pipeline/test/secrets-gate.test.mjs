// Secret findings in the held-out C19 shape (EVT-1): a sample token already on main copied into a test plan, a plan not
// committed yet while a scan ran, a value that reached a commit and stayed in unpushed history. With a fake scanner
// that reads commits (git mode, SARIF with the commit and the match's columns, value redacted) and files (dir mode).
// Covers: dirty-tree scans (every slot goes through runSlot/reportFor/fixLoop), values already on the base, the
// harness's commit gate, the deterministic fold of unpushed history, and the delivery's refusal to push a held file.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const tmp = (p) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));
process.env.FACTORY_CACHE_DIR = tmp('fcache-');

const { runSlot } = await import('../lib/analysis/runner.mjs');
const { reportFor, recordAnalysis } = await import('../lib/analysis/fixloop.mjs');
const { readReport, writeReport, evidenceText } = await import('../lib/analysis/report.mjs');
const { valueCandidates } = await import('../lib/analysis/secrets.mjs');
const { scanStaged, gateStaged, heldSecrets } = await import('../lib/analysis/commit-gate.mjs');
const { dropUnpushedSecrets } = await import('../lib/analysis/history.mjs');
const { resolveAnalysis } = await import('../lib/analysis/config.mjs');
const { readMetricsLocal } = await import('../lib/state.mjs');

// Obviously fake values in the shape of the sample token (a GUID).
const ON_MAIN = '0f0e0d0c-1111-4222-8333-944445555666';
const NEW_ONE = 'a1b2c3d4-0000-4fff-8eee-123456789abc';

const gitIn = (cwd) => (...args) => {
  const r = spawnSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', '-c', 'core.hooksPath=/dev/null', ...args], { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};
const write = (root, rel, text) => (fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }), fs.writeFileSync(path.join(root, rel), text));

// git mode: every added line holding a GUID in the commits of {range}; dir mode: every line of the given files.
const SCANNER = `import fs from 'node:fs'; import { execSync } from 'node:child_process';
const [mode, out, ...rest] = process.argv.slice(2);
if (process.env.FAKE_DIR_FAILS && mode === 'dir') process.exit(3);
const RX = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;
const results = [];
const add = (file, line, text, commit) => { const m = RX.exec(text); if (!m) return; const from = Math.max(0, text.lastIndexOf('Token', m.index)); results.push({ ruleId: 'generic-api-key', level: 'error', message: { text: 'generic-api-key has detected secret for file ' + file }, locations: [{ physicalLocation: { artifactLocation: { uri: file }, region: { startLine: line, startColumn: from + 1, endLine: line, endColumn: m.index + m[0].length, snippet: { text: 'REDACTED' } } } }], partialFingerprints: { commitSha: commit } }); };
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

function setup() {
  const root = tmp('secrets-');
  const git = gitIn(root);
  const tool = path.join(root, '..', `scan-${path.basename(root)}.mjs`);
  fs.writeFileSync(tool, SCANNER);
  const leaks = { licence: 'MIT', run: [process.execPath, tool, 'git', '{out}', '{range}'], worktreeRun: [process.execPath, tool, 'dir', '{out}', '{files}'], output: '{out}', parse: 'sarif', scope: 'repo', baseline: 'native', lens: 'security', block: { rules: ['*'] }, okExit: [0] };
  const analysis = { tools: { leaks }, stages: { pair: ['leaks'], story: ['leaks'], prCheck: ['leaks'] } };
  git('init', '-q', '-b', 'main');
  write(root, '.gitignore', '.factory/state/\n');
  // The sample token, committed on main in the client's settings (as src/WebhookClient/appsettings.json holds one).
  write(root, 'src/Client/appsettings.json', `{ "ClientOptions": { "Token": "${ON_MAIN}" } }\n`);
  write(root, '.factory/metrics/token-usage.jsonl.d/main.jsonl', '{}\n');
  git('add', '-A');
  git('commit', '-qm', 'base');
  const config = { root, mainRoot: root, stateDir: '.factory/state', metricsDir: '.factory/metrics', baseRef: 'main', project: { languages: [] }, precheck: {}, analysis };
  return { root, git, config, analysis, tool };
}
const leaked = (obj) => JSON.stringify(obj).includes(ON_MAIN) || JSON.stringify(obj).includes(NEW_ONE);

test('value candidates: the GUID in the scanner\'s match span, never the setting\'s name or a short word', () => {
  const line = `  - \`ValidateToken: "true"\` and \`ClientOptions__Token: ${ON_MAIN}\`, so its check answers 400.`;
  const col = line.indexOf('Token: ') + 1;
  assert.deepEqual(valueCandidates(line, { column: col, endColumn: line.indexOf(ON_MAIN) + ON_MAIN.length }), [ON_MAIN]);
  assert.deepEqual(valueCandidates('ClientOptions__Token is the setting'), []);
});

test('a value already on the base copied into a test plan is a note naming where it lives; a new value still blocks', async () => {
  const s = setup();
  s.git('checkout', '-qb', 'feat/evt-1');
  write(s.root, '.factory/plans/EVT-1/TC-EVT-1-10.md', `# TC\n\n- \`ClientOptions__Token: ${ON_MAIN}\`, so its check answers 400.\n`);
  write(s.root, 'src/Api/Hooks.cs', `class Hooks { const string Token = "${NEW_ONE}"; }\n`);
  s.git('add', '-A');
  s.git('commit', '-qm', 'plan and code');
  const rep = await runSlot(s.config, 'story', { cwd: s.root, base: 'main' });
  assert.deepEqual(rep.findings.map((f) => `${f.file}:${f.line}:${f.severity}`), ['src/Api/Hooks.cs:1:blocking'], 'only the new value blocks');
  const copy = rep.preexisting.find((f) => f.file === '.factory/plans/EVT-1/TC-EVT-1-10.md');
  assert.deepEqual(copy.alreadyOnBase, ['src/Client/appsettings.json']);
  assert.match(evidenceText(rep), /Values already on the base branch[\s\S]*TC-EVT-1-10\.md:3: already on the base in src\/Client\/appsettings\.json/);
  assert.equal(leaked(rep), false, 'the value is never in the report');
});

test('a plan not committed yet is read by the secret scan, and the scan of a dirty tree is never the commit\'s scan', async () => {
  const s = setup();
  s.git('checkout', '-qb', 'feat/evt-1');
  write(s.root, 'src/Api/Hooks.cs', 'class Hooks {}\n');
  s.git('add', '-A');
  s.git('commit', '-qm', 'code');
  const head = s.git('rev-parse', 'HEAD');
  // The plan sits under .factory/ and is not committed (held-out C19: the PR check scanned 94b0b33e this way).
  write(s.root, '.factory/plans/EVT-1/TC-EVT-1-10.md', `- token \`${NEW_ONE}\`\n`);
  const rep = await reportFor(s.config, 'prCheck', { cwd: s.root, base: 'main' });
  assert.deepEqual(rep.findings.map((f) => `${f.file}:${f.line}`), ['.factory/plans/EVT-1/TC-EVT-1-10.md:1'], 'the uncommitted plan is in the secret scan\'s scope');
  assert.equal(rep.tree.state, 'dirty');
  assert.deepEqual(rep.tree.uncommitted, ['.factory/plans/EVT-1/TC-EVT-1-10.md']);
  assert.equal(readReport(s.config, head, 'prCheck'), null, 'not stored under the HEAD commit');
  assert.equal(writeReport(s.config, rep), null);
  recordAnalysis(s.config, { story: 'EVT-1', stage: 'pr-check', report: rep });
  const [row] = readMetricsLocal(s.config, 'analysis-runs.jsonl');
  assert.deepEqual([row.sha, row.tree, row.covers, row.uncommitted], [head, 'dirty', null, 1]);
  assert.match(evidenceText(rep), /the working tree on commit [0-9a-f]{12} with 1 uncommitted file\(s\); not a scan of that commit/);
  // A commit-reading tool that cannot read the uncommitted files names them as unseen.
  process.env.FAKE_DIR_FAILS = '1';
  try {
    const blind = await runSlot(s.config, 'story', { cwd: s.root, base: 'main' });
    assert.deepEqual(blind.tree.unseen.map((u) => [u.tool, u.files]), [['leaks', ['.factory/plans/EVT-1/TC-EVT-1-10.md']]]);
    assert.match(evidenceText(blind), /Not seen by: leaks \(1 uncommitted file\(s\): \.factory\/plans\/EVT-1\/TC-EVT-1-10\.md\)/);
  } finally {
    delete process.env.FAKE_DIR_FAILS;
  }
});

test('only the pipeline\'s own records uncommitted: the scan is the commit\'s and is kept', async () => {
  const s = setup();
  s.git('checkout', '-qb', 'feat/bug-53');
  write(s.root, 'src/Api/Hooks.cs', 'class Hooks {}\n');
  s.git('add', '-A');
  s.git('commit', '-qm', 'fix');
  const head = s.git('rev-parse', 'HEAD');
  fs.appendFileSync(path.join(s.root, '.factory/metrics/token-usage.jsonl.d/main.jsonl'), '{"stage":"delivery"}\n');
  write(s.root, '.factory/state/implement/BUG-53.json', '{}\n');
  const rep = await reportFor(s.config, 'prCheck', { cwd: s.root, base: 'main', by: 'delivery' });
  assert.equal(rep.tree.state, 'clean');
  assert.equal(readReport(s.config, head, 'prCheck')?.by, 'delivery');
});

test('the commit gate keeps a new secret out of the commit; a value already on the base passes as a note', async () => {
  const s = setup();
  s.git('checkout', '-qb', 'feat/evt-1');
  write(s.root, '.factory/plans/EVT-1/TC-EVT-1-10.md', `- token \`${NEW_ONE}\`\n`);
  write(s.root, '.factory/plans/EVT-1/TC-EVT-1-11.md', `- \`ClientOptions__Token: ${ON_MAIN}\`\n`);
  write(s.root, 'src/Api/Hooks.cs', 'class Hooks {}\n');
  s.git('add', '-A');
  const resolved = resolveAnalysis(s.config);
  const loaded = { config: s.config, resolved, tools: [resolved.tools.get('leaks')] };
  const files = s.git('diff', '--cached', '--name-only').split('\n');
  const out = await scanStaged(s.root, { files, loaded });
  assert.deepEqual(out.held.map((h) => `${h.file}:${h.line}`), ['.factory/plans/EVT-1/TC-EVT-1-10.md:1']);
  assert.deepEqual(out.notes.map((h) => [h.file, h.alreadyOnBase]), [['.factory/plans/EVT-1/TC-EVT-1-11.md', ['src/Client/appsettings.json']]]);
  assert.equal(leaked(out), false);
  // gateStaged unstages the held file and records it; the rest commits.
  const spawn = () => ({ status: 0, stdout: `${JSON.stringify(out)}\n` });
  write(s.root, '.factory/config.json', `${JSON.stringify({ analysis: s.analysis })}\n`);
  s.git('add', '-A');
  gateStaged(s.root, { message: 'EVT-1: Test plan', spawn });
  s.git('commit', '-qm', 'EVT-1: Test plan');
  assert.equal(s.git('log', '-p', 'main..HEAD').includes(NEW_ONE), false, 'the new value never reached a commit');
  assert.match(s.git('status', '--porcelain'), /\?\? \.factory\/plans\/EVT-1\/TC-EVT-1-10\.md/);
  assert.deepEqual(heldSecrets(s.config, s.root).map((h) => h.file), ['.factory/plans/EVT-1/TC-EVT-1-10.md']);
  // The implementer refers to the setting by name; the file then commits and nothing is held.
  write(s.root, '.factory/plans/EVT-1/TC-EVT-1-10.md', '- the client\'s configured token (`ClientOptions__Token`)\n');
  s.git('add', '-A');
  gateStaged(s.root, { message: 'EVT-1: Implementation', spawn: () => ({ status: 0, stdout: '{"held":[],"notes":[]}\n' }) });
  s.git('commit', '-qm', 'EVT-1: Implementation');
  assert.deepEqual(heldSecrets(s.config, s.root), []);
});

test('the real commitAll runs the gate in a child process before it commits', async () => {
  const s = setup();
  write(s.root, '.factory/config.json', `${JSON.stringify({ analysis: s.analysis })}\n`);
  s.git('add', '-A');
  s.git('commit', '-qm', 'config');
  s.git('checkout', '-qb', 'feat/evt-1');
  const { commitAll } = await import('../../implement/lib/gitops.mjs');
  write(s.root, '.factory/plans/EVT-1/TC-EVT-1-10.md', `- token \`${NEW_ONE}\`\n`);
  write(s.root, 'src/Api/Hooks.cs', 'class Hooks {}\n');
  assert.equal(commitAll(s.root, 'EVT-1: Implementation'), true);
  assert.deepEqual(s.git('show', '--name-only', '--format=', 'HEAD').split('\n'), ['src/Api/Hooks.cs']);
  assert.equal(s.git('log', '-p', 'main..HEAD').includes(NEW_ONE), false);
  const records = JSON.stringify(readMetricsLocal(s.config, 'analysis-held.jsonl'));
  assert.match(records, /TC-EVT-1-10\.md/);
  assert.equal(records.includes(NEW_ONE), false);
});

function withRemote() {
  const s = setup();
  const bare = tmp('secrets-remote-');
  gitIn(bare)('init', '-q', '--bare', '-b', 'main');
  s.git('remote', 'add', 'origin', bare);
  s.git('push', '-q', 'origin', 'main');
  s.git('checkout', '-qb', 'feat/evt-1', 'origin/main');
  return s;
}
// The EVT-1 sequence: the value reaches a commit, the implementer removes it in a later one; history still holds it.
function leakThenRemove(s) {
  write(s.root, '.factory/plans/EVT-1/TC-EVT-1-10.md', `- token \`${NEW_ONE}\`\n`);
  s.git('add', '-A');
  s.git('commit', '-qm', 'EVT-1: Test plan');
  write(s.root, '.factory/plans/EVT-1/TC-EVT-1-10.md', '- the client\'s configured token (`ClientOptions__Token`)\n');
  write(s.root, 'src/Api/Hooks.cs', 'class Hooks {}\n');
  s.git('add', '-A');
  s.git('commit', '-qm', 'EVT-1: Reference the token by name');
}

test('a secret only in unpushed history: the harness folds the unpushed commits (same tree) and the next scan is clean', async () => {
  const s = withRemote();
  // A first part of the branch was pushed: it is kept as it is.
  write(s.root, 'src/Api/Start.cs', 'class Start {}\n');
  s.git('add', '-A');
  s.git('commit', '-qm', 'EVT-1: start');
  s.git('push', '-q', 'origin', 'feat/evt-1');
  const pushedTip = s.git('rev-parse', 'HEAD');
  leakThenRemove(s);
  const head = s.git('rev-parse', 'HEAD');
  const tree = s.git('rev-parse', 'HEAD^{tree}');
  const rep = await runSlot(s.config, 'story', { cwd: s.root, base: 'origin/main' });
  assert.equal(rep.findings.length, 1, 'the history scan still finds the removed value');
  const folded = dropUnpushedSecrets(s.config, s.root, rep.findings, { branch: 'feat/evt-1', base: 'origin/main' });
  assert.equal(folded.rewritten, true, folded.reason);
  assert.equal(s.git('rev-parse', 'HEAD^{tree}'), tree, 'the tree is the fixed tree');
  assert.equal(s.git('rev-parse', 'HEAD^'), pushedTip, 'the pushed commits are kept; the new commit fast-forwards the remote');
  assert.equal(folded.record.from, head);
  assert.equal(folded.record.dropped.length, 2);
  assert.equal(s.git('log', '-p', 'origin/main..HEAD').includes(NEW_ONE), false);
  assert.equal((await runSlot(s.config, 'story', { cwd: s.root, base: 'origin/main' })).findings.length, 0);
  assert.deepEqual(readMetricsLocal(s.config, 'history-rewrites.jsonl').map((r) => [r.treeIdentical, r.from, r.dropped.length]), [[true, head, 2]]);
  assert.equal(s.git('status', '--porcelain', '--', '.', ':(exclude).factory/metrics'), '', 'the worktree is untouched (only the record is new)');
});

test('the fold never rewrites pushed history, a shared branch, or a value still in the files', async () => {
  // Pushed: the commit holding the value is on the remote.
  const a = withRemote();
  leakThenRemove(a);
  a.git('push', '-q', 'origin', 'feat/evt-1');
  write(a.root, 'src/Api/Later.cs', 'class Later {}\n');
  a.git('add', '-A');
  a.git('commit', '-qm', 'EVT-1: later, not pushed');
  const ra = await runSlot(a.config, 'story', { cwd: a.root, base: 'origin/main' });
  const pa = dropUnpushedSecrets(a.config, a.root, ra.findings, { branch: 'feat/evt-1', base: 'origin/main' });
  assert.equal(pa.rewritten, false);
  assert.match(pa.reason, /a remote already has/);
  // A shared branch: never, even unpushed.
  const b = withRemote();
  b.git('checkout', '-q', 'main');
  leakThenRemove(b);
  const rb = await runSlot(b.config, 'story', { cwd: b.root, base: 'origin/main' });
  assert.match(dropUnpushedSecrets(b.config, b.root, rb.findings, { branch: 'main', base: 'origin/main' }).reason, /base or shared branch/);
  // Still in the files: the implementer must remove it first.
  const c = withRemote();
  write(c.root, '.factory/plans/EVT-1/TC-EVT-1-10.md', `- token \`${NEW_ONE}\`\n`);
  c.git('add', '-A');
  c.git('commit', '-qm', 'EVT-1: Test plan');
  const rc = await runSlot(c.config, 'story', { cwd: c.root, base: 'origin/main' });
  const before = c.git('rev-parse', 'HEAD');
  assert.match(dropUnpushedSecrets(c.config, c.root, rc.findings, { branch: 'feat/evt-1', base: 'origin/main' }).reason, /no finding lives only in history/);
  assert.equal(c.git('rev-parse', 'HEAD'), before);
});

test('the delivery does not push while a held secret is still uncommitted', async () => {
  const { deliverFinished } = await import('../../implement/lib/implement.mjs');
  const s = setup();
  let pushed = false;
  const io = { held: () => [{ tool: 'leaks', rule: 'generic-api-key', file: '.factory/plans/EVT-1/TC-EVT-1-10.md', line: 1 }], push: () => ((pushed = true), { pushed: true }) };
  const out = await deliverFinished(s.config, s.config, { id: 'EVT-1', keys: ['EVT-1'], label: 'EVT-1', branch: 'feat/evt-1', worktree: s.root, base: 'main', title: 't', body: 'b', isBug: false, io, save: () => {} });
  assert.equal(pushed, false);
  assert.equal(out.outcome, 'blocked');
  assert.match(out.reason, /TC-EVT-1-10\.md:1 leaks generic-api-key[\s\S]*not pushed/);
});
