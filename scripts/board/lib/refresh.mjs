// `board sync`: keeps the pipeline's open PRs mergeable. A pipeline PR that the code host reports as DIRTY only
// because of the union-merged metrics logs (see pipeline/lib/base-merge.mjs) gets the latest base merged in a
// temporary checkout and pushed, so its checks run again and it can merge; a real conflict is reported.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { git } from '../../pipeline/lib/git.mjs';
import { mergeLatestBase } from '../../pipeline/lib/base-merge.mjs';
import { setting } from '../../pipeline/lib/settings.mjs';
import { hostFor } from '../../pipeline/lib/hosts/index.mjs';

// The open PRs and one PR's merge state, as { number, headRefName, baseRefName, mergeStateStatus } (the host's merge
// state in upper case: DIRTY, UNKNOWN, CLEAN, ...; from `mergeable` where a host lists no merge state).
function prStates(config) {
  const host = hostFor(config).sync;
  const status = (p) => String(p?.mergeState ?? (p?.mergeable === false ? 'dirty' : p?.mergeable === true ? 'clean' : 'unknown')).toUpperCase();
  return {
    list: () => host.pr.list({ state: 'open', withMergeState: true }).map((p) => ({ number: p.number, headRefName: p.head, baseRefName: p.base, mergeStateStatus: status(p) })),
    state: (n) => String(host.pr.mergeState(n, { tries: 1 })?.mergeState ?? 'unknown').toUpperCase(),
  };
}

// The branch prefixes the pipeline opens PRs from.
export function pipelinePrefixes(config) {
  return [setting(config, 'implement.branchPrefix'), setting(config, 'implement.epic.branchPrefix'), setting(config, 'implement.epic.bugfixPrefix')];
}

// Best-effort removal of a temporary checkout, read-only folders included; never throws.
function removeTree(dir, log) {
  try {
    spawnSync('chmod', ['-R', 'u+w', dir]);
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (error) {
    log(`could not remove ${dir}: ${error.message}`);
  }
}

const pauseMs = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

export function refreshDirtyPrs(config, { log = () => {}, list = null, mergeBase = mergeLatestBase, gitImpl = git, stateOf = null, pause = pauseMs, tries = 4 } = {}) {
  const prefixes = pipelinePrefixes(config);
  const states = list && stateOf ? null : prStates(config);
  const prs = (list ?? states.list)();
  const refreshed = [];
  // UNKNOWN: GitHub recomputes mergeability lazily after the base moves (dogfood C2: right after a merge every
  // other PR read UNKNOWN and nothing was refreshed). Merging the base is a no-op when the branch has it already,
  // and only a merge that happened is pushed.
  // An UNKNOWN PR is asked again until GitHub has decided: merging the base into a PR that has no conflict forced a
  // merge commit and a full CI run on every open PR after each merge to main (council C4). Still UNKNOWN after the
  // retries, it is refreshed as before.
  const readState = stateOf ?? states.state;
  const settled = (pr) => {
    let state = pr.mergeStateStatus;
    for (let i = 0; state === 'UNKNOWN' && i < tries; i++) {
      pause(5000);
      state = readState(pr.number);
    }
    if (state !== pr.mergeStateStatus) log(`#${pr.number}: mergeability ${state.toLowerCase()} after GitHub recomputed it`);
    return state;
  };
  for (const pr of prs.filter((p) => ['DIRTY', 'UNKNOWN'].includes(p.mergeStateStatus) && prefixes.some((x) => p.headRefName.startsWith(x)) && ['DIRTY', 'UNKNOWN'].includes(settled(p)))) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-refresh-'));
    // No git hooks anywhere in the temporary checkout (the graphify hooks would build a graph with read-only
    // cache folders in it on checkout and on merge).
    const env = { ...process.env, PIPELINE_DISABLE: '1', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.hooksPath', GIT_CONFIG_VALUE_0: '/dev/null' };
    try {
      if (gitImpl(config.root, ['fetch', '-q', 'origin', pr.headRefName], { env }).status !== 0) continue;
      // No hooks in the temporary checkout: the graphify post-checkout hook would build a graph (with read-only
      // cache folders) in it (dogfood C2: the cleanup then failed with EACCES and stopped the refresh).
      if (gitImpl(config.root, ['worktree', 'add', '-q', '--detach', dir, `origin/${pr.headRefName}`], { env }).status !== 0) continue;
      const m = mergeBase(dir, pr.baseRefName, { gitImpl, env });
      if (m.conflict) {
        log(`#${pr.number}: merging ${pr.baseRefName} conflicts in ${m.files.join(', ')}; a person resolves it`);
        continue;
      }
      if (!m.merged) continue;
      const pushed = gitImpl(dir, ['push', '-q', 'origin', `HEAD:${pr.headRefName}`], { env });
      if (pushed.status === 0) {
        refreshed.push(pr.number);
        log(`#${pr.number}: ${pr.baseRefName} merged into ${pr.headRefName} (the metrics logs had made it unmergeable on GitHub); its checks run again`);
      } else log(`#${pr.number}: refresh push failed: ${String(pushed.stderr ?? '').trim().split('\n').pop()}`);
    } finally {
      gitImpl(config.root, ['worktree', 'remove', '--force', dir], { env });
      removeTree(dir, log);
    }
  }
  return refreshed;
}
