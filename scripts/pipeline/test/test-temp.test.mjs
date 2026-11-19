// Test hygiene: a test run removes every temp directory its tests and their processes create, passed or failed
// (run.mjs, temp-preload.mjs). The suites used to leave about 65,000 directories in $TMPDIR.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

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
