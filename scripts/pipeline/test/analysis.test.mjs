// Static analysis (scripts/pipeline/lib/analysis/): settings and their validation, parsers, baselining, the per-commit
// report and the PR body section, suppressions and the guard, licences, pinned downloads and rule sets (with fakes:
// no network), the CI jobs on every CI renderer and the review gate's lists, doctor rows, pruning, the generated CI
// script against fake tools, and the factory's own rules through Opengrep's test mode when the binary is on hand.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import YAML from 'yaml';

const tmp = (p) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));
process.env.FACTORY_CACHE_DIR = tmp('fcache-');

const { analysisProblems, blocks, configAnalysisProblems, normalizeTool, packAnalysis, resolveAnalysis } = await import('../lib/analysis/config.mjs');
const P = await import('../lib/analysis/parsers.mjs');
const { classify, identify, stripRulePrefix } = await import('../lib/analysis/baseline.mjs');
const { addedSuppressions, suppressionsText } = await import('../lib/analysis/suppressions.mjs');
const R = await import('../lib/analysis/report.mjs');
const { ALLOWLIST, REJECTED, licenceRows } = await import('../lib/analysis/licences.mjs');
const { installBinary, pruneData, ruleSet } = await import('../lib/analysis/fetch.mjs');
const CI = await import('../lib/analysis/ci.mjs');
const { runSlot } = await import('../lib/analysis/runner.mjs');
const { analysisDoctor } = await import('../lib/analysis/doctor.mjs');
const { INSTALL_ROOT } = await import('../lib/config.mjs');

const gitIn = (cwd) => (...args) => {
  const r = spawnSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', '-c', 'core.hooksPath=/dev/null', ...args], { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};
const write = (root, rel, text) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), text);
};
function repo() {
  const root = tmp('an-');
  const git = gitIn(root);
  git('init', '-q', '-b', 'main');
  write(root, 'README.md', '# x\n');
  git('add', '-A');
  git('commit', '-qm', 'base');
  return { root, git };
}
const cfg = (root, analysis, extra = {}) => ({ root, mainRoot: root, stateDir: '.factory/state', project: { languages: [] }, precheck: {}, analysis, ...extra });

// ---- settings --------------------------------------------------------------------------------------------------

test('validation names the key of every mistake; a correct section has none; no section is no problem', () => {
  assert.deepEqual(analysisProblems(undefined), []);
  assert.deepEqual(analysisProblems({ tools: { t: { run: ['x'], parse: 'sarif', licence: 'MIT' } }, stages: { pair: ['t'] } }), []);
  assert.match(analysisProblems({ tools: { t: { run: ['x'] } } }).join(), /analysis.tools.t.licence must name/);
  const p = analysisProblems({
    toolz: 1,
    tools: { Bad: { run: 'x' }, a: { parse: 'xml', scope: 'everything', baseline: 'magic', lens: 'vibes', block: { levels: ['fatal'] }, timeoutSec: -1 }, b: { run: ['b'], install: { version: 'latest', platforms: { 'linux-x64': { url: 'http://x/latest/b', sha256: 'abc', bin: '' } } } }, c: { run: ['c'], rules: [{ id: 'r', repo: 'https://x', commit: 'main' }] } },
    stages: { pair: ['nope'], nightly: [] },
    fixLoop: { bounces: 99 },
    acceptLicence: [{ tool: 'b', licence: 'X' }],
    licenceReview: 'loose',
  }).join('\n');
  for (const want of ['analysis.toolz is not a setting', 'analysis.tools.Bad: a tool id', 'analysis.tools.a.run must be a command', 'parse "xml" is not a parser', 'scope "everything"', 'baseline "magic"', 'lens "vibes"', 'block.levels: "fatal"', 'timeoutSec', 'install.version must pin a version', 'url must be an https URL', 'sha256 must be', 'bin must name', 'rules[0] needs repo and a pinned commit', 'rules[0].licence must name', 'stages.pair names "nope"', 'stages.nightly is not a slot', 'fixLoop.bounces', 'acceptLicence[0] must name', 'licenceReview must be']) assert.match(p, new RegExp(want.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('without an analysis section nothing resolves; with one, the security pack and the language packs supply tools, slots and CI jobs', () => {
  assert.equal(resolveAnalysis(cfg('/r', undefined)), null);
  const a = resolveAnalysis(cfg('/r', {}, { project: { languages: ['dotnet', 'typescript'] } }));
  for (const id of ['betterleaks', 'osv-scanner', 'opengrep', 'opengrep-interfile', 'zizmor', 'actionlint', 'roslyn-security', 'nuget-audit', 'eslint-security']) assert.ok(a.tools.has(id), id);
  for (const off of ['jscpd', 'lizard', 'trivy-config', 'psalm-taint']) assert.ok(!a.tools.has(off), `${off} is optional and off`);
  assert.deepEqual(a.stages.ci, []);
  assert.ok(a.stages.pair.includes('opengrep') && a.stages.pair.includes('nuget-audit') && !a.stages.pair.includes('roslyn-security'), 'the solution rebuild is not a pair-round tool');
  assert.deepEqual(a.ci.jobs.map((j) => [j.id, j.tools.join('+'), j.required, j.toolchain]), [['secrets', 'betterleaks', true, false], ['dependencies', 'osv-scanner+nuget-audit', true, true], ['sast', 'opengrep-interfile', true, false], ['workflows', 'zizmor+actionlint', true, false]]);
  // A repository's entry changes only the keys it names; null turns a tool off.
  const b = resolveAnalysis(cfg('/r', { tools: { lizard: { enabled: true }, zizmor: null } }));
  assert.equal(b.tools.get('lizard').parse, 'gcc');
  assert.ok(!b.tools.has('zizmor'));
});

test('blocks: a tool blocks only on its block list (levels, rules, rule prefixes)', () => {
  const t = normalizeTool('t', { run: ['t'], block: { levels: ['error'], rules: ['CA5*', 'X1'] } });
  assert.ok(blocks(t, { rule: 'A', level: 'error' }));
  assert.ok(blocks(t, { rule: 'CA5350', level: 'warning' }));
  assert.ok(blocks(t, { rule: 'X1', level: 'note' }));
  assert.ok(!blocks(t, { rule: 'CA2000', level: 'warning' }));
  assert.ok(!blocks(normalizeTool('u', { run: ['u'] }), { rule: 'A', level: 'error' }), 'no block list: nothing blocks');
});

// ---- parsers ---------------------------------------------------------------------------------------------------

test('parsers: SARIF (rule default level, file URIs), MSBuild (deduplicated), ESLint JSON and stylish, gcc-style lines', () => {
  const sarif = P.parseSarif(JSON.stringify({ runs: [{ tool: { driver: { rules: [{ id: 'R1', defaultConfiguration: { level: 'error' } }] } }, results: [{ ruleId: 'R1', message: { text: 'm' }, locations: [{ physicalLocation: { artifactLocation: { uri: 'file:///r/src/a%20b.ts' }, region: { startLine: 4, snippet: { text: 'x' } } } }] }, { ruleId: 'R2', level: 'note', message: { text: 'n' }, locations: [] , partialFingerprints: { k: 'abc' } }] }] }));
  assert.deepEqual(sarif.map((f) => [f.rule, f.level, f.file, f.line, f.key]), [['R1', 'error', '/r/src/a b.ts', 4, null], ['R2', 'note', null, null, 'abc']]);
  assert.throws(() => P.parseSarif('{"x":1}'), /not a SARIF log/);
  assert.deepEqual(P.parseMsbuild('src/A.cs(3,5): warning CA5350: weak [p.csproj]\nsrc/A.cs(3,5): warning CA5350: weak [q.csproj]\nsrc/B.cs(1,1,1,4): error CS0103: nope\n').map((f) => [f.file, f.line, f.rule, f.level]), [['src/A.cs', 3, 'CA5350', 'warning'], ['src/B.cs', 1, 'CS0103', 'error']]);
  assert.deepEqual(P.parseEslintJson(JSON.stringify([{ filePath: '/r/a.ts', messages: [{ ruleId: 'security/detect-child-process', severity: 1, message: 'm', line: 2 }, { fatal: true, severity: 2, message: 'p', line: 1 }] }])).map((f) => [f.rule, f.level]), [['security/detect-child-process', 'warning'], ['parse-error', 'error']]);
  assert.deepEqual(P.parseEslintStylish('/r/a.ts\n  12:5  error  Unexpected any  @typescript-eslint/no-explicit-any\n').map((f) => [f.file, f.line, f.rule]), [['/r/a.ts', 12, '@typescript-eslint/no-explicit-any']]);
  assert.deepEqual(P.parseLines('src/a.c:7:2: warning: complexity 20\nsrc/b.py:3:1: E501 line too long\n').map((f) => [f.file, f.line, f.level]), [['src/a.c', 7, 'warning'], ['src/b.py', 3, 'error']]);
});

test('parsers: secret reports never keep the secret; actionlint, OSV-Scanner and the packs\' own parsers', async () => {
  const leaks = P.parseGitleaksJson(JSON.stringify([{ RuleID: 'aws', File: 'a.env', StartLine: 2, Secret: 'TOP-SECRET-VALUE', Match: 'key=TOP-SECRET-VALUE', Commit: 'abc' }]));
  assert.doesNotMatch(JSON.stringify(leaks), /TOP-SECRET-VALUE/);
  assert.match(leaks[0].key, /^secret:[0-9a-f]{16}$/);
  assert.deepEqual(P.parseActionlintJson('[{"message":"m","filepath":".github/workflows/a.yml","line":3,"kind":"expression"}]').map((f) => [f.rule, f.file, f.line]), [['expression', '.github/workflows/a.yml', 3]]);
  const osv = P.parseOsvJson(JSON.stringify({ results: [{ source: { path: 'package-lock.json' }, packages: [{ package: { name: 'minimist', version: '1.2.0', ecosystem: 'npm' }, groups: [{ ids: ['CVE-1', 'GHSA-aaaa'], max_severity: '9.8' }, { ids: ['GHSA-bbbb'], max_severity: '3.1' }] }] }] }));
  assert.deepEqual(osv.map((f) => [f.rule, f.level, f.key]), [['GHSA-aaaa', 'error', 'npm:minimist:GHSA-aaaa'], ['GHSA-bbbb', 'warning', 'npm:minimist:GHSA-bbbb']]);
  for (const name of ['sarif', 'msbuild', 'eslint-json', 'eslint', 'lines', 'gcc', 'gitleaks-json', 'actionlint-json', 'osv-json', ...['dotnet/analysis/nuget-audit', 'python/analysis/bandit', 'rust/analysis/cargo-deny'].map((m) => `module:${path.join(INSTALL_ROOT, 'packs', `${m}.mjs`)}`)]) {
    const [ok, detail] = await P.parserSelfTest(name);
    assert.ok(ok, detail);
  }
  const nuget = (await import(path.join(INSTALL_ROOT, 'packs/dotnet/analysis/nuget-audit.mjs'))).parse('Restoring...\n' + JSON.stringify({ projects: [{ path: 'a.csproj', frameworks: [{ framework: 'net10.0', topLevelPackages: [{ id: 'P', resolvedVersion: '1', vulnerabilities: [{ severity: 'Moderate', advisoryurl: 'https://github.com/advisories/GHSA-x' }] }], transitivePackages: [{ id: 'Q', resolvedVersion: '2', vulnerabilities: [{ severity: 'Critical', advisoryurl: 'https://github.com/advisories/GHSA-y' }] }] }] }] }));
  assert.deepEqual(nuget.map((f) => [f.rule, f.level, f.key]), [['GHSA-x', 'warning', 'nuget:P:GHSA-x'], ['GHSA-y', 'error', 'nuget:Q:GHSA-y']]);
});

// ---- baselining ----------------------------------------------------------------------------------------------

test('baseline by lines: only findings on lines the change added count; others in touched files are pre-existing', () => {
  const { root, git } = repo();
  write(root, 'a.ts', 'one\ntwo\nthree\n');
  git('add', '-A');
  git('commit', '-qm', 'a');
  write(root, 'a.ts', 'one\nTWO\nthree\nfour\n');
  write(root, 'new.ts', 'x\n');
  const raw = [{ rule: 'R', level: 'warning', file: 'a.ts', line: 2, message: 'm' }, { rule: 'R', level: 'warning', file: 'a.ts', line: 3, message: 'm' }, { rule: 'R', level: 'warning', file: 'new.ts', line: 1, message: 'm' }, { rule: 'R', level: 'warning', file: 'other.ts', line: 1, message: 'm' }];
  const changed = new Map([['a.ts', new Set([2, 4])], ['new.ts', null]]);
  const f = identify(root, 't', raw);
  const r = classify(f, { scope: 'changed-lines', baseline: 'lines', changed });
  assert.deepEqual(r.introduced.map((x) => `${x.file}:${x.line}`), ['a.ts:2', 'new.ts:1']);
  assert.deepEqual(r.preexisting.map((x) => `${x.file}:${x.line}`), ['a.ts:3']);
  assert.match(f[0].id, /^tool:R:[0-9a-f]{16}$/);
});

test('baseline by merge-base fingerprint: a moved finding is the same finding, a second copy is new; native trusts the tool', () => {
  const root = tmp('fp-');
  write(root, 'a.cs', 'x\nvar h = MD5.Create();\n');
  const base = identify(root, 't', [{ rule: 'CA5351', level: 'error', file: 'a.cs', line: 2, message: 'md5' }]);
  write(root, 'a.cs', 'x\ny\nz\nvar h = MD5.Create();\nvar h = MD5.Create();\n');
  const head = identify(root, 't', [4, 5].map((line) => ({ rule: 'CA5351', level: 'error', file: 'a.cs', line, message: 'md5' })));
  const r = classify(head, { scope: 'repo', baseline: 'merge-base', changed: new Map(), base });
  assert.equal(r.preexisting.length, 1);
  assert.equal(r.introduced.length, 1);
  assert.notEqual(head[0].id, head[1].id, 'a second copy gets its own id');
  const n = classify(head, { scope: 'repo', baseline: 'native', changed: new Map() });
  assert.equal(n.introduced.length, 2);
  assert.equal(stripRulePrefix('private.tmp.c.rules.javascript.eval.r1', ['/private/tmp/c/rules']), 'javascript.eval.r1');
  assert.equal(stripRulePrefix('factory.bin.analysis.rules.opengrep.typescript.factory.ts.x', ['.factory/bin/analysis/rules/opengrep/typescript'], '/r'), 'factory.ts.x');
});

test('runSlot with a merge-base tool: the merge-base is analysed in a worktree once (cached), and only what the change adds counts', async () => {
  const { root, git } = repo();
  const tool = path.join(root, '..', `t-${path.basename(root)}.mjs`);
  fs.writeFileSync(tool, "import fs from 'node:fs'; const n = fs.existsSync('deps.txt') ? fs.readFileSync('deps.txt','utf8').split('\\n').filter(Boolean) : []; console.log(JSON.stringify(n.map((d) => ({ RuleID: 'vuln-' + d, File: 'deps.txt', StartLine: null, Secret: d }))));");
  write(root, 'deps.txt', 'a\n');
  git('add', '-A');
  git('commit', '-qm', 'deps');
  git('checkout', '-qb', 'feature');
  write(root, 'deps.txt', 'a\nb\n');
  git('add', '-A');
  git('commit', '-qm', 'more deps');
  const config = cfg(root, { tools: { audit: { licence: 'MIT', run: [process.execPath, tool], parse: 'gitleaks-json', scope: 'repo', baseline: 'merge-base', block: { levels: ['error'] } } }, stages: { story: ['audit'] } });
  let calls = 0;
  const { runAsync } = await import('../lib/util.mjs');
  const exec = (...a) => (calls++, runAsync(...a));
  const rep = await runSlot(config, 'story', { cwd: root, base: 'main', exec });
  assert.deepEqual(rep.findings.map((f) => [f.rule, f.severity]), [['vuln-b', 'blocking']]);
  assert.deepEqual(rep.preexisting.map((f) => f.rule), ['vuln-a']);
  assert.equal(calls, 2);
  await runSlot(config, 'story', { cwd: root, base: 'main', exec });
  assert.equal(calls, 3, 'the merge-base result is cached');
  assert.equal(gitIn(root)('worktree', 'list').split('\n').length, 1, 'no worktree is left behind');
});

test('a secret scanner that reads commits also reads what is not committed yet (worktreeRun): changed lines of modified and untracked files', async () => {
  const { root, git } = repo();
  const tool = path.join(root, '..', `s-${path.basename(root)}.mjs`);
  // git mode: secrets in committed files; dir mode: secrets in the files it is given. One finding per SECRET line.
  fs.writeFileSync(tool, "import fs from 'node:fs'; import { execSync } from 'node:child_process'; const [mode, ...rest] = process.argv.slice(2); const files = mode === 'git' ? execSync('git ls-files', { encoding: 'utf8' }).split('\\n').filter(Boolean) : rest; const out = []; for (const f of files) fs.readFileSync(f, 'utf8').split('\\n').forEach((l, i) => { if (l.includes('SECRET')) out.push({ RuleID: 'token', File: f, StartLine: i + 1, Secret: l }); }); console.log(JSON.stringify(mode === 'git' ? out.filter((x) => !process.env.ONLY_DIR) : out));");
  write(root, 'old.cs', 'SECRET on main\n');
  git('add', '-A');
  git('commit', '-qm', 'base');
  git('checkout', '-qb', 'feature');
  write(root, 'old.cs', 'SECRET on main\nSECRET modified, not committed\n');
  write(root, 'new.cs', 'SECRET untracked\n');
  const spec = { licence: 'MIT', run: [process.execPath, tool, 'git'], worktreeRun: [process.execPath, tool, 'dir', '{files}'], parse: 'gitleaks-json', scope: 'repo', baseline: 'native', block: { rules: ['*'] } };
  const config = cfg(root, { tools: { leaks: spec }, stages: { story: ['leaks'] } });
  process.env.ONLY_DIR = '1';
  try {
    const rep = await runSlot(config, 'story', { cwd: root, base: 'main' });
    assert.deepEqual(rep.findings.map((f) => `${f.file}:${f.line}:${f.severity}`).sort(), ['new.cs:1:blocking', 'old.cs:2:blocking'], 'the uncommitted secrets count; the line already on main does not');
    assert.match(rep.tools[0].note, /also read 2 uncommitted file/);
  } finally {
    delete process.env.ONLY_DIR;
  }
  // Committed and clean: only the commit-range run (no second invocation).
  git('add', '-A');
  git('commit', '-qm', 'feature');
  let calls = 0;
  const { runAsync } = await import('../lib/util.mjs');
  const rep2 = await runSlot(config, 'story', { cwd: root, base: 'main', exec: (...a) => (calls++, runAsync(...a)) });
  assert.equal(calls, 1);
  assert.ok(rep2.findings.length >= 2);
  assert.deepEqual(normalizeTool('x', { ...spec }).worktreeRun, spec.worktreeRun);
});

// ---- suppressions, guard ---------------------------------------------------------------------------------------

test('suppressions: inline suppressions a change adds are listed (tracked and new files), with a justification request', () => {
  const { root, git } = repo();
  write(root, 'a.cs', 'class A {}\n');
  git('add', '-A');
  git('commit', '-qm', 'a');
  write(root, 'a.cs', 'class A {}\n#pragma warning disable CA5350\n');
  write(root, 'b.ts', 'ok\n// eslint-disable-next-line\nconst k = 1; // gitleaks:allow\n');
  const patterns = [...resolveAnalysis(cfg(root, {}, { project: { languages: ['dotnet', 'typescript'] } })).suppressions];
  const list = addedSuppressions(root, 'HEAD', patterns);
  assert.deepEqual(list.map((s) => `${s.file}:${s.line}:${s.id}`).sort(), ['a.cs:2:pragma-warning-disable', 'b.ts:2:eslint-disable', 'b.ts:3:secret-allow']);
  assert.match(suppressionsText(list), /needs a justification/);
});

test('the factory guard protects analysis configuration and suppression files only when analysis is on', async () => {
  const { factoryGuard, protectedList } = await import('../lib/factory-guard.mjs');
  const root = tmp('guard-');
  const off = { root, project: { languages: [] }, precheck: {} };
  assert.ok(!protectedList(off).includes('.gitleaksignore'));
  const on = { ...off, project: { languages: ['dotnet'] }, analysis: { protect: ['security/allow.txt'] } };
  const list = protectedList(on);
  for (const p of ['.gitleaksignore', '.betterleaksignore', '.editorconfig', 'security/allow.txt']) assert.ok(list.includes(p), p);
  const env = { PIPELINE_CHILD: '1', PIPELINE_AGENT_NAME: 'pair-implementer' };
  assert.match(factoryGuard(on, { tool_name: 'Write', tool_input: { file_path: path.join(root, '.gitleaksignore'), content: 'x' } }, env), /static analysis configuration and suppression files/);
  assert.match(factoryGuard(on, { tool_name: 'Bash', tool_input: { command: 'echo x >> .editorconfig' }, cwd: root }, env), /Factory guard/);
  assert.equal(factoryGuard(off, { tool_name: 'Write', tool_input: { file_path: path.join(root, '.gitleaksignore'), content: 'x' } }, env), null);
});

// ---- report and PR body ----------------------------------------------------------------------------------------

test('tool findings for the council: source tool, stable id, the tool\'s lens, blocking only from the block list, action fix', () => {
  const report = { sha: 'abc123', findings: [{ id: 'tool:R:1', tool: 'opengrep', rule: 'R', lens: 'security', severity: 'blocking', file: 'a.ts', line: 3, message: 'm' }, { id: 'tool:S:2', tool: 'opengrep', rule: 'S', lens: 'security', severity: 'minor', file: null, line: null, message: 'n' }] };
  const f = R.toolFindings(report);
  assert.deepEqual(f.map((x) => [x.id, x.source, x.lens, x.severity, x.action, x.harness]), [['tool:R:1', 'tool', 'security', 'blocking', 'fix', true], ['tool:S:2', 'tool', 'security', 'minor', 'fix', true]]);
  assert.ok(R.isToolFinding({ id: 'tool:x' }) && !R.isToolFinding({ id: 'api-r1-1' }));
  assert.match(R.fixTaskText({ findings: report.findings }, { bounce: 1, bounces: 2 }), /fix bounce 1 of 2; this is not a review round[\s\S]*cannot be disputed/);
});

test('PR body: the Static analysis section is added once, regenerated in place, and a body without analysis is unchanged', () => {
  const report = { ts: '2026-11-16', sha: 'a', tools: [{ id: 'betterleaks', status: 'ok' }, { id: 'opengrep', status: 'findings' }, { id: 'zizmor', status: 'skipped' }], findings: [{ tool: 'opengrep', rule: 'factory.ts.dynamic-code', file: 'a.ts', line: 1, severity: 'blocking' }], preexisting: [{}, {}], suppressions: [{ file: 'b.cs', line: 2 }] };
  const section = R.staticAnalysisSection([report], { fixLoops: [{ fixed: 3, bounces: 2 }], head: 'abcdef0123', slot: 'prCheck' });
  assert.match(section, /## Static analysis\n\n- Report: the PR check's run on this head \(abcdef0\)\n- Tools run: betterleaks, opengrep\n- Fixed before review: 3 finding\(s\) \(2 harness fix bounce\(s\)/);
  assert.match(section, /Still open on this head: 1 \(1 blocking\)\n {2}- opengrep `factory.ts.dynamic-code` a.ts:1\n- Follow-ups on pre-existing code: 2\n- Inline suppressions added: 1/);
  // Council C10 (Sol 3, Opus 3): a tool that errored did not run; distinct open findings once; observations apart.
  const errored = { ...report, tools: [...report.tools, { id: 'roslyn-security', status: 'error', error: 'build failed' }], findings: [...report.findings, { tool: 'opengrep', rule: 'factory.ts.dynamic-code', file: 'a.ts', line: 1, severity: 'blocking' }] };
  const s2 = R.staticAnalysisSection([errored], { head: 'abcdef0123', slot: 'prCheck', observed: 12, distinct: 3, runs: 4 });
  assert.match(s2, /- Tools run: betterleaks, opengrep\n- Did not run: 1\n {2}- roslyn-security \(error\): build failed/);
  assert.match(s2, /Still open on this head: 1 \(1 blocking\)/);
  assert.match(s2, /Across the story's 4 analysis run\(s\): 12 observation\(s\) of 3 distinct open finding\(s\)/);
  assert.match(R.staticAnalysisSection([], { head: 'abcdef0123', runs: 2 }), /Report: none for this head \(abcdef0\); what follows is from earlier heads[\s\S]*Still open on this head: not known/);
  const body = 'Implements X.\n\n🤖 Generated with tooling';
  const once = R.withStaticAnalysis(body, section);
  assert.match(once, /<!-- static-analysis:start -->[\s\S]*<!-- static-analysis:end -->\n\n🤖 Generated with tooling\n$/);
  assert.equal(R.withStaticAnalysis(once, section), once, 'regenerated in place');
  assert.equal(R.withStaticAnalysis(body, ''), `${body}`);
  assert.equal(R.staticAnalysisSection([], {}), '');
});

test('reports are kept per commit and slot; another slot\'s report is read for the same commit; pruning keeps the newest', () => {
  const root = tmp('rep-');
  const config = cfg(root, {});
  R.writeReport(config, { sha: 'aaa', slot: 'pair', configHash: 'h1', ts: '1', findings: [] });
  assert.equal(R.readReport(config, 'aaa', 'pair', { configHash: 'h1' }).slot, 'pair');
  assert.equal(R.readReport(config, 'aaa', 'pair', { configHash: 'h2' }), null, 'other tool settings: not reused');
  assert.equal(R.readReport(config, 'aaa', 'prCheck', { any: true }).slot, 'pair');
  for (const s of ['b', 'c', 'd']) R.writeReport(config, { sha: s, slot: 'pair', ts: s, findings: [] });
  assert.equal(R.pruneReports(config, 2).length, 2);
});

// ---- licences --------------------------------------------------------------------------------------------------

test('licences: no default tool, rule source or data source carries a rejected or non-allowlisted licence', () => {
  const languages = fs.readdirSync(path.join(INSTALL_ROOT, 'packs')).filter((p) => p !== 'security');
  const all = packAnalysis(languages);
  for (const [id, t] of Object.entries(all.tools)) {
    if (t.enabled === false) continue;
    const tool = normalizeTool(id, t);
    assert.ok(tool.licence, `${id} states its licence`);
    for (const r of licenceRows({ tools: new Map([[id, tool]]) })) assert.ok(r.ok, `${r.what}: ${r.problem}`);
    for (const s of [...tool.rules, ...tool.data.filter((d) => !d.excluded)]) assert.ok(!REJECTED.some((x) => x.test(s)), `${id} ${s.id} is rejected`);
  }
  assert.ok(Object.values(ALLOWLIST).every((u) => ['any', 'data', 'execute'].includes(u)));
});

test('licences: rejected folders and sources fail even when named; other licences need a person\'s acceptLicence; LGPL rules are not execute-only', () => {
  const tool = (rules, extra = {}) => new Map([['og', normalizeTool('og', { run: ['og'], licence: 'LGPL-2.1-only', rules, ...extra })]]);
  const gitlab = { repo: 'https://gitlab.com/gitlab-org/security-products/sast-rules.git', commit: 'a'.repeat(40) };
  const rows = (rules, accept = [], extra) => licenceRows({ tools: tool(rules, extra) }, { acceptLicence: accept });
  assert.ok(rows([{ id: 'cc', ...gitlab, include: ['rules/lgpl-cc'], licence: 'MIT' }]).some((r) => !r.ok && /Commons Clause/.test(r.problem)));
  assert.ok(rows([{ id: 'ee', ...gitlab, include: ['rules/gitlab'], licence: 'MIT' }]).some((r) => !r.ok && /Enterprise/.test(r.problem)));
  assert.ok(rows([{ id: 'all', ...gitlab, licence: 'MIT' }]).some((r) => !r.ok && /include list/.test(r.problem)));
  assert.ok(rows([{ id: 'sg', repo: 'https://github.com/semgrep/semgrep-rules', commit: 'a'.repeat(40), licence: 'MIT' }], [{ source: 'og:sg', licence: 'MIT', by: 'x', rejected: true }]).some((r) => !r.ok && /internal use only/.test(r.problem)), 'never opt-in');
  assert.ok(rows([{ id: 'og-rules', repo: 'https://github.com/opengrep/opengrep-rules', commit: 'a'.repeat(40), licence: 'LGPL-2.1-only' }]).some((r) => !r.ok));
  const lgpl = [{ id: 'lgpl', ...gitlab, include: ['rules/lgpl'], licence: 'LGPL-3.0-only' }];
  assert.ok(rows(lgpl).some((r) => !r.ok && /running an unmodified binary only/.test(r.problem)));
  assert.ok(rows(lgpl, [{ source: 'og:lgpl', licence: 'LGPL-3.0-only', by: 'Legal, 2026-11-16' }]).every((r) => r.ok));
  const tob = [{ id: 'tob', repo: 'https://github.com/trailofbits/semgrep-rules', commit: 'a'.repeat(40), licence: 'AGPL-3.0-only' }];
  assert.ok(rows(tob).some((r) => !r.ok && /AGPL/.test(r.problem)));
  assert.ok(rows(tob, [{ source: 'og:tob', licence: 'AGPL-3.0-only', by: 'client', rejected: true }]).every((r) => r.ok), 'opt-in for a client');
  assert.ok(rows([], [], { licence: 'BUSL-1.1' }).some((r) => !r.ok && /not on the factory's licence allowlist/.test(r.problem)));
  // A configuration that pulls a rejected source fails `factory analysis check` and doctor through the resolved rows,
  // and the source is not loaded.
  const a = resolveAnalysis(cfg('/r', { tools: { opengrep: { rules: [{ id: 'cc', ...gitlab, include: ['rules/lgpl-cc'], licence: 'MIT' }] } } }));
  assert.ok(a.licences.some((r) => !r.ok));
  assert.deepEqual(a.tools.get('opengrep').rules, []);
});

test('licence review: pending items run by default with a warning; analysis.licenceReview "strict" turns all of them off at once', async () => {
  const def = resolveAnalysis(cfg('/r', {}));
  const pending = def.licences.filter((r) => r.pending).map((r) => r.what);
  assert.deepEqual(pending.sort(), ['opengrep rules gitlab-sast-rules-go-c (go, c)', 'opengrep-interfile rules gitlab-sast-rules-go-c (go, c)', 'osv-scanner data osv-os-distributions'].sort());
  assert.ok(def.licences.every((r) => r.ok));
  assert.ok(def.tools.get('opengrep').rules.some((s) => s.include.includes('go')));
  assert.ok(!def.tools.get('osv-scanner').data.find((d) => d.id === 'osv-os-distributions').excluded);
  const { warnings, rows } = await analysisDoctor(cfg('/r', {}), def, { runner: () => ({ status: 1, stdout: '', stderr: '' }) });
  assert.equal(warnings.length, 3);
  assert.ok(warnings.every(([, d]) => /legal review pending/.test(d)));
  assert.ok(rows.some(([w]) => /licence: rules opengrep rules gitlab-sast-rules \(java/.test(w)));
  const strict = resolveAnalysis(cfg('/r', { licenceReview: 'strict' }));
  assert.ok(strict.licences.every((r) => r.ok), 'strict does not fail: it turns them off');
  assert.deepEqual(strict.licences.filter((r) => r.off).length, 3);
  assert.ok(!strict.tools.get('opengrep').rules.some((s) => s.include.includes('go')));
  assert.ok(strict.tools.get('osv-scanner').data.find((d) => d.id === 'osv-os-distributions').excluded);
  // Wolfi/Chainguard data is never fetched or kept, in either mode, and enabling it fails.
  assert.ok(def.tools.get('osv-scanner').data.find((d) => d.id === 'osv-wolfi-chainguard').excluded);
  const forced = resolveAnalysis(cfg('/r', { tools: { 'osv-scanner': { data: [{ id: 'osv-wolfi-chainguard', paths: ['Wolfi'], licence: 'CC-BY-NC-ND-4.0' }] } } }));
  assert.ok(forced.licences.some((r) => !r.ok && /non-commercial/.test(r.problem)));
});

test('every default runs offline: the rendered commands carry their offline flags and never the network ones', () => {
  const a = resolveAnalysis(cfg('/r', {}, { project: { languages: ['dotnet', 'typescript'] } }));
  const { data } = CI.ciData(a);
  const flat = (c) => (Array.isArray(c) ? c.join(' ') : c);
  assert.match(flat(data.tools['osv-scanner'].run), /--offline .*--data-source native/);
  assert.match(flat(data.tools.betterleaks.run), /--redact/);
  assert.doesNotMatch(flat(data.tools.betterleaks.run), /--validation/);
  assert.match(flat(data.tools.zizmor.run), /--offline/);
  for (const [id, t] of a.tools) for (const flag of t.offline ?? []) assert.ok(flat(t.run).includes(flag), `${id} lacks ${flag}`);
  for (const t of Object.values(data.tools)) assert.doesNotMatch(JSON.stringify(t), /latest|--config auto|semgrep\.dev/);
});

// ---- downloads and rule sets (fakes, no network) ---------------------------------------------------------------

test('installBinary: verifies the SHA-256 before anything is kept; a bare executable is installed once', async () => {
  const cacheDir = tmp('inst-');
  const body = Buffer.from('#!/bin/sh\necho 1.0\n');
  const sha256 = createHash('sha256').update(body).digest('hex');
  const fetchImpl = async () => ({ ok: true, status: 200, arrayBuffer: async () => body });
  const bad = await installBinary('t', { version: '1.0', platforms: { p: { url: 'https://x/t', sha256: '0'.repeat(64), bin: 't' } } }, { cacheDir, plat: 'p', fetchImpl });
  assert.match(bad.detail, /checksum mismatch/);
  assert.equal(fs.readdirSync(path.join(cacheDir, 'tools')).length, 0, 'nothing kept');
  const good = await installBinary('t', { name: 'engine', version: '1.0', platforms: { p: { url: 'https://x/t', sha256, bin: 't' } } }, { cacheDir, plat: 'p', fetchImpl });
  assert.ok(good.ok && fs.existsSync(good.bin) && good.bin.includes('engine-1.0-p'));
  const again = await installBinary('t2', { name: 'engine', version: '1.0', platforms: { p: { url: 'https://x/t', sha256, bin: 't' } } }, { cacheDir, plat: 'p', fetchImpl: async () => assert.fail('no second download') });
  assert.match(again.detail, /already installed/);
});

test('ruleSet: only the included folders at the pinned commit, files without the licence header and files that do not load dropped, cached once', () => {
  const src = tmp('rules-src-');
  const git = gitIn(src);
  git('init', '-q', '-b', 'main');
  write(src, 'java/a.yml', '# License: MIT (c) Upstream\nrules:\n- id: a\n');
  write(src, 'java/broken.yml', '# License: MIT (c) Upstream\nrules:\n- id: broken\n');
  write(src, 'java/nohead.yml', 'rules:\n- id: n\n');
  write(src, 'rules/lgpl-cc/x.yml', '# License: MIT (c) Upstream\nrules:\n- id: x\n');
  write(src, 'java/README.md', 'docs');
  git('add', '-A');
  git('commit', '-qm', 'rules');
  const commit = git('rev-parse', 'HEAD');
  const cacheDir = tmp('rules-cache-');
  const spec = { id: 'up', repo: src, commit, include: ['java'], requireHeader: 'License: MIT (c) Upstream', licence: 'MIT' };
  let validations = 0;
  const r = ruleSet(spec, { cacheDir, validate: (f) => (validations++, { ok: !f.endsWith('broken.yml'), detail: 'bad pattern' }) });
  assert.ok(r.ok, r.detail);
  assert.equal(r.kept, 1);
  assert.deepEqual(r.dropped.map((d) => d.file).sort(), ['java/broken.yml', 'java/nohead.yml']);
  assert.deepEqual(fs.readdirSync(path.join(r.dir, 'java')), ['a.yml']);
  assert.ok(!fs.existsSync(path.join(r.dir, 'rules')), 'folders outside include are never fetched or kept');
  assert.ok(!fs.readdirSync(path.dirname(r.dir)).some((n) => n === '.git'), 'no clone left on disk');
  const again = ruleSet(spec, { cacheDir, validate: () => assert.fail('validated once') });
  assert.match(again.detail, /cached/);
  assert.equal(validations, 2);
  const wrong = ruleSet({ ...spec, commit: 'f'.repeat(40) }, { cacheDir });
  assert.ok(!wrong.ok);
});

test('pruneData: excluded advisory data is deleted wherever the tool put it after prepare', () => {
  const cache = tmp('data-');
  for (const d of ['db/osv-scalibr/npm', 'db/osv-scalibr/Wolfi', 'db/osv-scalibr/Chainguard', 'db/osv-scalibr/Debian']) fs.mkdirSync(path.join(cache, d), { recursive: true });
  const removed = pruneData(cache, [{ id: 'w', paths: ['Wolfi', 'Chainguard'], excluded: true }, { id: 'os', paths: ['Debian'] }]);
  assert.deepEqual(removed.map((p) => path.basename(p)).sort(), ['Chainguard', 'Wolfi']);
  assert.ok(fs.existsSync(path.join(cache, 'db/osv-scalibr/Debian')) && fs.existsSync(path.join(cache, 'db/osv-scalibr/npm')));
});

// ---- CI --------------------------------------------------------------------------------------------------------

const JOBS = [
  { id: 'secrets', name: 'Secret scan', tools: ['s'], required: true, when: ['pull_request'], fetchDepth: 0, toolchain: false, timeoutMin: 30 },
  { id: 'dependencies', name: 'Dependency audit', tools: ['d'], required: true, when: ['pull_request'], fetchDepth: 0, toolchain: true, timeoutMin: 30 },
  { id: 'extra', name: 'Optional thing', tools: ['e'], required: false, when: ['pull_request'], fetchDepth: 0, toolchain: false, timeoutMin: 10 },
];

test('CI jobs render for GitHub Actions, GitLab CI and Azure Pipelines from one provider-neutral list; each only calls the generated script', () => {
  const gh = YAML.parse(CI.renderGithubActions(JOBS));
  assert.deepEqual(Object.keys(gh.jobs), ['secrets', 'dependencies', 'extra']);
  assert.deepEqual(gh.permissions, { contents: read() });
  function read() {
    return 'read';
  }
  for (const j of Object.values(gh.jobs)) {
    assert.ok(j.steps.every((s) => !s.uses || /^actions\/(checkout|setup-node)@[0-9a-f]{40}$|^\.\/\.github\/actions\/factory-toolchain$/.test(s.uses)), 'only GitHub\'s own actions, pinned by commit');
    const run = j.steps.find((s) => s.run).run;
    assert.match(run, /node \.factory\/bin\/analysis\/ci\.mjs --job \S+ --base "origin\/\$BASE_REF"/);
    assert.doesNotMatch(run, /\$\{\{/, 'no template expansion inside a script');
    assert.equal(j.steps[0].with['persist-credentials'], false);
    assert.doesNotMatch(JSON.stringify(j), /secrets\./, 'no secret reaches a scanner');
  }
  assert.ok(gh.jobs.dependencies.steps.some((s) => s.uses === './.github/actions/factory-toolchain'));
  const gl = YAML.parse(CI.renderGitlabCi(JOBS));
  assert.deepEqual(Object.keys(gl), ['factory-analysis-secrets', 'factory-analysis-dependencies', 'factory-analysis-extra']);
  assert.match(gl['factory-analysis-secrets'].script.join('\n'), /ci\.mjs --job secrets --base "origin\/\$CI_MERGE_REQUEST_TARGET_BRANCH_NAME"/);
  assert.equal(gl['factory-analysis-extra'].rules[0].allow_failure, true);
  assert.equal(gl['factory-analysis-secrets'].rules[0].allow_failure, undefined);
  const az = YAML.parse(CI.renderAzurePipelines(JOBS));
  assert.deepEqual(az.jobs.map((j) => j.job), ['secrets', 'dependencies', 'extra']);
  assert.match(az.jobs[0].steps.at(-1).bash, /ci\.mjs --job secrets --base "origin\/\$base"/);
  assert.equal(az.jobs[2].continueOnError, true);
  assert.equal(CI.renderGithubActions([]), null);
});

test('the review gate waits for the analysis workflow: derived lists include it, explicit lists get it added and cannot ignore it', async () => {
  const { expectedWorkflows } = await import('../../review-gate/lib/expected-ci.mjs');
  const { defaultRequiredChecks } = await import('../../review-gate/lib/enforcement.mjs');
  const text = CI.renderGithubActions(JOBS);
  const exp = expectedWorkflows([{ path: CI.GITHUB_WORKFLOW, text }], { base: 'main', changed: ['src/a.ts'] });
  assert.deepEqual(exp.map((w) => [w.path, w.required]), [[CI.GITHUB_WORKFLOW, true]]);
  const root = tmp('req-');
  write(root, CI.GITHUB_WORKFLOW, text);
  assert.deepEqual(defaultRequiredChecks(root).filter((c) => /scan|audit|Optional/.test(c)).sort(), ['Dependency audit', 'Optional thing', 'Secret scan']);
  const config = { root, project: { languages: [] }, analysis: { ci: { jobs: [{ id: 'secrets', name: 'Secret scan', tools: ['betterleaks'] }] } }, implement: { reviewGate: { ci: { expected: ['.github/workflows/build.yml'], ignore: [CI.GITHUB_WORKFLOW] }, requiredChecks: ['build'] } } };
  CI.withAnalysisGate(config);
  assert.deepEqual(config.implement.reviewGate.ci.expected, ['.github/workflows/build.yml', CI.GITHUB_WORKFLOW]);
  assert.deepEqual(config.implement.reviewGate.ci.ignore, []);
  assert.deepEqual(config.implement.reviewGate.requiredChecks, ['build', 'Secret scan']);
});

test('ciOutputs: nothing without analysis; with it, the script, its modules, the factory\'s own rules, job data and the workflow', () => {
  assert.deepEqual(CI.ciOutputs(cfg('/r', undefined)), []);
  const outs = CI.ciOutputs(cfg('/r', {}, { project: { languages: ['dotnet'] } }));
  const paths = outs.map((o) => o.path);
  for (const p of [CI.CI_SCRIPT, '.factory/bin/analysis/parsers.mjs', '.factory/bin/analysis/baseline.mjs', '.factory/bin/analysis/fetch.mjs', CI.CI_DATA, '.factory/bin/analysis/parsers/nuget-audit.mjs', '.factory/bin/analysis/rules/opengrep/csharp/weak-crypto.yaml', CI.GITHUB_WORKFLOW]) assert.ok(paths.includes(p), p);
  assert.ok(!paths.some((p) => /\.(ts|cs)$/.test(p)), 'rule fixtures are not rendered');
  const data = JSON.parse(outs.find((o) => o.path === CI.CI_DATA).content);
  assert.ok(data.tools['opengrep-interfile'].rules.some((r) => r.dirs?.[0] === '.factory/bin/analysis/rules/opengrep/typescript'));
  assert.ok(data.tools['opengrep-interfile'].rules.some((r) => r.repo && r.include.includes('csharp')), 'third-party rules are fetched by the script, not rendered');
  const dir = tmp('chk-');
  for (const o of outs.filter((x) => x.path.endsWith('.mjs'))) {
    const f = path.join(dir, `${path.basename(o.path, '.mjs')}-${outs.indexOf(o)}.mjs`);
    fs.writeFileSync(f, o.content);
    const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' });
    assert.equal(r.status, 0, `${o.path}: ${r.stderr}`);
  }
});

test('the generated CI script on fake tools: introduced findings fail a required job, findings already on the base are reported only', () => {
  const { root, git } = repo();
  const tool = path.join(root, 'tool.mjs');
  fs.writeFileSync(tool, "import fs from 'node:fs'; const out=[]; for (const f of ['a.txt','b.txt']) if (fs.existsSync(f)) fs.readFileSync(f,'utf8').split('\\n').forEach((l,i)=>{ if (l.includes('BAD')) out.push({ruleId:'BAD',level:'error',message:{text:'bad'},locations:[{physicalLocation:{artifactLocation:{uri:f},region:{startLine:i+1}}}]}); }); console.log(JSON.stringify({version:'2.1.0',runs:[{tool:{driver:{name:'f'}},results:out}]}));");
  write(root, 'a.txt', 'BAD old\n');
  git('add', '-A');
  git('commit', '-qm', 'old finding');
  git('checkout', '-qb', 'pr');
  const config = cfg(root, { tools: { fake: { run: [process.execPath, tool], parse: 'sarif', scope: 'repo', baseline: 'merge-base', block: { levels: ['error'] }, licence: 'MIT' } }, ci: { jobs: [{ id: 'fake', name: 'Fake', tools: ['fake'] }] } });
  for (const o of CI.ciOutputs(config)) write(root, o.path, o.content);
  git('add', '-A');
  git('commit', '-qm', 'render');
  const run = () => spawnSync(process.execPath, [CI.CI_SCRIPT, '--job', 'fake', '--base', 'main'], { cwd: root, encoding: 'utf8', env: { ...process.env, FACTORY_CACHE_DIR: tmp('cic-') } });
  let r = run();
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /on base {2}fake BAD a\.txt:1/);
  write(root, 'b.txt', 'fine\nBAD new\n');
  git('add', '-A');
  git('commit', '-qm', 'new finding');
  r = run();
  assert.equal(r.status, 1);
  assert.match(r.stdout, /BLOCKING fake BAD b\.txt:2/);
  assert.match(r.stdout, /1 introduced \(1 blocking\), 1 already on the base/);
});

test('render writes the analysis CI files into the manifest only with an analysis section, and uninstall takes them back', async () => {
  const { render, uninstall, readManifest } = await import('../../factory/lib/render.mjs');
  const { root } = repo();
  write(root, '.factory/factory.json', JSON.stringify({ version: '0.0.0', tools: ['claude'], features: { lsp: false, graphify: false, ci: true, agentFiles: false, gitHooks: false, demoVideo: false } }));
  write(root, '.factory/config.json', '{}');
  render(root, INSTALL_ROOT);
  assert.ok(!Object.keys(readManifest(root).files).some((p) => p.includes('analysis')));
  write(root, '.factory/config.json', JSON.stringify({ analysis: { ci: { jobs: [{ id: 'secrets', name: 'Secret scan', tools: ['betterleaks'] }] } } }));
  render(root, INSTALL_ROOT);
  const files = Object.keys(readManifest(root).files);
  assert.ok(files.includes(CI.GITHUB_WORKFLOW) && files.includes(CI.CI_SCRIPT));
  assert.ok(fs.existsSync(path.join(root, CI.GITHUB_WORKFLOW)));
  uninstall(root, INSTALL_ROOT);
  assert.ok(!fs.existsSync(path.join(root, CI.GITHUB_WORKFLOW)) && !fs.existsSync(path.join(root, CI.CI_SCRIPT)));
});

// ---- doctor, prune -------------------------------------------------------------------------------------------

test('doctor rows: pinned version installed, parser sample, offline flags, rule sources, prepared data, CI rendered', async () => {
  const root = tmp('doc-');
  const a = resolveAnalysis(cfg(root, {}));
  const { rows } = await analysisDoctor(cfg(root, {}), a, { runner: () => ({ status: 0, stdout: 'betterleaks version 1.10.1', stderr: '' }), manifest: { files: {} }, plat: 'linux-x64' });
  const row = (re) => rows.find(([w]) => re.test(w));
  assert.equal(row(/betterleaks 1\.10\.1 installed/)[1], false);
  assert.match(row(/betterleaks 1\.10\.1 installed/)[2], /factory analysis install betterleaks/);
  assert.equal(row(/betterleaks reports version 1\.10\.1/)[1], true);
  assert.equal(row(/betterleaks parser reads its sample/)[1], true);
  assert.equal(row(/osv-scanner runs offline/)[1], true);
  assert.equal(row(/betterleaks never passes --validation/)[1], true);
  assert.equal(row(/opengrep rule sources/)[1], false);
  assert.equal(row(/offline vulnerability database at most 7/)[1], false);
  assert.equal(row(/CI jobs rendered/)[1], false);
});

test('prune: analysis reports beyond the newest kept, old merge-base caches, scratch folders and unpinned, unused cached tools', async () => {
  const { planAnalysis } = await import('../../factory/lib/prune.mjs');
  const cache = tmp('pc-');
  const dir = tmp('pa-');
  const old = Date.now() - 40 * 86_400_000;
  for (const p of ['tools/opengrep-2.0.0-linux-x64', 'tools/old-1.0-linux-x64', 'rules/gone-abc', 'reports/a', 'reports/b', 'reports/c', 'base/m1', 'out/x']) fs.mkdirSync(path.join(p.startsWith('tools') || p.startsWith('rules') ? cache : dir, p), { recursive: true });
  for (const p of [path.join(cache, 'tools/old-1.0-linux-x64'), path.join(cache, 'tools/opengrep-2.0.0-linux-x64'), path.join(cache, 'rules/gone-abc'), path.join(dir, 'base/m1'), path.join(dir, 'out/x')]) fs.utimesSync(p, old / 1000, old / 1000);
  const entries = planAnalysis({ analysis: { cache, dir, pinned: new Set(['opengrep-2.0.0-linux-x64']) }, settings: { analysisReports: 2, analysisCacheDays: 30, analysisBaseDays: 14 }, now: Date.now(), exec: () => ({ status: 1, stdout: '' }) });
  const names = entries.map((e) => path.basename(e.path)).sort();
  assert.deepEqual(names.filter((n) => n !== 'a' && n !== 'b' && n !== 'c'), ['gone-abc', 'm1', 'old-1.0-linux-x64', 'x']);
  assert.equal(names.filter((n) => ['a', 'b', 'c'].includes(n)).length, 1, 'reports beyond the newest two');
});

// ---- the factory's own rules ----------------------------------------------------------------------------------

const opengrep = () => {
  const candidates = [process.env.FACTORY_OPENGREP, ...((process.env.PATH ?? '').split(path.delimiter).map((d) => path.join(d, process.platform === 'win32' ? 'opengrep.exe' : 'opengrep')))].filter(Boolean);
  return candidates.find((c) => fs.existsSync(c)) ?? null;
};

test('the factory\'s TypeScript and C# rules: every rule has positive and negative fixtures and passes Opengrep\'s test mode', (t) => {
  const dir = path.join(INSTALL_ROOT, 'packs/security/rules/opengrep');
  for (const lang of ['typescript', 'csharp']) {
    const rules = fs.readdirSync(path.join(dir, lang)).filter((f) => f.endsWith('.yaml'));
    assert.ok(rules.length >= 8, `${lang}: ${rules.length} rules`);
    for (const r of rules) {
      const text = fs.readFileSync(path.join(dir, lang, r), 'utf8');
      assert.match(text, /The factory's own rule \(MIT\)/);
      const fixture = fs.readFileSync(path.join(dir, lang, r.replace(/\.yaml$/, lang === 'typescript' ? '.ts' : '.cs')), 'utf8');
      assert.match(fixture, /\/\/ ruleid: /, `${r} has a positive case`);
      assert.match(fixture, /\/\/ ok: /, `${r} has a negative case`);
    }
  }
  const bin = opengrep();
  if (!bin) {
    t.skip('opengrep is not installed here (set FACTORY_OPENGREP to its binary to run the rule tests; the suite never downloads)');
    return;
  }
  for (const lang of ['typescript', 'csharp']) {
    const r = spawnSync(bin, ['test', path.join(dir, lang)], { encoding: 'utf8', timeout: 300_000 });
    assert.match(`${r.stdout}${r.stderr}`, /All tests passed/, `${lang}: ${r.stdout}${r.stderr}`);
  }
});

test('configAnalysisProblems reads the packs of the configured languages', () => {
  assert.deepEqual(configAnalysisProblems({ project: { languages: ['dotnet'] }, analysis: { stages: { pair: ['nuget-audit', 'betterleaks'] } } }), []);
  assert.match(configAnalysisProblems({ project: { languages: [] }, analysis: { stages: { pair: ['nuget-audit'] } } }).join(), /not a tool/);
});

test('coverage evidence: lcov and Cobertura, only the production lines the change added, never test files', async () => {
  const { parseLcov, parseCobertura, changedLineCoverage, coverageText } = await import('../lib/analysis/coverage.mjs');
  const root = tmp('cov-');
  write(root, 'src/a.ts', 'x\n');
  const lcov = parseLcov('SF:src/a.ts\nDA:1,1\nDA:2,0\nDA:3,4\nend_of_record\nSF:test/a.test.ts\nDA:1,1\nend_of_record\n', root);
  const c = changedLineCoverage(lcov, new Map([['src/a.ts', new Set([2, 3, 9])], ['test/a.test.ts', null]]));
  assert.deepEqual([c.total, c.covered, c.pct, c.rows[0].uncovered], [2, 1, 50, [2]]);
  assert.match(coverageText(c), /1\/2 \(50%\)[\s\S]*src\/a\.ts: not run by any test: lines 2/);
  const cob = parseCobertura('<coverage><sources><source>' + root + '</source></sources><packages><package><classes><class name="A" filename="src/a.ts"><lines><line number="1" hits="0"/><line number="2" hits="3"/></lines></class></classes></package></packages></coverage>', root);
  assert.deepEqual([...cob.get('src/a.ts')], [[1, 0], [2, 3]]);
  assert.equal(coverageText(changedLineCoverage(new Map(), new Map([['src/a.ts', null]]))), '');
});

// ---- found running the real tools on the test repository (dogfood C15) ------------------------------------------

test('the merge-base is analysed outside the repository tree with hooks off, and placeholders reach the head run too', async () => {
  const { root, git } = repo();
  const tool = path.join(root, '..', `cwd-${path.basename(root)}.mjs`);
  // Records where it ran and the solution it was given; reports one finding per line of deps.txt.
  fs.writeFileSync(tool, "import fs from 'node:fs'; fs.appendFileSync(process.env.LOG, JSON.stringify({ cwd: process.cwd(), sln: process.argv[2] }) + '\\n'); const n = fs.existsSync('deps.txt') ? fs.readFileSync('deps.txt','utf8').split('\\n').filter(Boolean) : []; console.log(JSON.stringify(n.map((d) => ({ RuleID: 'vuln-' + d, File: 'deps.txt', StartLine: null, Secret: d }))));");
  const log = path.join(root, '..', `cwd-${path.basename(root)}.log`);
  write(root, 'deps.txt', 'a\n');
  // A post-checkout hook that would leave a read-only file behind in every checkout.
  write(root, '.hooks/post-checkout', '#!/bin/sh\nmkdir -p ro && touch ro/x && chmod -w ro\n');
  fs.chmodSync(path.join(root, '.hooks/post-checkout'), 0o755);
  git('add', '-A');
  git('commit', '-qm', 'deps');
  git('config', 'core.hooksPath', '.hooks');
  git('checkout', '-qb', 'feature');
  write(root, 'deps.txt', 'a\nb\n');
  git('add', '-A');
  git('commit', '-qm', 'more deps');
  const config = cfg(root, { vars: { solution: 'app.slnf' }, tools: { audit: { licence: 'MIT', run: [process.execPath, tool, '{solution}'], parse: 'gitleaks-json', scope: 'repo', baseline: 'merge-base', block: { levels: ['error'] }, env: { LOG: log } } }, stages: { story: ['audit'] } });
  const rep = await runSlot(config, 'story', { cwd: root, base: 'main' });
  const runs = fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(runs.map((r) => r.sln), ['app.slnf', 'app.slnf'], 'the head run gets analysis.vars, like the merge-base run');
  const real = fs.realpathSync(root);
  const baseRun = runs.find((r) => !r.cwd.startsWith(real) && !r.cwd.startsWith(root));
  assert.ok(baseRun, `the merge-base checkout is not inside the repository (${runs.map((r) => r.cwd).join(', ')})`);
  assert.ok(baseRun.cwd.includes('factory-analysis-base-'));
  assert.deepEqual(rep.preexisting.map((f) => f.rule), ['vuln-a']);
  assert.ok(!fs.existsSync(baseRun.cwd), 'the checkout is removed even with a read-only folder in it');
  assert.equal(gitIn(root)('worktree', 'list').split('\n').length, 1);
});

test('settings a report depends on: the placeholder values change the slot hash; unresolved placeholders are named with their candidates', async () => {
  const { slotHash } = await import('../lib/analysis/runner.mjs');
  const { unresolvedVars } = await import('../lib/analysis/config.mjs');
  const root = tmp('vars-');
  write(root, 'a.slnx', '');
  write(root, 'a.Web.slnf', '');
  const base = { tools: { b: { licence: 'MIT', run: ['b', '{solution}', '{out}'], parse: 'sarif', scope: 'repo' } }, stages: { story: ['b'] } };
  const a1 = resolveAnalysis(cfg(root, base));
  assert.deepEqual(unresolvedVars(a1, root), [{ tool: 'b', name: 'solution', candidates: [] }]);
  const packVars = resolveAnalysis(cfg(root, { ...base, vars: { solution: { candidates: ['*.slnx', '*.slnf'] } } }));
  assert.deepEqual(unresolvedVars(packVars, root)[0].candidates.sort(), ['a.Web.slnf', 'a.slnx'], 'two candidates: nothing is picked');
  const set = resolveAnalysis(cfg(root, { ...base, vars: { solution: 'a.Web.slnf' } }));
  assert.deepEqual(unresolvedVars(set, root), []);
  assert.notEqual(slotHash(set, 'story'), slotHash(resolveAnalysis(cfg(root, { ...base, vars: { solution: 'a.slnx' } })), 'story'));
});

test('analysis.secrets.allow: known non-secrets join the secret scanner\'s default rules as one allowlist; validated as governance', () => {
  const root = tmp('secrets-');
  const a = resolveAnalysis(cfg(root, { secrets: { allow: { stopwords: ['Pass123$'], regexes: ['^demo-[0-9]+$'] } } }));
  const toml = a.tools.get('betterleaks').env.BETTERLEAKS_CONFIG_TOML;
  assert.match(toml, /^\[extend\]\nuseDefault = true\n/);
  assert.match(toml, /stopwords = \["factoryfake", "Pass123\$"\]/);
  assert.match(toml, /regexes = \["\^demo-\[0-9\]\+\$"\]/);
  // Without a declared list, the factory's placeholder marker alone (the test-writing agents' fake values).
  assert.match(resolveAnalysis(cfg(root, {})).tools.get('betterleaks').env?.BETTERLEAKS_CONFIG_TOML, /stopwords = \["factoryfake"\]/);
  assert.deepEqual(analysisProblems({ secrets: { allow: { stopwords: ['x'] } } }), []);
  assert.match(analysisProblems({ secrets: { allow: { words: ['x'] } } }).join(), /analysis.secrets.allow.words must be a list/);
  assert.match(analysisProblems({ secrets: { allow: { regexes: ['('] } } }).join(), /is not a regular expression/);
});

test('the reviewers\' static-analysis evidence lists open findings, then tool problems by name; a skipped tool is not a problem', () => {
  const report = {
    sha: 'abcdef1234567890',
    tools: [
      { id: 'probe', status: 'findings', introduced: 1 },
      { id: 'eslint-security', status: 'skipped', error: 'no changed file for this tool' },
      { id: 'roslyn-security', status: 'timeout', error: 'roslyn-security timed out after 600 s' },
    ],
    fixLoop: { fixed: 0, autoFixed: true, bounces: 0 },
    findings: [{ severity: 'minor', tool: 'probe', rule: 'note', file: 'a.cs', line: 3, message: 'a working note' }],
    preexisting: [],
    suppressions: [],
  };
  const text = R.evidenceText(report);
  assert.match(text, /Still open after the harness fix loop[^\n]*\n- minor probe note a\.cs:3: a working note\n\nTool notes:\n- roslyn-security \(timeout\): roslyn-security timed out after 600 s$/);
  assert.doesNotMatch(text, /no changed file for this tool/);
});

test('the factory\'s own Opengrep rules skip test code (a test client\'s request is not the server\'s input; dogfood C15)', () => {
  const dir = path.join(INSTALL_ROOT, 'packs', 'security', 'rules', 'opengrep');
  for (const lang of ['csharp', 'typescript']) {
    for (const f of fs.readdirSync(path.join(dir, lang)).filter((x) => x.endsWith('.yaml'))) {
      const doc = YAML.parse(fs.readFileSync(path.join(dir, lang, f), 'utf8'));
      for (const rule of doc.rules) for (const p of ['e2e/**', '**/*.spec.*', 'tests/**', '**/*Tests/**']) assert.ok(rule.paths?.exclude?.includes(p), `${lang}/${f} ${rule.id} excludes ${p}`);
    }
  }
});

test('a tool\'s exclude globs keep it off those files: eslint-security does not read test code (council C10, Sol 4)', async () => {
  const { root, git } = repo();
  const tool = path.join(root, '..', `x-${path.basename(root)}.mjs`);
  // One finding per file it is given.
  fs.writeFileSync(tool, "console.log(JSON.stringify(process.argv.slice(2).map((f) => ({ RuleID: 'seen', File: f, StartLine: 1, Secret: f }))));");
  write(root, 'src/a.ts', 'x\n');
  git('add', '-A');
  git('commit', '-qm', 'base');
  git('checkout', '-qb', 'feature');
  write(root, 'src/a.ts', 'y\n');
  write(root, 'e2e/teststack/a.spec.ts', 'z\n');
  git('add', '-A');
  git('commit', '-qm', 'change');
  const spec = { licence: 'MIT', run: [process.execPath, tool, '{files}'], parse: 'gitleaks-json', scope: 'changed-files', baseline: 'lines', extensions: ['.ts'], exclude: ['e2e/**', '**/*.spec.*'] };
  const rep = await runSlot(cfg(root, { tools: { sec: spec }, stages: { story: ['sec'] } }), 'story', { cwd: root, base: 'main' });
  assert.deepEqual(rep.findings.map((f) => f.file), ['src/a.ts']);
  const pack = JSON.parse(fs.readFileSync(path.join(INSTALL_ROOT, 'packs/typescript/analysis.json'), 'utf8'));
  assert.ok(pack.tools['eslint-security'].exclude.includes('**/*.spec.*'));
});
