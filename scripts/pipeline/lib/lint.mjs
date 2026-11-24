// Lint the lines a change touches, with the repository's own linters (`featureVerification.precheck.lint`, by file extension).
// A codebase often has files that already fail its formatter; a gate that linted whole files would block
// every change that touches them. So a linter's findings count only on lines the change added or modified
// (a new or untracked file counts whole). Used by the pre-commit hook (`--staged`), CI (`--base <ref>`) and
// feature verification's precheck.
import fs from 'node:fs';
import path from 'node:path';
import { INSTALL_ROOT, repoOverlay } from './config.mjs';

import { matchesAny } from '../../implement/lib/plan.mjs';
import { git } from './git.mjs';
import { run, tail } from './util.mjs';
import { setting } from './settings.mjs';

// The repository's own settings (an invalid app.json is reported by the commands that load it, not here).
const safeOverlay = (root) => {
  try {
    return repoOverlay(root);
  } catch {
    return {};
  }
};

// {files}: one argument per file; {packs}: the installed language packs (a pack's own linter, such as
// packs/typescript/lint/eslint.mjs for a repository without ESLint of its own).
const expand = (template, files) => template.flatMap((a) => (a === '{files}' ? files : [a.replace(/\{files\}/g, files.join(' ')).replace(/\{packs\}/g, path.join(INSTALL_ROOT, 'packs')).replace(/\{factoryBin\}/g, path.join(INSTALL_ROOT, 'node_modules', '.bin'))]));

// Vendored, minified and generated code is never linted: it is not the application's to fix
// (featureVerification.precheck.lintExclude).
export const lintable = (config, files) => files.filter((f) => !matchesAny(f, setting(config, 'featureVerification.precheck.lintExclude')));

// The new-side line numbers a diff adds or changes in `file`, or null when the file is new (all of it counts).
export function changedLines(root, file, { staged = false, base = null } = {}) {
  const tracked = git(root, ['ls-files', '--error-unmatch', '--', file]).status === 0;
  const range = staged ? ['--cached'] : base ? [base] : [];
  if (!staged && !base && !tracked) return null;
  const inBase = base ? git(root, ['cat-file', '-e', `${base}:${file}`]).status === 0 : staged ? git(root, ['cat-file', '-e', `HEAD:${file}`]).status === 0 : true;
  if (!inBase) return null;
  const diff = git(root, ['diff', '-U0', '--no-ext-diff', ...range, '--', file]).stdout;
  const lines = new Set();
  for (const m of diff.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)) {
    const start = Number(m[1]);
    const count = m[2] === undefined ? 1 : Number(m[2]);
    for (let i = 0; i < count; i++) lines.add(start + i);
  }
  return lines;
}

// Diagnostics a linter printed, as { file, line } (file as printed). Understands `path(12,5)` (dotnet,
// MSBuild), `path:12:5` / `path:12` (markdownlint, ruff, gcc-style) and ESLint's stylish output (a file
// header line, then `  12:5  error ...` lines).
export function parseDiagnostics(output) {
  const found = [];
  let header = null;
  for (const raw of String(output).split('\n')) {
    const line = raw.replace(/\x1b\[[0-9;]*m/g, '');
    let m = /^(?:\s*)([^\s:()]+(?:\.[\w]+))\((\d+),\d+\)/.exec(line);
    if (m) {
      found.push({ file: m[1], line: Number(m[2]) });
      continue;
    }
    m = /^([^\s:]+\.[\w]+):(\d+)(?=[:\s]|$)/.exec(line);
    if (m) {
      found.push({ file: m[1], line: Number(m[2]) });
      continue;
    }
    if (/^\S.*\.[\w]+$/.test(line.trim()) && !/\s{2}/.test(line)) header = line.trim();
    m = /^\s+(\d+):\d+\s+(error|warning)\b/.exec(line);
    if (m && header) found.push({ file: header, line: Number(m[1]) });
  }
  return found;
}

const sameFile = (root, printed, file) => path.resolve(root, printed) === path.resolve(root, file) || printed.endsWith(`/${file}`) || printed === file;

// The linter a command runs, for messages: `node .../eslint.mjs` is eslint, not node.
export const linterName = (argv) => {
  const head = path.basename(argv[0] ?? '');
  const script = /^(node|python3?|npx|pnpm|yarn|bun|dotnet|uv|pipx)$/.test(head) ? argv.slice(1).find((a) => !a.startsWith('-') && a !== 'exec' && a !== 'run') : null;
  if (!script) return head;
  // An interpreter running a script is the script; a tool runner (dotnet format, npx prettier) keeps its name.
  return /^(node|python3?)$/.test(head) ? path.basename(script).replace(/\.(mjs|cjs|js|py)$/, '') : `${head} ${script}`;
};

// Errors (one per linter run) for findings on changed lines only. `files` are repository-relative.
// A configured linter whose local binary is missing (node_modules not installed) is reported in `skipped`,
// never passed over in silence; callers decide whether that fails (CI does). An engine default linter the
// repository never configured goes to `notes`: said, but not a failure.
export function lintChanged(config, files, { staged = false, base = null, runner = run, skipped = [], notes = [] } = {}) {
  const errors = [];
  for (const [ext, template] of Object.entries(config.featureVerification?.precheck?.lint ?? {})) {
    const matching = lintable(config, files).filter((f) => f.endsWith(ext) && fs.existsSync(path.join(config.root, f)));
    if (!matching.length || !template?.length) continue;
    const head = expand([template[0]], [])[0];
    if (head.includes('/') && !fs.existsSync(path.resolve(config.root, head))) {
      // A linter the repository configured itself is reported; the engine's default one is not expected.
      if (!(ext in (safeOverlay(config.root).featureVerification?.precheck?.lint ?? {}))) {
        notes.push(`${template[0]} (engine default for ${ext}) is not installed: ${matching.length} file(s) not linted; configure featureVerification.precheck.lint.${ext} to lint them`);
        continue;
      }
      skipped.push(`${template[0]} is not installed (${ext}: ${matching.length} file(s) not linted; run the repository's install, e.g. npm ci)`);
      continue;
    }
    const argv = expand(template, matching);
    const result = runner(argv[0], argv.slice(1), { cwd: config.root, timeoutSec: 600 });
    if (result.status === 127) {
      skipped.push(`${argv[0]} was not found on PATH (${ext}: ${matching.length} file(s) not linted)`);
      continue;
    }
    if (result.status === 0) continue;
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    const diagnostics = parseDiagnostics(output);
    if (!diagnostics.length) {
      errors.push(`\`${linterName(argv)}\` failed on ${matching.join(', ')}:\n${tail(output, 3000)}`);
      continue;
    }
    const kept = [];
    for (const file of matching) {
      const lines = changedLines(config.root, file, { staged, base });
      for (const d of diagnostics.filter((x) => sameFile(config.root, x.file, file))) if (lines === null || lines.has(d.line)) kept.push(`${file}:${d.line}`);
    }
    if (kept.length) {
      const wanted = new Set(kept);
      const shown = output.split('\n').filter((l) => [...wanted].some((w) => { const [f, n] = [w.slice(0, w.lastIndexOf(':')), w.slice(w.lastIndexOf(':') + 1)]; return l.includes(path.basename(f)) && (l.includes(`(${n},`) || l.includes(`:${n}`)); }) || /^\s+\d+:\d+\s+(error|warning)/.test(l));
      errors.push(`\`${linterName(argv)}\` reports problems on lines this change touches (${[...wanted].join(', ')}):\n${tail(shown.join('\n') || output, 3000)}`);
    }
  }
  return errors;
}

// Files a change touches: staged (pre-commit) or between `base` and the working tree (CI, precheck).
export function changedFiles(root, { staged = false, base = null } = {}) {
  const args = staged ? ['diff', '--cached', '--name-only', '--diff-filter=ACMR'] : ['diff', '--name-only', '--diff-filter=ACMR', base ?? 'HEAD'];
  return git(root, args).stdout.split('\n').filter(Boolean);
}
