// `factory doctor` rows for static analysis: each tool a slot or CI job uses is installed at its pinned version (and
// checksum), its parser reads a sample, it runs offline, its rule source and prepared data are present and fresh, and
// the CI jobs are rendered. Rows are [what, ok, detail].
import fs from 'node:fs';
import path from 'node:path';
import { run } from '../util.mjs';
import { SLOTS, unresolvedVars } from './config.mjs';
import { CI_SCRIPT, GITHUB_WORKFLOW } from './ci.mjs';
import { preparedAgeDays } from './install.mjs';
import { parserSelfTest } from './parsers.mjs';
import { expand, machineCache, pinnedBin, platformKey, ruleDirs } from './runner.mjs';
import { ruleSetDir } from './fetch.mjs';

const flat = (cmd) => (Array.isArray(cmd) ? cmd.join(' ') : String(cmd ?? ''));

// Returns { rows, warnings }: rows are [what, ok, detail]; warnings [what, detail] (items enabled pending legal review).
export async function analysisDoctor(config, resolved, opts = {}) {
  const rows = await analysisDoctorRows(config, resolved, opts);
  const warnings = [];
  for (const r of resolved?.licences ?? []) {
    if (r.pending) warnings.push([`analysis licence: ${r.kind} ${r.what} (${r.licence})`, 'enabled by default, legal review pending; analysis.licenceReview "strict" turns it off']);
    else rows.push([`analysis licence: ${r.kind} ${r.what} (${r.licence})${r.off ? ' off: legal review pending' : ''}`, r.ok, r.problem ?? (r.acceptedBy ? `accepted by ${r.acceptedBy}` : 'allowed')]);
  }
  return { rows, warnings };
}

export async function analysisDoctorRows(config, resolved, { runner = run, manifest = null, plat = platformKey() } = {}) {
  if (!resolved) return [];
  const used = new Set([...SLOTS.flatMap((s) => resolved.stages[s]), ...resolved.ci.jobs.flatMap((j) => j.tools)]);
  const rows = [];
  for (const id of used) {
    const t = resolved.tools.get(id);
    if (!t || t.builtin) continue;
    if (t.install) {
      const bin = pinnedBin(config, t, plat);
      const d = t.install.platforms?.[plat];
      if (!d) rows.push([`analysis: ${id} ${t.install.version} pinned for this platform`, false, `no build pinned for ${plat}`]);
      else rows.push([`analysis: ${id} ${t.install.version} installed (sha256 ${d.sha256.slice(0, 12)}...)`, Boolean(bin && fs.existsSync(bin)), bin && fs.existsSync(bin) ? bin : `run \`factory analysis install ${id}\``]);
    }
    if (t.version?.cmd) {
      const argv = expand(t.version.cmd, { bin: pinnedBin(config, t, plat) ?? '' });
      const r = Array.isArray(argv) ? runner(argv[0], argv.slice(1), { cwd: config.root, timeoutSec: 60 }) : runner('sh', ['-c', argv], { cwd: config.root, timeoutSec: 60 });
      const out = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim();
      const ok = r.status === 0 && (!t.version.match || out.includes(t.version.match));
      rows.push([`analysis: ${id} reports version ${t.version.match ?? '(any)'}`, ok, ok ? out.split('\n')[0].slice(0, 120) : r.status === 0 ? `got: ${out.split('\n')[0].slice(0, 120)}` : 'not found or does not start']);
    }
    const [pok, pdetail] = await parserSelfTest(t.parse);
    rows.push([`analysis: ${id} parser reads its sample`, pok, pdetail]);
    if (t.offline?.length) {
      const missing = t.offline.filter((flag) => !flat(t.run).includes(flag) || (t.worktreeRun && !flat(t.worktreeRun).includes(flag)));
      rows.push([`analysis: ${id} runs offline (${t.offline.join(' ')})`, missing.length === 0, missing.length ? `its run command lacks ${missing.join(', ')}` : 'no network call besides the pinned downloads']);
    }
    if (t.forbid?.length) {
      const bad = t.forbid.filter((flag) => flat(t.run).includes(flag) || (t.worktreeRun && flat(t.worktreeRun).includes(flag)));
      rows.push([`analysis: ${id} never passes ${t.forbid.join(', ')}`, bad.length === 0, bad.length ? `its run command passes ${bad.join(', ')} (a network call)` : 'ok']);
    }
    if (t.needsRules || t.rules?.length) {
      const { dirs, missing } = ruleDirs(config, t);
      rows.push([`analysis: ${id} rule sources (${t.rules.map((r) => r.id).join(', ') || 'none'})`, t.rules.length > 0 && !missing.length, !t.rules.length ? `no rule source configured: set analysis.tools.${id}.rules (see docs/ai-pipeline/analysis.md); until then ${id} is skipped` : missing.length ? `missing: ${missing.join(', ')}; run \`factory analysis install ${id}\`` : `${dirs.length} folder(s)`]);
      for (const src of t.rules.filter((r) => r.repo)) {
        try {
          const m = JSON.parse(fs.readFileSync(path.join(ruleSetDir(machineCache(), src), 'ruleset.json'), 'utf8'));
          rows.push([`analysis: ${id} rules ${src.id}@${src.commit.slice(0, 12)} validated`, true, `${m.kept} rule file(s) load; ${m.dropped.length} dropped${m.dropped.length ? ` (${m.dropped.slice(0, 3).map((d) => d.file).join(', ')})` : ''}`]);
        } catch {
          /* reported as missing above */
        }
      }
    }
    if (t.freshness) {
      const age = preparedAgeDays(t);
      const max = t.freshness.maxAgeDays ?? 7;
      rows.push([`analysis: ${id} ${t.freshness.what ?? 'prepared data'} at most ${max} day(s) old`, age !== null && age <= max, age === null ? `not prepared: run \`factory analysis install ${id}\`` : `${age} day(s) old`]);
    }
  }
  for (const u of unresolvedVars(resolved, config.root)) rows.push([`analysis: ${u.tool} has a value for {${u.name}}`, false, `set analysis.vars.${u.name}${u.candidates.length ? ` (candidates at the root: ${u.candidates.join(', ')})` : ''}; until then ${u.tool} is skipped`]);
  if (resolved.ci.jobs.length) {
    const files = manifest?.files ?? {};
    const rendered = [CI_SCRIPT, GITHUB_WORKFLOW].every((p) => files[p] && fs.existsSync(path.join(config.root, p)));
    rows.push([`analysis: CI jobs rendered (${resolved.ci.jobs.map((j) => j.id).join(', ')})`, rendered, rendered ? `${GITHUB_WORKFLOW} and ${CI_SCRIPT}` : 'run `factory render`']);
  }
  return rows;
}
