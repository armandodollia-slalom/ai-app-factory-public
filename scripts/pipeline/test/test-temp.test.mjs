// Test hygiene: a test run removes every temp directory its tests and their processes create, passed or failed
// (run.mjs, temp-preload.mjs). The suites used to leave about 65,000 directories in $TMPDIR.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { AGENT_CLIS } from './temp-preload.mjs';
import { POOL_CLIS } from '../lib/pool.mjs';
import { AGENT_CLIS as INTERVIEW_CLIS } from '../../factory/lib/interview.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

test('under npm test, this file\'s temp directory is its own and registered with the run, and every child uses it', { skip: process.env.FACTORY_TEST_TMP_FILE ? false : 'run directly with node --test, not through npm test' }, () => {
  assert.equal(os.tmpdir(), process.env.FACTORY_TEST_TMP_FILE);
  assert.match(fs.readFileSync(path.join(process.env.FACTORY_TEST_TMP_REGISTRY, path.basename(os.tmpdir())), 'utf8'), /test-temp\.test\.mjs/);
  const child = spawnSync(process.execPath, ['-e', 'console.log(require("os").tmpdir())'], { encoding: 'utf8' }).stdout.trim();
  assert.equal(child, os.tmpdir());
});

test('npm test uses the runner, so every suite\'s temp files go with the run', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(here, '../../../package.json'), 'utf8'));
  for (const script of ['test', 'test:pipeline']) assert.match(pkg.scripts[script], /node scripts\/pipeline\/test\/run\.mjs scripts\/\*\/test\/\*\.test\.mjs/);
});

test('a failing test file that leaves temp directories (its own and a child process\'s) leaves nothing after the run', () => {
  const parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'guard-')));
  const report = path.join(parent, 'report.json');
  try {
    const env = { ...process.env, FACTORY_TEST_TMP_PARENT: parent, LEAKY_REPORT: report };
    delete env.FACTORY_TEST_KEEP_TMP;
    const r = spawnSync(process.execPath, [path.join(here, 'run.mjs'), path.join(here, 'fixtures', 'leaky.fixture.mjs')], { encoding: 'utf8', env, timeout: 120_000 });
    assert.notEqual(r.status, 0, 'the fixture fails');
    const { tmp } = JSON.parse(fs.readFileSync(report, 'utf8'));
    assert.equal(path.dirname(tmp), parent, `the test file's temp dir ${tmp} was its own, in the run's temp folder`);
    assert.deepEqual(fs.readdirSync(parent), ['report.json'], 'the run removed the test file\'s directory, with what the test and its child left, and its registry');
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

// No test starts a paid agent: under the runner every agent CLI on PATH is a stand-in that records the call and fails,
// so a test that reads the failure as an unavailable provider (and passes) still fails its file and the run, naming
// them. A fake CLI first on PATH is what tests use, and passes.
test('a test file that starts the real claude fails, and the run names the file; a fake claude first on PATH passes', { skip: process.platform === 'win32' ? 'the stand-ins are shell scripts' : false }, () => {
  const parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'guard-agent-')));
  const fixture = path.join(here, 'fixtures', 'real-agent.fixture.mjs');
  const run = (extra = {}) => {
    const env = { ...process.env, FACTORY_TEST_TMP_PARENT: parent, ...extra };
    for (const k of ['FACTORY_TEST_KEEP_TMP', 'FACTORY_TEST_AGENT_CALLS', 'FACTORY_TEST_FILE']) delete env[k];
    return spawnSync(process.execPath, [path.join(here, 'run.mjs'), fixture], { encoding: 'utf8', env, timeout: 120_000 });
  };
  try {
    const real = run();
    assert.equal(real.status, 1, real.stdout + real.stderr);
    const out = real.stdout + real.stderr;
    assert.match(out, /# pass 1\n# fail 1/, 'the test passed, its file failed');
    assert.match(out, /not ok \d+ - \S*real-agent\.fixture\.mjs\n/);
    assert.match(out, new RegExp(`a test started a real agent CLI[^\\n]*real-agent\\.fixture\\.mjs\\t[^\\n]*\\tclaude -p --model claude-opus-5-5`));
    // A process started with a bare environment names no test file: its own file passes, the run fails and says so.
    const bare = run({ REAL_AGENT_BARE_ENV: '1' });
    assert.equal(bare.status, 1, bare.stdout + bare.stderr);
    assert.match(bare.stdout + bare.stderr, /# pass 1\n# fail 0[\s\S]*a test started a real agent CLI: \?\t[^\n]*\tclaude -p --model claude-opus-5-5/);
    const bin = fs.mkdtempSync(path.join(parent, 'fake-bin-'));
    fs.writeFileSync(path.join(bin, 'claude'), '#!/bin/sh\necho fake\n', { mode: 0o755 });
    const fake = run({ REAL_AGENT_FAKE_BIN: bin });
    assert.equal(fake.status, 0, fake.stdout + fake.stderr);
    assert.doesNotMatch(fake.stdout + fake.stderr, /real agent CLI/);
    // Council r3 (test-value follow-up): every CLI the factory runs (models.pool) or probes (the interview) has its
    // stand-in, and a version probe of one sees no CLI (exit 127, nothing recorded), the same on every machine.
    const product = [...new Set([...POOL_CLIS.filter((c) => c !== 'custom'), ...INTERVIEW_CLIS])];
    assert.deepEqual(product.filter((c) => !AGENT_CLIS.includes(c)), [], 'a stand-in for each');
    for (const cli of product) {
      const other = run({ REAL_AGENT_CLI: cli });
      assert.equal(other.status, 1, `${cli}: ${other.stdout}${other.stderr}`);
      assert.match(other.stdout + other.stderr, new RegExp(`a test started a real agent CLI: [^\\n]*\\t${cli} -p --model`), cli);
    }
    const probe = run({ REAL_AGENT_VERSION: '1' });
    assert.equal(probe.status, 0, probe.stdout + probe.stderr);
    assert.doesNotMatch(probe.stdout + probe.stderr, /real agent CLI/);
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});
