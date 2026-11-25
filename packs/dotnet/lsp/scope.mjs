#!/usr/bin/env node
// Scope module of the dotnet pack (the `scope` of the `csharp` server entry in packs/dotnet/lsp.json). lspd
// calls scope() when it starts a checkout's daemon; the answer tells roslyn-proxy.mjs what to open and
// prepare.mjs what to restore.
//
//   options.solution         solution file relative to the checkout (default: the only .slnx or .sln at its root)
//   options.restoreSolution  what to `dotnet restore` when the whole solution is opened, for a solution holding
//                            projects that cannot be restored on every machine (default: the solution itself)
//
// With owned globs it writes a solution filter (<state dir>/scope.slnf) holding the projects that own those
// globs plus their transitive ProjectReferences, so Roslyn loads a few projects instead of the whole solution.
//
// Also a CLI: node scope.mjs --owns <glob> [--owns <glob>...] --out <file.slnf> [--root <checkout>] [--solution <file>]
// prints {"ok":true,"projects":[...],"out":"..."}; exit 1 with {"ok":false,"error":"..."} otherwise.
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { generateSlnf } from './slnf.mjs';
import { isMain } from '../../../scripts/pipeline/lib/util.mjs';

export { generateSlnf };

export function findSolution(root) {
  for (const ext of ['.slnx', '.sln']) {
    const found = fs.readdirSync(root).filter((f) => f.toLowerCase().endsWith(ext));
    if (found.length === 1) return found[0];
    if (found.length > 1) return null; // ambiguous: options.solution must say which
  }
  return null;
}

export function scope({ worktree, owns = [], stateDir, options = {} }) {
  const solution = options.solution ?? findSolution(worktree);
  if (!solution) return { ok: false, error: `no solution file found in ${worktree}; set scope.options.solution` };
  const solutionFile = path.resolve(worktree, solution);
  if (!fs.existsSync(solutionFile)) return { ok: false, error: `${solution} not found in ${worktree}` };

  if (owns.length) {
    const out = path.join(stateDir, 'scope.slnf');
    const filter = generateSlnf({ root: worktree, owns, solution, out });
    if (!filter.ok) return { ok: false, error: filter.error };
    return { ok: true, env: { ROSLYN_SOLUTION: out, ROSLYN_RESTORE_SOLUTION: out }, description: `${filter.projects.length} project(s) of ${solution}`, projects: filter.projects };
  }
  const restore = options.restoreSolution && fs.existsSync(path.resolve(worktree, options.restoreSolution)) ? path.resolve(worktree, options.restoreSolution) : solutionFile;
  return { ok: true, env: { ROSLYN_SOLUTION: solutionFile, ROSLYN_RESTORE_SOLUTION: restore }, description: solution };
}

function parseArgs(argv) {
  const opts = { owns: [], root: process.cwd() };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--owns') opts.owns.push(argv[++i]);
    else if (a === '--out') opts.out = argv[++i];
    else if (a === '--root') opts.root = argv[++i];
    else if (a === '--solution') opts.solution = argv[++i];
    else throw new Error(`unknown argument ${a}`);
  }
  return opts;
}


if (isMain(import.meta.url)) {
  let result;
  try {
    const opts = parseArgs(process.argv.slice(2));
    result = generateSlnf({ ...opts, solution: opts.solution ?? findSolution(opts.root) });
  } catch (error) {
    result = { ok: false, projects: [], error: error.message };
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = result.ok ? 0 : 1;
}
