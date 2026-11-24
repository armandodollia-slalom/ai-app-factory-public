// Commercial scanners as part of static analysis (packs/commercial, analysis.commercial): the definitions, the config
// (licence by a named person, token as a reference, replace or beside per job), local mode in the fix loop and in the
// generated CI script (severity map with a client override, the vendor's triage respected and reported, dedupe by
// location and CWE), server mode against fake vendor APIs (the head waits for the scanner's check and result, a
// timeout fails closed, the vendor's gate and blocking findings fail it), and the guard against agents triaging in
// the vendor's system. No real vendor is called.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { analysisProblems, packAnalysis, resolveAnalysis } from '../lib/analysis/config.mjs';
import { ciCheckNames, ciOutputs } from '../lib/analysis/ci.mjs';
import { dedupe, normalizeVendorSeverity, severityOf } from '../lib/analysis/commercial.mjs';
import { parserFor } from '../lib/analysis/parsers.mjs';
import { runSlot } from '../lib/analysis/runner.mjs';
import { scannerEvidence, scannerFor, scannersFor } from '../lib/analysis/scanners/index.mjs';
import { headPipelines } from '../lib/ci/evidence.mjs';
import { conformance } from '../lib/providers/conformance.mjs';
import { vendorTriageCommand, factoryGuard } from '../lib/factory-guard.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, 'fakes/fake-scanner-cli.mjs');
const SHA = 'a'.repeat(40);
const workers = [];
after(() => Promise.all(workers.map((w) => w.terminate())));
async function fake(kind, auth) {
  const w = new Worker(path.join(HERE, 'fakes/providers-fake-server.mjs'), { workerData: { kind, auth } });
  workers.push(w);
  const [{ port }] = await once(w, 'message');
  const url = `http://127.0.0.1:${port}`;
  return { url, seed: (s) => fetch(`${url}/__fake/seed`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(s) }), state: async () => (await fetch(`${url}/__fake/state`)).json() };
}
const tmp = (p) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));
const accept = (tool, licence) => ({ tool, licence, by: 'Pat Doe (client security lead), 2026-11-17' });

test('the commercial pack: seven definitions, all off, each with a licence to accept, the token variable, its docs and whether it was verified', async () => {
  const tools = packAnalysis([]).tools;
  const ids = Object.keys(tools).filter((id) => tools[id].commercial);
  assert.deepEqual(ids.sort(), ['checkmarx', 'codeql', 'semgrep', 'snyk-code', 'snyk-open-source', 'sonarqube', 'veracode']);
  for (const id of ids) {
    const t = tools[id];
    assert.equal(t.enabled, false, `${id} is off by default`);
    assert.match(t.licence, /^LicenseRef-/, `${id}: a commercial licence a person must accept`);
    assert.ok(t.commercial.tokenEnv && t.commercial.docs.length && t.commercial.docsRead, id);
    assert.equal(typeof t.commercial.verified, 'boolean', id);
    assert.ok(t.commercial.modes.every((m) => ['local', 'server'].includes(m)), id);
    assert.ok(t.severity && ['critical', 'high', 'medium', 'low', 'info'].every((k) => ['blocking', 'major', 'minor'].includes(t.severity[k])), `${id}: a full severity map`);
  }
  // Without analysis.commercial nothing of the pack runs.
  const r = resolveAnalysis({ root: tmp('cs-'), analysis: {} });
  assert.ok(!ids.some((id) => r.tools.has(id)));
  assert.deepEqual(r.commercial, []);
  const v = await parserFor(`module:${path.resolve(HERE, '../../../packs/commercial/parsers/veracode-pipeline.mjs')}`);
  const found = v.parse(v.sample.text);
  assert.equal(found.length, v.sample.count);
  assert.deepEqual([found[0].cwe, found[0].vendorSeverity, found[0].line], ['CWE-89', 'high', 42]);
});

test('config: the token is a ${NAME} reference only, the mode must be one the scanner supports, severities are the factory\'s three', () => {
  const packTools = packAnalysis([]).tools;
  const p = (c) => analysisProblems({ commercial: c }, { packTools });
  assert.deepEqual(p({ scanner: 'snyk-code', token: '${ACME_SNYK}' }), []);
  assert.match(p({ scanner: 'snyk-code', token: 'snyk-abc123' }).join(), /reference, never the token itself/);
  assert.match(p({ scanner: 'snyk-code' }).join(), /token must name the variable/);
  assert.match(p({ scanner: 'sonarqube', mode: 'local', token: '${S}' }).join(), /runs server only/);
  assert.match(p({ scanner: 'nessus', token: '${S}' }).join(), /not a commercial scanner definition/);
  assert.match(p({ scanner: 'semgrep', token: '${S}', severity: { medium: 'urgent' } }).join(), /must be blocking, major, minor/);
  assert.match(p({ scanner: 'checkmarx', token: '${S}', env: { CX_CLIENT_ID: 'plain-id' } }).join(), /env.CX_CLIENT_ID must be a/);
});

test('replace or beside, per job: a scanner replacing sast takes its CI job and its fix-loop tools; beside it adds its own job; no licence acceptance, no run', () => {
  const root = tmp('cs-');
  const base = { root, analysis: { acceptLicence: [accept('snyk-code', 'LicenseRef-Snyk-Terms')] } };
  const replace = resolveAnalysis({ ...base, analysis: { ...base.analysis, commercial: { scanner: 'snyk-code', token: '${ACME_SNYK}', replaces: ['sast'] } } });
  assert.ok(!replace.ci.jobs.some((j) => j.id === 'sast'));
  assert.ok(replace.ci.jobs.some((j) => j.id === 'commercial-snyk-code' && j.required));
  assert.ok(!replace.stages.story.includes('opengrep') && replace.stages.story.includes('snyk-code'));
  assert.deepEqual(replace.tools.get('snyk-code').env, { SNYK_TOKEN: '${ACME_SNYK}' }, 'the vendor\'s variable gets the client\'s, as a reference');
  const beside = resolveAnalysis({ ...base, analysis: { ...base.analysis, commercial: { scanner: 'snyk-code', token: '${ACME_SNYK}' } } });
  assert.ok(beside.ci.jobs.some((j) => j.id === 'sast') && beside.ci.jobs.some((j) => j.id === 'commercial-snyk-code'));
  assert.ok(beside.stages.story.includes('opengrep') && beside.stages.story.includes('snyk-code'));
  const unaccepted = resolveAnalysis({ root, analysis: { commercial: { scanner: 'snyk-code', token: '${ACME_SNYK}' } } });
  assert.match(unaccepted.blocked['snyk-code'], /analysis\.acceptLicence/);
  assert.ok(!unaccepted.ci.jobs.some((j) => j.id === 'commercial-snyk-code'), 'no CI job runs an unaccepted licence');
  // Server mode: no fix-loop stage; its CI job uploads; its check joins the required checks.
  const server = resolveAnalysis({ root, analysis: { acceptLicence: [accept('sonarqube', 'LicenseRef-SonarSource-Commercial')], commercial: { scanner: 'sonarqube', mode: 'server', token: '${SONAR}', url: 'https://sonar.acme.io', project: 'shop' } } });
  assert.ok(!server.stages.story.includes('sonarqube'));
  assert.equal(server.tools.get('sonarqube').submitOnly, true);
  assert.ok(ciCheckNames(server).includes('SonarQube Code Analysis'));
});

test('severity map: vendor severities map to blocking, major, minor; the client overrides; a tool without a map keeps its block list', () => {
  const tool = { severity: { critical: 'blocking', high: 'blocking', medium: 'major', low: 'minor', info: 'minor' } };
  assert.equal(severityOf(tool, { vendorSeverity: 'high' }), 'blocking');
  assert.equal(severityOf(tool, { vendorSeverity: 'medium' }), 'major');
  assert.equal(severityOf({ severity: { ...tool.severity, medium: 'blocking' } }, { vendorSeverity: 'medium' }), 'blocking');
  assert.equal(severityOf(tool, { level: 'error' }), 'blocking', 'no vendor severity: the SARIF level stands for it');
  assert.equal(severityOf({ block: { levels: ['error'] } }, { level: 'warning' }), 'minor');
  assert.deepEqual(['9.8', '7.5', '5', '0.1', 'BLOCKER', 'MAJOR', 'Very High', 'informational'].map((x) => normalizeVendorSeverity(x)), ['critical', 'high', 'medium', 'low', 'critical', 'high', 'critical', 'info']);
  assert.equal(normalizeVendorSeverity(4, { scale: 5 }), 'high');
});

test('dedupe by location and CWE keeps the higher severity and names the other tools', () => {
  const out = dedupe([
    { tool: 'opengrep', file: 'a.js', line: 3, cwe: 'CWE-89', severity: 'minor' },
    { tool: 'snyk-code', file: 'a.js', line: 3, cwe: 'CWE-89', severity: 'blocking' },
    { tool: 'snyk-code', file: 'a.js', line: 3, cwe: 'CWE-79', severity: 'major' },
    { tool: 'osv-scanner', file: null, line: null, cwe: null, severity: 'blocking' },
  ]);
  assert.equal(out.length, 3);
  assert.deepEqual([out[0].tool, out[0].severity, out[0].alsoBy], ['snyk-code', 'blocking', ['opengrep']]);
});

function repo() {
  const root = tmp('cs-repo-');
  const g = (...a) => spawnSync('git', a, { cwd: root, encoding: 'utf8' });
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 't@example.com');
  g('config', 'user.name', 't');
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src/db.js'), 'export const ok = 1;\n');
  g('add', '.');
  g('commit', '-qm', 'base');
  g('checkout', '-qb', 'feat');
  fs.writeFileSync(path.join(root, 'src/db.js'), 'export const ok = 1;\nconst q = (id) => db.query("select " + id);\nconst x = eval(input);\nconsole.log(secret);\n');
  g('commit', '-qam', 'change');
  return root;
}
const localConfig = (root, extra = {}) => ({
  root,
  analysis: {
    tools: { 'snyk-code': { run: [process.execPath, CLI, '{out}'] }, 'fake-sast': { licence: 'MIT', run: [process.execPath, CLI, '{out}', '--flavor', 'oss'], output: '{out}', parse: 'sarif', scope: 'repo', baseline: 'merge-base', lens: 'security' } },
    stages: { story: ['fake-sast'] },
    acceptLicence: [accept('snyk-code', 'LicenseRef-Snyk-Terms')],
    commercial: { scanner: 'snyk-code', token: '${FACTORY_TEST_SNYK}', severity: { low: 'major' } },
    ...extra,
  },
});

test('local mode in the fix loop: the token from the environment, findings mapped, the vendor\'s triage reported not blocking, one finding per place and CWE', async () => {
  const root = repo();
  process.env.FACTORY_TEST_SNYK = 'good-token';
  const r = await runSlot(localConfig(root), 'story', { cwd: root, base: 'main' });
  const snyk = r.tools.find((t) => t.id === 'snyk-code');
  assert.equal(snyk.status, 'findings', JSON.stringify(r.tools));
  const sqli = r.findings.find((f) => f.cwe === 'CWE-89');
  assert.deepEqual([sqli.tool, sqli.rule, sqli.severity, sqli.alsoBy], ['snyk-code', 'javascript/Sqli', 'blocking', ['fake-sast']], 'the vendor rule id kept, the open-source copy folded in');
  assert.equal(r.findings.filter((f) => f.cwe === 'CWE-89').length, 1);
  assert.equal(r.findings.find((f) => f.cwe === 'CWE-532').severity, 'major', 'the client override (low -> major)');
  assert.ok(!r.findings.some((f) => f.cwe === 'CWE-95'), 'a finding triaged in the vendor system does not block');
  assert.deepEqual(r.triaged.map((f) => [f.rule, f.triage]), [['javascript/CodeInjection', 'false-positive']]);
  assert.ok(sqli.fingerprint && /^[0-9a-f]{16}$/.test(sqli.fingerprint), 'a stable fingerprint');
  // Without the token the scanner does not run, and says which variable is missing (never a value).
  delete process.env.FACTORY_TEST_SNYK;
  const none = await runSlot(localConfig(root), 'story', { cwd: root, base: 'main' });
  const t = none.tools.find((x) => x.id === 'snyk-code');
  assert.deepEqual([t.status, /FACTORY_TEST_SNYK is not set/.test(t.error)], ['missing', true]);
});

test('local mode in CI: the generated script reads the token from the CI secret store, fails on a blocking finding, reports the triaged one; the job data holds only the reference', () => {
  const root = repo();
  const config = localConfig(root);
  for (const f of ciOutputs(config, { provider: 'github-actions' })) {
    if (!f.path) continue;
    fs.mkdirSync(path.dirname(path.join(root, f.path)), { recursive: true });
    fs.writeFileSync(path.join(root, f.path), f.content);
  }
  const jobs = fs.readFileSync(path.join(root, '.factory/bin/analysis/jobs.json'), 'utf8');
  assert.match(jobs, /"SNYK_TOKEN": "\$\{FACTORY_TEST_SNYK\}"/);
  assert.doesNotMatch(jobs, /good-token/);
  const workflow = ciOutputs(config, { provider: 'github-actions' }).find((f) => f.path?.startsWith('.github/workflows/'));
  assert.match(workflow.content, /commercial-snyk-code/);
  const run = (env) => spawnSync(process.execPath, ['.factory/bin/analysis/ci.mjs', '--job', 'commercial-snyk-code', '--base', 'main'], { cwd: root, encoding: 'utf8', env: { ...process.env, FACTORY_CACHE_DIR: path.join(root, '.cache'), ...env } });
  const ok = run({ FACTORY_TEST_SNYK: 'good-token' });
  assert.equal(ok.status, 1, ok.stdout + ok.stderr);
  assert.match(ok.stdout, /BLOCKING snyk-code javascript\/Sqli src\/db\.js:2/);
  assert.match(ok.stdout, /triaged {2}snyk-code javascript\/CodeInjection src\/db\.js:3: false-positive/);
  assert.doesNotMatch(ok.stdout + ok.stderr, /good-token/);
  const env = { ...process.env };
  delete env.FACTORY_TEST_SNYK;
  const missing = spawnSync(process.execPath, ['.factory/bin/analysis/ci.mjs', '--job', 'commercial-snyk-code', '--base', 'main'], { cwd: root, encoding: 'utf8', env: { ...env, FACTORY_CACHE_DIR: path.join(root, '.cache') } });
  assert.equal(missing.status, 1);
  assert.match(missing.stdout, /FACTORY_TEST_SNYK not set \(add it to the CI system's secret store\)/);
  // Every CI system gets the job from the same data, and its token from its own secret store: mapped where a store
  // does not expose secrets to every step (GitHub Actions, Azure Pipelines, Jenkins), as is where it does.
  const SECRET = { 'github-actions': /FACTORY_TEST_SNYK: \$\{\{ secrets\.FACTORY_TEST_SNYK \}\}/, 'azure-pipelines': /FACTORY_TEST_SNYK: \$\(FACTORY_TEST_SNYK\)/, jenkins: /FACTORY_TEST_SNYK = credentials\('factory-test-snyk'\)/ };
  for (const provider of ['github-actions', 'gitlab-ci', 'azure-pipelines', 'jenkins', 'circleci', 'bitbucket-pipelines']) {
    const text = ciOutputs(config, { provider }).filter((f) => !f.path?.startsWith('.factory/')).map((f) => f.content).join('\n');
    assert.match(text, /commercial-snyk-code/, provider);
    if (SECRET[provider]) assert.match(text, SECRET[provider], provider);
    assert.doesNotMatch(text, /good-token/, provider);
  }
  // Without a commercial scanner the analysis workflow is exactly as before: no secret in it.
  const plain = ciOutputs({ root, analysis: {} }, { provider: 'github-actions' }).find((f) => f.path?.startsWith('.github/workflows/'));
  assert.doesNotMatch(plain.content, /secrets\./);
  assert.match(plain.content, /the scanners get no token and no secret/);
});

// CodeQL is on the factory's rejected list (its CLI terms need paid Advanced Security for closed-source code): the
// person accepting it says so explicitly ("rejected": true).
const serverConfig = (root, scanner, extra) => ({ root, host: { type: 'github', repo: 'acme/shop' }, analysis: { acceptLicence: [{ ...accept(scanner, packAnalysis([]).tools[scanner].licence), ...(scanner === 'codeql' ? { rejected: true } : {}) }], commercial: { scanner, mode: 'server', ...extra } } });

test('server mode, SonarQube: the head waits for the scanner\'s check, then the quality gate and the issues decide; triage is the vendor\'s', async () => {
  const sq = await fake('sonarqube', 'Bearer sq-good');
  process.env.FACTORY_TEST_SONAR = 'sq-good';
  const root = tmp('cs-sq-');
  const s = scannerFor(serverConfig(root, 'sonarqube', { token: '${FACTORY_TEST_SONAR}', url: sq.url, project: 'shop', timeoutSec: 300 }));
  assert.equal(s.type, 'sonarqube');
  const ev = (checks, now = Date.now()) => scannerEvidence(s, { head: SHA, pr: 1, checks, config: { root }, now });
  assert.equal(ev([]).state, 'pending', 'no check on the head yet: never green');
  assert.equal(ev([{ name: 'SonarQube Code Analysis', status: 'in_progress', conclusion: null }]).state, 'pending');
  const green = [{ name: 'SonarQube Code Analysis', status: 'completed', conclusion: 'success' }];
  const ok = ev(green);
  assert.equal(ok.state, 'success', ok.detail);
  assert.deepEqual(ok.triaged.map((f) => [f.rule, f.triage]), [['javascript:S3649', 'false-positive']], 'a false positive marked in SonarQube is reported, not blocking');
  await sq.seed({ sonarGate: { 1: 'ERROR' } });
  assert.match(ev(green).detail, /quality gate failed/);
  await sq.seed({ sonarGate: { 1: 'OK' }, sonarIssues: { 1: [{ key: 'B1', rule: 'java:S2076', severity: 'BLOCKER', component: 'shop:src/Run.java', line: 7, message: 'OS command injection', issueStatus: 'OPEN' }] } });
  assert.equal(ev(green).state, 'failure', 'an open blocker blocks even when the vendor\'s gate passed');
  // Asynchronous: no analysis of the PR yet stays pending until the timeout, then fails closed.
  await sq.seed({ sonarGate: {} });
  const t0 = Date.now();
  assert.equal(ev(green, t0).state, 'pending');
  const late = ev(green, t0 + 6 * 60_000);
  assert.deepEqual([late.state, /within 300 s/.test(late.detail)], ['failure', true]);
  const r = await conformance('scanner', s, { fixture: { head: SHA, pr: 1 } });
  assert.ok(r.ok, JSON.stringify(r.results));
});

test('server mode, GitHub code scanning and Semgrep: alerts and findings of the pull request, dismissals and ignores respected, CWE kept', async () => {
  const cs = await fake('codescanning', 'Bearer gh-good');
  process.env.FACTORY_TEST_GHAS = 'gh-good';
  const root = tmp('cs-gh-');
  const gh = scannerFor(serverConfig(root, 'codeql', { token: '${FACTORY_TEST_GHAS}', url: cs.url }));
  const checks = [{ name: 'CodeQL', status: 'completed', conclusion: 'success' }];
  const a = scannerEvidence(gh, { head: SHA, pr: 1, checks, config: { root } });
  assert.equal(a.state, 'failure', a.detail);
  assert.match(a.detail, /blocking finding/, 'a high-severity open alert blocks');
  assert.deepEqual([a.findings[0].rule, a.findings[0].cwe, a.triaged[0].triage], ['js/sql-injection', 'CWE-89', 'false-positive']);
  assert.ok((await conformance('scanner', gh, { fixture: { head: SHA, pr: 1 } })).ok);
  const sg = await fake('semgrep', 'Bearer sg-good');
  process.env.FACTORY_TEST_SEMGREP = 'sg-good';
  const sem = scannerFor(serverConfig(root, 'semgrep', { token: '${FACTORY_TEST_SEMGREP}', url: sg.url, project: 'acme/shop', deployment: 'acme', check: 'semgrep-cloud-platform/scan' }));
  const b = scannerEvidence(sem, { head: SHA, pr: 1, checks: [{ name: 'semgrep-cloud-platform/scan', status: 'completed', conclusion: 'success' }], config: { root } });
  assert.equal(b.state, 'success', `medium is major, not blocking; the high one was ignored in Semgrep: ${b.detail}`);
  assert.deepEqual([b.findings.map((f) => f.severity), b.triaged.map((f) => f.triage)], [['major'], ['accepted']]);
  assert.ok((await conformance('scanner', sem, { fixture: { head: SHA, pr: 1 } })).ok);
});

test('merge safety: the head\'s evidence includes the scanner, so a green CI with the scan still running is pending, and a red scan is failure', async () => {
  const sq = await fake('sonarqube', 'Bearer sq-good');
  process.env.FACTORY_TEST_SONAR = 'sq-good';
  const root = tmp('cs-merge-');
  const config = serverConfig(root, 'sonarqube', { token: '${FACTORY_TEST_SONAR}', url: sq.url, project: 'shop' });
  let checks = [{ name: 'build', status: 'completed', conclusion: 'success' }];
  const target = {
    host: { repo: 'acme/shop', pr: { get: () => ({ headSha: SHA, base: 'main', head: 'feat' }), files: () => [], checks: () => checks } },
    ci: { type: 'fake-scanner-merge', expected: () => [{ id: 'build', name: 'build', required: true }], runs: () => [{ id: 1, pipeline: 'build', name: 'build', status: 'completed', conclusion: 'success', event: 'pull_request' }] },
    scanners: scannersFor(config),
    scannerEvidence,
    config,
  };
  const w1 = headPipelines(target, 1, {});
  assert.equal(w1.state, 'pending', 'CI green, the scanner\'s check not on the head yet');
  assert.match(w1.running.join(), /SonarQube Code Analysis/);
  checks = [...checks, { name: 'SonarQube Code Analysis', status: 'completed', conclusion: 'success' }];
  assert.equal(headPipelines(target, 1, {}).state, 'success');
  checks = [checks[0], { name: 'SonarQube Code Analysis', status: 'completed', conclusion: 'failure' }];
  assert.equal(headPipelines(target, 1, {}).state, 'failure');
  // A head that moved since it was assessed is not judged on the old evidence.
  assert.equal(headPipelines(target, 1, { head: 'f'.repeat(40) }).state, 'pending');
  // A scanner whose licence nobody accepted is a failure, never a silent skip.
  const unaccepted = scannersFor({ ...config, analysis: { ...config.analysis, acceptLicence: [] } });
  assert.equal(scannerEvidence(unaccepted[0], { head: SHA, pr: 1, checks, config: { root } }).state, 'failure');
  // A check-only scanner without a check name cannot bind a result to the head: never green.
  const cx = scannersFor(serverConfig(root, 'checkmarx', { token: '${CX}', check: null }))[0];
  cx.settings.check = null;
  assert.equal(scannerEvidence(cx, { head: SHA, pr: 1, checks, config: { root } }).state, 'unknown');
});

test('a client\'s own scanner service through the custom adapter (the worked example): pending, then bound to the head, triage respected', async () => {
  const root = tmp('cs-custom-');
  const results = path.join(root, 'results.json');
  process.env.FACTORY_TEST_ACME = 'acme-token';
  process.env.FACTORY_TEST_ACME_RESULTS = results;
  const example = path.resolve(HERE, '../../../docs/providers/examples/custom-scanner.mjs');
  const config = { root, analysis: {
    tools: { 'acme-scan': { licence: 'LicenseRef-Acme-Scan', lens: 'security', severity: { critical: 'blocking', high: 'blocking', medium: 'major', low: 'minor', info: 'minor' }, commercial: { vendor: 'Acme', modes: ['server'], tokenEnv: 'ACME_SCAN_TOKEN', server: { adapter: 'custom', command: [process.execPath, example], env: { ACME_SCAN_TOKEN: '${FACTORY_TEST_ACME}', ACME_SCAN_RESULTS: '${FACTORY_TEST_ACME_RESULTS}' } } } } },
    commercial: { scanner: 'acme-scan', mode: 'server', token: '${FACTORY_TEST_ACME}' },
    acceptLicence: [accept('acme-scan', 'LicenseRef-Acme-Scan')],
  } };
  assert.deepEqual(analysisProblems(config.analysis, { packTools: packAnalysis([]).tools }), []);
  const s = scannerFor(config);
  assert.equal(s.checkName(), 'acme/scan', 'the script names its check');
  const checks = [{ name: 'acme/scan', status: 'completed', conclusion: 'success' }];
  assert.equal(scannerEvidence(s, { head: SHA, pr: 1, checks, config: { root } }).state, 'pending', 'no result for the head yet');
  fs.writeFileSync(results, JSON.stringify({ [SHA]: { findings: [{ rule: 'ACME-1', severity: 'critical', path: 'src/a.js', line: 3, message: 'x', cwe: 'CWE-22', triage: 'accepted' }, { rule: 'ACME-2', severity: 'medium', path: 'src/b.js', line: 1, message: 'y' }] } }));
  const ev = scannerEvidence(s, { head: SHA, pr: 1, checks, config: { root } });
  assert.deepEqual([ev.state, ev.triaged.map((f) => f.rule), ev.findings.map((f) => f.severity)], ['success', ['ACME-1'], ['major']]);
  assert.ok((await conformance('scanner', s, { fixture: { head: SHA, pr: 1 } })).ok);
});

test('doctor: the scanner\'s credential variables and its licence acceptance are checked; values are never shown', async () => {
  const { productRows } = await import('../../factory/lib/adapters.mjs');
  const root = tmp('cs-doc-');
  spawnSync('git', ['init', '-q'], { cwd: root });
  const config = { analysis: { acceptLicence: [accept('semgrep', 'LicenseRef-Semgrep-AppSec-Platform')], commercial: { scanner: 'semgrep', mode: 'server', token: '${ACME_SEMGREP}', check: 'semgrep-cloud-platform/scan' } } };
  const rows = (env) => productRows(root, config, { load: async () => ({ available: false, reason: 'n/a' }), env, used: { host: { type: 'github' }, tracker: { type: 'github' }, ci: { provider: 'github-actions' } } }).then((r) => r.rows.filter((x) => /scanner/.test(x[0])));
  const missing = await rows({});
  assert.deepEqual(missing.map((r) => r[1]), [false, true]);
  assert.match(missing[0][2], /ACME_SEMGREP not set/);
  const set = await rows({ ACME_SEMGREP: 'sg-secret-value' });
  assert.equal(set[0][1], true);
  assert.doesNotMatch(JSON.stringify(set), /sg-secret-value/);
});

test('guard: an agent may never change a finding\'s state in the vendor\'s system', () => {
  for (const c of ['gh api -X PATCH repos/a/b/code-scanning/alerts/3 -f state=dismissed -f dismissed_reason="false positive"', 'curl -X POST "$SONAR/api/issues/do_transition?issue=AX1&transition=falsepositive"', 'snyk ignore --id=SNYK-JS-1 --reason=x', 'cx triage update --similarity-id 1 --state NOT_EXPLOITABLE', 'curl -X POST https://semgrep.dev/api/v1/deployments/acme/triage -d ...']) assert.ok(vendorTriageCommand(c), c);
  for (const c of ['gh api repos/a/b/code-scanning/alerts?pr=3', 'snyk code test --sarif-file-output=x', 'semgrep ci']) assert.equal(vendorTriageCommand(c), null, c);
  assert.match(factoryGuard({ root: tmp('cs-g-') }, { tool_name: 'Bash', tool_input: { command: 'snyk ignore --id=X' } }, { PIPELINE_CHILD: '1', PIPELINE_AGENT_NAME: 'retro' }), /Only a person triages/);
  // The vendor's own suppression files are protected once the scanner is on.
  const r = resolveAnalysis({ root: tmp('cs-p-'), analysis: { acceptLicence: [accept('snyk-code', 'LicenseRef-Snyk-Terms')], commercial: { scanner: 'snyk-code', token: '${S}' } } });
  assert.ok(r.protect.includes('.snyk'));
});
