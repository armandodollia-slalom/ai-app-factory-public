// The `policy` section of .factory/app.json: NEW services an agent may declare for the architecture policy (an id,
// the root folders of its projects, the datastores it owns). A project's class is never declared: the engine derives
// it from the project itself by the profile's conventions (architecture-policy/hooks/architecture/classify.py).
//
// The same rules as the engine's topology.py, so the factory guard refuses a declaration when it is written, the
// post-run check reverts it, and the review stage and CI block it. Both implementations are tested against one
// table, architecture-policy/tests/topology_cases.json. Names are plain ASCII compared lower-cased, paths normalised:
// - an id that exists under any casing, or is declared twice, is refused;
// - a root must hold a project manifest, and may not overlap a profiled project or another declared root;
// - a datastore owned or shared under any casing, or declared twice, is refused;
// - a root that is, or is inside, a symbolic link is refused;
// - any other key is refused.
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

// yaml is loaded only when a profile is read: the config loader imports this module, and must load without it.
const parse = (text) => createRequire(import.meta.url)('yaml').parse(text);

const SERVICE_KEYS = new Set(['id', 'roots', 'owns_datastores']);
// Names are plain ASCII, compared lower-cased: the same rule in topology.py (no Unicode case folding, and no
// whitespace or invisible characters to tell two names apart).
const ID_RE = /^[A-Za-z][A-Za-z0-9-]*$/;
const STORE_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
export const norm = (p) => path.posix.normalize(String(p ?? '').replace(/\\/g, '/')).replace(/^\/+|\/+$/g, '').replace(/^\.$/, '');
const inside = (child, parent) => child === parent || child.startsWith(`${parent}/`);
// ASCII lower-casing only: names are ASCII, and toLowerCase on anything else would differ from Python's lower().
const lower = (s) => String(s ?? '').replace(/[A-Z]/g, (c) => c.toLowerCase());

/** The repository's policy profile document, or null (no policy, or unreadable). */
export function readProfile(root, policyDir = '.factory/policy') {
  try {
    const dir = path.join(root, policyDir);
    const manifest = parse(fs.readFileSync(path.join(dir, 'policy.yaml'), 'utf8')) ?? {};
    const file = manifest.profile_file ?? (manifest.default_profile ? `profiles/${manifest.default_profile}/profile.yaml` : 'profile.yaml');
    return parse(fs.readFileSync(path.join(dir, file), 'utf8'));
  } catch {
    return null;
  }
}

const globRe = (glob) => new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\0').replace(/\*/g, '[^/]*').replace(/\0/g, '.*').replace(/\?/g, '[^/]')}$`, 'i'); // manifests match without case, as in the engine (globs.match_manifest)

/** The folders among `candidates` (repository-relative) that hold a project manifest of the profile, on disk. */
export function manifestDirs(root, profile, candidates) {
  const globs = (profile?.project_manifests ?? ['**/*.csproj', '**/package.json', '**/Cargo.toml', '**/pom.xml', '**/go.mod', '**/pyproject.toml']).map(globRe);
  const out = new Set();
  for (const dir of candidates.map(norm)) {
    try {
      for (const f of fs.readdirSync(path.join(root, dir))) if (globs.some((g) => g.test(`${dir}/${f}`))) out.add(dir);
    } catch {
      /* not a folder */
    }
  }
  return out;
}

// Whether `rel` or a folder above it (inside the repository) is a symbolic link.
export function symlinked(root, rel) {
  if (!root) return false;
  let cur = root;
  for (const part of String(rel).split('/').filter(Boolean)) {
    cur = path.join(cur, part);
    try {
      if (fs.lstatSync(cur).isSymbolicLink()) return true;
    } catch {
      return false;
    }
  }
  return false;
}

// A name as the messages show it: printable ASCII as is, anything else escaped (the same in topology.py).
export const shown = (v) => (typeof v === 'string' ? v.replace(/[^\x20-\x7e]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`) : '?');

/** Problems with an app.json `policy` section, checked against the profile and the manifest folders. `root` (the
 * checkout on disk) or `isSymlink` (a predicate, for tests) refuses roots that are symbolic links. */
export function policyTopologyProblems(policy, profile, dirs = new Set(), { root = null, isSymlink = null } = {}) {
  if (policy == null) return [];
  if (typeof policy !== 'object' || Array.isArray(policy)) return ['policy must be an object with services'];
  const linked = isSymlink ?? ((rel) => symlinked(root, rel));
  const errors = [];
  for (const key of Object.keys(policy)) {
    if (key.startsWith('$')) continue;
    if (key === 'projects') errors.push('policy.projects: a project\'s class is derived from the project itself (the profile\'s classification conventions); declare only new services (policy.services: id, roots, owns_datastores)');
    else if (key !== 'services') errors.push(`policy.${shown(key)} is not application topology (only policy.services may be declared)`);
  }
  if (!profile) return errors;
  const existingIds = new Set((profile.services ?? []).map((s) => lower(s.id)));
  const taken = new Set([...(profile.services ?? []).flatMap((s) => (s.owns_datastores ?? []).map(lower)), ...(profile.shared_datastore_names ?? []).map(lower)]);
  const explicit = (profile.projects ?? []).map((p) => norm(p.path));
  const entries = policy.services ?? [];
  if (!Array.isArray(entries)) return [...errors, 'policy.services must be a list'];
  // Every root occurrence of the set, to check each against the others.
  const occurrences = entries.flatMap((s, i) => (s && typeof s === 'object' && Array.isArray(s.roots) ? s.roots.map((r, k) => ({ i, k, r })).filter((o) => typeof o.r === 'string').map((o) => ({ ...o, r: norm(o.r) })) : []));
  const seenIds = new Set();
  const seenStores = new Set();
  entries.forEach((s, i) => {
    const where = `policy.services[${i}]`;
    if (!s || typeof s !== 'object' || Array.isArray(s)) return errors.push(`${where}: must be an object`);
    const problems = [];
    const extra = Object.keys(s).filter((k) => !SERVICE_KEYS.has(k)).sort();
    if (extra.length) problems.push(`unknown key(s) ${extra.map(shown).join(', ')}`);
    const sid = typeof s.id === 'string' ? lower(s.id) : '';
    if (typeof s.id !== 'string' || !ID_RE.test(s.id)) problems.push('id must be a plain name (ASCII letters, digits, dashes)');
    else if (existingIds.has(sid)) problems.push(`service '${sid}' already exists in the profile (changing it is governance)`);
    else if (seenIds.has(sid)) problems.push(`service '${sid}' is declared twice`);
    seenIds.add(sid);
    const roots = Array.isArray(s.roots) && s.roots.length && s.roots.every((r) => typeof r === 'string') ? s.roots : null;
    if (!roots) problems.push('roots must list the folders of the new service\'s projects');
    (roots ?? []).forEach((raw, k) => {
      const r = norm(raw);
      if (!r || r.startsWith('..') || raw.startsWith('/')) return problems.push(`root '${shown(raw)}' must be a folder inside the repository`);
      if (linked(r)) return problems.push(`root '${shown(r)}' is, or is inside, a symbolic link`);
      if (!dirs.has(r)) problems.push(`root '${shown(r)}' holds no project manifest (create the project first)`);
      const clash = explicit.find((e) => inside(r, e) || inside(e, r));
      if (clash) problems.push(`root '${shown(r)}' overlaps the profiled project at ${clash}`);
      const others = occurrences.filter((o) => !(o.i === i && o.k === k));
      if (others.some((o) => o.r === r)) problems.push(`root '${shown(r)}' is declared twice`);
      else {
        const other = others.find((o) => inside(r, o.r) || inside(o.r, r));
        if (other) problems.push(`root '${shown(r)}' overlaps the declared root '${shown(other.r)}'`);
      }
    });
    const stores = Array.isArray(s.owns_datastores ?? []) && (s.owns_datastores ?? []).every((d) => typeof d === 'string') ? s.owns_datastores ?? [] : null;
    if (!stores) problems.push('owns_datastores must list datastore names');
    for (const d of stores ?? []) {
      const c = lower(d);
      if (!STORE_RE.test(d)) problems.push(`datastore '${shown(d)}' must be a plain name (ASCII letters, digits, '.', '_', '-'; no spaces)`);
      else if (taken.has(c)) problems.push(`datastore '${d}' is owned by another service or shared (names compare without case)`);
      else if (seenStores.has(c)) problems.push(`datastore '${d}' is declared twice`);
      seenStores.add(c);
    }
    if (problems.length) errors.push(`${where} (${shown(s.id)}): ${problems.join('; ')}`);
  });
  return errors;
}
