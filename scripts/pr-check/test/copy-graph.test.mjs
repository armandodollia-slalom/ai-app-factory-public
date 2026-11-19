// Council C12: two re-checks stopped before any critic ran because copying the main checkout's knowledge graph into the
// check's checkout failed (EACCES while an endpoint scanner held the cache files). The graph is a speed-up only.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { copyGraph } from '../lib/context.mjs';

const graphDir = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'graph-'));
  fs.writeFileSync(path.join(d, 'graph.json'), '{}');
  return d;
};
const eacces = () => Object.assign(new Error('EACCES: permission denied, copyfile'), { code: 'EACCES' });

test('a copy that fails once is tried again over a clean folder', () => {
  let calls = 0;
  const removed = [];
  const ok = copyGraph(graphDir(), '/x/graphify-out', { cp: () => { if (++calls === 1) throw eacces(); }, rm: (p) => removed.push(p), say: () => {} });
  assert.equal(ok, true);
  assert.equal(calls, 2);
  assert.deepEqual(removed, ['/x/graphify-out']);
});

test('a copy that keeps failing never stops the check: it goes on without the graph and says so', () => {
  const said = [];
  assert.equal(copyGraph(graphDir(), '/x/graphify-out', { cp: () => { throw eacces(); }, rm: () => {}, say: (m) => said.push(m) }), false);
  assert.match(said[0], /knowledge graph was not copied into the check's checkout \(EACCES\); the critics search without it/);
  assert.equal(copyGraph(fs.mkdtempSync(path.join(os.tmpdir(), 'nograph-')), '/x', { cp: () => assert.fail('no graph, no copy') }), false);
});

test('a real copy lands', () => {
  const src = graphDir();
  const dest = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dest-')), 'graphify-out');
  assert.equal(copyGraph(src, dest), true);
  assert.ok(fs.existsSync(path.join(dest, 'graph.json')));
});
