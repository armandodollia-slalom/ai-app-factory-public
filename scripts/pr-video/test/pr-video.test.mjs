// PR demo videos: spec selection, the managed PR section, and publishing to the storage branch,
// against throwaway git repos (no GitHub access).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { rawGitHubUrl, videoLinks } from '../../pr-check/lib/github.mjs';
import { changedSpecs, keyFolder, publishFolder, recordedTests, renderSection, upsertSection } from '../lib/pr-video.mjs';

const temps = [];
const tmp = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-video-test-'));
  temps.push(dir);
  return dir;
};
after(() => temps.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

const sh = (cwd, ...args) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};
const initRepo = (dir, bare = false) => {
  sh(dir, 'init', '-q', ...(bare ? ['--bare'] : []), '-b', 'main');
  if (!bare) {
    sh(dir, 'config', 'user.email', 't@example.com');
    sh(dir, 'config', 'user.name', 'Test');
  }
  return dir;
};
const write = (root, rel, text = 'x') => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), text);
};

test('changedSpecs lists only the configured specs added or changed on the branch, not deleted ones', () => {
  const repo = initRepo(tmp());
  write(repo, 'e2e/teststack/old.spec.ts');
  write(repo, 'e2e/teststack/gone.spec.ts');
  sh(repo, 'add', '-A');
  sh(repo, 'commit', '-q', '-m', 'base');
  sh(repo, 'checkout', '-q', '-b', 'feature');
  write(repo, 'e2e/teststack/old.spec.ts', 'changed');
  write(repo, 'e2e/teststack/new.spec.ts');
  write(repo, 'e2e/teststack/helpers.ts');
  write(repo, 'e2e/CartTest.spec.ts');
  fs.rmSync(path.join(repo, 'e2e/teststack/gone.spec.ts'));
  sh(repo, 'add', '-A');
  sh(repo, 'commit', '-q', '-m', 'feature');
  assert.deepEqual(changedSpecs(repo, 'main', ['e2e/teststack/*.spec.ts']).sort(), ['e2e/teststack/new.spec.ts', 'e2e/teststack/old.spec.ts']);
  assert.deepEqual(changedSpecs(repo, 'main', ['e2e/**/*.spec.ts']).sort(), ['e2e/CartTest.spec.ts', 'e2e/teststack/new.spec.ts', 'e2e/teststack/old.spec.ts'], 'the patterns are configuration (prVideo.specPatterns)');
  assert.deepEqual(changedSpecs(repo, 'main'), [], 'no pattern configured: no spec is picked');
});

test('upsertSection appends the section once and replaces it on later runs, keeping the rest of the body', () => {
  const first = upsertSection('Implements SHOP-3.', 'one');
  assert.match(first, /^Implements SHOP-3\.\n\n<!-- pr-demo-video:start -->\none\n<!-- pr-demo-video:end -->\n$/);
  const second = upsertSection(`${first}\nFooter`, 'two');
  assert.equal(second, 'Implements SHOP-3.\n\n<!-- pr-demo-video:start -->\ntwo\n<!-- pr-demo-video:end -->\n\nFooter');
  assert.equal(upsertSection('', 'only'), '<!-- pr-demo-video:start -->\nonly\n<!-- pr-demo-video:end -->\n');
});

test('recordedTests keeps the last attempt of each test that kept a video', () => {
  const t = (retry, ok, videos) => ({ project: 'scenarios', file: 'e2e/teststack/a.spec.ts', titlePath: ['scenarios', 'a.spec.ts', 'adds'], title: 'adds', retry, ok, videos });
  const api = { ...t(0, true, []), title: 'api', titlePath: ['scenarios', 'a.spec.ts', 'api'] };
  const tests = recordedTests({ tests: [t(0, false, ['a.failed.webm']), t(1, true, ['a.webm']), api] });
  assert.deepEqual(tests.map((x) => [x.retry, x.videos]), [[1, ['a.webm']]]);
});

test('the rendered section links each video so the PR check can download it', () => {
  const section = renderSection({
    repo: 'o/r',
    branch: 'pr-videos',
    pr: 7,
    headSha: 'abcdef1234',
    specs: ['e2e/teststack/a.spec.ts'],
    videos: [{ title: 'adds › to cart', file: 'e2e/teststack/a.spec.ts', ok: true, video: 'a--adds.webm', preview: 'a--adds.gif' }],
  });
  assert.match(section, /commit abcdef1/);
  assert.match(section, /\[!\[adds › to cart\]\(https:\/\/github\.com\/o\/r\/blob\/pr-videos\/pr-7\/a--adds\.gif\?raw=true\)\]/);
  const links = videoLinks(section, ['.webm', '.mp4']);
  assert.deepEqual(links, ['https://github.com/o/r/blob/pr-videos/pr-7/a--adds.webm']);
  assert.equal(rawGitHubUrl(links[0]), 'https://raw.githubusercontent.com/o/r/pr-videos/pr-7/a--adds.webm');
  assert.equal(rawGitHubUrl('https://example.com/a.webm'), 'https://example.com/a.webm');
});

test('publishFolder keeps one parentless commit with every PR folder, replacing and removing one PR', () => {
  const remote = initRepo(tmp(), true);
  const repo = initRepo(tmp());
  sh(repo, 'remote', 'add', 'origin', remote);
  const stage = (files) => {
    const dir = tmp();
    for (const [name, text] of Object.entries(files)) write(dir, name, text);
    return dir;
  };
  const files = () => sh(repo, `--git-dir=${remote}`, 'ls-tree', '-r', '--name-only', 'pr-videos').split('\n').filter(Boolean);

  assert.equal(publishFolder(repo, { branch: 'pr-videos', folder: 'pr-1', stageDir: stage({ 'a.webm': '1' }), message: 'm' }).pushed, true);
  publishFolder(repo, { branch: 'pr-videos', folder: 'pr-2', stageDir: stage({ 'b.webm': '2' }), message: 'm' });
  publishFolder(repo, { branch: 'pr-videos', folder: 'pr-1', stageDir: stage({ 'c.webm': '3', 'c.gif': '4' }), message: 'm' });
  assert.deepEqual(files(), ['pr-1/c.gif', 'pr-1/c.webm', 'pr-2/b.webm']);
  assert.equal(sh(repo, `--git-dir=${remote}`, 'rev-list', '--count', 'pr-videos'), '1');

  publishFolder(repo, { branch: 'pr-videos', folder: 'pr-1', stageDir: null, message: 'm' });
  assert.deepEqual(files(), ['pr-2/b.webm']);
  assert.equal(publishFolder(repo, { branch: 'pr-videos', folder: 'pr-9', stageDir: null, message: 'm' }).pushed, false);
});

// Council C8 proof: a PR whose net change was a spec (no UI or API file) ran that spec nowhere in CI.
test('the local step runs every changed spec in demo mode on its own slot, and writes a note or nothing when there is no video', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { produceLocal } = await import('../lib/local.mjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-video-local-'));
  const host = { repo: 'acme/shop', fileUrl: (f, b) => `https://host/${b}/${f}` };
  const tools = { ffmpeg: '/bin/true', narration: null, narrationWhyOff: 'narration is off', settings: { pacing: { stepDelayMs: 1, holdMs: 2, typeDelayMs: 3, cursorMs: 4 } } };
  const published = [];
  const publish = (o) => published.push({ ...o, section: fs.readFileSync(path.join(o.stageDir, 'section.md'), 'utf8') });
  const calls = [];
  const deps = { tools, publish, scope: { video: true, api: true }, specs: ['e2e/teststack/a.spec.ts', 'e2e/teststack/b.spec.ts'], stackUp: async () => (calls.push('up'), 0), stackDown: () => calls.push('down'), sh: (cmd, env) => (calls.push([cmd, env.E2E_DEMO, env.E2E_KEEP_VIDEOS, Boolean(env.E2E_REDACT_MODULE)]), 0) };
  const r = await produceLocal({ root, config: { prVideo: { specPatterns: ['e2e/teststack/*.spec.ts'] } }, base: 'main', key: 'feat/x', headSha: 'abc1234', host, deps, log: () => {} });
  assert.equal(calls[0], 'up');
  assert.match(calls[1][0], /--timeout 900000 "e2e\/teststack\/a\.spec\.ts" "e2e\/teststack\/b\.spec\.ts"$/, 'every changed spec, whatever else the change has');
  assert.deepEqual(calls[1].slice(1), ['1', '1', true]);
  assert.equal(calls[2], 'down');
  assert.equal(r.video, 'published');
  assert.equal(published[0].folder, 'branch-feat-x');
  assert.match(published[0].section, /^<!-- head: abc1234 -->/);
  assert.match(published[0].section, /recorded no video/, 'no manifest here: the section says so');
  // No spec changed: a note, no stack. A backend-only change: a note that there is nothing to see in a browser, no
  // stack; a change with neither frontend nor backend code: an empty section.
  calls.length = 0;
  const note = await produceLocal({ root, config: {}, base: 'main', key: 'feat/y', headSha: 'b', host, deps: { ...deps, specs: [] }, log: () => {} });
  assert.equal(note.video, 'note');
  assert.deepEqual(calls, []);
  const none = await produceLocal({ root, config: {}, base: 'main', key: 'feat/z', headSha: 'c', host, deps: { ...deps, scope: { video: false, api: true } }, log: () => {} });
  assert.equal(none.video, null);
  assert.match(published.at(-1).section, /^<!-- head: c -->\n## Demo video\n\nNo demo video: this change has no browser-visible part \(backend only\)/);
  await produceLocal({ root, config: {}, base: 'main', key: 'feat/d', headSha: 'd', host, deps: { ...deps, scope: { video: false, api: false } }, log: () => {} });
  assert.match(published.at(-1).section, /^<!-- head: d -->\n\n$/);
});

// Council C9: the footer named the template's file (pr-demo-video.yml); repositories install it as factory-pr-demo-video.yml.
test('the demo video footer names the workflow file as installed', async () => {
  const { workflowFile } = await import('../lib/pr-video.mjs');
  assert.equal(workflowFile({ GITHUB_WORKFLOW_REF: 'acme/shop/.github/workflows/factory-pr-demo-video.yml@refs/pull/196/merge' }), '.github/workflows/factory-pr-demo-video.yml');
  assert.equal(workflowFile({}), '.github/workflows/factory-pr-demo-video.yml');
});

test('before a PR exists (implement.preOpen) the videos and sections are keyed by the story branch', () => {
  assert.equal(keyFolder('feat/bug-47-be-ordering-api-a-shopper-can-open'), 'branch-feat-bug-47-be-ordering-api-a-shopper-can-open');
  const section = renderSection({ repo: 'acme/shop', branch: 'pr-videos', pr: null, folder: keyFolder('feat/x-1'), headSha: 'abcdef1234', specs: ['e2e/teststack/x.spec.ts'], videos: [{ ok: true, title: 'TC-1', video: 'tc-1.webm', file: 'tc-1.webm' }] });
  assert.match(section, /pr-videos\/branch-feat-x-1\/tc-1\.webm/);
  assert.doesNotMatch(section, /pr-null/);
});

test('embedSections writes the stored sections into an open PR body once, replacing earlier ones in place', async () => {
  const { embedSections } = await import('../lib/pr-video.mjs');
  const { API_MARKERS } = await import('../lib/api-summary.mjs');
  const media = { video: '### Demo video\n\nnew videos', api: null, notes: [] };
  const once = embedSections('Implements BRAND-1.\n\n<!-- pr-demo-video:start -->\nold\n<!-- pr-demo-video:end -->\n\nFollow-ups', media, API_MARKERS);
  assert.match(once, /<!-- pr-demo-video:start -->\n### Demo video\n\nnew videos\n<!-- pr-demo-video:end -->/);
  assert.ok(!once.includes('old'));
  assert.match(once, /Follow-ups$/, 'the rest of the body stays');
  assert.equal(embedSections(once, media, API_MARKERS), once, 'idempotent');
  assert.match(embedSections('Body', media, API_MARKERS), /^Body\n\n<!-- pr-demo-video:start -->/);
  assert.equal(embedSections('Body', { video: null, api: null }, API_MARKERS), 'Body');
});
