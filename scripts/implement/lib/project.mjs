// What the stages read from the project model (`config.project`, from the app repository's
// .factory/config.json) and from the language packs (packs/<id>/). Nothing in here knows a language, a
// framework or a folder layout: services, frontend paths and test runners are all configuration.
import fs from 'node:fs';
import path from 'node:path';
import { INSTALL_ROOT } from '../../pipeline/lib/config.mjs';
import { matchGlob } from './plan.mjs';

const toPosix = (p) => String(p).replace(/\\/g, '/').replace(/^\.\//, '');
const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// One path pattern against a repository-relative file. A pattern is a glob (`src/web/**`, `**/*.vue`),
// a directory (`src/web/` or `src/web`: everything under it), an extension or suffix (`.vue`,
// `.module.css`) or an exact file.
export function pathMatches(file, pattern) {
  const f = toPosix(file);
  const p = toPosix(pattern ?? '');
  if (!p) return false;
  if (/[*?]/.test(p)) return matchGlob(f, p);
  if (p.startsWith('.') && !p.slice(1).includes('/')) return f.endsWith(p) || f === p || f.startsWith(`${p}/`);
  const dir = p.replace(/\/+$/, '');
  return f === dir || f.startsWith(`${dir}/`);
}

export const matchesAnyPath = (file, patterns) => (patterns ?? []).some((p) => pathMatches(file, p));

export const servicesOf = (project) => (project?.services ?? []).filter((s) => s && s.name);
export const frontendServices = (project) => servicesOf(project).filter((s) => s.kind === 'frontend');

// Every pattern that marks a file as frontend: `project.frontendPaths` plus the paths of the services
// with `kind: "frontend"`.
export const frontendPatterns = (project) => [...(project?.frontendPaths ?? []), ...frontendServices(project).flatMap((s) => s.paths ?? [])];

export const isFrontendFile = (file, project) => matchesAnyPath(file, frontendPatterns(project));

// The services a file belongs to (a file can belong to several when their paths overlap).
export const servicesOfFile = (file, project) => servicesOf(project).filter((s) => matchesAnyPath(file, s.paths ?? []));

// Top-level folders the project model names (`src`, `crates`, `services`, ...), from the service paths,
// the frontend paths and `extra`. Used to recognise a path in free text.
export function knownRoots(project, extra = []) {
  const roots = new Set();
  for (const pattern of [...servicesOf(project).flatMap((s) => s.paths ?? []), ...(project?.frontendPaths ?? []), ...extra]) {
    const first = toPosix(pattern).split('/')[0];
    if (first && !/[*?]/.test(first) && toPosix(pattern).includes('/')) roots.add(first);
  }
  return [...roots].sort();
}

// A regular expression that finds repository paths in free text (an agent's "blocked" reason): anything
// under a known top-level folder, any other `dir/file.ext`, and bare file names with an extension from
// `pathHints.extensions`. Capture group 1 is the path.
export function pathLikeRegex(project, { roots = [], extensions = [] } = {}) {
  const tops = knownRoots(project, roots.map((r) => `${r}/`));
  const exts = [...new Set(extensions.map((e) => String(e).replace(/^\./, '')).filter(Boolean))];
  const parts = [];
  if (tops.length) parts.push(`(?:${tops.map(escapeRe).join('|')})/[\\w./-]+`);
  parts.push('[\\w.-]+(?:/[\\w.-]+)+\\.\\w+');
  if (exts.length) parts.push(`[\\w.-]+\\.(?:${exts.map(escapeRe).join('|')})`);
  return new RegExp(`(?:^|[\\s\`'"(])(${parts.join('|')})`, 'g');
}

// ---------------------------------------------------------------------------------------------
// Language packs
// ---------------------------------------------------------------------------------------------

export const packsDir = (installRoot = INSTALL_ROOT) => path.join(installRoot, 'packs');

// One file of a pack (packs/<id>/<file>), parsed, or null when the pack or the file does not exist.
export function readPack(id, file, installRoot = INSTALL_ROOT) {
  if (!/^[\w.-]+$/.test(String(id ?? ''))) return null;
  const full = path.join(packsDir(installRoot), id, file);
  if (!fs.existsSync(full)) return null;
  try {
    return JSON.parse(fs.readFileSync(full, 'utf8'));
  } catch (error) {
    throw new Error(`packs/${id}/${file} is not valid JSON: ${error.message}`, { cause: error });
  }
}

// The test runners a pack defines (packs/<id>/tests.json → runners), each stamped with its pack.
export const packRunners = (id, installRoot = INSTALL_ROOT) => (readPack(id, 'tests.json', installRoot)?.runners ?? []).map((r) => ({ ...r, pack: id }));

// The default commands of a pack (packs/<id>/commands.json), for the config generator.
export const packCommands = (id, installRoot = INSTALL_ROOT) => readPack(id, 'commands.json', installRoot);
