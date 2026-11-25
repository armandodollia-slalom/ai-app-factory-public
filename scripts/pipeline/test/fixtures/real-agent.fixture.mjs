// A test file whose test passes although it starts the real `claude` (it reads the failure as an unavailable provider),
// for the agent CLI guard test (test-temp.test.mjs). With REAL_AGENT_FAKE_BIN, a fake `claude` comes first on PATH and
// nothing real starts. Not run by `npm test` (not *.test.mjs).
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';

test('treats a failed agent run as an unavailable provider', () => {
  const fake = process.env.REAL_AGENT_FAKE_BIN;
  // REAL_AGENT_BARE_ENV: the agent gets a bare environment (PATH only), so no file can be named; the run still fails.
  const env = fake ? { ...process.env, PATH: `${fake}${path.delimiter}${process.env.PATH}` } : process.env.REAL_AGENT_BARE_ENV ? { PATH: process.env.PATH } : process.env;
  // REAL_AGENT_CLI: which agent CLI (claude by default). REAL_AGENT_VERSION: only a version probe, which sees no CLI.
  const cli = process.env.REAL_AGENT_CLI ?? 'claude';
  if (process.env.REAL_AGENT_VERSION) assert.equal(spawnSync(cli, ['--version'], { env, encoding: 'utf8' }).status, 127, 'a version probe sees a machine without the CLI');
  else spawnSync(cli, ['-p', '--model', 'claude-opus-5-5'], { input: 'review this', env, encoding: 'utf8' });
});
