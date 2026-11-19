import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PRUNED, pruneInstall } from '../install-setup.mjs';
import { installGuard } from '../../pipeline/lib/story-guard.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const shipped = () => execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean).filter((f) => !f.split('/').some((_, i, parts) => PRUNED(parts.slice(0, i + 1).join('/'))));

// Dogfood C4: the install shipped the reference's own notes on the bugs a pipeline agent was to fix. What an install
// keeps holds no ticket key of a real board and no story text; examples and docs use placeholder keys (SHOP-, FIX-,
// DEMO-, KEY-).
test('what an install keeps holds no real ticket key, run document or story text', () => {
  const files = shipped();
  assert.ok(files.length > 100);
  assert.ok(!files.some((f) => /^examples\/[^/]+\/(?!\.factory\/)/.test(f)), 'examples keep only their .factory/ folder');
  assert.ok(!files.some((f) => /(^|\/)(runs|test)\//.test(f)), 'no run documents, no tests');
  const offending = [];
  for (const f of files) {
    const abs = path.join(root, f);
    if (fs.statSync(abs).size > 2_000_000) continue;
    const text = fs.readFileSync(abs, 'utf8');
    if (/\0/.test(text)) continue;
    if (/\b(BUG|CAT|ORD|PROMO|LSPDEMO)-\d+\b/.test(text)) offending.push(`${f}: ticket key`);
    if (/^#{1,2} (?!(SHOP|FIX|DEMO|KEY)-)[A-Z][A-Z0-9]*-\d+: \[(FE|BE)/m.test(text)) offending.push(`${f}: story heading`);
  }
  assert.deepEqual(offending, []);
});

test('a machine install (a shallow clone) leaves out tests and example material; a developer checkout is never pruned', () => {
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'install-'));
  for (const d of ['test', 'scripts/board/test', 'scripts/board/lib', 'examples/eshop/docs/runs', 'examples/eshop/.factory/stack', 'docs/ai-pipeline']) fs.mkdirSync(path.join(dest, d), { recursive: true });
  fs.writeFileSync(path.join(dest, 'examples/eshop/README.md'), 'x');
  assert.deepEqual(pruneInstall(dest), [], 'no .git/shallow: not pruned');
  assert.ok(fs.existsSync(path.join(dest, 'test')));
  fs.mkdirSync(path.join(dest, '.git'), { recursive: true });
  fs.writeFileSync(path.join(dest, '.git', 'shallow'), 'abc\n');
  assert.deepEqual(pruneInstall(dest).sort(), ['examples/eshop/README.md', 'examples/eshop/docs', 'scripts/board/test', 'test']);
  for (const kept of ['scripts/board/lib', 'examples/eshop/.factory/stack', 'docs/ai-pipeline']) assert.ok(fs.existsSync(path.join(dest, kept)), kept);
});

test('install guard: a pipeline agent runs factory tools from the install but never reads, searches or edits it', () => {
  const install = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-'));
  for (const d of ['bin', 'packs/typescript/lint', 'node_modules/.bin', 'examples/eshop']) fs.mkdirSync(path.join(install, d), { recursive: true });
  const config = { root: fs.mkdtempSync(path.join(os.tmpdir(), 'app-')), storyGuard: {} };
  const child = { PIPELINE_CHILD: '1' };
  const call = (tool_name, tool_input) => installGuard(config, { tool_name, tool_input, cwd: config.root }, child, install);
  assert.match(call('Read', { file_path: path.join(install, 'examples/eshop/notes.md') }), /^Read guard: .* is outside what pipeline agents may read/);
  assert.match(call('Grep', { pattern: 'BUG', path: install }), /Read guard/);
  assert.match(call('Bash', { command: `cat ${install}/docs/x.md` }), /Read guard/);
  assert.match(call('Bash', { command: `grep -r quantity ${install}` }), /Read guard/);
  assert.equal(call('Bash', { command: `node ${install}/bin/factory.mjs fv check` }), null);
  assert.equal(call('Bash', { command: `node ${install}/packs/typescript/lint/eslint.mjs --fix src/a.ts` }), null);
  assert.equal(call('Bash', { command: `${install}/node_modules/.bin/markdownlint docs/a.md` }), null);
  assert.equal(call('Bash', { command: 'factory lint --base origin/main' }), null);
  assert.equal(call('Read', { file_path: path.join(config.root, 'src/a.cs') }), null);
  assert.equal(installGuard(config, { tool_name: 'Read', tool_input: { file_path: path.join(install, 'x') } }, {}, install), null, 'a person\'s session is not bound');
  assert.equal(installGuard({ root: install, storyGuard: {} }, { tool_name: 'Read', tool_input: { file_path: path.join(install, 'x') } }, child, install), null, 'the factory working on itself');
});

// Dogfood C5 audit: other repositories on the machine (a reference implementation that fixed the same bugs), other
// agents' session transcripts and paths the operator denies are off limits to pipeline agents too.
test('read guard: other repositories, agent session stores and denied paths are off limits; this repository and its worktrees are not', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'readguard-'));
  const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8' });
  const app = path.join(base, 'shop');
  const other = path.join(base, 'reference');
  for (const r of [app, other]) {
    fs.mkdirSync(path.join(r, 'src'), { recursive: true });
    fs.writeFileSync(path.join(r, 'src', 'a.cs'), 'x');
    git(r, 'init', '-q', '-b', 'main');
    git(r, '-c', 'user.email=t@e', '-c', 'user.name=t', 'add', '-A');
    git(r, '-c', 'user.email=t@e', '-c', 'user.name=t', 'commit', '-q', '-m', 'init');
  }
  const wt = path.join(base, 'shop-worktrees', 'story-1');
  git(app, 'worktree', 'add', '-q', '-b', 'story-1', wt);
  const install = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-'));
  const denied = fs.mkdtempSync(path.join(os.tmpdir(), 'notes-'));
  const config = { root: wt, mainRoot: app, storyGuard: {} };
  const env = { PIPELINE_CHILD: '1', FACTORY_GUARD_DENY: denied };
  const call = (tool_name, tool_input) => installGuard(config, { tool_name, tool_input, cwd: wt }, env, install);
  assert.match(call('Read', { file_path: path.join(other, 'src/a.cs') }), /^Read guard/);
  assert.match(call('Bash', { command: `git -C ${other} log -p` }), /^Read guard/);
  assert.match(call('Bash', { command: 'cat ../../reference/src/a.cs' }), /^Read guard/);
  assert.match(call('Read', { file_path: path.join(os.homedir(), '.claude', 'projects', 'x.jsonl') }), /^Read guard/);
  assert.match(call('Grep', { pattern: 'quantity', path: denied }), /^Read guard/);
  assert.equal(call('Read', { file_path: path.join(wt, 'src/a.cs') }), null, 'its own worktree');
  assert.equal(call('Read', { file_path: path.join(app, 'src/a.cs') }), null, 'the main checkout of the same repository');
  assert.equal(call('Bash', { command: 'dotnet build src/a.csproj && ls /usr/local/share/dotnet' }), null, 'toolchains outside any repository');
  // D-C7-2: the agent's own session folder (its CLI saves long tool output there) is readable; others' stay closed.
  const esc = path.resolve(wt).replace(/[^A-Za-z0-9]/g, '-');
  assert.equal(call('Read', { file_path: path.join(os.homedir(), '.claude', 'projects', esc, 'abc', 'tool-results', 'b1.txt') }), null, 'its own saved tool output');
  const tmpRoot = path.join(denied, '..', 'claude-501');
  const env2 = { ...env, FACTORY_GUARD_DENY: tmpRoot };
  const call2 = (tool_name, tool_input) => installGuard(config, { tool_name, tool_input, cwd: wt }, env2, install);
  assert.equal(call2('Read', { file_path: path.join(tmpRoot, esc, 'tasks', 'x.output') }), null, 'its own temp output under a denied root');
  assert.match(call2('Read', { file_path: path.join(tmpRoot, '-Users-someone-else', 'scratchpad', 'notes.md') }), /^Read guard/);
  assert.match(call('Read', { file_path: path.join(os.homedir(), '.claude', 'projects', `${esc}-other`, 'x.jsonl') }), /^Read guard/);
});

// Council C3: the read guard covered files only; the reference repository is public on GitHub.
test('the network guard keeps pipeline agents on this repository\'s GitHub', async () => {
  const { networkGuard, repoOfUrl } = await import('../../pipeline/lib/story-guard.mjs');
  const config = { root: process.cwd(), board: { repo: 'acme/shop' }, storyGuard: { denyHosts: ['example-leak.test'] } };
  const env = { PIPELINE_CHILD: '1', FACTORY_GUARD_DENY_REPOS: 'acme/reference' };
  const bash = (command) => networkGuard(config, { tool_name: 'Bash', tool_input: { command } }, env);
  // Denied: every way to another repository.
  for (const c of [
    'gh pr list -R acme/reference',
    'gh issue view 3 --repo acme/reference',
    'gh issue view 3 --repo=acme/reference',
    'gh api repos/acme/reference/contents/src/Fix.cs',
    'gh api graphql -f query=\'{repository(owner:"acme",name:"reference"){id}}\'',
    'gh repo view acme/reference',
    'gh repo clone acme/reference /tmp/x',
    'gh search code "TC-BUG"',
    'gh api search/code?q=fix',
    'git clone https://github.com/acme/reference.git',
    'git fetch git@github.com:acme/reference.git main',
    'curl -s https://raw.githubusercontent.com/acme/reference/main/README.md',
    'wget https://github.com/acme/reference/archive/main.zip',
    'cd x && gh pr diff 5 -R acme/reference | head',
    'curl https://example-leak.test/notes',
  ]) assert.match(bash(c) ?? '', /^Network guard: /, c);
  // Allowed: this repository, and commands that touch no other repository.
  for (const c of ['gh pr view 81 -R acme/shop', 'gh api repos/acme/shop/pulls/81', 'git fetch origin main', 'gh pr checks 81', 'npm test', 'curl http://localhost:28080/']) assert.equal(bash(c), null, c);
  assert.match(networkGuard(config, { tool_name: 'WebFetch', tool_input: { url: 'https://github.com/acme/reference/blob/main/x.cs' } }, env), /another repository/);
  assert.equal(networkGuard(config, { tool_name: 'WebFetch', tool_input: { url: 'https://learn.microsoft.com/aspnet' } }, env), null);
  assert.match(networkGuard(config, { tool_name: 'WebSearch', tool_input: { query: 'acme reference eShop bug fix' } }, env), /denied repository/);
  assert.equal(networkGuard(config, { tool_name: 'Bash', tool_input: { command: 'gh pr list -R acme/reference' } }, {}), null, 'people are not guarded');
  assert.equal(repoOfUrl('https://api.github.com/repos/Acme/Reference/pulls'), 'acme/reference');
});
