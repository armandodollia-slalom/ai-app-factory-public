// `factory doctor` rows of the dotnet pack: what agents of a .NET repository need on this machine beyond the
// SDK. Each row: [what, ok, note]. Called by scripts/factory/factory.mjs for repositories using the pack.
//
// EF Core: a repository with migrations needs dotnet-ef at the EF Core version it builds with; a global
// dotnet-ef of another major version writes migrations the code cannot use. The fix is a local tool pinned in
// the repository's tool manifest (dotnet tool restore, which the implement prepareCmd runs, then installs it in
// every worktree).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const MANIFESTS = ['.config/dotnet-tools.json', 'dotnet-tools.json'];

function walkHasMigrations(dir, depth = 0) {
  if (depth > 5 || !fs.existsSync(dir)) return false;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!e.isDirectory() || ['bin', 'obj', 'node_modules', '.git', '.factory'].includes(e.name) || e.name.startsWith('.')) continue;
    if (e.name === 'Migrations' && fs.readdirSync(path.join(dir, e.name)).some((f) => /ModelSnapshot\.cs$/.test(f))) return true;
    if (walkHasMigrations(path.join(dir, e.name), depth + 1)) return true;
  }
  return false;
}

// The EF Core version the repository builds with: central package management first, then any project file.
export function efCoreVersion(root) {
  const re = /Include="Microsoft\.EntityFrameworkCore(?:\.(?:Design|Tools|Relational|SqlServer|Sqlite))?"\s+Version="([\d.]+[^"]*)"/;
  const props = path.join(root, 'Directory.Packages.props');
  if (fs.existsSync(props)) {
    const m = re.exec(fs.readFileSync(props, 'utf8'));
    if (m) return m[1];
  }
  return null;
}

export function localDotnetEf(root) {
  for (const m of MANIFESTS) {
    const f = path.join(root, m);
    if (!fs.existsSync(f)) continue;
    const tool = JSON.parse(fs.readFileSync(f, 'utf8')).tools?.['dotnet-ef'];
    if (tool) return { manifest: m, version: tool.version };
  }
  return null;
}

const minor = (v) => String(v ?? '').split('.').slice(0, 2).join('.');

export function checks(root) {
  if (!walkHasMigrations(root)) return [];
  const ef = efCoreVersion(root);
  const local = localDotnetEf(root);
  const install = `dotnet tool install --local dotnet-ef --version ${ef ?? '<the EF Core version>'}`;
  if (!local) return [[`dotnet-ef for EF Core migrations${ef ? ` (EF Core ${ef})` : ''}`, false, `the repository has migrations but no local dotnet-ef: ${install}, then commit the tool manifest`]];
  if (ef && minor(local.version) !== minor(ef)) return [['dotnet-ef matches EF Core', false, `${local.manifest} pins dotnet-ef ${local.version}, the code uses EF Core ${ef}: ${install}`]];
  const run = spawnSync('dotnet', ['ef', '--version'], { cwd: root, encoding: 'utf8' });
  const reported = /(\d+\.\d+\.\d+)/.exec(run.stdout ?? '')?.[1];
  const ok = run.status === 0 && minor(reported) === minor(local.version);
  return [[`dotnet ef runs the pinned version (EF Core ${ef ?? '?'})`, ok, ok ? `dotnet-ef ${reported} from ${local.manifest}` : `\`dotnet ef --version\` gave ${reported ?? `exit ${run.status}`}: run \`dotnet tool restore\``]];
}
