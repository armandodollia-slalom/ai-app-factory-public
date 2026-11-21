// `factory render` keeps the shared e2e fixtures (e2e/fixtures.ts, demo.ts, video-reporter.ts) in step (dogfood C24:
// upgrades did not refresh them and a pin PR copied them by hand). A copy that is missing, unchanged since the last
// render, or exactly a version the factory shipped is refreshed; one the repository edited is kept and its difference
// reported, by render and by check (a notice, not a failure).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { E2E_SEEDS, check, readManifest, render } from '../lib/render.mjs';

const INSTALL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const sha = (t) => crypto.createHash('sha256').update(String(t).replace(/\r\n/g, '\n').trim()).digest('hex').slice(0, 16);
const template = (f) => fs.readFileSync(path.join(INSTALL, 'templates/e2e', f), 'utf8');

function repo(features = { lsp: false, graphify: false, ci: false, agentFiles: false, gitHooks: false, demoVideo: true }, files = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-seeds-')));
  spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  for (const [rel, text] of Object.entries({ '.factory/factory.json': JSON.stringify({ version: '0.0.0', tools: ['claude'], features }), '.factory/config.json': '{}', ...files })) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  }
  return root;
}

test('every current template is in the shipped history (a release that changes one must add its hash)', () => {
  const history = JSON.parse(fs.readFileSync(path.join(INSTALL, 'templates/e2e/history.json'), 'utf8')).files;
  for (const f of E2E_SEEDS) assert.ok(history[f].includes(sha(template(f))), `templates/e2e/history.json lacks the current ${f}`);
});

test('missing or an older shipped version: refreshed; the repository\'s own edit: kept, its diff reported, check notices', () => {
  // An older shipped version: the first committed fixtures.ts of the factory (its hash is in the history).
  const first = spawnSync('git', ['log', '--reverse', '--format=%H', '--', 'templates/e2e/fixtures.ts'], { cwd: INSTALL, encoding: 'utf8' }).stdout.split('\n')[0];
  const older = spawnSync('git', ['show', `${first}:templates/e2e/fixtures.ts`], { cwd: INSTALL, encoding: 'utf8' }).stdout;
  assert.notEqual(sha(older), sha(template('fixtures.ts')));
  const root = repo(undefined, { 'e2e/fixtures.ts': older, 'e2e/demo.ts': '// our own demo helper, edited\nexport const x = 1;\n' });
  const r = render(root, INSTALL);
  assert.ok(r.written.includes('e2e/fixtures.ts'), 'the older shipped copy is refreshed');
  assert.ok(r.written.includes('e2e/video-reporter.ts'), 'a missing one is written');
  assert.equal(fs.readFileSync(path.join(root, 'e2e/fixtures.ts'), 'utf8'), template('fixtures.ts'));
  assert.deepEqual(r.kept.map((k) => k.path), ['e2e/demo.ts']);
  assert.match(r.kept[0].diff, /^\+\/\/ our own demo helper, edited$/m);
  assert.match(fs.readFileSync(path.join(root, 'e2e/demo.ts'), 'utf8'), /our own demo helper/, 'not overwritten');
  // A second render keeps it again and writes nothing; check reports it as a notice only.
  const again = render(root, INSTALL);
  assert.deepEqual([again.written, again.kept.map((k) => k.path)], [[], ['e2e/demo.ts']]);
  const seed = check(root, INSTALL).filter((p) => p.path.startsWith('e2e/'));
  assert.deepEqual(seed.map((p) => [p.path, p.notice]), [['e2e/demo.ts', true]]);
  assert.match(seed[0].problem, /render keeps your version/);
  assert.equal(readManifest(root).files['e2e/fixtures.ts'].kind, 'seed');
});

test('a copy unchanged since the last render is refreshed when the engine ships a new version', () => {
  const root = repo();
  render(root, INSTALL);
  // The engine's template moved on: the manifest records what render wrote, and the copy still matches it.
  const m = readManifest(root);
  fs.writeFileSync(path.join(root, 'e2e/demo.ts'), '// what an earlier engine wrote\n');
  m.files['e2e/demo.ts'].sha = sha('// what an earlier engine wrote\n');
  fs.writeFileSync(path.join(root, '.factory/manifest.json'), JSON.stringify(m));
  const r = render(root, INSTALL);
  assert.ok(r.written.includes('e2e/demo.ts'));
  assert.deepEqual(r.kept, []);
});

test('demo video off: no seeds; a custom e2e folder from the config is honoured', () => {
  assert.ok(!render(repo({ demoVideo: false }), INSTALL).written.some((p) => p.endsWith('fixtures.ts')));
  const root = repo(undefined, { '.factory/config.json': JSON.stringify({ e2e: { dir: 'tests/e2e' } }) });
  assert.ok(render(root, INSTALL).written.includes('tests/e2e/fixtures.ts'));
});
