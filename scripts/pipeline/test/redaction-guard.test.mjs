// No writer or poster goes around the redaction boundary (redact.mjs). Records and published text reach a file only
// through writeText / appendText / writeJson / appendJsonl, and reach a service only through a provider adapter whose
// write operations are gated. A direct fs write is allowed only where this table says why it never carries a record or a
// published text; a new one fails here until it goes through the boundary or is reviewed into the table.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

// file (under scripts/) -> [count of direct fs writes, why none of them is a record or a published text]
const ALLOWED = {
  'pipeline/lib/redact.mjs': [3, 'the boundary itself (writeText, appendText) and its hash-only registry'],
  'pipeline/lib/util.mjs': [5, 'writeJson/appendJsonl redact their value first; a child process input file; lock files'],
  'pipeline/lib/record-gate.mjs': [1, 'writes the redacted text of a staged record'],
  'pipeline/lib/analysis/fetch.mjs': [3, 'downloaded rule archives and their metadata'],
  'pipeline/lib/analysis/scanners/index.mjs': [1, 'a scanner poll cursor (a timestamp)'],
  'pipeline/lib/analysis/install.mjs': [1, 'a tool cache stamp'],
  'pipeline/lib/analysis/decide.mjs': [1, 'the values file handed to the scanner (mode 600, a temp file, never committed or posted)'],
  'pipeline/lib/providers/docs.mjs': [1, 'generated provider docs from the contract data'],
  'pipeline/lib/experiment.mjs': [1, 'copies repository files into an experiment arm worktree'],
  'pipeline/lib/factory-guard.mjs': [4, 'restores files from a snapshot taken before an agent ran'],
  'pipeline/lib/bot.mjs': [2, 'the bot App private key and settings, local mode 600 files by design (never committed or posted)'],
  'pipeline/lib/council.mjs': [1, 'a council member job file (its task input)'],
  'board/board.mjs': [1, 'the board config the user edits'],
  'board/lib/assets.mjs': [1, 'a downloaded attachment (binary)'],
  'board/lib/trackers/azure-boards.mjs': [1, 'a downloaded attachment (binary)'],
  'board/lib/trackers/jira.mjs': [1, 'a downloaded attachment (binary)'],
  'board/lib/trackers/gitlab.mjs': [1, 'a downloaded attachment (binary)'],
  'board/lib/migrate.mjs': [2, 'migrates the repository\'s own files in place'],
  'teststack/lib/context.mjs': [1, 'the test stack env file (local, holds stack secrets by design, never committed)'],
  'teststack/lib/images.mjs': [4, 'image ids, stamps, a pid, the stack env file (local)'],
  'lsp/lspd.mjs': [1, 'a pid file'],
  'lsp/launch.mjs': [1, 'the language server state file'],
  'lsp/lib/common.mjs': [1, 'the language server state file'],
  'lsp/lib/daemon.mjs': [1, 'the MCP config for the language servers'],
  'models/lib/models.mjs': [1, 'the model catalogue cache'],
  'pr-check/lib/video.mjs': [1, 'a local HTML player for frame extraction'],
  'pr-video/lib/tools.mjs': [2, "pip's own package list of the local toolchain, and a downloaded model file (binary, checked by SHA-256)"],
  'retro/lib/lessons.mjs': [1, 'a format-patch of a lessons commit that already passed the boundary'],
  'implement/lib/gitops.mjs': [1, 'restores a file to its committed content'],
  'implement/lib/semaphore.mjs': [1, 'a semaphore lock'],
  'implement/lib/mockups.mjs': [3, 'mockup render manifests and PNGs'],
  'implement/requeue-schedule.mjs': [1, 'a launchd plist'],
  'stack/lib/leases.mjs': [2, 'stack slot leases'],
  'factory/factory.mjs': [7, 'the repository\'s config, pin and app files the user owns'],
  'factory/lib/render.mjs': [6, 'rendered pipeline files from the generator\'s templates'],
  'factory/lib/prune.mjs': [1, 'pruned image ids'],
  'factory/lib/init.mjs': [1, 'a .gitkeep'],
  'factory/policy-library.mjs': [1, 'policy library files from the generator'],
  'pr-check/lib/github.mjs': [1, 'a downloaded attachment (binary, async writeFile)'],
};

const WRITE = /\bfs\.(?:writeFileSync|appendFileSync)\(|\bcreateWriteStream\(|(?<![.\w])writeFile\(|(?<![.\w])appendFile\(/g;

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== 'test' && e.name !== 'node_modules') walk(p, out);
    } else if (/\.mjs$/.test(e.name)) out.push(p);
  }
  return out;
}

test('every direct file write outside the boundary is reviewed: none carries a record or a published text', () => {
  const found = {};
  for (const file of walk(path.join(ROOT, 'scripts'))) {
    const rel = path.relative(path.join(ROOT, 'scripts'), file).replace(/\\/g, '/');
    const text = fs.readFileSync(file, 'utf8').replace(/^\s*\/\/.*$/gm, '');
    const n = [...text.matchAll(WRITE)].length;
    if (n) found[rel] = n;
  }
  const unexpected = Object.entries(found).filter(([f, n]) => !ALLOWED[f] || n > ALLOWED[f][0]).map(([f, n]) => `${f}: ${n} direct write(s) (allowed ${ALLOWED[f]?.[0] ?? 0})`);
  assert.deepEqual(unexpected, [], 'a writer goes around the redaction boundary: use writeText/appendText/writeJson/appendJsonl (pipeline/lib/redact.mjs, util.mjs)');
  const stale = Object.keys(ALLOWED).filter((f) => !found[f]);
  assert.deepEqual(stale, [], 'allow-list entries without a direct write: remove them');
});

test('every host, tracker and sink write operation is gated, for every adapter type', async () => {
  const { createAdapter, HOST_WRITE_OPS } = await import('../lib/hosts/index.mjs');
  const { trackerFor } = await import('../../board/lib/trackers/index.mjs');
  const { operations } = await import('../lib/providers/contracts.mjs');
  const at = (o, id) => id.split('.').reduce((x, k) => x?.[k], o);
  const fakeGh = () => ({ status: 0, stdout: '{}', stderr: '' });
  for (const type of ['github', 'gitlab', 'bitbucket', 'azure-devops']) {
    const host = createAdapter({ type, repo: 'o/r', project: 'p', org: 'o', url: 'https://example.invalid' }, { gh: fakeGh, fetch: async () => ({ ok: true, status: 200, json: async () => ({}), text: async () => '{}' }) });
    for (const id of HOST_WRITE_OPS) {
      const fn = at(host, id);
      if (typeof fn === 'function') assert.equal(fn.name, 'guarded', `${type} host ${id} is not gated`);
    }
  }
  for (const type of ['github', 'gitlab', 'jira', 'azure-boards', 'linear']) {
    const tracker = trackerFor({ root: '/tmp/x', tracker: { type, repo: 'o/r', project: 'P', url: 'https://example.invalid' } }, { gh: fakeGh, send: fakeGh });
    for (const op of operations('tracker').filter((o) => o.mode === 'write')) {
      const fn = at(tracker, op.id);
      if (typeof fn === 'function') assert.equal(fn.name, 'guarded', `${type} tracker ${op.id} is not gated`);
    }
  }
});
