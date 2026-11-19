// `implement stop`: ends the current implement run and everything it started, and marks it stopped so no
// recovery path starts it again. Without it, killing the runner left its batch process retrying the story
// as one that "died", and the detached feature verification and PR check processes running on (dogfood
// step 5). The run's records (batch.json, each story's run record, the story's stage states) say "stopped";
// `implement run <KEY> --force` starts a story again.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { loadState, updateState } from '../../pipeline/lib/state.mjs';
import { INSTALL_ROOT } from '../../pipeline/lib/config.mjs';
import { isProcessAlive, nowIso, readJson, writeJson } from '../../pipeline/lib/util.mjs';

const ACTIVE = new Set(['running', 'starting', 'waiting']);

// Sends SIGTERM to the process group of `pid` (the runner and the agents it spawned share it), or to the
// process alone when its group cannot be read.
function defaultKill(pid) {
  const pgid = process.platform === 'win32' ? null : Number(spawnSync('ps', ['-o', 'pgid=', '-p', String(pid)], { encoding: 'utf8' }).stdout.trim());
  try {
    if (pgid && pgid !== process.pid && pgid !== Number(spawnSync('ps', ['-o', 'pgid=', '-p', String(process.pid)], { encoding: 'utf8' }).stdout.trim())) process.kill(-pgid, 'SIGTERM');
    else process.kill(pid, 'SIGTERM');
    return true;
  } catch {
    return false;
  }
}

// What a stopped run leaves behind is cleaned up as a finished run would (council C3, C7: `implement stop` left six
// language-server daemons, two stack leases and a running slot stack): daemons whose run died are stopped
// (`lspd orphans`), and every stack slot whose lease holder is gone is taken down and released.
export function defaultCleanup(config) {
  const node = (args) => spawnSync(process.execPath, args, { cwd: config.root, encoding: 'utf8' });
  const lsp = node([path.join(INSTALL_ROOT, 'scripts/lsp/lspd.mjs'), 'orphans']);
  let daemons = 0;
  try {
    daemons = JSON.parse(String(lsp.stdout).trim().split('\n').pop() || '{}').stopped?.length ?? 0;
  } catch {}
  const slots = [];
  const list = node([path.join(INSTALL_ROOT, 'scripts/stack/slots.mjs'), 'list', '--root', config.root]);
  let entries = [];
  try {
    entries = JSON.parse(String(list.stdout).trim().split('\n').pop() || '{}').slots ?? [];
  } catch {}
  for (const e of entries.filter((x) => x.lease && x.stale)) {
    node([path.join(INSTALL_ROOT, 'scripts/teststack/teststack.mjs'), '--root', config.root, '--slot', String(e.slot), 'down']);
    node([path.join(INSTALL_ROOT, 'scripts/stack/slots.mjs'), 'release', '--root', config.root, '--slot', String(e.slot)]);
    slots.push(e.slot);
  }
  return { daemons, slots };
}

/** { stopped: [pids], stories: [keys], cleaned: { daemons, slots } } */
export function stopRun(config, { runsDir, batchFile, kill = defaultKill, alive = isProcessAlive, cleanup = defaultCleanup } = {}) {
  const batch = readJson(batchFile, null);
  if (!batch) return { stopped: [], stories: [], reason: 'no implement run' };
  const pids = new Map();
  if (batch.pid && !batch.finishedAt && alive(batch.pid, batch.boot)) pids.set(batch.pid, 'runner');
  const stories = [];
  const records = fs.existsSync(runsDir) ? fs.readdirSync(runsDir).filter((f) => f.endsWith('.json') && !/\.(result|plan)\.json$/.test(f) && f !== 'batch.json') : [];
  for (const f of records) {
    const file = path.join(runsDir, f);
    const rec = readJson(file, null);
    if (!rec?.key) continue;
    const wt = rec.worktree && fs.existsSync(rec.worktree) ? { ...config, root: rec.worktree } : null;
    if (wt) {
      const st = loadState(wt, rec.key);
      for (const stage of ['plan', 'automation', 'prCheck']) if (ACTIVE.has(st[stage]?.status) && st[stage].pid && alive(st[stage].pid, st[stage].boot)) pids.set(st[stage].pid, `${rec.key} ${stage}`);
      updateState(wt, rec.key, (s) => {
        for (const stage of ['plan', 'automation', 'prCheck']) if (ACTIVE.has(s[stage]?.status)) Object.assign(s[stage], { status: 'stopped', reason: 'stopped by implement stop' });
      });
    }
    if (rec.status === 'running' || !rec.outcome) {
      writeJson(file, { ...rec, status: 'stopped', outcome: 'stopped', reason: 'stopped by implement stop', finishedAt: nowIso() });
      stories.push(rec.key);
    }
  }
  const stopped = [];
  for (const [pid] of pids) if (kill(pid)) stopped.push(pid);
  writeJson(batchFile, { ...batch, stoppedAt: nowIso(), finishedAt: batch.finishedAt ?? nowIso() });
  let cleaned = { daemons: 0, slots: [] };
  try {
    cleaned = cleanup(config) ?? cleaned;
  } catch {}
  return { stopped, stories, what: Object.fromEntries(pids), cleaned };
}
