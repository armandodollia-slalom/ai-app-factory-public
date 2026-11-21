// Every code-host operation the engine calls exists on every built-in host adapter and on the custom adapter, in both
// calling forms (`await host.x` and `host.sync.x`). The calls are read from the engine's source, not listed by hand:
// a call written without `?.` on a host object is a promise that the operation is there, and a missing one crashes a
// run after work is done (an epic run died after its PR opened on `host.ownsPr is not a function`, because the derived
// operations were set on the async host only).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { hostFor } from '../lib/hosts/index.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
// Adapter internals call their own private helpers; the engine is everything else.
const SKIP_DIRS = ['scripts/pipeline/lib/hosts/'];

function engineFiles() {
  const out = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const rel = path.posix.join(dir, e.name);
      if (e.isDirectory()) {
        if (!['node_modules', 'test', 'tests', 'fixtures'].includes(e.name)) walk(rel);
      } else if (/\.(mjs|js)$/.test(e.name) && !SKIP_DIRS.some((d) => rel.startsWith(d))) out.push(rel);
    }
  };
  walk('scripts');
  walk('bin');
  return out;
}

// A host object in engine code: a variable named host / prHost / *Host, `hostFor(...)`, `hostSync(...)` or `hostOf(...)`,
// optionally followed by `.sync`. Then an operation path (`pr.get`, `repo.defaultBranch`, `ownsPr`) called with `(`.
// An access with `?.` before the operation name is optional by design (the caller degrades) and is not counted.
const CALL = /\b(?:host|prHost|[a-z]+Host|hostFor\([^()]*\)|hostSync\([^()]*\)|hostOf\([^()]*\))(\??\.sync)?((?:\.(?:pr|repo|issues|bot))?)\.([a-zA-Z]+)\(/g;
const NOT_OPS = new Set(['split', 'join', 'toString', 'toLowerCase', 'trim', 'replace', 'startsWith', 'endsWith', 'includes', 'match', 'map', 'filter']);

export function engineHostCalls(files = engineFiles(), read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')) {
  const calls = new Map();
  for (const rel of files) {
    read(rel).split('\n').forEach((line, i) => {
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
      for (const m of line.matchAll(CALL)) {
        const op = `${m[2] ? m[2].slice(1) + '.' : ''}${m[3]}`;
        if (NOT_OPS.has(m[3]) || /^(settings|git)$/.test(m[2]?.slice(1) ?? '')) continue;
        const key = `${m[1] ? 'sync:' : ''}${op}`;
        if (!calls.has(key)) calls.set(key, `${rel}:${i + 1}`);
      }
    });
  }
  return calls;
}

const get = (obj, dotted) => dotted.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'host-calls-')));

// Every built-in adapter and the custom adapter, built without touching a network (no call is made: only shapes).
function adapters() {
  process.env.FACTORY_TEST_NONE = 'placeholder';
  const root = tmp();
  const gh = () => {
    throw new Error('no gh in this test');
  };
  return {
    github: hostFor({ root, host: { type: 'github', repo: 'o/r' } }, { gh, remote: '' }),
    gitlab: hostFor({ root, host: { type: 'gitlab', url: 'https://gitlab.example.test', repo: 'g/r', token: '${FACTORY_TEST_NONE}' } }, { remote: '' }),
    'azure-devops': hostFor({ root, host: { type: 'azure-devops', url: 'https://dev.example.test', repo: 'o/p/r', token: '${FACTORY_TEST_NONE}' } }, { remote: '' }),
    bitbucket: hostFor({ root, host: { type: 'bitbucket', url: 'https://bb.example.test', repo: 'w/r', token: '${FACTORY_TEST_NONE}' } }, { remote: '' }),
    custom: hostFor({ root, host: { type: 'custom', repo: 'acme/app', url: 'https://code.example.test', command: [process.execPath, '-e', 'process.exit(3)'] } }, { remote: '' }),
  };
}

test('the scan finds the engine\'s host calls, including the one that crashed the epic run', () => {
  const calls = engineHostCalls();
  for (const op of ['pr.get', 'pr.open', 'pr.update', 'repo.defaultBranch']) assert.ok([...calls.keys()].some((k) => k.endsWith(op)), op);
  assert.ok(calls.has('ownsPr') || calls.has('sync:ownsPr'), 'ownsPr is called');
  // The scanner itself: optional calls are skipped, `.sync` is seen, `hostFor(config).sync` counts as a sync call.
  const fake = engineHostCalls(['x.mjs'], () => 'const h = hostFor(config).sync; h.pr.get(1);\nhostFor(config).sync.pr.list({});\nhost.bot?.author?.();\nhost.ownsPr(p);\nprHost?.ownsPr(p);');
  assert.ok(fake.has('sync:pr.list') && fake.has('ownsPr') && fake.has('ownsPr'));
  assert.ok(!fake.has('bot.author'));
});

test('every host operation the engine calls exists on every adapter, async and sync', () => {
  const calls = engineHostCalls();
  const missing = [];
  for (const [type, host] of Object.entries(adapters())) {
    for (const [key, where] of calls) {
      const op = key.replace(/^sync:/, '');
      // A call on an unqualified `host` may be either form (callers hold `.sync` in a variable named host): both must have it.
      for (const [form, target] of [['async', host], ['sync', host.sync]]) {
        if (typeof get(target, op) !== 'function') missing.push(`${type} ${form} ${op} (called at ${where})`);
      }
    }
  }
  assert.deepEqual(missing, [], `operations the engine calls that an adapter does not have:\n${missing.join('\n')}`);
});

test('the derived operations answer the same on both forms', () => {
  for (const [type, host] of Object.entries(adapters())) {
    const url = host.prUrl(7);
    assert.equal(host.sync.prUrl(7), url, type);
    assert.equal(host.sync.ownsPr(url), true, type);
    assert.equal(host.sync.ownsPr('https://elsewhere.example.test/x/y/pull/7'), false, type);
    assert.equal(host.sync.fileUrl('a.txt', 'main'), host.fileUrl('a.txt', 'main'), type);
    assert.deepEqual(host.sync.settings, host.settings, type);
  }
});
