#!/usr/bin/env node
// `factory lint [--staged | --base <ref>] [<file>...]`: the repository's linters (precheck.lint) on the files a
// change touches, failing only on findings in the lines it added or changed. The pre-commit hook runs it with
// --staged, the CI gate with --base origin/<target branch>.
import { runMain } from '../pipeline/lib/cli.mjs';
import { loadConfig, repoRoot } from '../pipeline/lib/config.mjs';
import { changedFiles, lintChanged } from '../pipeline/lib/lint.mjs';

// A configuration that does not load is reported as its message, like every other command (no stack trace).
runMain(async () => {
  const argv = process.argv.slice(2);
  const staged = argv.includes('--staged');
  const i = argv.indexOf('--base');
  const base = i >= 0 ? argv[i + 1] : null;
  const given = argv.filter((a, k) => !a.startsWith('--') && argv[k - 1] !== '--base');
  const root = repoRoot();
  const config = loadConfig('feature-verification', root);
  const files = given.length ? given : changedFiles(root, { staged, base });
  const skipped = [];
  const notes = [];
  const errors = lintChanged(config, files, { staged, base, skipped, notes });
  for (const e of errors) console.error(e);
  for (const sk of skipped) console.error(`factory lint: skipped: ${sk}`);
  for (const n of notes) console.error(`factory lint: note: ${n}`);
  // In CI (or with --strict) a configured linter that cannot run fails the check.
  if (skipped.length && (process.env.CI || argv.includes('--strict'))) errors.push(...skipped);
  console.error(errors.length ? `factory lint: ${errors.length} linter(s) report problems on changed lines (SKIP_LINT=1 skips the hook once).` : `factory lint: ${files.length} changed file(s), no problem on changed lines.`);
  return errors.length ? 1 : 0;
}, 'factory lint');
