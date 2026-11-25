// One analysis report per head commit and slot, under the factory state folder of the main checkout, so later slots,
// the architecture-review council, feature verification and the PR check read it instead of running the tools again.
// Also: the findings as harness findings for the council, the evidence text members get, and the PR body section.
import { writeText } from '../redact.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { analysisDir } from './runner.mjs';
import { suppressionsText } from './suppressions.mjs';
import { withMarkedSection } from '../util.mjs';

export const reportsDir = (config) => path.join(analysisDir(config), 'reports');
export const reportFile = (config, sha, slot) => path.join(reportsDir(config), sha, `${slot}.json`);

// A scan of a dirty tree (uncommitted files in its scope) is never stored under the HEAD commit: it did not scan that commit.
export function writeReport(config, report) {
  if (!report?.sha || report.tree?.state === 'dirty') return null;
  const file = reportFile(config, report.sha, report.slot);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeText(file, `${JSON.stringify(report, null, 1)}\n`);
  return file;
}

// The report for a commit: the given slot's, else (with `any`) the latest of any slot that ran the same tools
// (`configHash`). A report from other tool settings is never reused.
export function readReport(config, sha, slot, { configHash = null, any = false } = {}) {
  // A dirty tree's scan never stands for the commit (writeReport does not store one; an older engine's file is ignored).
  const read = (f) => {
    try {
      const r = JSON.parse(fs.readFileSync(f, 'utf8'));
      return r?.tree?.state === 'dirty' ? null : r;
    } catch {
      return null;
    }
  };
  const own = read(reportFile(config, sha, slot));
  if (own && (!configHash || own.configHash === configHash)) return own;
  if (!any) return null;
  const dir = path.join(reportsDir(config), sha);
  if (!fs.existsSync(dir)) return null;
  const all = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => read(path.join(dir, f))).filter(Boolean);
  return all.filter((r) => !configHash || r.configHash === configHash).sort((a, b) => String(b.ts).localeCompare(String(a.ts)))[0] ?? null;
}

// The report's open findings as harness findings for a pair verdict or a council: `source: tool`, an id stable across
// rounds, the tool's lens, blocking only for rules on the tool's block list, always `action: fix`. They stand outside
// the council's votes (blockQuorum) and cannot be disputed to a model: only a change that makes the tool stop reporting
// them ends them.
export function toolFindings(report) {
  return (report?.findings ?? []).map((f) => ({
    id: f.id,
    source: 'tool',
    tool: f.tool,
    rule: f.rule,
    lens: f.lens,
    severity: f.severity,
    action: 'fix',
    category: 'analysis',
    harness: true,
    file: f.file,
    line: f.line,
    issue: `${f.tool} ${f.rule}${f.file ? ` at ${f.file}${f.line ? `:${f.line}` : ''}` : ''}: ${f.message}`,
    evidence: `reported by ${f.tool} on commit ${String(report.sha).slice(0, 12)} (a finding this change introduced)`,
    fix: f.severity === 'blocking' ? 'Fix it so the tool no longer reports it. A suppression needs a justification next to it.' : f.severity === 'major' ? 'Fix it (the scanner\'s severity map rates it major: it does not fail CI, reviewers see it open).' : 'Fix it, or leave it with a reason (it does not block).',
    ...(f.cwe ? { cwe: f.cwe } : {}),
    ...(f.alsoBy?.length ? { alsoBy: f.alsoBy } : {}),
  }));
}

export const isToolFinding = (f) => f?.source === 'tool' || String(f?.id ?? '').startsWith('tool:');

// What the implementer gets in a fix bounce: exactly the findings, nothing to argue with.
export function fixTaskText(report, { bounce, bounces }) {
  const lines = report.findings.slice(0, 60).map((f) => `- [${f.severity === 'blocking' ? 'blocking' : 'fix'}] ${f.tool} ${f.rule} at ${f.file ?? '(no file)'}${f.line ? `:${f.line}` : ''}: ${f.message}`);
  return [
    `Static analysis (fix bounce ${bounce} of ${bounces}; this is not a review round): the repository's analysis tools report these findings on code this change introduced. Fix exactly these, change nothing else, and finish.`,
    'They are facts a tool proves, not opinions: they cannot be disputed. A finding you believe is a false positive may be suppressed inline only with a justification comment on the same or previous line; the reviewers see every suppression.',
    'Never change a finding\'s state in a scanner\'s own system (accept, ignore, mark false positive, dismiss): only a person does that there.',
    '',
    ...lines,
    ...(report.findings.length > 60 ? [`- ... and ${report.findings.length - 60} more of the same tools`] : []),
  ].join('\n');
}

// The evidence block members and verifiers get with the build output: what ran, what is still open, suppressions.
export function evidenceText(report, { coverage = null } = {}) {
  if (!report) return '';
  const tools = report.tools.map((t) => `${t.id} (${t.status}${t.introduced ? `, ${t.introduced} open` : ''})`).join(', ') || 'none';
  const fl = report.fixLoop;
  const dirty = report.tree?.state === 'dirty';
  const parts = [dirty ? `### Static analysis (harness, the working tree on commit ${String(report.sha).slice(0, 12)} with ${report.tree.count} uncommitted file(s); not a scan of that commit)` : `### Static analysis (harness, commit ${String(report.sha).slice(0, 12)})`, '', `Tools: ${tools}.${fl ? ` Fixed before this review: ${fl.fixed} (auto-fix ${fl.autoFixed ? 'applied' : 'none'}, ${fl.bounces} fix bounce(s)).` : ''}`];
  if (dirty && report.tree.unseen?.length) parts.push('', `Not seen by: ${report.tree.unseen.map((u) => `${u.tool} (${u.files.length} uncommitted file(s): ${u.files.slice(0, 5).join(', ')})`).join('; ')}.`);
  if (report.findings.length) {
    parts.push('', 'Still open after the harness fix loop (already handed to the implementer as harness findings; do not raise them again, judge everything else):');
    parts.push(...report.findings.slice(0, 40).map((f) => `- ${f.severity} ${f.tool} ${f.rule} ${f.file ?? ''}${f.line ? `:${f.line}` : ''}: ${f.message}`));
  }
  parts.push(...[cleanCodeEvidence(report)].filter(Boolean).flatMap((text) => ['', text]));
  if (report.preexisting.length) parts.push('', `Pre-existing findings in touched code (not this change's; follow-ups): ${report.preexisting.length}.`);
  const copies = valueNotes(report);
  if (copies.length) parts.push('', 'Values already on the base branch (notes, not blocking; refer to the setting by name instead of copying its value):', ...copies.map((t) => `- ${t}`));
  if (report.triaged?.length) parts.push('', `Triaged by a person in the scanner's own system (reported, not blocking): ${report.triaged.map((f) => `${f.tool} ${f.rule} ${f.file ?? ''}${f.line ? `:${f.line}` : ''} (${f.triage})`).slice(0, 20).join('; ')}.`);
  // A tool that did not run as asked (an error, a timeout, missing) is said by name, apart from the findings; a skip
  // (nothing for the tool to read) is not a problem (dogfood C15: "- note: no changed file for this tool" sat in the
  // open-findings list without a tool name).
  const notes = report.tools.filter((x) => x.error && x.status !== 'skipped');
  if (notes.length) parts.push('', 'Tool notes:', ...notes.map((t) => `- ${t.id} (${t.status}): ${t.error}`));
  const sup = suppressionsText(report.suppressions);
  if (sup) parts.push('', sup);
  const cov = coverage ?? report.coverage;
  if (cov?.text) parts.push('', cov.text);
  return parts.join('\n');
}

// What the clean-code lens tools (repeated values, duplication, complexity) report on this change: evidence for the
// clean-code reviewer, who upholds each item as its own finding (citing the rule) or says why it is not a problem. An
// item is never a finding by itself.
export function cleanCodeEvidence(report, { limit = 40 } = {}) {
  const items = report?.cleanCode ?? [];
  if (!items.length) return '';
  return [
    'Clean-code evidence (tool reports on this change; not findings: the clean-code reviewer upholds each one as its own finding or says why it is not a problem):',
    ...items.slice(0, limit).map((f) => `- ${f.tool} ${f.rule} ${f.file ?? ''}${f.line ? `:${f.line}` : ''}: ${f.message}`),
    ...(items.length > limit ? [`- ... and ${items.length - limit} more`] : []),
  ].join('\n');
}

// Secret findings whose value the base already holds (secrets.mjs): where the copy is and where the value lives.
export const valueNotes = (report) => (report?.preexisting ?? []).filter((f) => f.alreadyOnBase?.length).slice(0, 10).map((f) => `${f.tool} \`${f.rule}\` ${f.file ?? ''}${f.line ? `:${f.line}` : ''}: already on the base in ${f.alreadyOnBase.slice(0, 3).join(', ')}`);

// Pre-existing findings as follow-ups (never ticket findings): one per tool and rule.
export function preexistingFollowUps(report) {
  const groups = new Map();
  for (const f of report?.preexisting ?? []) {
    const k = `${f.tool}|${f.rule}`;
    groups.set(k, [...(groups.get(k) ?? []), f]);
  }
  return [...groups.values()].map((list) => ({ title: `${list[0].tool} ${list[0].rule}: ${list.length} pre-existing finding(s) in code this change touches`, reason: list.slice(0, 5).map((f) => `${f.file ?? ''}${f.line ? `:${f.line}` : ''}`).join(', '), source: `tool:${list[0].tool}` }));
}

// What changed between a scanned commit and the head, by kind: this change's production files, its tests and test plans,
// and files the base merge brought in (analysedAncestor). Without kinds, every file is named as a changed file.
function changedText(source) {
  const names = (l) => `${l.slice(0, 5).join(', ')}${l.length > 5 ? ', ...' : ''}`;
  const k = source.kinds;
  if (!k) return `${source.changed.length} file(s) (${names(source.changed)})`;
  const parts = [];
  if (k.production.length) parts.push(`${k.production.length} production file(s)${source.baseKnown ? ' of this change' : ''} (${names(k.production)})`);
  if (k.tests.length) parts.push(`${k.tests.length} test or test plan file(s) (${names(k.tests)})`);
  if (k.fromBase.length) parts.push(`${k.fromBase.length} file(s) from the merge of the base branch (${names(k.fromBase)})`);
  return parts.join(', ') || 'nothing outside the pipeline\'s records';
}

const SSTART = '<!-- static-analysis:start -->';
const SEND = '<!-- static-analysis:end -->';

// The PR body's "Static analysis" section from the reports of the PR's commits (the latest per slot) and the fix-loop
// records: tools run, fixed before review, still open, follow-ups on pre-existing code.
export function staticAnalysisSection(reports, { fixLoops = [], head = null, slot = null, source = null, observed = null, distinct = null, runs = null } = {}) {
  const list = (reports ?? []).filter(Boolean);
  if (!list.length && !fixLoops.length && !runs) return '';
  const latest = list.sort((a, b) => String(b.ts).localeCompare(String(a.ts)))[0] ?? null;
  const RAN = ['ok', 'findings'];
  // A tool that errored, timed out or was missing did not run: it is never listed as run (council C10, Opus 3).
  const ran = [...new Set(list.flatMap((r) => r.tools.filter((t) => RAN.includes(t.status)).map((t) => t.id)))];
  const failed = list.flatMap((r) => r.tools.filter((t) => ['error', 'timeout', 'missing', 'licence'].includes(t.status)));
  const fixed = fixLoops.reduce((n, r) => n + (r.fixed ?? 0), 0);
  const bounces = fixLoops.reduce((n, r) => n + (r.bounces ?? 0), 0);
  // Open findings on the head, each distinct finding once.
  const seen = new Set();
  const open = (latest?.findings ?? []).filter((f) => {
    const k = f.fingerprint ?? f.id ?? `${f.tool}|${f.rule}|${f.file}|${f.line}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  const pre = latest?.preexisting ?? [];
  const slotName = latest?.by === 'delivery' ? 'the delivery' : { prCheck: 'the PR check', story: 'the story', featureVerification: 'feature verification', pair: 'a pair round' }[slot ?? latest?.slot] ?? slot ?? latest?.slot ?? null;
  const lines = ['## Static analysis', ''];
  const at = (x) => String(x).slice(0, 7);
  // `source`: the report is an earlier commit's (prAnalysisSection). It covers the head only when nothing in the product
  // changed since; otherwise it is provenance, never a result for the head.
  const covers = Boolean(latest) && (!source || !source.changed?.length);
  const runOf = slotName ? `${slotName}'s run` : 'the run';
  if (latest && !source) lines.push(`- Report: ${runOf} on this head${head ? ` (${at(head)})` : ''}`);
  else if (latest && covers) lines.push(`- Report: ${runOf} on ${at(source.sha)}; this head${head ? ` (${at(head)})` : ''} changed only the pipeline's records since, so its production code is the code analysed`);
  else if (latest) lines.push(`- Report: none for this head${head ? ` (${at(head)})` : ''}. The latest is ${runOf} on ${at(source.sha)}; changed since: ${changedText(source)}. It is shown as that commit's result, not this head's`);
  else lines.push(`- Report: none for this head${head ? ` (${at(head)})` : ''}; what follows is from earlier heads and is not a result for this one`);
  lines.push(`- Tools run: ${ran.join(', ') || 'none'}`);
  if (failed.length) {
    lines.push(`- Did not run: ${failed.length}`);
    for (const t of failed.slice(0, 10)) lines.push(`  - ${t.id} (${t.status})${t.error ? `: ${String(t.error).slice(0, 160)}` : ''}`);
  }
  lines.push(`- Fixed before review: ${fixed} finding(s) (${bounces} harness fix bounce(s), outside the review rounds)`);
  const openCount = `${open.length}${open.length ? ` (${open.filter((f) => f.severity === 'blocking').length} blocking)` : ''}`;
  lines.push(covers ? `- Still open on this head: ${openCount}` : latest ? `- Still open on ${at(source.sha)}: ${openCount}; on this head: not known (no report for it)` : '- Still open on this head: not known (no report for it)');
  for (const f of open.slice(0, 10)) lines.push(`  - ${f.tool} \`${f.rule}\` ${f.file ?? ''}${f.line ? `:${f.line}` : ''}${f.severity === 'blocking' ? '' : ' (not blocking)'}`);
  if (observed != null && observed > open.length) lines.push(`- Across the story's ${runs ?? 'analysis'} analysis run(s): ${observed} observation(s) of ${distinct} distinct open finding(s) (a finding seen in several runs is counted once per run here)`);
  lines.push(`- Follow-ups on pre-existing code: ${pre.length}`);
  for (const t of valueNotes(latest)) lines.push(`  - note: ${t}`);
  if (latest?.triaged?.length) {
    lines.push(`- Triaged in the scanner's own system (by a person; not blocking): ${latest.triaged.length}`);
    for (const f of latest.triaged.slice(0, 10)) lines.push(`  - ${f.tool} \`${f.rule}\` ${f.file ?? ''}${f.line ? `:${f.line}` : ''}: ${f.triage}${f.justification ? ` (${String(f.justification).slice(0, 120)})` : ''}`);
  }
  if (latest?.suppressions?.length) lines.push(`- Inline suppressions added: ${latest.suppressions.length} (${latest.suppressions.slice(0, 5).map((s) => `${s.file}:${s.line}`).join(', ')})`);
  return lines.join('\n');
}

// The body with the section replaced, or added before the trailing generator line / the demo video block / the end.
export const withStaticAnalysis = (body, section) => withMarkedSection(body, section, [SSTART, SEND]);
