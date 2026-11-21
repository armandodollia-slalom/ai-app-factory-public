// A UI bug's pair of headline demos (docs/ai-pipeline/pr-demo-video.md, "Bugs: before and after the fix"):
// "Before the fix" records the bug's regression flow against the application built from the merge base, and must fail
// exactly at the check that the "After the fix" recording (the same flow on the fixed branch) passes; "After the fix" is
// that passing recording. Both are narrated as a pair by the demo-narrator agent and rendered like any headline demo.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { git } from '../../pipeline/lib/git.mjs';
import { writeText } from '../../pipeline/lib/redact.mjs';
import { caseIdOf } from './script.mjs';

export const BUG_PAIR_DEFAULTS = {
  // Record a "before the fix" video for UI bugs.
  enabled: true,
  // A UI bug whose reproduction cannot be shown before the fix opens no PR (the delivery escalates) instead of a note.
  requireBefore: false,
};
export const bugPairSettings = (config = {}) => ({ ...BUG_PAIR_DEFAULTS, ...(config.video?.bugPair ?? {}) });

const readText = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '');
const readJson = (f) => {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {
    return null;
  }
};

// Whether a ticket is a bug: its cached type, else its key.
export function isBug(root, key, stateDir = '.factory/state') {
  const dir = path.join(root, stateDir, 'board', key);
  const type = readJson(path.join(dir, 'meta.json'))?.type ?? /\*\*Type:\*\*\s*(\w+)/.exec(readText(path.join(dir, 'story.md')))?.[1] ?? '';
  return /^bug$/i.test(type) || (!type && /^BUG-\d+$/i.test(key));
}

// The UI bugs this change fixes, each with the cases that may reproduce it. A bug is a UI bug when its verified test plan
// has a browser flow (an e2e case) that a changed spec runs, and the change touches the frontend (the caller passes that:
// a backend-only change gets no demo video at all). Which case reproduces the bug is found by running them on the base:
// the first, in this order, that fails there at its check while it passes on the fix (a `demo: headline` case first,
// then by priority, the bug's sad paths before its happy paths, most acceptance criteria covered, lowest id).
// Returns [{ key, caseIds: [id], specs: [file] }].
export function uiBugs({ root, cases, specs, stateDir = '.factory/state' }) {
  const texts = specs.map((f) => [f, readText(path.join(root, f))]);
  const byKey = new Map();
  for (const c of cases) if (c.layer === 'e2e') (byKey.get(c.plan) ?? byKey.set(c.plan, []).get(c.plan)).push(c);
  const out = [];
  for (const [key, list] of byKey) {
    if (!isBug(root, key, stateDir)) continue;
    const inSpecs = list.filter((c) => texts.some(([, t]) => new RegExp(`\\b${c.id}\\b`).test(t)));
    if (!inSpecs.length) continue;
    const rank = (c) => [/^headline$/i.test(c.demo) ? 0 : 1, c.priority, c.type === 'sad' ? 0 : 1, -c.coversCount, c.id];
    const ordered = [...inSpecs].sort((a, b) => {
      const x = rank(a);
      const y = rank(b);
      for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
      return 0;
    });
    const files = texts.filter(([, t]) => ordered.some((c) => new RegExp(`\\b${c.id}\\b`).test(t))).map(([f]) => f);
    out.push({ key, caseIds: ordered.map((c) => c.id), specs: files });
  }
  return out;
}

// The before run of one bug may be used only when it failed at the reproduction check: an assertion (not an action, a
// navigation, a timeout or setup), every step before it passed, the stack was healthy, and the after run passed the same
// check after the same actions. Returns { ok, why }.
export function verifyBefore({ test, steps, after, healthy }) {
  if (!test) return { ok: false, why: 'the before run recorded no video of this case (it did not start, or the spec is not on the base run)' };
  if (healthy === false) return { ok: false, why: 'the test stack built from the base was not healthy during the before run' };
  if (test.ok) return { ok: false, why: 'the bug does not reproduce on the base: the reproduction check passed before the fix' };
  const f = steps?.failed;
  if (!f) return { ok: false, why: 'the before run failed outside the flow (a timeout, setup or the stack), not at a check' };
  if (f.kind !== 'check') return { ok: false, why: `the before run failed at an earlier step (${f.kind === 'navigation' ? 'a navigation' : `the ${f.what ?? 'user'} action`} after ${f.actionsBefore} action(s)), not at the reproduction check` };
  if (!after?.steps) return { ok: false, why: 'there is no passing after recording of the same case to compare with' };
  const sig = (a) => `${a.kind}:${a.target?.name ?? ''}`;
  const beforeActions = (steps.actions ?? []).slice(0, f.actionsBefore).map(sig);
  const afterActions = (after.steps.actions ?? []).slice(0, f.actionsBefore).map(sig);
  if (beforeActions.join('|') !== afterActions.join('|')) return { ok: false, why: 'the before run took other actions than the after run before it failed' };
  const passes = (after.steps.checks ?? []).some((c) => c.line && c.line === f.line && (after.steps.actions ?? []).filter((a) => a.t <= c.t).length >= f.actionsBefore);
  if (!passes) return { ok: false, why: `the before run failed at a check the after run does not pass at the same point ("${String(f.line ?? f.matcher).slice(0, 60)}")` };
  return { ok: true, why: null };
}

// The base checkout for the before run: a worktree of the merge base, kept by commit under the state folder so a
// re-run does not check out or rebuild again; its stack images are tagged with the commit (`stack.imageTag` in its own
// .factory/config.json, where the stack's settings live), so they never replace the fixed branch's images. The branch's
// scenarios are copied in: the reproduction loads the bug's scenario, which the base does not have yet (test data, not
// code). Returns { dir, sha }.
export function baseCheckout(root, base, stateDir = '.factory/state') {
  const sha = git(root, ['merge-base', base, 'HEAD'], { allowFail: false }).stdout.trim();
  const dir = path.join(root, stateDir, 'demo-base', sha.slice(0, 12));
  if (!fs.existsSync(path.join(dir, '.git'))) {
    fs.rmSync(dir, { recursive: true, force: true });
    git(root, ['worktree', 'add', '--detach', '--force', dir, sha], { allowFail: false });
  }
  const file = path.join(dir, '.factory/config.json');
  const json = readJson(file) ?? {};
  const name = json.project?.name ?? readJson(path.join(dir, '.factory/app.json'))?.name ?? 'app';
  const tag = `${String(json.stack?.imageTag ?? `${name}-teststack`).replace(/-base-[0-9a-f]{12}$/, '')}-base-${sha.slice(0, 12)}`;
  if (json.stack?.imageTag !== tag) {
    json.stack = { ...(json.stack ?? {}), imageTag: tag };
    writeText(file, `${JSON.stringify(json, null, 2)}\n`);
  }
  const rel = json.stack?.scenariosDir ?? readJson(path.join(root, '.factory/config.json'))?.stack?.scenariosDir ?? '.factory/stack/scenarios';
  if (fs.existsSync(path.join(root, rel))) fs.cpSync(path.join(root, rel), path.join(dir, rel), { recursive: true, force: true });
  return { dir, sha };
}

// The recorded test of a case in a manifest (its last attempt).
export function testOfCase(manifest, caseId) {
  const all = (manifest?.tests ?? []).filter((t) => caseIdOf(t.title) === caseId && t.videos?.length);
  return all.sort((a, b) => (a.retry ?? 0) - (b.retry ?? 0)).at(-1) ?? null;
}

export const shellQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
export const run = (cmd, opts) => spawnSync('sh', ['-c', cmd], { stdio: 'inherit', ...opts }).status;
