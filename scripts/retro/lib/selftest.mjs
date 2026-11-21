// `factory retro selftest`: a mechanical check of the plumbing the retro uses to propose a factory change. It is
// not a proposal and changes nothing in the factory. It clones the factory source the pin names, makes a branch
// `retro/selftest-<date>` with a one-line scratch file, pushes it, checks the branch is on the remote at that commit
// (the retro pushes its proposal and a person opens the PR; it opens none), then deletes the branch. Every step is recorded; the result says which step failed, if one did.
import { writeText } from '../../pipeline/lib/redact.mjs';
import { remoteHost } from '../../pipeline/lib/hosts/index.mjs';
import { detectHost } from '../../pipeline/lib/products.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appendJsonl, nowIso, run as defaultRun } from '../../pipeline/lib/util.mjs';
import { metricsFile } from '../../pipeline/lib/state.mjs';
import { factorySource } from './lessons.mjs';

export const SELFTEST_TITLE = 'retro self-test (no change proposed)';
export const SELFTEST_FILE = '.retro-selftest';

// owner/repo from a GitHub remote URL (https or ssh), or null.
export const repoOf = (url) => detectHost(String(url ?? '').replace(/\/$/, ''))?.repo ?? null;

export function retroSelftest(config, { run = defaultRun, now = new Date(), source = null } = {}) {
  const src = source ?? factorySource(config);
  const steps = [];
  const step = (name, ok, detail = '') => {
    steps.push({ step: name, ok, detail });
    return ok;
  };
  const result = (extra = {}) => {
    const out = { status: steps.every((s) => s.ok) ? 'passed' : 'failed', kind: 'plumbing self-test, not a proposal', steps, ...extra };
    appendJsonl(metricsFile(config, 'retro-selftests.jsonl'), [{ ts: nowIso(), ...out }]);
    return out;
  };
  if (!step('factory source', Boolean(src?.source), src?.source ?? 'no factory source with a remote (factory.json source, or the install\'s origin)')) return result();
  const host = remoteHost(src.source, { run });
  const repo = host ? String(host.repo ?? '') || null : null;
  if (!step('code host repository', Boolean(repo), repo ?? `not a code host URL the factory knows: ${src.source}`)) return result();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'retro-selftest-'));
  const branch = `retro/selftest-${now.toISOString().slice(0, 16).replace(/[:T]/g, '-')}`;
  const git = (args) => run('git', args, { cwd: dir });
  const attempt = () => {
    const cloned = run('git', ['clone', '-q', '--depth', '1', src.source, dir]);
    if (!step('clone', cloned.status === 0, cloned.status === 0 ? src.source : cloned.stderr.trim())) return;
    git(['checkout', '-q', '-b', branch]);
    writeText(path.join(dir, SELFTEST_FILE), `retro self-test ${now.toISOString()}: plumbing check, no change proposed\n`);
    git(['add', SELFTEST_FILE]);
    const committed = git(['-c', 'user.name=factory retro', '-c', 'user.email=retro@localhost', 'commit', '-q', '-m', SELFTEST_TITLE]);
    if (!step('commit', committed.status === 0, committed.stderr.trim())) return;
    const pushed = git(['push', '-q', '-u', 'origin', branch]);
    if (!step('push', pushed.status === 0, pushed.status === 0 ? `${branch} to ${repo}` : pushed.stderr.trim())) return;
    // The retro pushes its proposal branch and a person opens the PR (it never opens one: owner requirement C18), so the
    // self-test checks what the retro does: the pushed branch is on the factory's remote at the commit it pushed.
    const head = git(['rev-parse', 'HEAD']).stdout?.trim?.() ?? '';
    const listed = git(['ls-remote', 'origin', `refs/heads/${branch}`]);
    const remote = String(listed.stdout ?? '').split(/\s+/)[0] ?? '';
    step('verify pushed branch', listed.status === 0 && Boolean(remote) && (!head || remote === head), listed.status === 0 ? `${branch} at ${remote.slice(0, 12) || 'nothing'} on ${repo}` : String(listed.stderr ?? '').trim());
  };
  try {
    attempt();
  } finally {
    if (steps.some((x) => x.step === 'push' && x.ok)) {
      const deleted = git(['push', '-q', 'origin', '--delete', branch]);
      step('delete branch', deleted.status === 0, deleted.stderr.trim());
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
  return result({ branch, pr: null });
}
