// `factory detect`: a deterministic first reading of a codebase, from its tracked files and the language
// packs (packs/<id>/pack.json). It finds the languages, the buildable units (a Cargo crate, a Maven module,
// a .csproj, a package.json, ...), which of them look like tests or a frontend, and the files a setup skill
// should read next (compose files, Dockerfiles, CI, docs). It never decides: `factory init` turns it into a
// draft .factory/config.json, and a person or a setup skill corrects the draft.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseRemote } from './hosting.mjs';

const globToRegExp = (glob) => new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]')}$`);
const matchesAny = (name, globs = []) => globs.some((g) => globToRegExp(g).test(name));
const slug = (text) => String(text).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'app';

export function loadPacks(installRoot) {
  const dir = path.join(installRoot, 'packs');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).sort().flatMap((id) => {
    const file = path.join(dir, id, 'pack.json');
    if (!fs.existsSync(file)) return [];
    const part = (name) => {
      const f = path.join(dir, id, name);
      return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null;
    };
    return [{ ...JSON.parse(fs.readFileSync(file, 'utf8')), dir: path.join(dir, id), lsp: part('lsp.json'), tests: part('tests.json'), commands: part('commands.json'), stack: part('stack.json') }];
  });
}

// Tracked and untracked-but-not-ignored files, so build output and dependencies never count.
export function repoFiles(root) {
  const r = spawnSync('git', ['ls-files', '-co', '--exclude-standard', '-z'], { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, timeout: 120_000 });
  if (r.status !== 0) throw new Error(`git ls-files failed in ${root}: ${r.stderr.trim()}`);
  return r.stdout.split('\0').filter(Boolean);
}

const read = (root, rel, max = 200_000) => {
  try {
    return fs.readFileSync(path.join(root, rel), 'utf8').slice(0, max);
  } catch {
    return '';
  }
};

const FACTORY_OWNED = /^(\.factory|graphify-out)\//;
const COMPOSE = /(^|\/)(docker-)?compose[\w.-]*\.ya?ml$/i;
const DOCKERFILE = /(^|\/)(Dockerfile[\w.-]*|[\w.-]+\.Dockerfile|Containerfile)$/;
const CI = /^(\.github\/workflows\/[^/]+\.ya?ml|\.gitlab-ci\.yml|azure-pipelines\.ya?ml|Jenkinsfile|\.circleci\/config\.yml|bitbucket-pipelines\.yml)$/;
const DOCS = /^(README|CONTRIBUTING|ARCHITECTURE|AGENTS|CLAUDE|GEMINI)(\.md|\.rst|\.txt)?$|^docs\/[^/]+\.md$|^\.editorconfig$/i;
const E2E = /(^|\/)(playwright|cypress)\.config\.[cm]?[jt]s$/;

// Where an e2e config keeps its specs (`testDir: './e2e'`, Cypress `specPattern`), relative to the root.
function e2eDirs(root, configs) {
  const dirs = [];
  for (const config of configs) {
    const text = read(root, config);
    const m = /testDir\s*:\s*['"`]([^'"`]+)['"`]/.exec(text) ?? /specPattern\s*:\s*['"`]([^'"`*{]+)/.exec(text);
    const base = path.dirname(config);
    const dir = m ? path.posix.normalize(path.posix.join(base, m[1])).replace(/\/+$/, '') : base;
    if (dir && dir !== '.' && !dirs.includes(dir)) dirs.push(dir);
  }
  return dirs;
}

export function detect(root, packs) {
  const files = repoFiles(root).filter((f) => !FACTORY_OWNED.test(f));
  const languages = [];
  const units = [];
  const contracts = [];
  for (const pack of packs) {
    const ignored = (f) => (pack.ignore ?? []).some((d) => f.split('/').includes(d));
    const sources = files.filter((f) => !ignored(f) && pack.extensions.includes(path.extname(f)));
    const unitFiles = files.filter((f) => !ignored(f) && matchesAny(path.basename(f), pack.unitFiles));
    const rootFiles = files.filter((f) => !f.includes('/') && matchesAny(f, pack.rootFiles));
    if (!sources.length && !unitFiles.length) continue;
    languages.push({ id: pack.id, name: pack.name, files: sources.length, units: unitFiles.length, rootFiles, topFiles: files.filter((f) => !f.includes('/')), manifests: unitFiles.slice(0, 200).map((f) => read(root, f)).join('\n') });
    const testDir = pack.testHints?.dir ? new RegExp(pack.testHints.dir, 'i') : null;
    const testContent = pack.testHints?.content ? new RegExp(pack.testHints.content, 'i') : null;
    const frontContent = pack.frontendHints?.content ? new RegExp(pack.frontendHints.content, 'i') : null;
    const hostContent = pack.hostHints?.content ? new RegExp(pack.hostHints.content) : null;
    // A unit that builds no executable (a class library) is a library: shared, or part of the one service using it.
    const exeContent = pack.executableHints?.content ? new RegExp(pack.executableHints.content) : null;
    for (const unitFile of unitFiles) {
      const dir = path.dirname(unitFile) === '.' ? '' : path.dirname(unitFile);
      const text = read(root, unitFile);
      const own = files.filter((f) => (dir ? f.startsWith(`${dir}/`) : true));
      const isTest = Boolean((testDir && dir && testDir.test(dir)) || (testContent && testContent.test(text)));
      const isFrontend = !isTest && Boolean((frontContent && frontContent.test(text)) || own.some((f) => matchesAny(path.basename(f), pack.frontendHints?.files)));
      // A workspace root (a Cargo workspace, a Maven parent, a package.json with workspaces) is not a unit of its own.
      const isWorkspace = /\[workspace\]|<modules>|"workspaces"\s*:/.test(text) && unitFiles.some((u) => u !== unitFile && (dir ? u.startsWith(`${dir}/`) : true));
      const isHost = !isTest && Boolean(hostContent && hostContent.test(text));
      const isLibrary = !isTest && !isHost && Boolean(exeContent) && !exeContent.test(text);
      units.push({ path: dir || '.', file: unitFile, pack: pack.id, kind: isWorkspace ? 'workspace' : isTest ? 'test' : isHost ? 'host' : isLibrary ? 'library' : isFrontend ? 'frontend' : 'backend', ...(isFrontend ? { ui: true } : {}) });
    }
    // Source folders no unit owns (sources linked into several projects, e.g. a src/Shared folder): shared code.
    const unitDirs = units.filter((u) => u.path !== '.' && !u.linked).map((u) => u.path);
    const orphans = new Set();
    for (const f of sources) {
      const parts = f.split('/');
      if (parts.length < 3 || unitDirs.some((d) => f.startsWith(`${d}/`)) || (testDir && testDir.test(f))) continue;
      orphans.add(parts.slice(0, 2).join('/'));
    }
    // Only for a language that has units of its own below the root (not a root package.json's loose scripts).
    if (!units.some((u) => u.pack === pack.id && u.path !== '.')) orphans.clear();
    for (const dir of [...orphans].sort()) units.push({ path: dir, file: null, pack: pack.id, kind: 'library', shared: true, linked: true });
    // Folders that declare contracts other services depend on (integration events).
    if (pack.contractHints?.content) {
      const re = new RegExp(pack.contractHints.content);
      const dirs = new Set(sources.slice(0, 20000).filter((f) => re.test(read(root, f))).map((f) => path.dirname(f)));
      if (dirs.size) contracts.push({ name: pack.contractHints.name ?? 'Contracts', paths: [...dirs].sort().map((d) => `${d}/**`) });
    }
  }
  languages.sort((a, b) => b.files - a.files);
  const origin = spawnSync('git', ['remote', 'get-url', 'origin'], { cwd: root, encoding: 'utf8', timeout: 60_000 });
  const remote = origin.status === 0 ? origin.stdout.trim() : null;
  const gh = remote && /github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?$/.exec(remote);
  // The code host of the origin remote ({ type, url, repo }): a self-hosted server is recognised by the
  // `host` section of an existing .factory/config.json, or guessed from its name or path.
  let configuredHost;
  try {
    configuredHost = JSON.parse(read(root, '.factory/config.json') || '{}').host ?? {};
  } catch {
    configuredHost = {};
  }
  return {
    root,
    name: slug(path.basename(root)),
    remote,
    github: gh ? { owner: gh[1], repo: `${gh[1]}/${gh[2]}` } : null,
    host: parseRemote(remote, configuredHost),
    languages,
    units,
    compose: files.filter((f) => COMPOSE.test(f)),
    dockerfiles: files.filter((f) => DOCKERFILE.test(f)),
    ci: files.filter((f) => CI.test(f)),
    docs: files.filter((f) => DOCS.test(f)),
    contracts,
    stack: fs.existsSync(path.join(root, '.factory/stack/docker-compose.yaml')),
    e2e: files.filter((f) => E2E.test(f)),
    e2eDirs: e2eDirs(root, files.filter((f) => E2E.test(f))),
    ciText: files.filter((f) => CI.test(f)).map((f) => read(root, f)).join('\n'),
    fileCount: files.length,
  };
}

// The nearest test unit for a service: same name with a test suffix, or a test unit that names it.
// Unit tests are preferred over functional or integration tests when a service has both.
function unitTestsFor(unit, tests) {
  const base = path.basename(unit.path).toLowerCase().replace(/[._-](api|service|svc)$/, '');
  const hits = tests.filter((t) => t.path !== '.' && path.basename(t.path).toLowerCase().includes(base));
  const hit = hits.find((t) => /unit/i.test(path.basename(t.path))) ?? hits[0];
  return hit ? hit.path : null;
}

// A test unit at the repository root (a package.json that only holds an e2e harness) does not make the
// whole repository a test folder: its tests are where its e2e config points, or it is left out.
const testRootsOf = (found, tests) => [...new Set(tests.flatMap((t) => (t.path === '.' ? found.e2eDirs ?? [] : [t.path])))];

// A draft project model. Unit names must be unique; a clash keeps the path as the name.
export function draftProject(found, packs) {
  const tests = found.units.filter((u) => u.kind === 'test');
  const seen = new Set();
  const services = found.units
    .filter((u) => ['backend', 'frontend', 'host', 'library'].includes(u.kind))
    .map((u) => {
      let name = slug(u.path === '.' ? found.name : path.basename(u.path));
      if (seen.has(name)) name = slug(u.path);
      seen.add(name);
      const unitTests = unitTestsFor(u, tests);
      return { name, kind: u.kind, paths: [u.path === '.' ? '**' : `${u.path}/**`], ...(unitTests ? { unitTests } : {}), ...(u.shared ? { shared: true } : {}), ...(u.ui && u.kind !== 'frontend' ? { ui: true } : {}) };
    });
  // dependsOn from the unit files' references to other units (packs' referenceHints, e.g. ProjectReference).
  const nameOf = new Map();
  for (const u of found.units) {
    const svc = services.find((s) => s.paths[0] === (u.path === '.' ? '**' : `${u.path}/**`));
    if (svc) nameOf.set(u.path, svc.name);
  }
  for (const u of found.units) {
    const pack = packs.find((p) => p.id === u.pack);
    const svc = nameOf.get(u.path) && services.find((s) => s.name === nameOf.get(u.path));
    if (!svc || !u.file || !pack?.referenceHints?.pattern || !found.root) continue;
    const re = new RegExp(pack.referenceHints.pattern, 'g');
    const deps = new Set();
    for (const m of read(found.root, u.file).matchAll(re)) {
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(u.file), m.groups.ref.replace(/\\/g, '/')));
      const dep = nameOf.get(path.posix.dirname(target));
      if (dep && dep !== svc.name) deps.add(dep);
    }
    if (deps.size) svc.dependsOn = [...deps];
  }
  const used = packs.filter((p) => found.languages.some((l) => l.id === p.id));
  return {
    name: found.name,
    languages: found.languages.map((l) => l.id),
    toolPaths: [...new Set(used.flatMap((p) => p.toolPaths ?? []))],
    services,
    frontendPaths: services.filter((s) => s.kind === 'frontend' || s.ui).flatMap((s) => s.paths),
    testRoots: testRootsOf(found, tests),
  };
}
