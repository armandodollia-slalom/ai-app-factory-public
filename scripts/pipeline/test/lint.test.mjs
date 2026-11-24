// Lint on changed lines (scripts/pipeline/lib/lint.mjs): diagnostic formats, and which lines a change touches.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { changedLines, lintable, lintChanged, parseDiagnostics } from '../lib/lint.mjs';

test('parseDiagnostics: dotnet/MSBuild, gcc-style, grep-style and ESLint stylish output', () => {
  assert.deepEqual(parseDiagnostics('/r/src/A.cs(66,9): error WHITESPACE: Fix whitespace formatting. [/r/src/A.csproj]'), [{ file: '/r/src/A.cs', line: 66 }]);
  assert.deepEqual(parseDiagnostics('docs/a.md:19 error MD060/table-column-style\ndocs/b.md:3:1 MD041'), [{ file: 'docs/a.md', line: 19 }, { file: 'docs/b.md', line: 3 }]);
  assert.deepEqual(parseDiagnostics('notes/a.txt:2:BAD'), [{ file: 'notes/a.txt', line: 2 }]);
  assert.deepEqual(parseDiagnostics('/r/e2e/a.spec.ts\n  12:5  error  Unexpected any  @typescript-eslint/no-explicit-any\n\n✖ 1 problem'), [{ file: '/r/e2e/a.spec.ts', line: 12 }]);
});

test('changedLines: the lines a commit or a branch adds or changes; null for a new file', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lint-lines-')));
  const git = (...args) => spawnSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', '-c', 'core.hooksPath=/dev/null', ...args], { cwd: root, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(root, 'a.txt'), '1\n2\n3\n4\n');
  git('add', '-A');
  git('commit', '-qm', 'base');
  fs.writeFileSync(path.join(root, 'a.txt'), '1\ntwo\n3\n4\nfive\n');
  fs.writeFileSync(path.join(root, 'b.txt'), 'new\n');
  git('add', '-A');
  assert.deepEqual([...changedLines(root, 'a.txt', { staged: true })], [2, 5]);
  assert.equal(changedLines(root, 'b.txt', { staged: true }), null);
  git('commit', '-qm', 'change');
  assert.deepEqual([...changedLines(root, 'a.txt', { base: 'HEAD~1' })], [2, 5]);
  assert.equal(changedLines(root, 'b.txt', { base: 'HEAD~1' }), null, 'not in the base: a new file counts whole');
});

test('util.run hands stdin over so the child always sees end-of-file (spawnSync input races on macOS)', async () => {
  const { run } = await import('../lib/util.mjs');
  const child = "import fs from 'node:fs'; const s = fs.readFileSync(0, 'utf8'); await new Promise((r) => setTimeout(r, 2)); process.stdout.write(String(s.length));";
  // With spawnSync's own input pipe about 1 in 400 of these never got EOF; 150 runs keep the test short.
  for (let i = 0; i < 150; i++) {
    const input = 'x'.repeat(20000 + ((i * 7919) % 150000));
    const r = run(process.execPath, ['--input-type=module', '-e', child], { input, timeoutSec: 10 });
    assert.equal(r.stdout, String(input.length), `run ${i}: ${r.stderr}`);
  }
  assert.equal(run('cat', [], {}).status, 0, 'no input: stdin is an empty pipe');
});

test('lintChanged never skips in silence: a configured linter that is missing is skipped, an engine default is a note', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lint-skip-')));
  fs.mkdirSync(path.join(root, '.factory'));
  fs.writeFileSync(path.join(root, '.factory/config.json'), JSON.stringify({ featureVerification: { precheck: { lint: { '.md': ['node_modules/.bin/markdownlint', '{files}'] } } } }));
  fs.writeFileSync(path.join(root, 'a.md'), '# a\n');
  fs.writeFileSync(path.join(root, 'b.ts'), 'x\n');
  const config = { root, featureVerification: { precheck: { lint: { '.md': ['node_modules/.bin/markdownlint', '{files}'], '.ts': ['node_modules/.bin/eslint', '{files}'] } } } };
  const skipped = [];
  const notes = [];
  const errors = lintChanged(config, ['a.md', 'b.ts'], { skipped, notes, runner: () => assert.fail('nothing can run') });
  assert.deepEqual(errors, []);
  assert.equal(skipped.length, 1);
  assert.match(skipped[0], /markdownlint is not installed \(\.md: 1 file/);
  assert.equal(notes.length, 1);
  assert.match(notes[0], /eslint \(engine default for \.ts\) is not installed/);
  fs.rmSync(root, { recursive: true, force: true });
});

test('lintable: vendored, minified and generated code is never linted; the application\'s own browser scripts are', () => {
  const files = ['src/WebApp/wwwroot/js/cart.js', 'src/WebApp/wwwroot/lib/bootstrap/dist/js/bootstrap.js', 'src/Identity.API/wwwroot/js/site.min.js', 'web/node_modules/x/index.js', '.factory/bin/factory.mjs', 'e2e/a.spec.ts'];
  assert.deepEqual(lintable({ featureVerification: { precheck: {} } }, files), ['src/WebApp/wwwroot/js/cart.js', 'e2e/a.spec.ts']);
  assert.deepEqual(lintable({ featureVerification: { precheck: { lintExclude: ['e2e/**'] } } }, files).includes('e2e/a.spec.ts'), false, 'a repository may set its own list');
});

test('lint messages name the linter, not its interpreter', async () => {
  const { linterName } = await import('../lib/lint.mjs');
  assert.equal(linterName(['node', '/install/packs/typescript/lint/eslint.mjs', '--fix', 'a.ts']), 'eslint');
  assert.equal(linterName(['dotnet', 'format', 'App.slnf', '--verify-no-changes']), 'dotnet format');
  assert.equal(linterName(['node_modules/.bin/markdownlint', 'a.md']), 'markdownlint');
});
