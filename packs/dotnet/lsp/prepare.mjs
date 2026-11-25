#!/usr/bin/env node
// `prepare` command of the dotnet pack's `csharp` server: runs in the checkout before Roslyn starts.
//  1. `dotnet tool restore`: the Roslyn language server is a .NET local tool pinned in the app repo's
//     dotnet-tools.json (.config/ or the root: `dotnet new tool-manifest` writes the root one since .NET 10). A no-op once the package is in the NuGet cache, which every checkout shares.
//  2. `dotnet restore <target>` when a project of the target has no NuGet restore output yet: Roslyn reports
//     bogus "type not found" errors for unrestored projects. The target is $ROSLYN_RESTORE_SOLUTION (set by
//     scope.mjs), else $ROSLYN_SOLUTION, else the only solution in the working directory.
// Output goes to <state dir>/prepare-csharp.log. Exit code 0 when both steps worked or had nothing to do.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { findSolution } from './scope.mjs';
import { solutionProjects } from './slnf.mjs';
import { isMain } from '../../../scripts/pipeline/lib/util.mjs';

// Where `dotnet tool restore` finds a local tool manifest (the root one is what .NET 10's `dotnet new tool-manifest` writes).
export const TOOL_MANIFESTS = ['.config/dotnet-tools.json', 'dotnet-tools.json'];

const worktree = process.cwd();
const env = { ...process.env, DOTNET_CLI_TELEMETRY_OPTOUT: '1', DOTNET_NOLOGO: '1' };
const dotnet = (args) => spawnSync('dotnet', args, { cwd: worktree, stdio: 'inherit', env, windowsHide: true }).status ?? 127;

// Projects of the restore target with no restore output: obj/project.assets.json beside the project, or
// artifacts/obj/<name>/ at the root for the artifacts layout (UseArtifactsOutput=true).
export function unrestoredProjects(target, root) {
  try {
    let projects;
    if (target.endsWith('.slnf')) {
      const filter = JSON.parse(fs.readFileSync(target, 'utf8')).solution;
      const slnDir = path.dirname(path.resolve(path.dirname(target), filter.path));
      projects = filter.projects.map((p) => path.resolve(slnDir, p.replace(/\\/g, '/')));
    } else if (/\.(sln|slnx)$/i.test(target)) {
      projects = solutionProjects(target).map((p) => path.resolve(path.dirname(target), p));
    } else projects = [target];
    return projects.filter((p) => {
      const name = path.basename(p, path.extname(p));
      return !fs.existsSync(path.join(root, 'artifacts/obj', name, 'project.assets.json')) && !fs.existsSync(path.join(path.dirname(p), 'obj/project.assets.json'));
    });
  } catch {
    return [];
  }
}

function main() {
  let failed = 0;
  if (TOOL_MANIFESTS.some((m) => fs.existsSync(path.join(worktree, m))) && dotnet(['tool', 'restore']) !== 0) {
    console.error('prepare: dotnet tool restore failed');
    failed = 1;
  }
  const found = findSolution(worktree);
  const target = process.env.ROSLYN_RESTORE_SOLUTION || process.env.ROSLYN_SOLUTION || (found && path.join(worktree, found));
  if (!target) return failed;
  const missing = unrestoredProjects(target, worktree);
  if (!missing.length) return failed;
  console.error(`prepare: restoring NuGet packages for ${missing.length} project(s) of ${path.basename(target)}`);
  return dotnet(['restore', target]) === 0 ? failed : 1;
}


if (isMain(import.meta.url)) process.exit(main());
