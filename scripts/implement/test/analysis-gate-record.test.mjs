// The pre-push gate keeps each job's result in the run records (held-out C21: SAST "could not run here" was only in a log
// line and the PR body, and why it could not run was recoverable only by running it again). One row per job and head in
// analysis-gate.jsonl (ran, verdict, why; no value), the PR line says why, and the Static analysis section draws on it.
import assert from 'node:assert/strict';
import { spawnSync as sh } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const { analysisGate, analysisGateSection, GATE_METRICS, whyNotRun } = await import('../lib/analysis-gate.mjs');
const { prAnalysisSection } = await import('../../pipeline/lib/analysis/fixloop.mjs');
const { readMetricsLocal } = await import('../../pipeline/lib/state.mjs');
const { KNOWN_STREAMS } = await import('../../pipeline/lib/sink.mjs');

function repo() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gate-record-')));
  const g = (...a) => sh('git', ['-c', 'core.hooksPath=/dev/null', ...a], { cwd: dir, encoding: 'utf8' });
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 't@example.com');
  g('config', 'user.name', 'T');
  fs.mkdirSync(path.join(dir, '.factory/bin/analysis'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.factory/bin/analysis/jobs.json'), JSON.stringify({ jobs: [{ id: 'secrets', name: 'Secret scan' }, { id: 'sast', name: 'Security patterns (SAST)' }] }));
  fs.writeFileSync(path.join(dir, '.gitignore'), '.factory/state/\n');
  g('add', '-A');
  g('commit', '-qm', 'init');
  const head = g('rev-parse', 'HEAD').stdout.trim();
  return { dir, head, config: { root: dir, stateDir: '.factory/state', metricsDir: '.factory/metrics', implement: {}, project: { languages: [] }, analysis: { tools: {}, stages: {} } } };
}

const OUTPUT = 'opengrep-interfile: running\n[ERROR] Could not remove git worktree /tmp/og-1\nopengrep-interfile: its output could not be read (sarif): not a SARIF log (no "runs")';
const results = [
  { check: 'factory-analysis Secret scan', job: 'secrets', ok: true, output: '', findings: [] },
  { check: 'factory-analysis Security patterns (SAST)', job: 'sast', ok: true, unverified: true, why: whyNotRun(OUTPUT, 1), output: OUTPUT, findings: [] },
];

test('the gate writes one row per job: ran, verdict and why it could not run', () => {
  const r = repo();
  const gate = analysisGate(r.config, { cwd: r.dir, branch: 'feat/pwd-1', base: 'main', keys: ['PWD-1'], fix: () => ({ results, fixRun: null }) });
  assert.equal(gate.ok, true);
  const rows = readMetricsLocal(r.config, GATE_METRICS);
  assert.deepEqual(rows.map((x) => [x.job, x.ran, x.verdict]), [['secrets', true, 'pass'], ['sast', false, 'unverified']]);
  assert.equal(rows[1].head, r.head);
  assert.equal(rows[1].story, 'PWD-1');
  assert.match(rows[1].why, /Could not remove git worktree|not a SARIF log/);
  assert.ok(KNOWN_STREAMS.includes(GATE_METRICS), 'shipped to the metrics sink');
});

test('the PR line and the Static analysis section say which job could not run here and why', () => {
  const r = repo();
  analysisGate(r.config, { cwd: r.dir, branch: 'feat/pwd-1', base: 'main', keys: ['PWD-1'], fix: () => ({ results, fixRun: null }) });
  assert.match(analysisGateSection({ results }), /could not run here, CI decides: sast \(.*not a SARIF log.*\)/);
  const section = prAnalysisSection(r.config, ['PWD-1'], { cwd: r.dir, head: r.head });
  assert.match(section, new RegExp(`CI's analysis jobs before the push \\(on ${r.head.slice(0, 7)}\\): secrets passed; sast could not run here \\(CI decides\\)`));
  assert.match(section, /- sast: .*not a SARIF log/);
  assert.equal(prAnalysisSection(r.config, ['OTHER-1'], { cwd: r.dir, head: r.head }), '', 'another story\'s gate is not this one\'s');
});
