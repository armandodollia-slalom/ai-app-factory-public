import { writeText, appendText } from './redact.mjs';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { log, readJson, readJsonl, writeJson } from './util.mjs';
import { setting } from './settings.mjs';

const emptyState = (key) => ({
  story: key,
  done: null,
  review: { rounds: 0, lastHash: null, lastVerdict: null, lastReason: null, approvedHash: null, unchangedBlocks: 0, inProgress: null, recoveries: 0 },
  automation: { status: 'idle', requestedHash: null, verifiedHash: null, pid: null, log: null, bugs: [], progress: null, recoveries: 0, retryAt: null },
  plan: { status: 'idle', pid: null, log: null, progress: null, recoveries: 0, retryAt: null },
  implement: { status: 'idle', worktree: null, branch: null, runs: 0, pid: null, log: null, lastResult: null },
  prCheck: { status: 'idle', hash: null, pid: null, log: null, verdict: null, score: null, openFindings: [], report: null, reason: null, deliveries: 0, runs: 0, recoveries: 0, retryAt: null },
});

export const stateDir = (config) => path.join(config.root, config.stateDir);
// The main checkout (the main worktree, on the base branch) never writes the tracked metrics files: pipeline
// branches commit theirs with their work, and a merged PR brings them to the base branch, so a main checkout that
// appended to them could not `git pull` without a stash (dogfood C2). There, records spool to the ignored state
// folder and the metrics sink ships them; readers see the tracked records and the spooled ones.
// FACTORY_METRICS_SPOOL=1|0 forces it on or off.
const spoolMemo = new Map();
export function spools(config) {
  const forced = process.env.FACTORY_METRICS_SPOOL;
  if (forced === '1') return true;
  if (forced === '0') return false;
  const root = path.resolve(config.root);
  if (!spoolMemo.has(root)) {
    const git = (args) => spawnSync('git', args, { cwd: root, encoding: 'utf8', timeout: 60_000 });
    const dir = git(['rev-parse', '--absolute-git-dir']).stdout.trim();
    const common = path.resolve(root, git(['rev-parse', '--git-common-dir']).stdout.trim());
    const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']).stdout.trim();
    const base = String(setting(config, 'baseRef')).replace(/^origin\//, '');
    spoolMemo.set(root, Boolean(dir) && path.resolve(dir) === common && branch === base);
  }
  return spoolMemo.get(root);
}
export const spoolDir = (config) => path.join(config.root, setting(config, 'stateDir'), 'metrics-spool');
export const trackedMetricsFile = (config, name) => path.join(config.root, config.metricsDir, name);
// A branch writes each stream to a file of its own, `<metricsDir>/<stream>.d/<branch>.jsonl`, that no other
// branch writes (council C4: every pipeline branch appended to the same `<stream>.jsonl`, so each merge to main
// made every other open pipeline PR conflict on GitHub, which ignores `merge=union`, until `board sync` merged main
// into it). Outside a git branch (detached, no repository) the stream's own file is used, as before.
const shardMemo = new Map();
// FACTORY_METRICS_SHARD=0 writes the stream's own file (the engine's tests); =1 forces shards.
export function metricsShard(config) {
  if (process.env.FACTORY_METRICS_SHARD === '0') return null;
  const root = path.resolve(config.root);
  if (!shardMemo.has(root)) {
    const r = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: root, encoding: 'utf8', timeout: 60_000 });
    const branch = r.status === 0 ? r.stdout.trim() : '';
    shardMemo.set(root, branch && branch !== 'HEAD' ? branch.replace(/[^A-Za-z0-9._-]+/g, '__') : null);
  }
  return shardMemo.get(root);
}
export const shardDirOf = (dir, name) => path.join(dir, `${name}.d`);
export function trackedWriteFile(config, name) {
  const shard = metricsShard(config);
  return shard ? path.join(shardDirOf(path.join(config.root, config.metricsDir), name), `${shard}.jsonl`) : trackedMetricsFile(config, name);
}
export const metricsFile = (config, name) => (spools(config) ? path.join(spoolDir(config), name) : trackedWriteFile(config, name));
// Every tracked file of a stream in a metrics folder: its own file, then every branch's shard (sorted).
export function trackedStreamFiles(metricsDir, name) {
  const dir = shardDirOf(metricsDir, name);
  let shards = [];
  try {
    shards = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')).sort().map((f) => path.join(dir, f));
  } catch {
    shards = [];
  }
  return [path.join(metricsDir, name), ...shards];
}
export const readTrackedStream = (metricsDir, name) => trackedStreamFiles(metricsDir, name).flatMap((f) => readJsonl(f));
// Every local record of a stream: the tracked files plus, in a spooling checkout, the spool.
export const readMetricsLocal = (config, name) => [...readTrackedStream(path.join(config.root, config.metricsDir), name), ...(spools(config) ? readJsonl(path.join(spoolDir(config), name)) : [])];

// A metrics stream as its readers see it. Normally the local file. A run that set FACTORY_METRICS_MERGED=1
// (the retro, after `sink pull`) also gets the records the remote store returned, without duplicates, so
// it covers other machines, CI runs and, with sink scope "all", other repositories.
let merge = null;
export const setMetricsMerger = (fn) => { merge = fn; };
export function readMetrics(config, name) {
  const local = readMetricsLocal(config, name);
  return merge && process.env.FACTORY_METRICS_MERGED === '1' ? merge(config, name, local) : local;
}
const escalationFile = (config, key, stage) => path.join(stateDir(config), 'escalations', `${key}-${stage}.md`);

// A loop that cannot converge stops and leaves a note for a human; the next agent session is told.
export function escalate(config, story, stage, title, details) {
  const file = escalationFile(config, story.key, stage);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeText(file, `# ${story.key} ${stage}: ${title}\n\n${new Date().toISOString()}\n\n${details}\n`);
  // Also a metric, so the retro and the metrics see every escalation (the file above is replaced when the
  // stage escalates again, and the state folder is not committed).
  try {
    if (config.metricsDir) {
      const m = metricsFile(config, 'escalations.jsonl');
      fs.mkdirSync(path.dirname(m), { recursive: true });
      appendText(m, `${JSON.stringify({ ts: new Date().toISOString(), story: story.key, stage, title, details: String(details ?? '').slice(0, 2000) })}\n`);
    }
  } catch {
    // a metric must never stop an escalation
  }
  log(`ESCALATED ${story.key} ${stage}: ${title} (see ${path.relative(config.root, file)})`);
  return file;
}

export function clearEscalation(config, story, stage) {
  fs.rmSync(escalationFile(config, story.key, stage), { force: true });
}

export function listEscalations(config) {
  const dir = path.join(stateDir(config), 'escalations');
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.md')).map((f) => f.replace(/\.md$/, '')) : [];
}

export function setActiveStory(config, key) {
  fs.mkdirSync(stateDir(config), { recursive: true });
  writeText(path.join(stateDir(config), 'active-story'), `${key}\n`);
}
const stateFile = (config, key) => path.join(stateDir(config), 'stories', `${key}.json`);

export function loadState(config, key) {
  const state = readJson(stateFile(config, key), null) ?? emptyState(key);
  const base = emptyState(key);
  return { ...base, ...state, review: { ...base.review, ...state.review }, automation: { ...base.automation, ...state.automation }, plan: { ...base.plan, ...state.plan }, implement: { ...base.implement, ...state.implement }, prCheck: { ...base.prCheck, ...state.prCheck } };
}

export function saveState(config, state) {
  writeJson(stateFile(config, state.story), state);
}

export function updateState(config, key, mutate) {
  const state = loadState(config, key);
  mutate(state);
  saveState(config, state);
  return state;
}

export function allStates(config) {
  const dir = path.join(stateDir(config), 'stories');
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => readJson(path.join(dir, f), null))
    .filter(Boolean);
}

export const lockFile = (config, key, stage) => path.join(stateDir(config), 'locks', `${key}-${stage}.lock`);

export function logFile(config, key, stage) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return path.join(stateDir(config), 'logs', `${key}-${stage}-${stamp}.log`);
}
