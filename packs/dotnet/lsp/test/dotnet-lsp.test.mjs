// The dotnet pack's LSP helpers: solution filter generator, scope module and restore check.
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { TOOL_MANIFESTS, unrestoredProjects } from '../prepare.mjs';
import { findSolution, scope } from '../scope.mjs';
import { generateSlnf, globToRegExp, projectMatches } from '../slnf.mjs';

const PACK_LSP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = (prefix) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));

describe('solution filter', () => {
  let root;
  before(() => {
    root = tmp('lspd-slnf-');
    const proj = (dir, refs = []) => {
      fs.mkdirSync(path.join(root, dir), { recursive: true });
      const items = refs.map((r) => `    <ProjectReference Include="${r}" />`).join('\n');
      fs.writeFileSync(path.join(root, dir, `${path.basename(dir)}.csproj`), `<Project Sdk="Microsoft.NET.Sdk">\n  <ItemGroup>\n${items}\n  </ItemGroup>\n</Project>\n`);
    };
    proj('src/Api', ['..\\Domain\\Domain.csproj', '..\\Infra\\Infra.csproj']);
    proj('src/Infra', ['..\\Domain\\Domain.csproj']);
    proj('src/Domain');
    proj('src/Web', ['../Shared/Shared.csproj']);
    proj('src/Shared');
    proj('tests/Api.Tests', ['..\\..\\src\\Api\\Api.csproj']);
    const projects = ['src/Api/Api.csproj', 'src/Infra/Infra.csproj', 'src/Domain/Domain.csproj', 'src/Web/Web.csproj', 'src/Shared/Shared.csproj', 'tests/Api.Tests/Api.Tests.csproj'];
    fs.writeFileSync(path.join(root, 'eShop.slnx'), `<Solution>\n${projects.map((p) => `  <Project Path="${p}" />`).join('\n')}\n</Solution>\n`);
  });
  after(() => fs.rmSync(root, { recursive: true }));

  test('globs match directories and files inside them', () => {
    assert.ok(globToRegExp('src/Api/**').test('src/Api'));
    assert.ok(globToRegExp('src/**').test('src/Api'));
    assert.ok(globToRegExp('**/Api').test('src/Api'));
    assert.ok(!globToRegExp('src/A*').test('src/Api/x'));
    assert.ok(projectMatches('src/Api', 'src/Api/Controllers/*.cs'));
    assert.ok(projectMatches('src/Api', 'src/Api'));
    assert.ok(!projectMatches('src/Api', 'src/Web/**'));
    assert.ok(!projectMatches('src/Api', 'src/ApiX/**'));
  });

  test('includes the transitive ProjectReference closure', () => {
    const r = generateSlnf({ root, solution: 'eShop.slnx', owns: ['src/Api/**'] });
    assert.deepEqual(r.projects, ['src/Api/Api.csproj', 'src/Domain/Domain.csproj', 'src/Infra/Infra.csproj']);
    const both = generateSlnf({ root, solution: 'eShop.slnx', owns: ['src/Web/Pages/*.razor', 'tests/Api.Tests/**'] });
    assert.deepEqual(both.projects, ['src/Api/Api.csproj', 'src/Domain/Domain.csproj', 'src/Infra/Infra.csproj', 'src/Shared/Shared.csproj', 'src/Web/Web.csproj', 'tests/Api.Tests/Api.Tests.csproj']);
  });

  test('writes a filter whose paths resolve against the solution', () => {
    const out = path.join(root, 'filters', 'api.slnf');
    const r = generateSlnf({ root, solution: 'eShop.slnx', owns: ['src/Infra'], out });
    assert.ok(r.ok);
    const slnf = JSON.parse(fs.readFileSync(out, 'utf8'));
    assert.equal(slnf.solution.path, '../eShop.slnx');
    assert.deepEqual(slnf.solution.projects, ['src\\Domain\\Domain.csproj', 'src\\Infra\\Infra.csproj']);
    for (const p of slnf.solution.projects) assert.ok(fs.existsSync(path.join(root, p.replace(/\\/g, '/'))));
  });

  test('fails clearly when nothing matches', () => {
    const r = generateSlnf({ root, solution: 'eShop.slnx', owns: ['src/Nope/**'] });
    assert.equal(r.ok, false);
    assert.match(r.error, /no project/);
  });

  test('CLI prints JSON', () => {
    const r = spawnSync(process.execPath, [path.join(PACK_LSP, 'scope.mjs'), '--root', root, '--owns', 'src/Web/**'], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout).projects, ['src/Shared/Shared.csproj', 'src/Web/Web.csproj']);
  });

  test('scope module: whole solution without globs, a filter in the state dir with globs', () => {
    const stateDir = path.join(root, '.state');
    fs.mkdirSync(stateDir, { recursive: true });
    assert.equal(findSolution(root), 'eShop.slnx');
    const whole = scope({ worktree: root, owns: [], stateDir, options: {} });
    assert.deepEqual(whole.env, { ROSLYN_SOLUTION: path.join(root, 'eShop.slnx'), ROSLYN_RESTORE_SOLUTION: path.join(root, 'eShop.slnx') });
    fs.writeFileSync(path.join(root, 'Web.slnf'), '{}');
    const restore = scope({ worktree: root, owns: [], stateDir, options: { solution: 'eShop.slnx', restoreSolution: 'Web.slnf' } });
    assert.equal(restore.env.ROSLYN_SOLUTION, path.join(root, 'eShop.slnx'));
    assert.equal(restore.env.ROSLYN_RESTORE_SOLUTION, path.join(root, 'Web.slnf'));
    const narrowed = scope({ worktree: root, owns: ['src/Infra/**'], stateDir, options: { restoreSolution: 'Web.slnf' } });
    assert.ok(narrowed.ok);
    assert.equal(narrowed.env.ROSLYN_SOLUTION, path.join(stateDir, 'scope.slnf'));
    assert.equal(narrowed.env.ROSLYN_RESTORE_SOLUTION, path.join(stateDir, 'scope.slnf'), 'a filter is restored itself');
    assert.deepEqual(narrowed.projects, ['src/Domain/Domain.csproj', 'src/Infra/Infra.csproj']);
    assert.equal(scope({ worktree: root, owns: ['src/Nope/**'], stateDir, options: {} }).ok, false);
    assert.match(scope({ worktree: root, owns: [], stateDir, options: { solution: 'Missing.sln' } }).error, /Missing\.sln not found/);
  });

  test('prepare: finds the local tool manifest where .NET 10 writes it (the root) and in .config/', () => {
    assert.deepEqual([...TOOL_MANIFESTS].sort(), ['.config/dotnet-tools.json', 'dotnet-tools.json']);
  });

  test('prepare: lists the projects with no restore output, for a solution and for a filter', () => {
    const sln = path.join(root, 'eShop.slnx');
    assert.equal(unrestoredProjects(sln, root).length, 6);
    fs.mkdirSync(path.join(root, 'src/Api/obj'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src/Api/obj/project.assets.json'), '{}');
    fs.mkdirSync(path.join(root, 'artifacts/obj/Domain'), { recursive: true });
    fs.writeFileSync(path.join(root, 'artifacts/obj/Domain/project.assets.json'), '{}');
    assert.equal(unrestoredProjects(sln, root).length, 4);
    const out = path.join(root, 'filters', 'restore.slnf');
    generateSlnf({ root, solution: 'eShop.slnx', owns: ['src/Api/**'], out });
    assert.deepEqual(unrestoredProjects(out, root), [path.join(root, 'src/Infra/Infra.csproj')]);
  });
});
