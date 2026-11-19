// Where a red CI run of a pipeline PR fails: the failing tests named in the failed jobs' logs, the files that
// hold them, and the story that wrote them (its story tag, packs/<id>/tests.json `storyTag`). A failure in a
// test the pipeline itself wrote is a pipeline defect to diagnose, never "infrastructure" to re-run (council C3:
// a test class the pipeline added made a functional test project time out on start-up for days; the runner re-ran a red job and called it
// infrastructure).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ANSI = /\u001b\[[0-9;]*m/g;

// Failing test classes in a test log: .NET (`failed Namespace.Class.Method (12ms)`, class fixture and cleanup
// failures) and Playwright (`✘ … e2e/x.spec.ts:12:3 › …`).
export function failedTestsIn(log) {
  const classes = new Set();
  const specs = new Set();
  for (const raw of String(log).split('\n')) {
    const line = raw.replace(ANSI, '');
    const dn = /\bfailed\s+(?:\[[^\]]*\(\s*)?([A-Za-z_][\w.]*)\.([A-Za-z_]\w*)[\s)]/.exec(line);
    if (dn) classes.add(dn[1].split('.').pop());
    const fx = /Class fixture type '([\w.]+)' threw/.exec(line);
    if (fx) classes.add(`fixture:${fx[1].split('.').pop()}`);
    const pw = /(?:✘|\[\d+\/\d+\].*?)\s.*?([\w./-]+\.spec\.[tj]s):\d+/.exec(line);
    if (pw && /✘|failed/.test(line)) specs.add(pw[1]);
  }
  return { classes: [...classes], specs: [...specs] };
}

const git = (root, args) => {
  try {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 120_000 });
  } catch {
    return '';
  }
};

// The stories that wrote the failing tests: [{ story, file, test }]. `storyPattern` is a regex with one group
// for the story key (from the runners' story tags), `ref` the commit to read (the PR head).
export function pipelineOrigin(root, failed, { ref = 'HEAD', storyPattern = /(?:Trait\(\s*"Story"\s*,\s*"|TestCategory\(\s*")([A-Z][A-Z0-9]*-\d+)"/ } = {}) {
  const out = [];
  const files = new Map();
  for (const c of failed.classes) {
    const name = c.replace(/^fixture:/, '');
    const hits = git(root, ['grep', '-l', '-E', `class[[:space:]]+${name}([^[:alnum:]_]|$)`, ref, '--', '*.cs']).split('\n').filter(Boolean).map((l) => l.replace(`${ref}:`, ''));
    for (const f of hits) files.set(f, c);
    // A fixture that failed to start: every class that sets it up is a suspect (the class that loses a start-up race
    // is not always the one that caused it; council C3: #40 failed in WebhooksApiTests, beside #49's Bug16Tests).
    if (c.startsWith('fixture:')) {
      const users = git(root, ['grep', '-l', '-E', `(IClassFixture|ICollectionFixture)[[:space:]]*<[[:space:]]*${name}[[:space:]]*>`, ref, '--', '*.cs']).split('\n').filter(Boolean).map((l) => l.replace(`${ref}:`, ''));
      for (const f of users) if (!files.has(f)) files.set(f, `${name} user`);
    }
  }
  for (const s of failed.specs) files.set(s, s);
  for (const [file, test] of files) {
    const text = git(root, ['show', `${ref}:${file}`]) || (fs.existsSync(path.join(root, file)) ? fs.readFileSync(path.join(root, file), 'utf8') : '');
    const story = storyPattern.exec(text)?.[1] ?? /\b(?:TC[-_])?([A-Z][A-Z0-9]*[-_]\d+)[-_]\d+/.exec(text)?.[1]?.replace('_', '-') ?? null;
    out.push({ test, file, story });
  }
  return out;
}

// One line for the gate notice and the sync log, or null when nothing failing was found.
export function originLine(origins) {
  const ours = origins.filter((o) => o.story);
  if (!ours.length) return origins.length ? `failing tests: ${origins.map((o) => o.test).join(', ')} (no story tag: not written by the pipeline)` : null;
  const stories = [...new Set(ours.map((o) => o.story))];
  return `failing tests the pipeline wrote (${stories.join(', ')}: ${ours.map((o) => `${o.test} in ${o.file}`).join('; ')}). This is a defect in the pipeline's own tests to diagnose and fix, not an infrastructure failure to re-run`;
}
