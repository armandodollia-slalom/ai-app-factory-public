// Systems touched by a fix PR: every changed file mapped to the system it belongs to (globs as in a
// subtask's `owns`). The systems are `implement.reviewGate.systems` when that is set; otherwise they
// come from the project model, one system per `project.services` entry:
// - a `library` that exactly one other service depends on (`dependsOn`, also through other libraries:
//   a service's own domain and infrastructure projects) is part of that service's system, not shared;
//   a library several services use, or whose users are unknown, is shared; `partOf: <service>` says it
//   explicitly; `shared: true` / `contract: true` on any service override;
// - a `host` (an orchestrator such as an Aspire AppHost) is shared;
// - `reviewGate.sharedPaths` ({ name: [globs] }: build files, linked shared sources) and
//   `reviewGate.contractPaths` (integration-event and API contracts) add shared and contract systems.
// Files matching `ignore`, plus the project's test roots, touch no system; any other file is "Other".
import { matchGlob, matchesAny } from '../../implement/lib/plan.mjs';

export const OTHER = 'Other';

// The systems of a project model, in the order the services are listed, then the extra shared and
// contract systems.
export function systemsFromProject(project, { sharedPaths = {}, contractPaths = {} } = {}) {
  const services = (project?.services ?? []).filter((s) => s?.name && s.paths?.length);
  const byName = new Map(services.map((s) => [s.name, s]));
  const isLib = (s) => s.kind === 'library';
  // The non-library services that use a library, directly or through other libraries.
  const ownersOf = (lib, seen = new Set([lib.name])) => {
    const owners = new Set();
    for (const t of services) {
      if (!(t.dependsOn ?? []).includes(lib.name) || seen.has(t.name)) continue;
      seen.add(t.name);
      if (isLib(t) && t.shared == null && !t.partOf) for (const o of ownersOf(t, seen)) owners.add(o);
      else owners.add(t.partOf ?? t.name);
    }
    return owners;
  };
  const partOf = new Map();
  for (const s of services) {
    if (s.partOf && byName.has(s.partOf)) partOf.set(s.name, s.partOf);
    else if (isLib(s) && s.shared == null && !s.contract) {
      const owners = ownersOf(s);
      if (owners.size === 1) partOf.set(s.name, [...owners][0]);
    }
  }
  const root = (name) => (partOf.has(name) ? root(partOf.get(name)) : name);
  const systems = [];
  for (const s of services) {
    if (partOf.has(s.name)) continue;
    const shared = s.shared ?? (isLib(s) || s.kind === 'host');
    const paths = [...s.paths, ...services.filter((x) => partOf.has(x.name) && root(x.name) === s.name).flatMap((x) => x.paths)];
    systems.push({ name: s.name, paths, ...(shared ? { shared: true } : {}), ...(s.contract ? { contract: true } : {}) });
  }
  for (const [name, paths] of Object.entries(sharedPaths ?? {})) if (paths?.length) systems.push({ name, paths, shared: true });
  for (const [name, paths] of Object.entries(contractPaths ?? {})) if (paths?.length) systems.push({ name, paths, shared: true, contract: true });
  return systems;
}

// The systems to map files to: the explicit list, else the project model's (`project` is `config.project`;
// `settings.project` is used when a caller put it there).
export function systemsFor(settings, project = settings?.project ?? null) {
  return Array.isArray(settings?.systems) && settings.systems.length ? settings.systems : systemsFromProject(project, settings ?? {});
}

// Test roots touch no system: a test-only change is not a change to a service.
export const testRootIgnores = (config) => [...new Set(config.project?.testRoots ?? [])].filter((r) => r && r !== '.').map((r) => `${String(r).replace(/\/+$/, '')}/**`);

// `config.implement.reviewGate` with its systems resolved against `config.project` and the test roots ignored.
export function gateSystemsSettings(config) {
  const gate = config.implement?.reviewGate ?? {};
  return { ...gate, ignore: [...new Set([...(gate.ignore ?? []), ...testRootIgnores(config)])], systems: systemsFor(gate, config.project) };
}

// Every system the file belongs to. A file can belong to several: an event contract inside a service's
// folder is both that service and the contract.
export function systemsOf(file, settings, project = undefined) {
  if (matchesAny(file, settings.ignore ?? [])) return [];
  const hits = systemsFor(settings, project).filter((s) => matchesAny(file, s.paths ?? []));
  return hits.length ? hits : [{ name: OTHER, paths: [], shared: false }];
}

// { systems: [{ name, shared, contract, files }], shared: bool, contract: bool, names: [...] } for the
// changed files, systems in configuration order.
export function systemsTouched(files, settings, project = undefined) {
  const byName = new Map();
  for (const file of files ?? []) {
    for (const s of systemsOf(file, settings, project)) {
      if (!byName.has(s.name)) byName.set(s.name, { name: s.name, shared: Boolean(s.shared), contract: Boolean(s.contract), files: [] });
      byName.get(s.name).files.push(file);
    }
  }
  const order = [...systemsFor(settings, project).map((s) => s.name), OTHER];
  const systems = [...byName.values()].sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name));
  return {
    systems,
    names: systems.map((s) => s.name),
    shared: systems.some((s) => s.shared),
    contract: systems.some((s) => s.contract),
  };
}

// How agents are governed: always a floor path, whatever the repository's own `floor.paths` say, so a
// change to the factory's settings, policy, agents, hooks or CI never merges on Low ratings.
export const GOVERNANCE_FLOOR_PATHS = [
  '.factory/config.json', '.factory/factory.json', '.factory/app.json', '.factory/manifest.json',
  '.factory/policy/**', '.factory/agents/**', '.factory/lessons/**', '.factory/githooks/**', '.factory/bin/**',
  '.factory/stack/docker-compose.yaml',
  '.github/workflows/**', '.github/actions/**', '.github/CODEOWNERS', 'CODEOWNERS', 'docs/CODEOWNERS',
  // The same on GitLab CI and Azure Pipelines (and the toolchain script their jobs run with secrets).
  '.gitlab-ci.yml', '.gitlab/ci/**', '.gitlab/CODEOWNERS', '.azure-pipelines/**', '.factory/ci/**',
  '.claude/settings.json', '.claude/agents/**', '.github/agents/**', '.codex/**', '.gemini/settings.json', '.mcp.json',
];

// The override paths (governance, then the configured `floor.paths`) the files hit, with the files that hit each.
export function overridePathsHit(files, settings) {
  return [...new Set([...GOVERNANCE_FLOOR_PATHS, ...(settings.floor?.paths ?? [])])]
    .map((glob) => ({ path: glob, files: (files ?? []).filter((f) => matchGlob(f, glob)) }))
    .filter((h) => h.files.length);
}

// ---------------------------------------------------------------------------------------------
// CODEOWNERS: the fallback reviewers of the systems touched
// ---------------------------------------------------------------------------------------------

// Parses a CODEOWNERS file into rules [{ pattern, owners }] in file order (the last match wins).
export function parseCodeowners(text) {
  const rules = [];
  for (const raw of String(text ?? '').split('\n')) {
    const line = raw.replace(/(^|\s)#.*$/, '').trim();
    if (!line) continue;
    const [pattern, ...owners] = line.split(/\s+/);
    rules.push({ pattern, owners: owners.filter((o) => o.startsWith('@')).map((o) => o.slice(1)) });
  }
  return rules;
}

// CODEOWNERS pattern semantics, close enough for owner lookup: `*` alone is everything; a pattern with
// no slash (or only a trailing one) matches at any depth; a leading slash anchors at the root; a
// trailing slash or a directory matches its whole subtree.
export function codeownersMatch(file, pattern) {
  if (pattern === '*' || pattern === '/*' || pattern === '**') return true;
  let p = pattern;
  const anchored = p.startsWith('/') || p.replace(/\/$/, '').includes('/');
  p = p.replace(/^\//, '');
  const dir = p.endsWith('/');
  p = p.replace(/\/$/, '');
  const globs = anchored ? [p, `${p}/**`] : [`**/${p}`, `**/${p}/**`, p, `${p}/**`];
  return globs.some((g) => (dir && !g.endsWith('/**') ? false : matchGlob(file, g)));
}

// The owners of a file: the owners of the last rule that matches it.
export function ownersOf(file, rules) {
  let owners = [];
  for (const r of rules) if (codeownersMatch(file, r.pattern)) owners = r.owners;
  return owners;
}

// Owners of a set of files (team handles like org/team are kept as they are).
export const ownersOfFiles = (files, rules) => [...new Set((files ?? []).flatMap((f) => ownersOf(f, rules)))];
