// What jscpd and lizard report about one change (GEN-17): duplication and complexity the change adds, never what was
// already there. Both run over more than the change (jscpd over the repository, to find the other copy; lizard over the
// changed files, whole functions), and these keep only what touches a line the change adds or edits:
//   code-clone     a jscpd clone with at least one copy on a changed line, reported at that copy with both places;
//   high-complexity  a function that overlaps a changed line and is over `analysis.complexity.maxCyclomatic`;
//   long-function  the same, over `analysis.complexity.maxFunctionLines`.
// Each is reported on a changed line of its own (the runner keeps changed-lines findings only), in the lines format.
// The findings are evidence for the clean-code reviewer (the tools' lens is clean-code): never blocking by themselves.
// `changed` is decide.mjs changedMap: file -> Set of changed line numbers, or null for a file the base does not have.
import { changedMap } from './decide.mjs';

// A tool script's command line: its `--<name> <value>` flags (`names`, and `base`), `--json` and the files after them,
// and the change it judges: with `--base`, the lines added or edited since that merge base (working tree included);
// without, every given file whole.
export function toolArgs(argv, names, root = process.cwd()) {
  const args = [...argv];
  const flags = Object.fromEntries([...names, 'base'].map((n) => [n, args.includes(`--${n}`) ? args.splice(args.indexOf(`--${n}`), 2)[1] : null]));
  const json = args.includes('--json') && Boolean(args.splice(args.indexOf('--json'), 1));
  return { flags, json, files: args, changed: () => (flags.base ? changedMap(root, flags.base, { worktree: true }) : new Map(args.map((f) => [f, null]))) };
}

// A tool script's output: the lines format the analysis gate reads, or with `--json` the items whole (the generator's
// clean-code report reads those).
export const toolOutput = (findings, json) => (json ? `${JSON.stringify(findings)}\n` : findings.length ? `${asLines(findings)}\n` : '');

// The first changed line of `file` between `start` and `end`, or null when the change does not touch that range.
export function changedLineIn(changed, file, start, end) {
  if (!changed.has(file)) return null;
  const lines = changed.get(file);
  if (lines === null) return start;
  for (let n = start; n <= end; n++) if (lines.has(n)) return n;
  return null;
}

const place = (c) => `${c.name}:${c.start}-${c.end}`;

// jscpd's JSON report (`duplicates`) -> code-clone findings of the change, one per clone, at a changed copy.
export function clonesInChange(duplicates, changed) {
  const out = [];
  for (const d of duplicates ?? []) {
    const copies = [d.firstFile, d.secondFile].filter(Boolean);
    const at = copies.map((c) => ({ c, line: changedLineIn(changed, c.name, c.start, c.end) })).find((x) => x.line !== null);
    if (!at) continue;
    const [a, b] = copies;
    out.push({ rule: 'code-clone', file: at.c.name, line: at.line, message: `${d.lines} lines (${d.tokens} tokens) duplicated between ${place(a)} and ${place(b)} (CC-2: extract it when both copies describe the same knowledge)`, copies: copies.map((c) => ({ file: c.name, start: c.start, end: c.end })), lines: d.lines, tokens: d.tokens });
  }
  return out;
}

// lizard's CSV (NLOC, CCN, token, PARAM, length, location, file, function, long_name, start, end) -> functions.
export function parseLizardCsv(text) {
  return String(text ?? '')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => [...l.matchAll(/"([^"]*)"|([^,]+)/g)].map((m) => m[1] ?? m[2]))
    .filter((c) => c.length >= 11 && Number.isFinite(Number(c[1])))
    .map((c) => ({ ccn: Number(c[1]), length: Number(c[4]), file: c[6], name: c[7], start: Number(c[9]), end: Number(c[10]) }));
}

// Functions the change adds or edits that are over a limit -> high-complexity and long-function findings.
export function breachesInChange(functions, changed, { maxCyclomatic, maxFunctionLines }) {
  const out = [];
  for (const f of functions) {
    const line = changedLineIn(changed, f.file, f.start, f.end);
    if (line === null) continue;
    const fn = { name: f.name, start: f.start, end: f.end, ccn: f.ccn, length: f.length };
    if (f.ccn > maxCyclomatic) out.push({ rule: 'high-complexity', file: f.file, line, ...fn, message: `${f.name} (${f.file}:${f.start}-${f.end}) has a cyclomatic complexity of ${f.ccn}, over ${maxCyclomatic} (CC-5: one job per function)` });
    if (f.length > maxFunctionLines) out.push({ rule: 'long-function', file: f.file, line, ...fn, message: `${f.name} (${f.file}:${f.start}-${f.end}) is ${f.length} lines long, over ${maxFunctionLines} (CC-5: one job per function)` });
  }
  return out;
}

// The lines format the analysis gate reads (a rule id is hyphenated, so the lines parser takes it as the rule).
export const asLines = (findings) => findings.map((f) => `${f.file}:${f.line}: warning ${f.rule}: ${f.message}`).join('\n');
