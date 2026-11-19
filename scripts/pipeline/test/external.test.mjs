// Council C12 (D-C12-1): a `gh pr checks` call whose connection had closed never returned, and the run waited on it
// for 1h45m. Every external call (gh, git's network commands, docker, HTTP) now has a timeout and, when a repeat is
// safe, bounded retries; a hung call ends as a retry and then as a not-delivered outcome with its cause.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { externalKind, fetchWithTimeout, retrySafe, transientFailure } from '../lib/external.mjs';
import { run, runAsync } from '../lib/util.mjs';
import { ciGate, ciFlaky, ciLine, ciOutcome, deliveryDecision, waitForCi } from '../../implement/lib/ci-wait.mjs';
import { exec as boardExec } from '../../board/lib/assets.mjs';
import { capture } from '../../teststack/lib/runner.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = path.resolve(here, '..', '..', '..');

// A fake `gh` on PATH: `hang` sleeps far longer than any test, `flaky-net` fails once with a connection reset, then
// answers; every call is counted.
function fakeGh(mode) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-gh-'));
  const counter = path.join(dir, 'calls');
  fs.writeFileSync(
    path.join(dir, 'gh'),
    `#!/usr/bin/env node
const fs = require('fs');
const n = (fs.existsSync(${JSON.stringify(counter)}) ? Number(fs.readFileSync(${JSON.stringify(counter)}, 'utf8')) : 0) + 1;
fs.writeFileSync(${JSON.stringify(counter)}, String(n));
const mode = ${JSON.stringify(mode)};
if (mode === 'hang') setTimeout(() => {}, 600000);
else if (mode === 'flaky-net' && n === 1) { process.stderr.write('Post "https://api.github.com/graphql": read tcp: connection reset by peer'); process.exit(1); }
else { process.stdout.write(JSON.stringify([{ name: 'build', state: 'SUCCESS', bucket: 'pass' }])); }
`,
    { mode: 0o755 },
  );
  const env = { ...process.env, PATH: `${dir}${path.delimiter}${process.env.PATH}`, FACTORY_EXTERNAL_TIMEOUT_GH: '1', FACTORY_EXTERNAL_PAUSE_MS: '0' };
  return { dir, env, calls: () => Number(fs.existsSync(counter) ? fs.readFileSync(counter, 'utf8') : 0), done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('a hung gh read times out, is retried twice, then fails with its cause instead of hanging', () => {
  const gh = fakeGh('hang');
  const started = Date.now();
  const r = run('gh', ['pr', 'checks', '7', '-R', 'o/r', '--json', 'name'], { env: gh.env });
  const took = Date.now() - started;
  assert.ok(took < 15_000, `bounded (${took} ms)`);
  assert.equal(r.timedOut, true);
  assert.equal(r.attempts, 3);
  // (A fake gh killed before it starts up on a loaded machine counts no call, so the count is at most 3.)
  assert.ok(gh.calls() <= 3);
  assert.match(r.cause, /gh pr checks 7 -R timed out after 1 s \(3 attempts\)/);
  gh.done();
});

test('a call that is not safe to repeat (a comment) times out once and is not sent again', () => {
  const gh = fakeGh('hang');
  const r = run('gh', ['pr', 'comment', '7', '--body', 'x'], { env: gh.env });
  assert.equal(r.timedOut, true);
  assert.equal(r.attempts, 1, 'one attempt, not repeated');
  assert.ok(gh.calls() <= 1);
  gh.done();
});

test('a connection reset on a read is retried and the second attempt answers', async () => {
  const gh = fakeGh('flaky-net');
  const r = run('gh', ['pr', 'checks', '7', '-R', 'o/r', '--json', 'name'], { env: gh.env });
  assert.equal(r.status, 0);
  assert.equal(gh.calls(), 2);
  gh.done();
  const g2 = fakeGh('flaky-net');
  const a = await runAsync('gh', ['pr', 'view', '7', '--json', 'body'], { env: g2.env });
  assert.equal(a.status, 0);
  assert.equal(g2.calls(), 2);
  g2.done();
});

test('runAsync and the board and teststack runners bound a hung external call too', async () => {
  const gh = fakeGh('hang');
  const a = await runAsync('gh', ['pr', 'view', '7'], { env: gh.env });
  assert.equal(a.timedOut, true);
  assert.equal(a.attempts, 3);
  const before = gh.calls();
  const saved = { ...process.env };
  Object.assign(process.env, gh.env);
  try {
    const b = boardExec('gh', ['issue', 'view', '3']);
    assert.equal(b.timedOut, true);
    assert.equal(b.attempts, 3);
    assert.ok(gh.calls() - before <= 3);
    const c = await capture('gh', ['pr', 'view', '7'], { env: gh.env, timeoutSec: 1 });
    assert.equal(c.timedOut, true);
    assert.match(c.stderr, /timed out after 1 s/);
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
    gh.done();
  }
});

test('the CI wait with a hung gh ends as a not-delivered outcome that names the cause (ACCT-1, council C12)', async () => {
  const gh = fakeGh('hang');
  const call = (args) => run('gh', args, { env: gh.env });
  const logs = [];
  const ci = await waitForCi(call, 'o/r', 7, { pollSec: 0, sleep: async () => {}, log: (m) => logs.push(m) });
  assert.equal(ci.state, 'unknown');
  assert.match(ci.error, /gh pr checks 7 -R timed out after 1 s \(3 attempts\)/);
  assert.equal(logs.filter((m) => /could not be read/.test(m)).length, 3, 'three polls of three attempts each, then it gives up');
  assert.match(logs.at(-1), /giving up: not delivered/);
  assert.equal(ciOutcome(ci), 'ci-unverified');
  assert.match(ciLine(ci), /CI state unknown \(gh pr checks 7 -R timed out after 1 s \(3 attempts\)\): not delivered/);
  const decision = deliveryDecision({ ...ci, fixed: false, rounds: 0 });
  assert.equal(decision.outcome, 'ci-unverified');
  assert.match(decision.reason, /timed out/);
  gh.done();
});

test('one unreadable poll between readable ones does not end the wait', async () => {
  let n = 0;
  const gh = (args) => (args[1] === 'checks' ? (++n === 1 ? { status: 1, stdout: '', stderr: 'x', cause: 'gh pr checks timed out' } : { status: 0, stdout: JSON.stringify([{ name: 'build', bucket: 'pass' }]) }) : { status: 0, stdout: 'CLEAN' });
  const ci = await waitForCi(gh, 'o/r', 7, { pollSec: 0, settleSec: 0, sleep: async () => {}, ciOptions: { workflows: () => ({ state: 'success', expected: [], missing: [], running: [], failing: [] }) } });
  assert.equal(ci.state, 'success');
});

test('green CI whose logs cannot be read is not delivered: the retry check did not run (never a silent pass)', async () => {
  const gh = (args) => (args[0] === 'pr' && args[1] === 'view' ? { status: 0, stdout: 'abc123\n' } : { status: 1, stdout: '', stderr: 'timed out', cause: 'gh run list timed out after 120 s (3 attempts)' });
  assert.equal(ciFlaky(gh, 'o/r', 7), null);
  const ci = await ciGate({ gh, repo: 'o/r', pr: 7, wait: async () => ({ state: 'success', failing: [], pending: [] }) });
  assert.equal(ci.state, 'unknown');
  assert.match(ci.error, /retry check could not read the CI logs/);
  assert.equal(deliveryDecision(ci).outcome, 'ci-unverified');
});

test('which calls are external, and which are safe to repeat', () => {
  assert.equal(externalKind('gh', ['pr', 'view']), 'gh');
  assert.equal(externalKind('git', ['push', 'origin', 'x']), 'git-network');
  assert.equal(externalKind('git', ['-C', '/r', 'fetch']), 'git-network');
  assert.equal(externalKind('git', ['rev-parse', 'HEAD']), 'git');
  // Local writes are not external calls: never killed or repeated (a killed merge leaves MERGE_HEAD behind).
  for (const a of [['merge', '--no-ff', 'x'], ['commit', '-m', 'x'], ['worktree', 'add', 'p'], ['checkout', 'x'], ['hash-object', '-w', 'f'], ['config', 'user.name', 'x']]) assert.equal(externalKind('git', a), null, a.join(' '));
  assert.equal(externalKind('git', ['config', '--get', 'user.name']), 'git');
  assert.equal(externalKind('git', ['remote', 'get-url', 'origin']), 'git');
  assert.equal(externalKind('/usr/local/bin/docker', ['compose', 'up']), 'docker-long');
  assert.equal(externalKind('docker', ['info']), 'docker');
  assert.equal(externalKind('node', ['x.mjs']), null);
  for (const a of [['pr', 'view', '1'], ['pr', 'checks', '1'], ['run', 'view', '1', '--log'], ['api', 'repos/o/r/pulls/1'], ['api', 'graphql', '-f', 'query=query { viewer { login } }'], ['pr', 'edit', '1', '--add-label', 'x']]) assert.equal(retrySafe('gh', a), true, a.join(' '));
  for (const a of [['pr', 'comment', '1'], ['pr', 'create'], ['issue', 'create'], ['api', '-X', 'POST', 'repos/o/r/issues'], ['api', 'repos/o/r/issues', '-f', 'title=x'], ['api', 'graphql', '-f', 'query=mutation { x }'], ['pr', 'merge', '1']]) assert.equal(retrySafe('gh', a), false, a.join(' '));
  assert.equal(transientFailure({ stderr: 'error connecting to api.github.com' }), true);
  assert.equal(transientFailure({ stderr: 'HTTP 404: Not Found' }), false);
});

test('fetchWithTimeout ends a request the server never answers, after bounded retries', async () => {
  let hits = 0;
  const server = http.createServer(() => hits++); // never responds
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/x`;
  await assert.rejects(fetchWithTimeout(url, {}, { timeoutSec: 0.3, retries: 2, pause: async () => {} }), (e) => e.timedOut && /timed out after 0.3 s \(3 attempts\)/.test(e.message));
  assert.equal(hits, 3);
  hits = 0;
  await assert.rejects(fetchWithTimeout(url, { method: 'POST', body: 'x' }, { timeoutSec: 0.3, retries: 2, pause: async () => {} }), /timed out/);
  assert.equal(hits, 1, 'a POST is not sent again');
  server.closeAllConnections();
  server.close();
});

// The audit of every call site: a process for gh, git, docker or curl, and fetch(), go through the policy (util.run,
// runAsync, fetchWithTimeout, the board's exec, the teststack runner) or carry their own timeout. An interactive
// command a person stops is marked `external-call: interactive` on the line above, a local git write `external-call: local`.
test('every external call site in the factory has a timeout (audit)', () => {
  const files = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!['node_modules', 'test', 'tests', '.git', 'fixtures'].includes(e.name)) walk(p);
      } else if (/\.(mjs|js|cjs)$/.test(e.name)) files.push(p);
    }
  };
  for (const d of ['scripts', 'bin', 'templates']) walk(path.join(source, d));
  const offenders = [];
  const POLICY = new Set(['scripts/pipeline/lib/util.mjs', 'scripts/pipeline/lib/external.mjs', 'scripts/board/lib/assets.mjs', 'scripts/teststack/lib/runner.mjs']);
  for (const file of files) {
    const rel = path.relative(source, file).split(path.sep).join('/');
    if (POLICY.has(rel)) continue;
    const text = fs.readFileSync(file, 'utf8');
    const lines = text.split('\n');
    const re = /\b(spawnSync|execFileSync|execSync|spawn|execFile)\(\s*(['"`](gh|git|docker|curl)['"`]|ctx\.runner\.docker|docker\b)|(?<![\w.])fetch\(/g;
    let m;
    while ((m = re.exec(text))) {
      const line = text.slice(0, m.index).split('\n').length;
      // The call's own options: up to its closing parenthesis on the following few lines.
      const window = lines.slice(line - 1, line + 3).join('\n');
      const marked = /external-call: (interactive|local)/.test(lines[line - 2] ?? '');
      if (!marked && !/timeout/.test(window)) offenders.push(`${rel}:${line}: ${lines[line - 1].trim().slice(0, 120)}`);
    }
  }
  assert.deepEqual(offenders, [], `external calls without a timeout:\n${offenders.join('\n')}`);
});

// AbortSignal.timeout()'s signal can be garbage-collected while a request is pending, and then it never fires: the full
// suite once hung 29 minutes in fetchWithTimeout. Every timeout is a controller and a timer the caller holds.
test('no factory code bounds a request with AbortSignal.timeout (audit)', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
  const hits = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!['node_modules', 'test', 'tests', '.git', 'fixtures'].includes(e.name)) walk(p);
      } else if (/\.(mjs|js|cjs)$/.test(e.name) && /AbortSignal\.timeout\(/.test(fs.readFileSync(p, 'utf8').replace(/^\s*\/\/.*$/gm, ''))) hits.push(path.relative(root, p));
    }
  };
  walk(path.join(root, 'scripts'));
  assert.deepEqual(hits, []);
});
