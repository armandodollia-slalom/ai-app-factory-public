// The language-server adapter against a fake lspd, and `implement cleanup` stopping daemons.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createSubtaskWorktree } from '../lib/gitops.mjs';
import { callsFile, formatDiagnostics, lspAdapter, signatureChanges } from '../lib/lsp.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = path.resolve(here, '..', '..', '..');
const fake = path.join(here, 'fixtures', 'fake-lspd.mjs');
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lsp-')));
const logFile = path.join(tmp, 'lspd.log');
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const sh = (cwd, cmd, args, env = process.env) => {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', env });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')}: ${r.stdout}\n${r.stderr}`);
  return r.stdout.trim();
};
const logged = () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

function repo(name) {
  const root = path.join(tmp, name);
  fs.mkdirSync(path.join(root, 'src/Catalog.API'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src/Catalog.API/Api.cs'), '// api\n');
  sh(root, 'git', ['init', '-q', '-b', 'main']);
  sh(root, 'git', ['config', 'user.email', 't@e.com']);
  sh(root, 'git', ['config', 'user.name', 'T']);
  sh(root, 'git', ['add', '-A']);
  sh(root, 'git', ['commit', '-qm', 'init']);
  return root;
}

const config = (root, lsp) => ({ root, implement: { lsp: { enabled: true, lspdCmd: [process.execPath, fake], timeoutSec: 30, ...lsp } } });

test('missing tooling disables the adapter; every call degrades to no information', async () => {
  const root = repo('missing');
  const lsp = lspAdapter({ root, implement: { lsp: { lspdCmd: ['node', 'scripts/lsp/nope.mjs'] } } }, { mainRoot: root });
  assert.equal(lsp.enabled, false);
  assert.deepEqual(await lsp.start(root), { ok: false, leased: 'unavailable', reason: 'lsp tooling not installed', servers: {} });
  assert.equal(lsp.leasedRunning(root), false);
  assert.deepEqual(await lsp.diagnostics(root, ['src/Catalog.API/Api.cs']), { available: false, errors: [], warnings: [] });
});

test('start passes the owned globs to the daemon; diagnostics split errors and warnings; stop', async () => {
  const root = repo('daemon');
  fs.rmSync(logFile, { force: true });
  process.env.FAKE_LSPD_LOG = logFile;
  process.env.FAKE_LSPD_DIAG = JSON.stringify({ files: { 'src/Catalog.API/Api.cs': [{ severity: 'error', line: 3, col: 5, code: 'CS1002', message: '; expected' }, { severity: 'warning', line: 1, col: 1, code: 'CS0168', message: 'unused' }, { severity: 'info', line: 1, message: 'x' }], 'web/app.ts': { unavailable: 'typescript language server unavailable (still loading); use graphify and grep' } } });
  try {
    const lsp = lspAdapter(config(root), { mainRoot: root });
    const started = await lsp.start(root, { owns: ['src/Catalog.API/**', 'tests/**'] });
    assert.equal(started.leased, 'running');
    assert.equal(started.servers.heavy.status, 'running');
    assert.ok(lsp.leasedRunning(root));
    assert.ok(lsp.leasedRunning(root));
    // Was: a separate slnf command wrote <git-dir>/lsp/subtask.slnf and start got --slnf <file>. Narrowing is now
    // the daemon's job (scope modules), so the adapter only hands it the globs.
    assert.deepEqual(logged(), [['start', '--worktree', root, '--owns', 'src/Catalog.API/**', 'tests/**']]);
    const diag = await lsp.diagnostics(root, ['src/Catalog.API/Api.cs', 'deleted.cs']);
    assert.equal(logged().at(-1).filter((a) => a === 'deleted.cs').length, 0, 'deleted files are not asked about');
    assert.deepEqual(diag.errors, [{ file: 'src/Catalog.API/Api.cs', line: 3, col: 5, code: 'CS1002', message: '; expected' }]);
    assert.equal(diag.warnings.length, 1);
    assert.match(formatDiagnostics(diag), /error src\/Catalog\.API\/Api\.cs:3:5 CS1002: ; expected\n- warning/);
    await lsp.stop(root);
    assert.deepEqual(logged().at(-1), ['stop', '--worktree', root]);
    assert.ok(!lsp.leasedRunning(root));
    assert.ok(!lsp.leasedRunning(root));
  } finally {
    delete process.env.FAKE_LSPD_DIAG;
  }
});

test('start without owns passes none; an unavailable leased server is logged by its id and the run carries on', async () => {
  const root = repo('unavailable');
  fs.rmSync(logFile, { force: true });
  process.env.FAKE_LSPD_LOG = logFile;
  process.env.FAKE_LSPD_LEASED = 'unavailable';
  const lines = [];
  try {
    // No wait here (leaseWaitSec 0): the bounded wait for a free slot is tested in lsp-wait.test.mjs.
    const cfg = config(root);
    cfg.implement.lsp.leaseWaitSec = 0;
    const lsp = lspAdapter(cfg, { mainRoot: root, log: (l) => lines.push(l) });
    const started = await lsp.start(root);
    assert.deepEqual(logged(), [['start', '--worktree', root]]);
    assert.equal(started.ok, true);
    assert.equal(started.leased, 'unavailable');
    assert.equal(lsp.leasedRunning(root), false);
    assert.deepEqual(lines, ['lsp: heavy language server unavailable for unavailable (all 1 leased language server slots are in use (/other)); agents fall back to graphify']);
  } finally {
    delete process.env.FAKE_LSPD_LEASED;
  }
});

test('the engine install root is searched before the app repo for the lspd command', () => {
  const root = repo('roots');
  const lsp = lspAdapter({ root, implement: { lsp: { lspdCmd: ['node', 'scripts/lsp/lspd.mjs'], setupCmd: ['node', 'scripts/lsp/setup.mjs'] } } });
  assert.equal(lsp.enabled, true, 'found in the install root although the app repo has no scripts/');
});

test('LSP calls are counted per agent and time window from the worktree call log', () => {
  const root = repo('calls');
  const lsp = lspAdapter(config(root), { mainRoot: root });
  const file = callsFile(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const t = Date.now();
  const rec = (agent, tool, at) => JSON.stringify({ ts: new Date(at).toISOString(), agent, tool, file: 'a.cs', symbol: 'X' });
  fs.writeFileSync(file, [rec('pair-implementer', 'mcp__csharp__find_references', t), rec('pair-implementer', 'mcp__csharp__definition', t), rec('pair-verifier', 'mcp__csharp__hover', t), rec('pair-implementer', 'mcp__csharp__hover', t - 60_000)].join('\n') + '\n');
  const calls = lsp.calls(root, 'pair-implementer', t - 5000, t + 5000);
  assert.equal(calls.length, 2);
  assert.equal(calls.filter((c) => lsp.isReferences(c.tool)).length, 1);
});

test('signature changes are found in a diff', () => {
  const diff = ['--- a/x.cs', '+++ b/x.cs', '-    public int Total(Basket b)', '+    public decimal Total(Basket b, Coupon? c)', '+    private void Helper()', '+    public string Name { get; set; }', '+    [HttpGet] internal static Task<IResult> Get(int id) =>'].join('\n');
  assert.deepEqual(signatureChanges(diff), ['public int Total(Basket b)', 'public decimal Total(Basket b, Coupon? c)', '[HttpGet] internal static Task<IResult> Get(int id) =>']);
});

test('signature changes are found in other declaration styles, and the pattern is configurable', () => {
  const diff = [
    '--- a/lib.rs',
    '+++ b/lib.rs',
    '+pub fn total(basket: &Basket) -> Money {',
    '+    fn helper() {}',
    '+export function total(basket: Basket): number {',
    '+export const TAX = 0.2;',
    '+func Total(b Basket) int {',
    '+def total(basket):',
    '+    @Override public BigDecimal total(Basket b) {',
    '+    let x = compute(1);',
  ].join('\n');
  assert.deepEqual(signatureChanges(diff), ['pub fn total(basket: &Basket) -> Money {', 'export function total(basket: Basket): number {', 'func Total(b Basket) int {', 'def total(basket):', '@Override public BigDecimal total(Basket b) {']);
  const root = repo('signature');
  const lsp = lspAdapter(config(root, { signaturePattern: '^[+-]\\s*sub\\s+\\w+' }), { mainRoot: root });
  assert.deepEqual(lsp.signatureChanges('+sub total {\n+pub fn x()'), ['sub total {']);
  assert.deepEqual(lspAdapter(config(root), { mainRoot: root }).signatureChanges('+pub fn x()'), ['pub fn x()']);
});

test('implement cleanup stops the daemon of each subtask worktree before removing it', () => {
  const root = repo('cleanup-shop');
  for (const dir of ['scripts/pipeline', 'scripts/implement', 'scripts/review', 'scripts/feature-verification', 'scripts/board', 'scripts/models', 'scripts/pr-video', 'scripts/review-gate', 'scripts/retro', 'scripts/factory', 'scripts/stack', 'scripts/teststack']) fs.cpSync(path.join(source, dir), path.join(root, dir), { recursive: true, filter: (p) => !p.includes(`${path.sep}test`) });
  fs.mkdirSync(path.join(root, 'scripts/lsp'), { recursive: true });
  fs.copyFileSync(fake, path.join(root, 'scripts/lsp/lspd.mjs'));
  sh(root, 'git', ['add', '-A']);
  sh(root, 'git', ['commit', '-qm', 'scripts']);
  sh(root, 'git', ['checkout', '-qb', 'feat/demo-1-x']);
  const story = path.join(tmp, 'cleanup-wt', 'demo-1');
  fs.mkdirSync(path.dirname(story), { recursive: true });
  sh(root, 'git', ['worktree', 'add', '-q', story, '-b', 'feat/demo-1-story']);
  const wt = createSubtaskWorktree(story, { prefix: 'feat/', key: 'DEMO-1', id: 'api' });
  fs.rmSync(logFile, { force: true });
  const env = { ...process.env, FAKE_LSPD_LOG: logFile };
  delete env.PIPELINE_ROOT;
  const status = sh(root, process.execPath, ['scripts/implement/implement.mjs', 'status'], env);
  assert.match(status, /Subtask worktrees still on disk[\s\S]*DEMO-1 +api +.*demo-1--api/);
  const out = sh(root, process.execPath, ['scripts/implement/implement.mjs', 'cleanup', 'DEMO-1'], env);
  assert.match(out, /removed .*demo-1--api \(feat\/demo-1--api\)/);
  assert.deepEqual(logged(), [['stop', '--worktree', wt.path]]);
  assert.ok(!fs.existsSync(wt.path));
  assert.equal(sh(root, 'git', ['branch', '--list', 'feat/demo-1--api']), '');
});
