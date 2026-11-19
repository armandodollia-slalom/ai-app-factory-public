#!/usr/bin/env node
// `factory analysis <command>`: static analysis as the pipeline runs it (docs/ai-pipeline/analysis.md).
//   check                                  validate the analysis settings; list tools, slots and CI jobs; parser samples
//   run [--base <ref>] [--stage <slot>] [--json]
//                                          run a slot's tools on the change from <ref> (default: baseRef) and write the
//                                          report for HEAD; exit 1 when the change introduces a blocking finding
//   install [<tool>...]                    install pinned binaries (SHA-256 verified), rule sources and prepared data
//                                          into the per-machine cache
import { loadConfig, repoRoot } from '../pipeline/lib/config.mjs';
import { resolveAnalysis, SLOTS } from '../pipeline/lib/analysis/config.mjs';
import { parserSelfTest } from '../pipeline/lib/analysis/parsers.mjs';
import { runSlot } from '../pipeline/lib/analysis/runner.mjs';
import { readReport, writeReport } from '../pipeline/lib/analysis/report.mjs';
import { installRules, installTool, prepareTool } from '../pipeline/lib/analysis/install.mjs';
import { slotHash } from '../pipeline/lib/analysis/runner.mjs';

const [command, ...rest] = process.argv.slice(2);
const opt = (name) => (rest.includes(name) ? rest[rest.indexOf(name) + 1] : null);
const positional = rest.filter((a, i) => !a.startsWith('--') && !['--base', '--stage'].includes(rest[i - 1]));

async function main() {
  const root = repoRoot();
  let config;
  try {
    config = loadConfig('feature-verification', root);
  } catch (error) {
    console.error(error.message);
    return 1;
  }
  const a = resolveAnalysis(config);
  if (!a) {
    console.log('analysis is off: .factory/config.json has no "analysis" section (docs/configuration.md#analysis)');
    return command === 'check' ? 0 : 1;
  }
  if (command === 'check') {
    for (const t of a.tools.values()) console.log(`tool ${t.id}${t.pack ? ` (pack ${t.pack})` : ''}: parse ${t.parse}, scope ${t.scope}, baseline ${t.baseline}, lens ${t.lens}, blocks ${[...t.block.levels, ...t.block.rules].join(', ') || 'nothing'}${t.install ? `, pinned ${t.install.version}` : ''}`);
    for (const s of SLOTS) console.log(`slot ${s}: ${a.stages[s].join(', ') || '(none)'}`);
    for (const j of a.ci.jobs) console.log(`ci job ${j.id} "${j.name}": ${j.tools.join(', ')}${j.required ? ' (required)' : ''}`);
    let ok = true;
    // A placeholder nothing fills ({solution} with two solution files at the root) would skip its tool at run time.
    const { unresolvedVars } = await import('../pipeline/lib/analysis/config.mjs');
    for (const u of unresolvedVars(a, config.root)) {
      ok = false;
      console.log(`FAILED  tool ${u.tool}: {${u.name}} is not set; set analysis.vars.${u.name}${u.candidates.length ? ` (candidates at the root: ${u.candidates.join(', ')})` : ''}`);
    }
    // Licences: every tool engine, rule source and data source, with warnings for items pending legal review.
    const { licenceLine } = await import('../pipeline/lib/analysis/licences.mjs');
    for (const r of a.licences) {
      console.log(licenceLine(r));
      ok &&= r.ok;
    }
    for (const p of new Set([...a.tools.values()].map((t) => t.parse))) {
      const [good, detail] = await parserSelfTest(p);
      ok &&= good;
      console.log(`${good ? 'ok' : 'FAILED'}  parser ${detail}`);
    }
    return ok ? 0 : 1;
  }
  if (command === 'run') {
    const slot = opt('--stage') ?? 'pair';
    if (!SLOTS.includes(slot)) {
      console.error(`--stage ${slot} is not a slot (${SLOTS.join(', ')})`);
      return 1;
    }
    const base = opt('--base') ?? config.baseRef;
    const sha = (await import('../pipeline/lib/git.mjs')).git(root, ['rev-parse', 'HEAD']).stdout.trim();
    const report = readReport(config, sha, slot, { configHash: slotHash(a, slot) }) ?? (await runSlot(config, slot, { cwd: root, base, resolved: a }));
    writeReport(config, report);
    if (rest.includes('--json')) console.log(JSON.stringify(report, null, 2));
    else {
      for (const t of report.tools) console.log(`${t.id}: ${t.status}${t.introduced ? `, ${t.introduced} introduced` : ''}${t.preexisting ? `, ${t.preexisting} pre-existing` : ''}${t.error ? ` (${t.error})` : ''}${t.note ? ` (${t.note})` : ''}`);
      for (const f of report.findings) console.log(`${f.severity === 'blocking' ? 'BLOCKING' : 'finding '} ${f.tool} ${f.rule} ${f.file ?? ''}${f.line ? `:${f.line}` : ''}: ${f.message}`);
      for (const s of report.suppressions) console.log(`suppression ${s.file}:${s.line} (${s.id}): ${s.text}`);
    }
    return report.findings.some((f) => f.severity === 'blocking') ? 1 : 0;
  }
  if (command === 'install') {
    const ids = positional.length ? positional : [...a.tools.keys()];
    let ok = true;
    for (const id of ids) {
      const t = a.tools.get(id);
      if (!t) {
        console.error(`no tool "${id}"`);
        ok = false;
        continue;
      }
      for (const step of [() => installTool(config, t, { log: console.log }), () => installRules(config, t), () => prepareTool(config, t)]) {
        const r = await step();
        if (r.detail) console.log(`${r.ok ? 'ok    ' : 'FAILED'}  ${r.detail}`);
        if (!r.ok) {
          ok = false;
          break;
        }
      }
    }
    return ok ? 0 : 1;
  }
  console.error('Usage: factory analysis check | run [--base <ref>] [--stage <slot>] [--json] | install [<tool>...]');
  return 1;
}

process.exitCode = await main();
