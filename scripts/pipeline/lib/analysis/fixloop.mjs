// The harness fix loop of a slot (the pair rounds' main use): auto-fix, run the tools on what the change touched, and
// hand the provable findings back to the implementer, up to `analysis.maxFixRounds` times. A bounce is not a pair
// or council round. What is open after the budget is the report's `findings`: they reach the members as harness
// findings (report.mjs toolFindings). One report is written for the final head commit.
import { appendJsonl, nowIso } from '../util.mjs';
import { metricsFile, readMetricsLocal } from '../state.mjs';
import { git as gitSync } from '../git.mjs';
import { runTags } from '../run-tags.mjs';
import { resolveAnalysis } from './config.mjs';
import { readReport, reportsDir, staticAnalysisSection, writeReport, fixTaskText } from './report.mjs';
import fs from 'node:fs';
import { autoFix, recordPrefixes, runSlot, slotHash, touchedFiles, uncommittedInScope } from './runner.mjs';
import { isTestFile, testRunners } from '../../../feature-verification/lib/runners.mjs';
import { setting } from '../settings.mjs';

// The pre-push analysis gate's records (implement/lib/analysis-gate.mjs writes them; the report reads them).
export const GATE_METRICS = 'analysis-gate.jsonl';

export const FINDINGS_FILE = 'analysis-findings.jsonl';
export const RUNS_FILE = 'analysis-runs.jsonl';

// deps: { commit(message) -> bool, head() -> sha, askImplementer(task, bounce) -> Promise, exec, log }
export async function fixLoop(config, slot, { cwd, base, deps, bounces = null, label = '', resolved = resolveAnalysis(config), signal = null, deadline = Infinity }) {
  if (!resolved || !(resolved.stages[slot] ?? []).length) return null;
  const budget = bounces ?? resolved.fixLoop.bounces;
  const seen = new Map();
  let autoFixed = false;
  let bounce = 0;
  let report;
  const wall = { tools: 0 };
  for (;;) {
    const files = touchedFiles(cwd, base);
    const ran = await autoFix(config, resolved.stages[slot], { cwd, files, exec: deps.exec, signal, resolved });
    if (ran.length && deps.commit(`${label}analysis auto-fix (${ran.join(', ')})`)) autoFixed = true;
    // The same commit and tool settings were analysed already (a resumed run, a later slot): read, do not run.
    const sha = deps.head();
    // A stored report describes the commit; with uncommitted files in scope the tree is not that commit.
    const cached = uncommittedInScope(config, cwd).length ? null : readReport(config, sha, slot, { configHash: slotHash(resolved, slot) });
    report = cached ?? (await runSlot(config, slot, { cwd, base, exec: deps.exec, signal, resolved, deadline }));
    if (!cached) wall.tools += report.tools.reduce((n, t) => n + (t.wallMs ?? 0), 0);
    for (const f of report.findings) if (!seen.has(f.id)) seen.set(f.id, f);
    if (!report.findings.length || bounce >= budget) break;
    bounce++;
    deps.log?.(`${label}static analysis: ${report.findings.length} finding(s); fix bounce ${bounce} of ${budget}`);
    // not-routed: tool findings, the harness's own facts, always the code agent's
    await deps.askImplementer(fixTaskText(report, { bounce, bounces: budget }), bounce);
    deps.commit(`${label}fix static analysis findings (bounce ${bounce})`);
  }
  const open = new Set(report.findings.map((f) => f.id));
  const fixedList = [...seen.values()].filter((f) => !open.has(f.id));
  report.fixLoop = { bounces: bounce, budget, autoFixed, fixed: fixedList.length, open: report.findings.length, toolWallMs: wall.tools };
  report.fixedBeforeReview = fixedList.map((f) => ({ id: f.id, tool: f.tool, rule: f.rule, file: f.file, line: f.line, severity: f.severity }));
  writeReport(config, report);
  return report;
}

// Metrics: every finding with its source (`tool:<id>`), whether it was fixed before review, the bounces and the tools'
// wall time, so council rounds per story can be compared before and after analysis.
export function recordAnalysis(config, { story, stage, step = null, round = null, report }) {
  if (!report) return;
  const tags = runTags();
  try {
    appendJsonl(metricsFile(config, RUNS_FILE), {
      ts: nowIso(),
      story,
      stage,
      step,
      round,
      slot: report.slot,
      sha: report.sha,
      // Clean: a scan of the commit `sha`. Dirty: a scan of a working tree on it with uncommitted files, never coverage
      // of `sha` (`covers` null); `unseen` names the uncommitted files a commit-reading tool did not read.
      tree: report.tree?.state ?? 'clean',
      covers: report.tree?.state === 'dirty' ? null : report.sha,
      ...(report.tree?.state === 'dirty' ? { uncommitted: report.tree.count, unseen: report.tree.unseen ?? [] } : {}),
      tools: report.tools.map((t) => ({ id: t.id, status: t.status, wallMs: t.wallMs, introduced: t.introduced, preexisting: t.preexisting })),
      bounces: report.fixLoop?.bounces ?? 0,
      fixed: report.fixLoop?.fixed ?? 0,
      open: report.findings.length,
      blocking: report.findings.filter((f) => f.severity === 'blocking').length,
      suppressions: report.suppressions?.length ?? 0,
      // What the clean-code tools reported on this ticket's change (GEN-17), beside what its clean-code member upheld.
      cleanCode: cleanCodeCounts(report),
      toolWallMs: report.fixLoop?.toolWallMs ?? report.tools.reduce((n, t) => n + (t.wallMs ?? 0), 0),
      ...tags,
    });
    const rows = [
      ...(report.fixedBeforeReview ?? []).map((f) => ({ ...f, outcome: 'fixed-before-review' })),
      ...report.findings.map((f) => ({ id: f.id, tool: f.tool, rule: f.rule, file: f.file, line: f.line, severity: f.severity, outcome: 'open' })),
      ...report.preexisting.map((f) => ({ id: f.id, tool: f.tool, rule: f.rule, file: f.file, line: f.line, severity: f.severity, outcome: 'pre-existing', ...(f.alreadyOnBase ? { alreadyOnBase: f.alreadyOnBase } : {}) })),
    ].slice(0, 500);
    if (rows.length) appendJsonl(metricsFile(config, FINDINGS_FILE), rows.map((r) => ({ ts: nowIso(), story, stage, step, round, source: `tool:${r.tool}`, ...r, ...tags })));
  } catch {
    /* metrics are best effort */
  }
}

// The clean-code tools' items of a report by kind: clones (jscpd), breaches (lizard's complexity and length) and
// repeats (the repeated-values check).
const KIND = { 'code-clone': 'clones', 'high-complexity': 'breaches', 'long-function': 'breaches', 'repeated-default': 'repeats', 'repeated-constant': 'repeats' };
export function cleanCodeCounts(report) {
  const counts = { clones: 0, breaches: 0, repeats: 0 };
  for (const f of report?.cleanCode ?? []) if (KIND[f.rule]) counts[KIND[f.rule]] += 1;
  return counts;
}

// The report for the head of `cwd`: one any slot already wrote for that commit (the pair rounds, the story, another PR
// check round), else this slot's tools run once and the report is written. No fix loop: for the PR check, feature
// verification and the architecture review, which read it as evidence. Null when analysis is off or the slot has no tool.
// `by`: who ran the scan when it is not the slot's own stage (the delivery's scan of the head it opens the PR on).
export async function reportFor(config, slot, { cwd, base, resolved = resolveAnalysis(config), exec, signal = null, by = null }) {
  if (!resolved || !(resolved.stages[slot] ?? []).length || !base) return null;
  const git = gitSync;
  const sha = git(cwd, ['rev-parse', 'HEAD']).stdout.trim();
  // Another slot's report counts only when no file in the scan's scope is uncommitted (its sha would then not describe
  // what is analysed). The pipeline's own records (metrics shards, run state) are never in that scope: they are written
  // between the push and the delivery's scan, and they must not cost the delivered head its own report.
  const dirty = uncommittedInScope(config, cwd).length > 0;
  const found = dirty ? null : readReport(config, sha, slot, { configHash: slotHash(resolved, slot) }) ?? readReport(config, sha, slot, { any: true });
  if (found) return found;
  const report = await runSlot(config, slot, { cwd, base, exec, signal, resolved });
  if (report && by) report.by = by;
  // writeReport keeps a clean tree's scan under the commit and never a dirty one's (report.tree).
  writeReport(config, report);
  return report;
}

// The PR body's "Static analysis" section for these stories: the head's report (any slot) and the fix-loop records.
// '' when analysis is off, so a body without analysis is unchanged.
// `base`: the branch the change targets, so files that came in through a merge of it are told apart from the change's own.
export function prAnalysisSection(config, keys, { cwd = config.root, head = null, base = null } = {}) {
  if (!resolveAnalysis(config)) return '';
  const runs = readMetricsLocal(config, RUNS_FILE).filter((r) => keys.includes(r.story));
  // The delivered head (council C11, Sol 3: a held-out feature's section named an intermediate commit, not the PR's head).
  const sha = head ?? gitSync(cwd, ['rev-parse', 'HEAD']).stdout.trim();
  // The head's own report, from the widest slot that analysed it (council C10, Sol 3 / Opus 3: #243 printed the story slot's
  // clean report while the PR-check slot of that head had three findings open, and a tool error read as "ran").
  const pick = (at) => {
    const own = REPORT_SLOTS.find((s) => readReport(config, at, s, { any: false }));
    const report = own ? readReport(config, at, own, { any: false }) : readReport(config, at, 'story', { any: true });
    return report ? { report, slot: own ?? report.slot ?? null } : null;
  };
  let found = pick(sha);
  let source = null;
  if (!found) {
    // No report for the head: the newest analysed ancestor. It covers the head only when the head changed nothing but
    // the pipeline's own records since (production tree identical); otherwise it is shown with its commit, as provenance.
    const earlier = analysedAncestor(config, cwd, sha, { base });
    if (earlier) {
      found = pick(earlier.sha);
      source = found ? earlier : null;
    }
  }
  const report = found?.report ?? null;
  const slot = found?.slot ?? null;
  const fixLoops = runs.filter((r) => r.stage === 'pair').map((r) => ({ fixed: r.fixed, bounces: r.bounces }));
  // Every observation of the story's tool findings across its analysis runs, and how many distinct findings they are.
  const observed = readMetricsLocal(config, FINDINGS_FILE).filter((r) => keys.includes(r.story) && r.outcome === 'open');
  const distinct = new Set(observed.map((r) => r.id ?? `${r.tool}|${r.rule}|${r.file}|${r.line}`)).size;
  // CI's analysis jobs as the pre-push gate ran them here (its newest run for these stories): what ran, what could not
  // and why, so a job CI alone decided is visible in the report, not only in a log line.
  const gateRows = readMetricsLocal(config, GATE_METRICS).filter((r) => keys.includes(r.story) || (r.stories ?? []).some((k) => keys.includes(k)));
  const lastTs = gateRows.reduce((m, r) => (r.ts > m ? r.ts : m), '');
  const gate = gateRows.filter((r) => r.ts === lastTs);
  const gateLines = gate.length
    ? `- CI's analysis jobs before the push (on ${String(gate[0].head ?? '').slice(0, 7) || 'the pushed head'}${gate[0].head && gate[0].head !== sha ? `, not this head: ${sha.slice(0, 7)} came after it` : ''}): ${gate.map((r) => `${r.job} ${r.verdict === 'unverified' ? 'could not run here (CI decides)' : r.verdict === 'pass' ? 'passed' : 'failed'}`).join('; ')}\n${gate.filter((r) => r.verdict === 'unverified').map((r) => `  - ${r.job}: ${r.why || 'no reason recorded'}\n`).join('')}`
    : '';
  if (!report && !runs.length && !gateLines) return '';
  const section = staticAnalysisSection(report ? [report] : [], { fixLoops, head: sha, slot, source, observed: observed.length, distinct, runs: runs.length });
  if (!gateLines) return section;
  const end = '<!-- static-analysis:end -->';
  return section.includes(end) ? section.replace(end, `${gateLines}${end}`) : `${section}\n${gateLines}`;
}

// Paths that are the pipeline's own records, not the product: a head that changed only these has the same production tree.
const recordPaths = (config) => recordPrefixes(config).map((p) => `:(exclude)${p.replace(/\/+$/, '')}`);
// The newest ancestor of `sha` with an analysis report: { sha, changed, kinds }, or null. `changed`: every file outside
// the pipeline's records that differs between it and the head; `kinds` sorts them (classifyChanged), so the PR body never
// calls a test plan, a spec or a file the base merge brought in a production file of this change.
export function analysedAncestor(config, cwd, sha, { base = null } = {}) {
  let names;
  try {
    names = fs.readdirSync(reportsDir(config));
  } catch {
    return null;
  }
  const candidates = names.filter((n) => /^[0-9a-f]{7,40}$/.test(n) && n !== sha && gitSync(cwd, ['merge-base', '--is-ancestor', n, sha]).status === 0);
  if (!candidates.length) return null;
  // Newest first: the ancestor with the fewest commits up to the head.
  const distance = (n) => Number(gitSync(cwd, ['rev-list', '--count', `${n}..${sha}`]).stdout.trim() || Infinity);
  const best = candidates.map((n) => ({ n, d: distance(n) })).sort((a, b) => a.d - b.d)[0].n;
  const diff = gitSync(cwd, ['diff', '--name-only', best, sha, '--', '.', ...recordPaths(config)]);
  if (diff.status !== 0) return null;
  const changed = diff.stdout.split('\n').filter(Boolean);
  const kinds = classifyChanged(config, cwd, changed, { base, sha });
  return { sha: best, changed, kinds, baseKnown: Boolean(kinds.own) };
}

// Where feature verification keeps scenarios when the config does not say (scripts/feature-verification/config.json).

// Generic test locations and names (any language), for repositories without configured test runners.
const TEST_PATH = /(^|\/)(tests?|specs?|e2e|__tests__)\/|[Tt]ests?\.(cs|[cm]?[jt]sx?|py|java|kt|go)$|\.(spec|test)\.[cm]?[jt]sx?$|_test\.(go|py)$/;
export const isGenericTestPath = (file) => TEST_PATH.test(file);

// Sorts changed files into { production, tests, fromBase }: `fromBase`, files this change itself does not touch (they
// differ from the head only because the base was merged in; known only with `base`); `tests`, test plans, scenarios and
// test code; `production`, the rest of this change's files.
export function classifyChanged(config, cwd, files, { base = null, sha = 'HEAD' } = {}) {
  let own = null;
  if (base) {
    const r = gitSync(cwd, ['diff', '--name-only', `${base}...${sha}`]);
    if (r.status === 0) own = new Set(r.stdout.split('\n').filter(Boolean));
  }
  // Plans and scenarios at their configured places, else their defaults (a worktree's config may not name them).
  const dirs = [setting(config, 'featureVerification.plansDir'), setting(config, 'teststack.scenariosDir')].filter(Boolean).map((d) => `${String(d).replace(/\/+$/, '')}/`);
  const runners = testRunners(config);
  const isTest = (f) => dirs.some((d) => f.startsWith(d)) || TEST_PATH.test(f) || ((config.featureVerification?.testExtensions?.length || runners.length) && isTestFile(config, f, runners));
  const out = { production: [], tests: [], fromBase: [] };
  for (const f of files) out[own && !own.has(f) ? 'fromBase' : isTest(f) ? 'tests' : 'production'].push(f);
  // Whether the change's own files were known (with `base`); not enumerable, so the kinds compare as three lists.
  Object.defineProperty(out, 'own', { value: Boolean(own) });
  return out;
}

// The slots whose report describes a head, widest first: the PR check's covers the most tools.
export const REPORT_SLOTS = ['prCheck', 'story', 'featureVerification', 'pair'];
