// The secret decision table, every cell: value (new, on-base, shares-span, allow-listed, fake-flagged) by location
// (uncommitted, unpushed, pushed with no PR, PR open) by place (local, CI), with the verdict and the way out. Then the
// table on real trees: value classes and locations, the pre-push gate (a fake value committed but not pushed: replaced,
// folded, nothing pushed before the jobs pass), and the HINT-1 replay (held-out C20: a fake token beside a base user id
// in a scenario, pushed for the CI proof, CI red): the fold of the story's own branch with no PR, pushed with a lease,
// and CI's job green on the result; escalation where the table says so.
import assert from 'node:assert/strict';
import { ciFixBudget } from '../../implement/lib/ci-wait.mjs';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const tmp = (p) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));
process.env.FACTORY_CACHE_DIR = tmp('fcache-');
const INSTALL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const { secretCell, VALUES, LOCATIONS, PLACES, valueClass, valueLocation, judgeSecret } = await import('../lib/analysis/secret-table.mjs');
const { resolveAnalysis } = await import('../lib/analysis/config.mjs');
const { ciOutputs } = await import('../lib/analysis/ci.mjs');
const { readMetricsLocal } = await import('../lib/state.mjs');
const { analysisGate, remedyRedBranch, runAnalysisJobs } = await import('../../implement/lib/analysis-gate.mjs');

const GUID_MAIN = '0f0e0d0c-1111-4222-8333-944445555666';
const USER = '7a6b5c4d-2222-4333-8444-a55556666777';
const NEW_TOKEN = 'tok_Q8w2Er4Ty6Ui8Op0';
const MARKED = 'tok_factoryfake0001x';
const SCENARIO = '.factory/stack/scenarios/hint-1/webhooksdb.sql';

// The table as the design states it: [value, location] -> [verdict, ways out]; identical for both places.
const EXPECTED = {
  new: { uncommitted: ['block', ['implementer']], unpushed: ['block', ['implementer', 'fold-unpushed']], 'pushed-no-pr': ['block', ['escalate']], 'pr-open': ['block', ['escalate']] },
  'on-base': { uncommitted: ['note', []], unpushed: ['note', []], 'pushed-no-pr': ['note', []], 'pr-open': ['note', []] },
  'shares-span': { uncommitted: ['block', ['implementer']], unpushed: ['block', ['implementer', 'fold-unpushed']], 'pushed-no-pr': ['block', ['escalate']], 'pr-open': ['block', ['escalate']] },
  'allow-listed': { uncommitted: ['pass', []], unpushed: ['pass', []], 'pushed-no-pr': ['pass', []], 'pr-open': ['pass', []] },
  'fake-flagged': { uncommitted: ['block', ['implementer']], unpushed: ['block', ['implementer', 'fold-unpushed']], 'pushed-no-pr': ['block', ['implementer', 'fold-branch']], 'pr-open': ['block', ['escalate']] },
};

test('every cell of the table: the verdict and the way out, the same in both places', () => {
  let cells = 0;
  for (const value of VALUES) {
    for (const location of LOCATIONS) {
      const verdicts = PLACES.map((place) => secretCell({ value, location, place }));
      for (const c of verdicts) {
        assert.deepEqual([c.verdict, c.wayOut], EXPECTED[value][location], `${value} / ${location} / ${c.place}`);
        assert.ok(c.why, 'each cell says why');
        cells++;
      }
      assert.deepEqual(verdicts.map((c) => [c.verdict, c.wayOut]), [verdicts[0], verdicts[0]].map((c) => [c.verdict, c.wayOut]), 'the place never changes the verdict');
    }
  }
  assert.equal(cells, 5 * 4 * 2);
  // A shared span judged as the value the base does not hold: fake, then the fake row.
  assert.deepEqual(secretCell({ value: 'shares-span', location: 'pushed-no-pr', fake: true }).wayOut, ['implementer', 'fold-branch']);
  assert.throws(() => secretCell({ value: 'nope', location: 'unpushed' }));
});

const gitIn = (cwd) => (...args) => {
  const r = spawnSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', '-c', 'core.hooksPath=/dev/null', ...args], { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};
const write = (root, rel, text) => (fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }), fs.writeFileSync(path.join(root, rel), text));
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

// A repository with a bare origin, main pushed, the CI files rendered and committed; the worktree on `branch`.
function setup(branch = 'feat/hint-1') {
  const root = tmp('table-');
  const origin = tmp('origin-');
  const git = gitIn(root);
  gitIn(origin)('init', '-q', '--bare', '-b', 'main');
  const scan = path.join(root, '..', `scan-${path.basename(root)}.mjs`);
  fs.writeFileSync(scan, SCANNER);
  const leaks = { licence: 'MIT', run: [process.execPath, scan, 'git', '{out}', '{range}'], worktreeRun: [process.execPath, scan, 'dir', '{out}', '{files}'], output: '{out}', parse: 'sarif', scope: 'repo', baseline: 'native', lens: 'security', block: { rules: ['*'] }, okExit: [0], env: { FAKE_ALLOW: 'factoryfake' } };
  const analysis = { tools: { leaks }, stages: { story: ['leaks'] }, ci: { jobs: [{ id: 'secrets', name: 'Secret scan', tools: ['leaks'] }] } };
  const config = { root, mainRoot: root, stateDir: '.factory/state', metricsDir: '.factory/metrics', baseRef: 'origin/main', project: { languages: [] }, featureVerification: { precheck: {} }, analysis, implement: {} };
  git('init', '-q', '-b', 'main');
  git('remote', 'add', 'origin', origin);
  write(root, '.gitignore', '.factory/state/\n');
  write(root, 'src/Client/appsettings.json', `{ "ClientOptions": { "Token": "${GUID_MAIN}" } }\n`);
  write(root, '.factory/stack/scenarios/users.sql', `INSERT INTO users VALUES ('${USER}', 'alice');\n`);
  const resolved = resolveAnalysis(config, { installRoot: INSTALL });
  for (const o of ciOutputs(config, { provider: 'github-actions', installRoot: INSTALL, resolved })) if (o.path) write(root, o.path, o.content);
  git('add', '-A');
  git('commit', '-qm', 'base');
  git('push', '-q', 'origin', 'main');
  git('checkout', '-q', '-b', branch);
  return { root, origin, git, config, branch };
}
const commit = (s, files, msg) => {
  for (const [rel, text] of Object.entries(files)) write(s.root, rel, text);
  s.git('add', '-A');
  s.git('commit', '-qm', msg);
  return s.git('rev-parse', 'HEAD');
};
const ciJob = (s) => spawnSync(process.execPath, ['.factory/bin/analysis/ci.mjs', '--job', 'secrets', '--base', 'origin/main'], { cwd: s.root, encoding: 'utf8' });
const finding = (file, line, commitSha = null) => ({ tool: 'leaks', rule: 'generic-api-key', file, line, column: 1, endColumn: null, vendorFingerprint: commitSha });
const spanOf = (s, rel, line) => {
  const text = fs.readFileSync(path.join(s.root, rel), 'utf8').split('\n')[line - 1];
  const all = [...text.matchAll(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|tok_[A-Za-z0-9]{12,}/g)];
  return all.at(-1).index + all.at(-1)[0].length + 1;
};

test('value classes and locations on a real tree', () => {
  const s = setup('feat/classes');
  const mb = s.git('rev-parse', 'origin/main');
  const sha = commit(s, {
    'tests/copied.json': `{ "Token": "${GUID_MAIN}" }\n`,
    'src/Api/settings.json': `{ "Token": "${NEW_TOKEN}" }\n`,
    'tests/new.json': `{ "Token": "${NEW_TOKEN}" }\n`,
    [SCENARIO]: `INSERT INTO webhooks VALUES ('${USER}', '${NEW_TOKEN}');\n`,
  }, 'values');
  const f = (rel) => ({ ...finding(rel, 1, sha), endColumn: spanOf(s, rel, 1) });
  assert.deepEqual(valueClass(s.root, f('tests/copied.json'), { mergeBase: mb }), { value: 'on-base', fake: false });
  assert.deepEqual(valueClass(s.root, f('src/Api/settings.json'), { mergeBase: mb }), { value: 'new', fake: false }, 'outside test files: real-looking');
  assert.deepEqual(valueClass(s.root, f('tests/new.json'), { mergeBase: mb }), { value: 'fake-flagged', fake: true });
  assert.deepEqual(valueClass(s.root, f(SCENARIO), { mergeBase: mb }), { value: 'shares-span', fake: true }, 'HINT-1: a base user id beside a new token is not on-base');
  assert.deepEqual(valueClass(s.root, f('tests/new.json'), { mergeBase: mb, credentials: [`x${NEW_TOKEN}y`] }), { value: 'new', fake: false }, 'a credential the harness can see is never fake');
  // Locations: committed and on no remote, then pushed (no PR / PR open / unknown), and a finding with no commit.
  assert.equal(valueLocation(s.root, f('tests/new.json')), 'unpushed');
  s.git('push', '-q', 'origin', 'feat/classes');
  assert.equal(valueLocation(s.root, f('tests/new.json'), { prOpen: false }), 'pushed-no-pr');
  assert.equal(valueLocation(s.root, f('tests/new.json'), { prOpen: true }), 'pr-open');
  assert.equal(valueLocation(s.root, f('tests/new.json'), { prOpen: null }), 'pr-open', 'unknown counts as open');
  assert.equal(valueLocation(s.root, finding('tests/new.json', 1, null)), 'uncommitted');
  assert.deepEqual(judgeSecret(s.root, f(SCENARIO), { mergeBase: mb, prOpen: false }).wayOut, ['implementer', 'fold-branch']);
  assert.deepEqual(judgeSecret(s.root, f('src/Api/settings.json'), { mergeBase: mb, prOpen: false }).wayOut, ['escalate']);
});

test('pre-push gate: a fake value committed but not pushed goes back for a fix, its commit is folded out, nothing is pushed before CI\'s job passes here', () => {
  const s = setup('feat/gate');
  commit(s, { [SCENARIO]: `INSERT INTO webhooks VALUES ('${USER}', '${NEW_TOKEN}');\n` }, 'scenario with a hand-made fake token');
  assert.equal(ciJob(s).status, 1, 'CI\'s own job blocks it');
  const fixes = [];
  // The fixing round (pr-check run --fix-first in the harness): here, a fixer that replaces the value with a marked one.
  const fix = ({ cwd, base, checks, findingsOf }) => {
    const first = checks(cwd, base);
    assert.ok(first.some((r) => !r.ok));
    const seed = findingsOf(first);
    fixes.push(seed);
    assert.match(seed[0].fix, /factoryfake/, 'the fixer is told which value the scanner accepts');
    assert.match(seed[0].evidence, new RegExp(SCENARIO.replace(/[.]/g, '\\.')));
    assert.ok(!JSON.stringify(seed).includes(NEW_TOKEN), 'no value in the fixer\'s input');
    commit(s, { [SCENARIO]: `INSERT INTO webhooks VALUES ('${USER}', '${MARKED}');\n` }, 'fix: allow-listed placeholder');
    return { results: checks(cwd, base), fixRun: { verdict: 'PASS' } };
  };
  const g = analysisGate(s.config, { cwd: s.root, branch: 'feat/gate', base: 'origin/main', targetArgs: ['--story', 'HINT-1'], seedFile: path.join(s.root, '.factory/state/seed.json'), prCheckCli: 'unused', env: process.env, fix });
  assert.equal(fixes.length, 1);
  assert.equal(g.ok, true, JSON.stringify(g.results));
  assert.equal(ciJob(s).status, 0, 'CI\'s job passes on the folded head');
  assert.equal(s.git('ls-remote', 'origin', 'refs/heads/feat/gate'), '', 'nothing was pushed by the gate');
  const rows = readMetricsLocal(s.config, 'history-rewrites.jsonl');
  assert.equal(rows.at(-1).kind, 'unpushed');
  assert.equal(rows.at(-1).treeIdentical, true);
});

function hint1(prOpen, { file = SCENARIO } = {}) {
  const s = setup();
  // Held-out C20, HINT-1: the scenario commit is pushed for the CI proof; the CI fixing round replaces the value and
  // pushes; CI is still red because the first commit holds the value.
  commit(s, { [file]: `INSERT INTO webhooks VALUES ('${USER}', '${NEW_TOKEN}');\n` }, 'scenario');
  s.git('push', '-q', '-u', 'origin', 'feat/hint-1');
  const fixed = commit(s, { [file]: `INSERT INTO webhooks VALUES ('${USER}', '${MARKED}');\n` }, 'CI fix round');
  s.git('push', '-q', 'origin', 'feat/hint-1');
  assert.equal(ciJob(s).status, 1, 'CI red on the pushed head');
  const tree = s.git('rev-parse', `${fixed}^{tree}`);
  let leases = 0;
  const r = remedyRedBranch(s.config, {
    budget: ciFixBudget({ ci: { maxFixRounds: 2 } }, {}, {}),
    worktree: s.root,
    branch: 'feat/hint-1',
    base: 'origin/main',
    ci: { state: 'failure', failing: ['workflow factory-analysis'] },
    prOpen,
    keys: ['HINT-1'],
    targetArgs: ['--story', 'HINT-1'],
    seedFile: path.join(s.root, '.factory/state/seed.json'),
    prCheckCli: 'unused',
    env: process.env,
    credentials: [],
    jobs: runAnalysisJobs,
    fix: () => assert.fail('the value is only in history: no fixing round'),
    push: async () => assert.fail('no plain push'),
    pushLease: (lease) => {
      leases++;
      const p = spawnSync('git', ['push', '-q', `--force-with-lease=refs/heads/feat/hint-1:${lease}`, 'origin', 'feat/hint-1'], { cwd: s.root, encoding: 'utf8' });
      return p.status === 0 ? { pushed: true } : { pushed: false, reason: p.stderr };
    },
  });
  return { s, r, fixed, tree, leases: () => leases };
}

test('HINT-1 replay: a fake value in the story\'s own pushed branch with no PR is folded out and pushed with a lease; CI\'s job is green on it', async () => {
  const { s, r: pending, fixed, tree, leases } = hint1(false);
  const r = await pending;
  assert.equal(r.retried, true, r.reason);
  assert.equal(leases(), 1);
  const head = s.git('rev-parse', 'HEAD');
  assert.notEqual(head, fixed);
  assert.equal(s.git('rev-parse', 'HEAD^{tree}'), tree, 'the same tree');
  assert.equal(s.git('ls-remote', 'origin', 'refs/heads/feat/hint-1').split(/\s/)[0], head, 'the remote branch is the fold');
  assert.equal(ciJob(s).status, 0, 'CI\'s job passes on the folded head');
  const decisions = readMetricsLocal(s.config, 'secret-decisions.jsonl');
  const d = decisions.find((x) => x.where === 'after-branch-ci');
  assert.deepEqual([d.value, d.fake, d.location, d.verdict, d.wayOut], ['shares-span', true, 'pushed-no-pr', 'block', ['implementer', 'fold-branch']]);
  assert.ok(decisions.some((x) => x.where === 'fold-branch'));
  assert.equal(readMetricsLocal(s.config, 'history-rewrites.jsonl').at(-1).kind, 'branch');
  const agreement = readMetricsLocal(s.config, 'analysis-agreement.jsonl').at(-1);
  assert.equal(agreement.agree, true, 'CI red on the analysis workflow and the same job red here');
  const all = JSON.stringify([decisions, readMetricsLocal(s.config, 'history-rewrites.jsonl')]);
  assert.ok(![NEW_TOKEN, USER].some((v) => all.includes(v)), 'no value in a record');
});

test('HINT-1 escalates where the table says so: an open PR, an unknown PR state, a real-looking value', async () => {
  for (const [prOpen, file, why] of [[true, SCENARIO, /escalate/], [null, SCENARIO, /escalate/], [false, 'src/Api/webhooks.sql', /escalate/]]) {
    const { s, r: pending, fixed, leases } = hint1(prOpen, { file });
    const r = await pending;
    assert.equal(r.retried, false);
    assert.match(r.reason, why);
    assert.equal(leases(), 0, 'nothing force-pushed');
    assert.equal(s.git('rev-parse', 'HEAD'), fixed, 'the branch is unchanged');
  }
});

test('pre-mortem: a job that cannot run here does not hold the push; a non-analysis red is left to CI; a refused lease restores the branch', async () => {
  const s = setup('feat/premortem');
  commit(s, { 'src/ok.txt': 'clean\n' }, 'clean change');
  const cannot = () => [{ check: 'factory-analysis Dependency audit', job: 'dependencies', ok: true, unverified: true, output: 'osv-scanner: prepare failed', findings: [{ verdict: 'error', tool: 'osv-scanner', error: 'offline' }] }];
  const g = analysisGate(s.config, { cwd: s.root, branch: 'feat/premortem', base: 'origin/main', targetArgs: [], seedFile: path.join(s.root, '.factory/state/seed.json'), prCheckCli: 'unused', jobs: cannot, fix: ({ cwd, base, checks }) => ({ results: checks(cwd, base), fixRun: null }) });
  assert.equal(g.ok, true, 'unverified here: CI decides');
  const { analysisGateSection } = await import('../../implement/lib/analysis-gate.mjs');
  assert.match(analysisGateSection(g), /could not run here, CI decides: dependencies/);
  // A red Playwright run: the analysis jobs pass here, nothing to do, recorded as agreement on the analysis jobs.
  const r = await remedyRedBranch(s.config, { worktree: s.root, branch: 'feat/premortem', base: 'origin/main', ci: { failing: ['workflow AI app factory'] }, prOpen: false, keys: ['X-1'], jobs: () => [{ check: 'factory-analysis Secret scan', job: 'secrets', ok: true, findings: [] }], fix: () => assert.fail('no fixing round'), push: () => assert.fail('no push'), pushLease: () => assert.fail('no push'), credentials: [], budget: ciFixBudget({ ci: { maxFixRounds: 2 } }, {}, {}) });
  assert.equal(r.retried, false);
  assert.match(r.reason, /not an analysis job/);
  // The lease is refused (someone pushed meanwhile): the fold is undone locally, nothing half-done.
  const { s: h, fixed } = (() => {
    const t = setup();
    commit(t, { [SCENARIO]: `INSERT INTO webhooks VALUES ('${USER}', '${NEW_TOKEN}');\n` }, 'scenario');
    t.git('push', '-q', '-u', 'origin', 'feat/hint-1');
    const f = commit(t, { [SCENARIO]: `INSERT INTO webhooks VALUES ('${USER}', '${MARKED}');\n` }, 'fix');
    t.git('push', '-q', 'origin', 'feat/hint-1');
    return { s: t, fixed: f };
  })();
  const refused = await remedyRedBranch(h.config, { worktree: h.root, branch: 'feat/hint-1', base: 'origin/main', ci: { failing: ['workflow factory-analysis'] }, prOpen: false, keys: ['HINT-1'], jobs: runAnalysisJobs, fix: () => assert.fail('history only'), push: () => assert.fail('no plain push'), pushLease: () => ({ pushed: false, reason: 'stale info' }), credentials: [], budget: ciFixBudget({ ci: { maxFixRounds: 2 } }, {}, {}) });
  assert.equal(refused.retried, false);
  assert.match(refused.reason, /could not be pushed: stale info/);
  assert.equal(h.git('rev-parse', 'HEAD'), fixed, 'the branch is back where the remote has it');
});
