// `factory analysis install`: a tool's pinned binary, its pinned rule sources (only the included folders, validated
// once with the engine) and its prepared data (an offline database), all in the per-machine cache. Never "latest":
// validation refuses an unpinned version, URL or commit. The downloads themselves are in fetch.mjs, which the generated
// CI script shares.
import fs from 'node:fs';
import path from 'node:path';
import { run } from '../util.mjs';
import { commandValidator, installBinary, pruneData, ruleSet } from './fetch.mjs';
import { expand, machineCache, pinnedBin, platformKey, preparedAgeDays, ruleDirs, toolDataDir } from './runner.mjs';

export { preparedAgeDays };

export async function installTool(config, tool, { plat = platformKey(), fetchImpl = globalThis.fetch } = {}) {
  if (!tool.install) return { ok: true, bin: null, detail: `${tool.id} is not a pinned binary (it comes with the toolchain)` };
  return installBinary(tool.id, tool.install, { cacheDir: machineCache(), plat, fetchImpl });
}

// Every pinned git rule source of the tool: fetched sparse at its commit, licence headers checked, each rule file
// loaded once with the engine (validateRule; a file that does not load is dropped and reported, so one bad upstream
// rule never fails a run). Local and built-in sources need nothing.
export function installRules(config, tool, { git } = {}) {
  const sources = (tool.rules ?? []).filter((s) => s.repo);
  if (!sources.length) {
    const { missing } = ruleDirs(config, tool);
    return missing.length ? { ok: false, detail: `${tool.id}: rule folder(s) missing: ${missing.join(', ')}` } : { ok: true, detail: null };
  }
  const cacheDir = machineCache();
  const bin = pinnedBin(config, tool);
  const validate = tool.validateRule ? commandValidator(expand(tool.validateRule, { bin }), { cacheDir }) : null;
  const details = [];
  for (const src of sources) {
    const r = ruleSet(src, { cacheDir, validate, ...(git ? { git } : {}) });
    details.push(r.detail);
    if (!r.ok) return { ok: false, detail: details.join('; ') };
  }
  return { ok: true, detail: details.join('; ') };
}

// A tool's `prepare` command (an offline vulnerability database download into {cache}). Its time is recorded in
// {cache}/.prepared, which doctor reads for the data's age and the runner requires before a tool with `freshness` runs.
export function prepareTool(config, tool, { runner = run } = {}) {
  if (!tool.prepare) return { ok: true, detail: null };
  const cache = toolDataDir(tool);
  fs.mkdirSync(cache, { recursive: true });
  const cmd = expand(tool.prepare, { bin: pinnedBin(config, tool), cache, root: config.root });
  const [c, a] = Array.isArray(cmd) ? [cmd[0], cmd.slice(1)] : process.platform === 'win32' ? ['cmd.exe', ['/d', '/s', '/c', cmd]] : ['sh', ['-c', cmd]];
  const env = { ...process.env, ...Object.fromEntries(Object.entries(tool.env ?? {}).map(([k, v]) => [k, expand(String(v), { cache, root: config.root })])) };
  const r = runner(c, a, { cwd: config.root, timeoutSec: tool.timeoutSec ?? 600, env });
  if (!(tool.okExit ?? [0]).includes(r.status) || (tool.errorPattern && new RegExp(tool.errorPattern).test(`${r.stdout}${r.stderr}`))) return { ok: false, detail: `${tool.id}: prepare failed (exit ${r.status}): ${String(r.stderr).trim().slice(-300)}` };
  const removed = pruneData(cache, tool.data);
  fs.writeFileSync(path.join(cache, '.prepared'), new Date().toISOString());
  return { ok: true, detail: `${tool.id}: prepared${removed.length ? ` (removed excluded data: ${removed.map((p) => path.basename(p)).join(', ')})` : ''}` };
}
