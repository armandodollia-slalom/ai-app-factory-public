// other-38: no test contacts a code host, whatever this machine has signed in or exported.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

test('the test runner gives every test process no host token, a gh that fails, and a fetch that stays on this machine', async () => {
  for (const k of ['GH_TOKEN', 'GITHUB_TOKEN', 'GITLAB_TOKEN', 'AZURE_DEVOPS_TOKEN', 'SYSTEM_ACCESSTOKEN', 'BITBUCKET_TOKEN']) assert.equal(process.env[k], undefined, k);
  assert.equal(globalThis.__factoryTestsOffline, true, 'run through scripts/pipeline/test/run.mjs');
  await assert.rejects(fetch('https://api.bitbucket.org/2.0/user'), /tests run offline/);
  const gh = spawnSync('gh', ['api', 'user'], { encoding: 'utf8', shell: process.platform === 'win32' });
  assert.notEqual(gh.status, 0);
  // A child process (doctor, a CLI a test spawns) inherits the same.
  const child = spawnSync(process.execPath, ['-e', 'fetch("https://gitlab.com").then(() => process.exit(0), (e) => { console.log(e.message); process.exit(3); })'], { encoding: 'utf8' });
  assert.equal(child.status, 3);
  assert.match(child.stdout, /tests run offline/);
});
