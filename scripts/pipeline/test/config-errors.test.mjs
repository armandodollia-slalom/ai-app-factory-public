// A configuration that does not load: the status commands print its message, never a stack trace.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const STATUS = [
  ['implement', 'scripts/implement/implement.mjs'],
  ['board', 'scripts/board/board.mjs'],
  ['review-gate', 'scripts/review-gate/review-gate.mjs'],
];

test('implement, board and review-gate status print a config error as its message, without a stack trace', (t) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'config-error-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  fs.mkdirSync(path.join(dir, '.factory'));
  const env = { ...process.env, PIPELINE_ROOT: dir };
  for (const [config, message] of [
    ['{ not json', /\.factory\/config\.json is not valid JSON/],
    [JSON.stringify({ video: { script: { scope: 'sometimes' } } }), /\.factory\/config\.json: video\.script\.scope/],
  ]) {
    fs.writeFileSync(path.join(dir, '.factory/config.json'), config);
    for (const [tag, cli] of STATUS) {
      const r = spawnSync(process.execPath, [path.join(ROOT, cli), 'status'], { cwd: dir, encoding: 'utf8', env, timeout: 60_000 });
      assert.equal(r.status, 1, `${tag} status: ${r.stderr}`);
      assert.match(r.stderr, new RegExp(`^${tag}: `), `${tag} status names the command`);
      assert.match(r.stderr, message);
      assert.doesNotMatch(r.stderr, /\n\s+at /, `${tag} status printed a stack trace:\n${r.stderr}`);
    }
  }
});

// Sol 36: a stage's config and a tool's section validated different parts of the same file.
test('a problem in the repository\'s settings is reported the same way whichever loader reads the file first', async (t) => {
  const { ConfigError, loadConfig, toolConfig } = await import('../lib/config.mjs');
  for (const [settings, message] of [
    [{ prune: { keepLocal: 'yes' } }, /prune\.keepLocal must be true or false/],
    [{ prune: { afterDelivery: 1 } }, /prune\.afterDelivery must be true or false/],
    [{ implement: { preOpen: { afterOpen: 'sometimes' } } }, /implement\.preOpen\.afterOpen must be one of draft, label, close-reopen/],
    // other-36 (round 4): an explicit video script scope too.
    [{ video: { script: { scope: 'sometimes' } } }, /video\.script\.scope must be one of/],
    // other-36 (round 5): a role's model that is not allowed, in a tool's section too.
    [{ agent: { models: { implementer: 'no-such-model' } } }, /agent\.models\.implementer is "no-such-model", which is not in agent\.allowedModels/],
  ]) {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'config-same-')));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
    fs.mkdirSync(path.join(dir, '.factory'));
    fs.writeFileSync(path.join(dir, '.factory/config.json'), JSON.stringify(settings));
    for (const load of [() => toolConfig('prune', {}, dir), () => loadConfig('implement', dir), () => loadConfig(null, dir)]) {
      assert.throws(load, (e) => e instanceof ConfigError && message.test(e.message), JSON.stringify(settings));
    }
  }
});

// other-36 (round 5): `factory lint` reports a configuration that does not load as its message, like every other command.
test('factory lint prints a config error as its message, without a stack trace', (t) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'config-lint-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  fs.mkdirSync(path.join(dir, '.factory'));
  fs.writeFileSync(path.join(dir, '.factory/config.json'), JSON.stringify({ prune: { afterDelivery: 'yes' } }));
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts/factory/lint.mjs'), 'x.js'], { cwd: dir, encoding: 'utf8', env: { ...process.env, PIPELINE_ROOT: dir }, timeout: 60_000 });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /^factory lint: .*prune\.afterDelivery must be true or false/);
  assert.doesNotMatch(r.stderr, /\n\s+at /, `a stack trace:\n${r.stderr}`);
});
