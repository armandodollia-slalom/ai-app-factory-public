// The provider docs (docs/providers/) against the code: every generated part (the contract reference, each built-in's
// capability table, the commercial definitions, the interview's questions, the worked examples) matches what the code
// says, every built-in has its page, and every relative link in the provider docs resolves.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { BUILTINS, staleParts } from '../lib/providers/docs.mjs';
import { CI_TYPES } from '../lib/ci/index.mjs';
import { HOST_TYPES } from '../lib/hosts/index.mjs';
import { TRACKER_TYPES } from '../../board/lib/trackers/index.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const DOCS = path.join(ROOT, 'docs/providers');

test('every generated part of the provider docs matches the code (node scripts/pipeline/lib/providers/docs.mjs --write)', async () => {
  assert.deepEqual((await staleParts()).map((s) => `${s.file}: ${s.id}: ${s.problem}`), []);
});

test('every built-in host, tracker and CI system has a page with its capability table', () => {
  const documented = (kind) => BUILTINS.filter((b) => b.kind === kind).map((b) => b.type);
  for (const [kind, types] of [['host', HOST_TYPES], ['tracker', TRACKER_TYPES], ['ci', CI_TYPES]]) {
    for (const t of types.filter((x) => x !== 'custom')) assert.ok(documented(kind).includes(t), `${kind} ${t} has no page`);
  }
  for (const b of BUILTINS) assert.ok(fs.existsSync(path.join(DOCS, b.page)), b.page);
});

test('relative links in the provider docs resolve', () => {
  const files = [];
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).forEach((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith('.md') && files.push(path.join(d, e.name))));
  walk(DOCS);
  const broken = [];
  for (const f of files) {
    const text = fs.readFileSync(f, 'utf8').replace(/```[\s\S]*?```/g, '');
    for (const m of text.matchAll(/\]\(([^)]+)\)/g)) {
      const target = m[1].split('#')[0];
      if (!target || /^[a-z]+:/i.test(target)) continue;
      if (!fs.existsSync(path.resolve(path.dirname(f), target))) broken.push(`${path.relative(ROOT, f)}: ${m[1]}`);
    }
  }
  assert.deepEqual(broken, []);
});
