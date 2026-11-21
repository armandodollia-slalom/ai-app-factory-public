// Disk use of the pipeline, kept in bounds (dogfood: the ticket worktrees reached 90 GB, mostly test-stack build output,
// Docker held 63 GB of superseded stack images and ~/.ai-app-factory/versions 28 old installs). `factory prune` and the
// automatic prune at the start and end of `implement run` remove, in this order:
//
//   build      build output of a pipeline worktree no run and no live stack-slot lease uses any more (`buildDirs`, and
//              every git-ignored folder named in `buildDirNames` outside node_modules); the worktree itself stays
//   slot       a stack slot's build folders (artifacts, build) in a checkout still in use, when no live lease holds the
//              slot and they are older than `slotMaxAgeHours`, or, oldest first, while all of them hold more than
//              `slotMaxGb`
//   image      stack images the pipeline built (recorded in the machine-wide images.jsonl, or listed in a slot's
//              images.ids) that a rebuild left untagged, no remaining slot records and no container uses, older
//              than `imageMinAgeHours` (a tagged image is what a slot's tag points at now)
//   install    engine installs under ~/.ai-app-factory/versions that no live branch pins (the checked-out HEAD, the
//              default branch, open pull requests' branches, worktrees in use; also of `installRepos`), no running
//              process uses, beyond the newest `keepInstalls`
//   worktree   a ticket's worktrees (and its subtask worktrees) `worktreeDays` after its run finished, once its pull
//              request is merged or closed (or, with no PR, its issue is closed and its head is on the base), with no
//              uncommitted tracked change and a head the remote has; its branch is kept
//
// Nothing is removed that a running run, a live lease or a worktree touched in the last `idleMinutes` needs. Settings
// (`prune` in .factory/config.json): see PRUNE_DEFAULTS and docs/ai-pipeline/disk.md (the defaults and what each removal checks).
import { hostFor, hostOf } from '../../pipeline/lib/hosts/index.mjs';
import { trackerFor } from '../../board/lib/trackers/index.mjs';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const PRUNE_DEFAULTS = {
  enabled: true,
  minFreeGb: 20,
  pausePollSec: 60,
  idleMinutes: 60,
  buildDirs: ['.factory/state/teststack', 'artifacts', 'test-results', 'playwright-report'],
  buildDirNames: ['bin', 'obj'],
  slotMaxAgeHours: 24,
  slotMaxGb: 4,
  imageMinAgeHours: 3,
  worktreeDays: 7,
  keepInstalls: 3,
  installRepos: [],
  // Static analysis: pinned tools and rule sources in the per-machine cache that this repository does not pin and that
  // were not used for this many days; analysis reports beyond the newest `analysisReports` commits; merge-base caches.
  analysisCacheDays: 30,
  analysisReports: 200,
  analysisBaseDays: 14,
};

const GB = 1024 ** 3;
const SLOT_BUILD = ['artifacts', 'build', 'build-partial'];
const SKIP_WALK = new Set(['node_modules', '.git', '.factory']);

export const defaultExec = (cmd, args, { cwd, input, timeoutSec = 120 } = {}) => {
  const r = spawnSync(cmd, args, { cwd, input, encoding: 'utf8', timeout: timeoutSec * 1000, killSignal: 'SIGKILL', maxBuffer: 64 * 1024 * 1024 });
  return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? String(r.error ?? '') };
};

// Free space (GB) of the file system holding `dir` (the nearest existing parent), or null when df cannot tell.
export function freeGb(dir, { exec = defaultExec } = {}) {
  let d = path.resolve(dir);
  while (!fs.existsSync(d) && path.dirname(d) !== d) d = path.dirname(d);
  const r = exec('df', ['-Pk', d], { timeoutSec: 30 });
  const line = r.status === 0 ? r.stdout.trim().split('\n').pop() : '';
  const avail = Number(line.split(/\s+/)[3]);
  return Number.isFinite(avail) ? Math.round((avail * 1024 / GB) * 10) / 10 : null;
}

// Bytes a path holds on disk (0 when it does not exist).
export function sizeOf(p, { exec = defaultExec } = {}) {
  if (!fs.existsSync(p)) return 0;
  const r = exec('du', ['-sk', p], { timeoutSec: 300 });
  const kb = Number(r.stdout.trim().split(/\s+/)[0]);
  return Number.isFinite(kb) ? kb * 1024 : 0;
}

const newest = (paths) => Math.max(0, ...paths.map((p) => {
  try {
    return fs.statSync(p).mtimeMs;
  } catch {
    return 0;
  }
}));

const inside = (child, parent) => {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

// `git worktree list --porcelain` as [{ path, branch, head, gitdir }]; the first is the main checkout.
export function listWorktrees(root, { exec = defaultExec } = {}) {
  const r = exec('git', ['worktree', 'list', '--porcelain'], { cwd: root });
  const out = [];
  let cur = null;
  for (const line of r.stdout.split('\n')) {
    if (line.startsWith('worktree ')) out.push((cur = { path: line.slice(9), branch: null, head: null }));
    else if (cur && line.startsWith('HEAD ')) cur.head = line.slice(5);
    else if (cur && line.startsWith('branch refs/heads/')) cur.branch = line.slice(18);
  }
  return out;
}

// Git-ignored folders named in `names` under `dir` (outside node_modules, .git and .factory), outermost only.
export function ignoredBuildDirs(dir, names, { exec = defaultExec, maxDepth = 8 } = {}) {
  const wanted = new Set(names);
  const found = [];
  const walk = (d, depth) => {
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory() || SKIP_WALK.has(e.name)) continue;
      const p = path.join(d, e.name);
      if (wanted.has(e.name)) found.push(p);
      else if (depth < maxDepth) walk(p, depth + 1);
    }
  };
  walk(dir, 0);
  if (!found.length) return [];
  const r = exec('git', ['check-ignore', '--stdin', '-z'], { cwd: dir, input: found.map((p) => path.relative(dir, p)).join('\0') });
  const ignored = new Set(r.stdout.split('\0').filter(Boolean).map((p) => path.resolve(dir, p)));
  // A folder that matches an ignore rule but holds tracked files (a committed tools/bin) is the team's, not output.
  const trackedDirs = new Set();
  for (const f of exec('git', ['ls-files', '-z'], { cwd: dir }).stdout.split('\0').filter(Boolean)) {
    for (let d = path.dirname(f); d !== '.' && !trackedDirs.has(d); d = path.dirname(d)) trackedDirs.add(d);
  }
  return found.filter((p) => ignored.has(p) && !trackedDirs.has(path.relative(dir, p)));
}

// A version string's parts for sorting (0.2.63 > 0.2.9).
const versionKey = (v) => String(v).split(/[.-]/).map((x) => (/^\d+$/.test(x) ? Number(x) : x));
export const compareVersions = (a, b) => {
  const x = versionKey(a);
  const y = versionKey(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if (x[i] === y[i]) continue;
    if (x[i] === undefined) return -1;
    if (y[i] === undefined) return 1;
    return typeof x[i] === 'number' && typeof y[i] === 'number' ? x[i] - y[i] : String(x[i]).localeCompare(String(y[i]));
  }
  return 0;
};

// The engine versions `refs` of `repo` pin in .factory/factory.json ({ versions, ok }; ok is false when git fails).
export function pinnedVersions(repo, refs, { exec = defaultExec } = {}) {
  const names = [...new Set(refs.filter(Boolean))];
  if (!names.length) return { versions: new Set(), ok: true };
  const r = exec('git', ['cat-file', '--batch'], { cwd: repo, input: names.map((n) => `${n}:.factory/factory.json`).join('\n') + '\n' });
  const versions = new Set();
  for (const m of r.stdout.matchAll(/"version"\s*:\s*"([^"]+)"/g)) versions.add(m[1]);
  return { versions, ok: r.status === 0 };
}

// The refs that can still run the pipeline: the checked-out HEAD, the remote default branch, the branches of open pull
// requests (null when they cannot be read) and the given worktrees' branches. A merged ticket's old branch is not one.
export function liveRefs(repo, { exec = defaultExec, code = null, branches = [] } = {}) {
  const refs = ['HEAD', ...branches.map((b) => `refs/heads/${b}`)];
  const def = exec('git', ['symbolic-ref', '-q', 'refs/remotes/origin/HEAD'], { cwd: repo });
  refs.push(def.status === 0 && def.stdout.trim() ? def.stdout.trim() : 'refs/remotes/origin/main');
  if (code) {
    const open = code.openBranches();
    if (!open) return null;
    refs.push(...open.map((b) => `refs/remotes/origin/${b}`));
  }
  return refs;
}

// Stack leases of this project, live or not: [{ slot, cwd, live }].
export function readLeases(home, { now = Date.now(), ttlMs = 240 * 60_000, isAlive, hostname = os.hostname() } = {}) {
  const dir = path.join(home, 'leases');
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => /^slot-\d+\.json$/.test(f));
  } catch {
    return [];
  }
  return files.map((f) => {
    let lease = null;
    try {
      lease = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    } catch {
      return { slot: Number(/\d+/.exec(f)[0]), cwd: null, live: true }; // being written: treat as held
    }
    const age = now - Date.parse(lease.renewedAt ?? lease.createdAt);
    const sameHost = !lease.hostname || lease.hostname === hostname;
    const live = age <= ttlMs && (!lease.pid || !sameHost || isAlive(lease.pid));
    return { slot: lease.slot, cwd: lease.cwd ?? null, live };
  });
}

// What the pipeline owns on this machine for the repository at `root`, read once (no decision taken here).
// What prune asks the code host and the tracker: the open PRs' branches, one PR's state, whether a ticket is closed.
// `gh`: a gh runner (GitHub; the tests' fake); otherwise the repository's own code host and tracker.
export function codeOps(config, { gh = null } = {}) {
  const host = () => (gh ? hostOf(gh) : hostFor(config).sync);
  const tracker = () => trackerFor(config, gh ? { gh } : {});
  return {
    openBranches() {
      try {
        return host().pr.list({ state: 'open', limit: 500 }).map((p) => p.head).filter(Boolean);
      } catch {
        return null;
      }
    },
    prState(pr) {
      try {
        const p = host().pr.get(pr);
        return p ? { state: p.state, headSha: p.headSha } : null;
      } catch {
        return null;
      }
    },
    ticketClosed(link) {
      try {
        const id = String(link).match(/(\d+)\/?$/)?.[1] ?? link;
        const t = tracker().tickets.get(id);
        return t ? t.state === 'closed' : null;
      } catch {
        return null;
      }
    },
  };
}

export function gather({ root, settings, implementConfig, stackConfig, stackHome, versionsDir, installRoot, exec = defaultExec, now = Date.now(), isAlive, gh = null, code = null, docker = 'docker', analysis = null }) {
  const worktrees = listWorktrees(root, { exec });
  const main = worktrees[0]?.path ?? root;
  const wtDir = path.resolve(main, implementConfig.implement.worktreeDir.replace('{repo}', path.basename(main)));
  const runsDir = path.join(main, implementConfig.stateDir, 'implement');
  const runs = [];
  try {
    for (const f of fs.readdirSync(runsDir)) {
      if (!/^[A-Z][A-Z0-9]*-\d+\.json$/i.test(f)) continue;
      try {
        runs.push(JSON.parse(fs.readFileSync(path.join(runsDir, f), 'utf8')));
      } catch {
        /* a record being written is read next time */
      }
    }
  } catch {
    /* no runs yet */
  }
  let batch = null;
  try {
    batch = JSON.parse(fs.readFileSync(path.join(runsDir, 'batch.json'), 'utf8'));
  } catch {
    /* none */
  }
  const batchAlive = Boolean(batch && !batch.finishedAt && batch.pid && isAlive(batch.pid));
  const batchStart = batchAlive ? Date.parse(batch.startedAt) || 0 : null;
  const leases = readLeases(stackHome, { now, ttlMs: (stackConfig.leaseTtlMinutes ?? 240) * 60_000, isAlive });
  const ps = exec('ps', ['-axo', 'command'], { timeoutSec: 30 });
  return { root, main, wtDir, worktrees, runs, batchAlive, batchStart, leases, settings, stackStateDir: stackConfig.stateDir, stackHome, versionsDir, installRoot, processes: ps.status === 0 ? ps.stdout : null, exec, now, code: code ?? (gh || implementConfig ? codeOps(implementConfig ?? { root }, { gh }) : null), docker, analysis };
}

// The pipeline worktrees (under the worktree folder) with who still needs them.
function classify(g) {
  const idleMs = g.settings.idleMinutes * 60_000;
  const activeRunPaths = g.runs.filter((r) => g.batchAlive && ['running', 'queued'].includes(r.status)).map((r) => r.worktree).filter(Boolean);
  return g.worktrees.slice(1).filter((w) => inside(w.path, g.wtDir)).map((w) => {
    const run = activeRunPaths.find((p) => w.path === p || w.path.startsWith(`${p}--`));
    const lease = g.leases.find((l) => l.live && l.cwd && inside(l.cwd, w.path));
    const gitdir = gitDirOf(w.path);
    const touched = newest([path.join(gitdir ?? '', 'index'), path.join(gitdir ?? '', 'HEAD'), ...['.factory/state', '.factory/state/logs', '.factory/state/teststack', '.factory/metrics', 'artifacts'].map((d) => path.join(w.path, d))]);
    const recent = idleMs > 0 && g.now - touched < idleMs;
    // While a run of this repository goes, a worktree it touched (an epic's or a group's has no ticket record) is its.
    const ofRun = g.batchStart != null && touched >= g.batchStart;
    const why = run || ofRun ? 'a running run uses it' : lease ? `stack slot ${lease.slot} is leased from it` : recent ? `touched in the last ${g.settings.idleMinutes} min` : null;
    return { ...w, inUse: why };
  });
}

function gitDirOf(wt) {
  try {
    const text = fs.readFileSync(path.join(wt, '.git'), 'utf8');
    const m = /^gitdir:\s*(.+)$/m.exec(text);
    return m ? path.resolve(wt, m[1].trim()) : null;
  } catch {
    return null;
  }
}

// The removals, each { kind, path|id, bytes, reason }. Pure but for reading sizes, the file system and git/gh/docker.
export function planPrune(g) {
  const s = g.settings;
  const out = [];
  const wts = classify(g);
  const dropped = new Set(); // checkouts whose whole test-stack state goes (their images.ids no longer count)

  // Worktrees of merged or closed tickets, worktreeDays after their run finished.
  const removedWt = new Set();
  if (s.worktreeDays != null && s.worktreeDays >= 0 && g.code) {
    for (const run of g.runs) {
      if (run.status !== 'finished' || !run.worktree || !run.finishedAt) continue;
      if (g.now - Date.parse(run.finishedAt) < s.worktreeDays * 86_400_000) continue;
      const own = wts.filter((w) => w.path === run.worktree || w.path.startsWith(`${run.worktree}--`));
      if (!own.length || own.some((w) => w.inUse)) continue;
      const closed = ticketClosed(g, run, own.find((w) => w.path === run.worktree));
      if (!closed.ok) continue;
      for (const w of own) {
        removedWt.add(w.path);
        out.push({ kind: 'worktree', path: w.path, bytes: sizeOf(w.path, g), reason: `${run.key}: ${closed.why}, run finished ${run.finishedAt.slice(0, 10)}` });
      }
    }
  }

  // Build output of pipeline worktrees no run and no lease uses.
  for (const w of wts) {
    if (w.inUse || removedWt.has(w.path)) continue;
    const dirs = [...s.buildDirs.map((d) => path.join(w.path, d)).filter((p) => fs.existsSync(p)), ...ignoredBuildDirs(w.path, s.buildDirNames, g).filter((p) => !s.buildDirs.some((d) => inside(p, path.join(w.path, d))))];
    for (const p of dirs) {
      const bytes = sizeOf(p, g);
      if (bytes) out.push({ kind: 'build', path: p, bytes, reason: `${path.basename(w.path)}: no run or lease uses this worktree` });
    }
    if (dirs.some((p) => inside(path.join(w.path, g.stackStateDir), p))) dropped.add(w.path);
  }

  // Slot build folders of checkouts still in use (the main checkout, and worktrees a run or lease holds).
  const slots = [];
  for (const checkout of [g.main, ...wts.filter((w) => !dropped.has(w.path) && !removedWt.has(w.path)).map((w) => w.path)]) {
    const state = path.join(checkout, g.stackStateDir);
    if (!fs.existsSync(state)) continue;
    const dirs = [{ slot: 0, dir: state }, ...fs.readdirSync(state).filter((f) => /^slot-\d+$/.test(f)).map((f) => ({ slot: Number(f.slice(5)), dir: path.join(state, f) }))];
    for (const { slot, dir } of dirs) {
      const held = slot > 0 && g.leases.some((l) => l.live && l.slot === slot && l.cwd && inside(l.cwd, checkout));
      const parts = SLOT_BUILD.map((b) => path.join(dir, b)).filter((p) => fs.existsSync(p));
      if (!parts.length) continue;
      const mtime = newest([dir, ...['images.stamp', '.env', 'images.ids'].map((f) => path.join(dir, f)), ...parts]);
      slots.push({ checkout, slot, dir, held, parts, mtime, bytes: parts.reduce((n, p) => n + sizeOf(p, g), 0) });
    }
  }
  const maxAgeMs = s.slotMaxAgeHours * 3_600_000;
  let kept = slots.reduce((n, x) => n + x.bytes, 0);
  for (const x of [...slots].sort((a, b) => a.mtime - b.mtime)) {
    if (x.held || !x.bytes) continue;
    const old = g.now - x.mtime > maxAgeMs;
    const over = s.slotMaxGb != null && kept > s.slotMaxGb * GB;
    if (!old && !over) continue;
    kept -= x.bytes;
    for (const p of x.parts) out.push({ kind: 'slot', path: p, bytes: sizeOf(p, g), reason: `slot ${x.slot} of ${path.basename(x.checkout)}: ${old ? `unused for more than ${s.slotMaxAgeHours} h` : `slot build folders over ${s.slotMaxGb} GB`}` });
  }
  const slotGone = new Set(out.filter((e) => e.kind === 'slot' || e.kind === 'build' || e.kind === 'worktree').map((e) => e.path));

  out.push(...planImages(g, { dropped: new Set([...dropped, ...removedWt]), slotGone }));
  out.push(...planAnalysis(g));
  out.push(...planInstalls({ ...g, liveBranches: wts.filter((w) => w.inUse && w.branch).map((w) => w.branch) }));
  return out;
}

// Whether a finished run's ticket is merged or closed, and its work is safe on the remote.
function ticketClosed(g, run, wt) {
  if (!wt) return { ok: false };
  const status = g.exec('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: wt.path });
  if (status.status !== 0 || status.stdout.trim()) return { ok: false };
  const head = g.exec('git', ['rev-parse', 'HEAD'], { cwd: wt.path }).stdout.trim();
  if (run.pr) {
    const pr = g.code.prState(run.pr);
    if (!pr) return { ok: false };
    if (!['merged', 'closed'].includes(pr.state)) return { ok: false };
    if (pr.headSha !== head) return { ok: false };
    return { ok: true, why: `pull request ${pr.state}` };
  }
  if (!run.issueUrl) return { ok: false };
  if (g.code.ticketClosed(run.issueUrl) !== true) return { ok: false };
  const onBase = g.exec('git', ['merge-base', '--is-ancestor', 'HEAD', run.base ?? 'origin/main'], { cwd: wt.path });
  return onBase.status === 0 ? { ok: true, why: 'issue closed and its head is on the base' } : { ok: false };
}

const readIds = (file) => {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').map((l) => l.trim().split(/\s+/).pop()).filter((id) => /^sha256:[0-9a-f]{64}$/.test(id));
  } catch {
    return [];
  }
};

// Stack images the pipeline built that no remaining slot records and no container uses.
function planImages(g, { dropped, slotGone }) {
  const s = g.settings;
  const built = new Set();
  try {
    for (const line of fs.readFileSync(path.join(g.stackHome, 'images.jsonl'), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        for (const id of JSON.parse(line).ids ?? []) built.add(id);
      } catch {
        /* skip */
      }
    }
  } catch {
    /* no history yet */
  }
  const kept = new Set();
  for (const checkout of [g.main, ...g.worktrees.slice(1).map((w) => w.path)]) {
    const state = path.join(checkout, g.stackStateDir);
    if (!fs.existsSync(state)) continue;
    const files = [path.join(state, 'images.ids'), ...fs.readdirSync(state).filter((f) => /^slot-\d+$/.test(f)).map((f) => path.join(state, f, 'images.ids'))];
    for (const f of files) {
      const ids = readIds(f);
      ids.forEach((id) => built.add(id));
      if (!dropped.has(checkout) && ![...slotGone].some((p) => inside(f, p))) ids.forEach((id) => kept.add(id));
    }
  }
  if (!built.size) return [];
  const ps = g.exec(g.docker, ['ps', '-aq', '--no-trunc'], { timeoutSec: 60 });
  if (ps.status !== 0) return []; // Docker unreachable: nothing is known, nothing goes
  const containers = ps.stdout.split('\n').filter(Boolean);
  if (containers.length) {
    const used = g.exec(g.docker, ['inspect', '-f', '{{.Image}}', ...containers], { timeoutSec: 120 });
    if (used.status !== 0 && !used.stdout.trim()) return [];
    used.stdout.split('\n').filter(Boolean).forEach((id) => kept.add(id.trim()));
  }
  const candidates = [...built].filter((id) => !kept.has(id));
  if (!candidates.length) return [];
  const info = g.exec(g.docker, ['image', 'inspect', '-f', '{{.Id}} {{.Created}} {{.Size}} {{len .RepoTags}}', ...candidates], { timeoutSec: 120 });
  const out = [];
  for (const line of info.stdout.split('\n').filter(Boolean)) {
    const [id, created, size, tags] = line.split(' ');
    // A tagged image is what a slot's tag points at now (a slot uses it); a rebuild leaves the old one untagged.
    if (Number(tags) > 0) continue;
    if (g.now - Date.parse(created) < s.imageMinAgeHours * 3_600_000) continue;
    out.push({ kind: 'image', id, bytes: Number(size) || 0, reason: 'built by the pipeline, superseded (untagged); no slot records it and no container uses it' });
  }
  return out;
}

// Engine installs no branch pins and no process runs, beyond the newest keepInstalls.
// Static analysis disk use: the per-machine cache (pinned tools, rule sources) beyond what this repository pins and
// unused for analysisCacheDays (other repositories on the machine share it, hence the age), reports beyond the newest
// analysisReports commits, merge-base caches older than analysisBaseDays, and leftover scratch folders.
export function planAnalysis(g) {
  const a = g.analysis;
  if (!a) return [];
  const s = g.settings;
  const out = [];
  const ls = (dir) => {
    try {
      return fs.readdirSync(dir).map((n) => ({ n, p: path.join(dir, n), t: fs.statSync(path.join(dir, n)).mtimeMs }));
    } catch {
      return [];
    }
  };
  const days = (t) => (g.now - t) / 86_400_000;
  for (const kind of ['tools', 'rules']) {
    for (const e of ls(path.join(a.cache, kind))) {
      if (a.pinned.has(e.n) || days(e.t) < (s.analysisCacheDays ?? 30)) continue;
      out.push({ kind: 'analysis', path: e.p, bytes: sizeOf(e.p, g), reason: `analysis ${kind === 'tools' ? 'tool' : 'rule source'} ${e.n}: not pinned here, unused for ${Math.floor(days(e.t))} day(s)` });
    }
  }
  const reports = ls(path.join(a.dir, 'reports')).sort((x, y) => y.t - x.t);
  for (const e of reports.slice(s.analysisReports ?? 200)) out.push({ kind: 'analysis', path: e.p, bytes: sizeOf(e.p, g), reason: `analysis report of ${e.n.slice(0, 12)}: older than the newest ${s.analysisReports ?? 200}` });
  for (const e of ls(path.join(a.dir, 'base'))) if (days(e.t) >= (s.analysisBaseDays ?? 14)) out.push({ kind: 'analysis', path: e.p, bytes: sizeOf(e.p, g), reason: `analysis merge-base cache ${e.n.slice(0, 12)}: older than ${s.analysisBaseDays ?? 14} day(s)` });
  for (const e of [...ls(path.join(a.dir, 'out')), ...ls(a.dir).filter((x) => x.n.startsWith('base-'))]) if (days(e.t) >= 1) out.push({ kind: 'analysis', path: e.p, bytes: sizeOf(e.p, g), reason: 'analysis scratch folder left by a stopped run' });
  return out;
}

function planInstalls(g) {
  const s = g.settings;
  let versions;
  try {
    versions = fs.readdirSync(g.versionsDir).filter((v) => fs.statSync(path.join(g.versionsDir, v)).isDirectory());
  } catch {
    return [];
  }
  const pinned = new Set();
  const repos = [{ repo: g.main, code: g.code, branches: g.liveBranches ?? [] }, ...(s.installRepos ?? []).map((r) => ({ repo: r.replace(/^~(?=\/|$)/, os.homedir()), code: null, branches: [] }))];
  for (const { repo, code, branches } of repos) {
    const refs = liveRefs(repo, { exec: g.exec, code, branches });
    const p = refs ? pinnedVersions(repo, refs, g) : { ok: false };
    if (!p.ok) return []; // a pin that cannot be read could be any version: remove none
    p.versions.forEach((v) => pinned.add(v));
  }
  if (g.processes === null) return [];
  const newestKept = new Set([...versions].sort(compareVersions).slice(-Math.max(0, s.keepInstalls ?? 0)));
  const out = [];
  for (const v of versions) {
    const dir = path.join(g.versionsDir, v);
    if (pinned.has(v) || newestKept.has(v) || inside(g.installRoot, dir) || g.processes.includes(`${dir}/`)) continue;
    out.push({ kind: 'install', path: dir, bytes: sizeOf(dir, g), reason: `engine ${v}: no live branch pins it, no process runs it` });
  }
  return out;
}

// Carries the plan out; returns [{ ...entry, ok, error }].
export function applyPrune(g, entries) {
  return entries.map((e) => {
    try {
      if (e.kind === 'image') {
        const r = g.exec(g.docker, ['rmi', '-f', e.id], { timeoutSec: 120 });
        return { ...e, ok: r.status === 0, error: r.status === 0 ? null : r.stderr.trim().split('\n').pop() };
      }
      if (e.kind === 'worktree') {
        g.exec('git', ['worktree', 'remove', '--force', e.path], { cwd: g.main, timeoutSec: 600 });
        if (fs.existsSync(e.path)) fs.rmSync(e.path, { recursive: true, force: true });
        g.exec('git', ['worktree', 'prune'], { cwd: g.main });
        return { ...e, ok: !fs.existsSync(e.path), error: null };
      }
      fs.rmSync(e.path, { recursive: true, force: true });
      return { ...e, ok: !fs.existsSync(e.path), error: null };
    } catch (error) {
      return { ...e, ok: false, error: error.message };
    }
  });
}

const human = (bytes) => (bytes >= GB ? `${(bytes / GB).toFixed(1)} GB` : `${Math.round(bytes / 1024 ** 2)} MB`);
export { human as humanBytes };

export function formatPlan(entries, { dryRun = false } = {}) {
  if (!entries.length) return 'Nothing to prune.';
  const kinds = ['worktree', 'build', 'slot', 'image', 'install', 'analysis'];
  const lines = [];
  for (const k of kinds) {
    const list = entries.filter((e) => e.kind === k);
    if (!list.length) continue;
    lines.push(`${k} (${list.length}, ${human(list.reduce((n, e) => n + e.bytes, 0))}):`);
    for (const e of list) lines.push(`  ${e.ok === false ? 'FAILED ' : ''}${e.path ?? e.id.slice(7, 19)}  ${human(e.bytes)}  ${e.reason}${e.error ? ` (${e.error})` : ''}`);
  }
  const total = entries.filter((e) => e.ok !== false).reduce((n, e) => n + e.bytes, 0);
  lines.push(`${dryRun ? 'Would free' : 'Freed'} about ${human(total)}.`);
  return lines.join('\n');
}

// The machine-wide record of the stack images the pipeline built (read by planImages).
export function recordBuiltImages(home, ids, { now = new Date() } = {}) {
  const list = ids.filter((id) => /^sha256:[0-9a-f]{64}$/.test(id));
  if (!list.length) return;
  fs.mkdirSync(home, { recursive: true });
  fs.appendFileSync(path.join(home, 'images.jsonl'), `${JSON.stringify({ at: now.toISOString(), ids: list })}\n`);
}

// The prune of the repository at `root` as configured (`prune` in .factory/config.json over PRUNE_DEFAULTS).
// What the analysis pruning needs: the per-machine cache, this repository's analysis folder and what it pins.
async function analysisPruneInfo(config) {
  try {
    const { resolveAnalysis } = await import('../../pipeline/lib/analysis/config.mjs');
    const { analysisDir, machineCache } = await import('../../pipeline/lib/analysis/runner.mjs');
    const { ruleSetDir } = await import('../../pipeline/lib/analysis/fetch.mjs');
    const pinned = new Set();
    for (const t of resolveAnalysis(config)?.tools.values() ?? []) {
      for (const plat of Object.keys(t.install?.platforms ?? {})) pinned.add(`${t.install.name ?? t.id}-${t.install.version}-${plat}`);
      for (const src of t.rules ?? []) if (src.repo) pinned.add(path.basename(ruleSetDir(machineCache(), src)));
    }
    // The demo-video toolchain (packs/video/tools.json) is the factory's, pinned for every repository.
    try {
      const { PINS } = await import('../../pr-video/lib/tools.mjs');
      pinned.add(PINS.id);
    } catch {
      // no video toolchain in this install
    }
    return { cache: machineCache(), dir: analysisDir(config), pinned };
  } catch {
    return null;
  }
}

export async function pruneContext(root, { exec = defaultExec, gh = null, now = Date.now() } = {}) {
  const { loadConfig, toolConfig, INSTALL_ROOT } = await import('../../pipeline/lib/config.mjs');
  const { isPidAlive } = await import('../../pipeline/lib/util.mjs');
  const stack = await import('../../stack/lib/ports.mjs');
  const settings = toolConfig('prune', PRUNE_DEFAULTS, root);
  const implementConfig = loadConfig('implement', root);
  const stackConfig = stack.loadConfig(root);
  return gather({
    root,
    settings,
    implementConfig,
    stackConfig,
    stackHome: stack.stateHome(stackConfig),
    versionsDir: process.env.FACTORY_VERSIONS_DIR || path.join(os.homedir(), '.ai-app-factory', 'versions'),
    installRoot: INSTALL_ROOT,
    exec,
    now,
    isAlive: isPidAlive,
    gh,
    docker: process.env.TESTSTACK_DOCKER || 'docker',
    analysis: await analysisPruneInfo(implementConfig),
  });
}

// The free space the pipeline's disks have: the main checkout's and the worktree folder's (the lower one counts).
export function diskRoom(g) {
  const free = [g.main, g.wtDir].map((d) => freeGb(d, g)).filter((x) => x != null);
  const gb = free.length ? Math.min(...free) : null;
  return { freeGb: gb, minFreeGb: g.settings.minFreeGb, ok: gb == null || g.settings.minFreeGb == null || gb >= g.settings.minFreeGb };
}

// The automatic prune of `implement run` (at its start and its end): what may go goes, then the free space is read.
// A failure to prune never stops a run; the free-space check does. Returns { pruned, freed, room } or { skipped }.
export async function autoPrune(root, { when = 'start', log = console.log, context = pruneContext, env = process.env } = {}) {
  if (env.FACTORY_PRUNE === '0' && context === pruneContext) return { skipped: true, room: { ok: true, freeGb: null } };
  let g;
  try {
    g = await context(root);
  } catch (error) {
    log(`prune (${when}): skipped, ${error.message}`);
    return { skipped: true, room: { ok: true, freeGb: null } };
  }
  let done = [];
  if (g.settings.enabled !== false) {
    try {
      done = applyPrune(g, planPrune(g));
    } catch (error) {
      log(`prune (${when}): ${error.message}`);
    }
  }
  const freed = done.filter((e) => e.ok).reduce((n, e) => n + e.bytes, 0);
  const failed = done.filter((e) => !e.ok);
  const room = diskRoom(g);
  if (done.length) log(`prune (${when}): removed ${done.length - failed.length} item(s), about ${human(freed)}${failed.length ? `; ${failed.length} could not be removed` : ''}${room.freeGb == null ? '' : `; ${room.freeGb} GB free`}`);
  return { pruned: done.length - failed.length, freed, room };
}

// Back-pressure on disk: before a new ticket, group or pair, waits while the free space is below minFreeGb (a run
// pauses instead of dying on a full disk), pruning once more on every check. Only active when the run set
// FACTORY_DISK_MIN_GB (implement run does, after its start check).
export async function waitForDisk(label, { env = process.env, room = null, prune = null, wait = (ms) => new Promise((r) => setTimeout(r, ms)), log = console.log, pollSec = Number(env.FACTORY_DISK_POLL_SEC) || 60 } = {}) {
  const min = Number(env.FACTORY_DISK_MIN_GB);
  const root = env.FACTORY_DISK_ROOT;
  if (!(min > 0) || !root) return 0;
  // df first; the prune runs only when the space is short.
  const check = room ?? (async () => {
    const now = diskRoom({ main: root, wtDir: env.FACTORY_DISK_WORKTREES || root, settings: { minFreeGb: min }, exec: defaultExec });
    return now.ok ? now : (await autoPrune(root, { when: `before ${label}`, log, context: prune ?? pruneContext })).room;
  });
  let waited = 0;
  for (;;) {
    const r = await check();
    if (r.ok || r.freeGb == null) {
      if (waited) log(`${label}: ${r.freeGb} GB free again; starting`);
      return waited;
    }
    if (!waited || waited % 600 < pollSec) log(`${label}: only ${r.freeGb} GB free, below prune.minFreeGb (${min} GB) after pruning; paused until space is freed (\`factory prune --dry-run\` lists what the pipeline holds)`);
    await wait(pollSec * 1000);
    waited += pollSec;
  }
}
