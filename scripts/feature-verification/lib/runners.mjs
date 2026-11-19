// Test runners: how feature verification finds, tags, builds and runs a story's automated tests. The
// engine knows no test framework. Each runner is configuration (`precheck.testRunners` in
// .factory/config.json), usually taken from a language pack (packs/<id>/tests.json):
//
//   name      shown in logs and messages
//   match     the files it runs: globs (`tests/**/*.rs`) or extensions (`.cs`)
//   exclude   files it never runs (same forms)
//   roots     folders worth searching for its tests (used when `testRoots` is empty)
//   testFile  optional regex: only files whose text matches hold tests (helpers and fixtures that
//             mention a case id are then neither tag-checked nor required to have a unit)
//   discover  how files group into runnable units: { marker: [file name globs], required, contains,
//             fallbackDepth }. A file's unit is its nearest ancestor folder holding a marker file
//             (a project or package manifest). `contains` (regex) must match that marker file's text,
//             or the runner does not apply. Without a marker the runner does not apply when `required`,
//             else the unit is the first `fallbackDepth` folders of the path, else "." (the repository).
//             Without `discover` there is one unit: ".".
//   build     optional argv, run once per unit, one unit after another, before any test runs
//   run       argv, run once per unit, all units at the same time
//   runAll    optional argv: the unit's whole test project, unfiltered, as CI runs it; run once per unit after its
//             story run passed, so tests that only fail beside the others (shared fixtures, containers) are caught
//   storyTag  { pattern, template, caseTemplate, note }: `pattern` (regex) must match every test file of
//             the story, so the run command can select the story's tests; `template` and `caseTemplate`
//             tell the agents what to write
//   stack     true for an end-to-end runner that needs the app stack: it runs on a leased stack slot
//             (or under the shared stack lock), one at a time
//   evidence  true when the run writes the recorded-run manifest (`evidence.manifest`)
//   env       extra environment for build and run
//   lang      code fence language for its files in agent prompts (default: the file extension)
//   notes     extra lines for the automation agent's task
//   sharedFixture  { perClass: regex whose first group is a fixture type set up once per test class, note }:
//             a fixture type declared per class in more than one class of a unit starts one instance per
//             class (an app host, containers), which the test framework runs in parallel. The precheck fails
//             then, for the whole unit, so a story's new class reuses the shared fixture (dogfood C3/C7:
//             a second IClassFixture<WebhooksApiFixture> made Webhooks CI time out on start-up)
//
// Placeholders in argv, pattern and template: {files} (the unit's test files, one argument each), {unit},
// {story} (SHOP-1), {casePrefix} (TC-SHOP-1-), {storyIdent} (shop_1), {caseIdent} (tc_shop_1_),
// {storyPascal} (Promo1) for languages whose test names cannot hold a dash.
//
// An entry of `precheck.testRunners` is a runner object, "<pack>" (every runner of that pack),
// "<pack>/<name>" (one of them), or { "use": "<pack>/<name>", ...overrides }. When `precheck.testRunners`
// is null, the runners of the packs named in `project.languages` are used; [] means none.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { matchGlob } from '../../implement/lib/plan.mjs';
import { matchesAnyPath, packRunners } from '../../implement/lib/project.mjs';
import { deepMerge } from '../../pipeline/lib/config.mjs';

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const posix = (p) => String(p).replace(/\\/g, '/').replace(/^\.\//, '');

// The names a story key takes in commands, tags and test names.
export function storyTokens(key) {
  const words = String(key).split(/[^A-Za-z0-9]+/).filter(Boolean);
  const ident = words.join('_').toLowerCase();
  return {
    story: key,
    casePrefix: `TC-${key}-`,
    storyIdent: ident,
    caseIdent: `tc_${ident}_`,
    storyPascal: words.map((w) => w[0].toUpperCase() + w.slice(1).toLowerCase()).join(''),
  };
}

const fill = (text, values, encode = (v) => v) => String(text).replace(/\{(\w+)\}/g, (whole, key) => (typeof values[key] === 'string' ? encode(values[key]) : whole));

// A command template with its placeholders filled. `{files}` alone expands to one argument per file.
export function expandArgv(template, values) {
  return (template ?? []).flatMap((part) => {
    if (part === '{files}') return values.files ?? [];
    return [String(part).replace(/\{(\w+)\}/g, (_, key) => (values[key] == null || Array.isArray(values[key]) ? '' : String(values[key])))];
  });
}

function resolveEntry(entry, installRoot) {
  if (typeof entry === 'string' || (entry && typeof entry === 'object' && entry.use)) {
    const ref = typeof entry === 'string' ? entry : entry.use;
    const [pack, name] = ref.split('/');
    const found = packRunners(pack, installRoot).filter((r) => !name || r.name === name);
    if (!found.length) throw new Error(`precheck.testRunners: "${ref}" names no runner (packs/${pack}/tests.json${name ? ` has no runner "${name}"` : ' is missing or empty'})`);
    if (typeof entry === 'string') return found;
    const { use: _use, ...overrides } = entry;
    return found.map((r) => deepMerge(r, overrides));
  }
  return entry && typeof entry === 'object' ? [entry] : [];
}

// The runners of this configuration, in the order they are tried.
export function testRunners(config) {
  const given = config.precheck?.testRunners;
  const entries = Array.isArray(given) ? given : (config.project?.languages ?? []).filter((id) => packRunners(id, config.installRoot).length);
  const runners = entries.flatMap((e) => resolveEntry(e, config.installRoot));
  for (const r of runners) {
    if (!r.name) throw new Error('precheck.testRunners: every runner needs a `name`');
    if (!Array.isArray(r.run) || !r.run.length) throw new Error(`precheck.testRunners: runner "${r.name}" has no \`run\` command`);
    if (!Array.isArray(r.match) || !r.match.length) throw new Error(`precheck.testRunners: runner "${r.name}" has no \`match\` patterns`);
  }
  return runners;
}

const runnerMatches = (runner, file) => matchesAnyPath(file, runner.match) && !matchesAnyPath(file, runner.exclude ?? []);

// The file's unit under this runner, or null when the runner does not apply to it.
export function unitOf(config, runner, file) {
  const d = runner.discover;
  if (!d?.marker?.length) return '.';
  const parts = posix(file).split('/').slice(0, -1);
  for (let n = parts.length; n >= 0; n--) {
    const dir = parts.slice(0, n).join('/');
    let names;
    try {
      names = fs.readdirSync(path.join(config.root, dir));
    } catch {
      continue;
    }
    const marker = names.find((name) => d.marker.some((glob) => matchGlob(name, glob)));
    if (!marker) continue;
    if (d.contains && !new RegExp(d.contains, 'i').test(fs.readFileSync(path.join(config.root, dir, marker), 'utf8'))) return null;
    return dir || '.';
  }
  if (d.required || d.contains) return null;
  return d.fallbackDepth ? parts.slice(0, d.fallbackDepth).join('/') || '.' : '.';
}

// The first runner that takes the file: { runner, unit }, or null.
export function runnerFor(config, file, runners = testRunners(config)) {
  for (const runner of runners) {
    if (!runnerMatches(runner, file)) continue;
    const unit = unitOf(config, runner, file);
    if (unit != null) return { runner, unit };
  }
  return null;
}

// Whether the file is one feature verification should look at for case ids: by `testExtensions` when
// that is set, else by the runners' `match`; with neither configured, any source file (not Markdown, not
// the pipeline's own folders), so an unconfigured repository still finds its tests.
export function isTestFile(config, file, runners = testRunners(config)) {
  const exts = config.testExtensions ?? [];
  if (exts.length) return exts.some((ext) => file.endsWith(ext));
  if (runners.length) return runners.some((r) => runnerMatches(r, file));
  if (file.endsWith('.md')) return false;
  const own = ['.factory/', 'graphify-out/', '.git/'];
  return file.startsWith(`${config.scenariosDir}/`) || !own.some((dir) => file.startsWith(dir));
}

// Where to look for test files: `testRoots`, else the runners' `roots`, else the whole repository.
export function testRoots(config, runners = testRunners(config)) {
  if (config.testRoots?.length) return config.testRoots;
  if (!runners.length || runners.some((r) => !r.roots?.length)) return ['.'];
  return [...new Set([...runners.flatMap((r) => r.roots), config.scenariosDir].filter(Boolean))];
}

const holdsTests = (runner, text) => !runner.testFile || new RegExp(runner.testFile).test(text);

export const storyTagPattern = (runner, key) => (runner.storyTag?.pattern ? new RegExp(fill(runner.storyTag.pattern, storyTokens(key), escapeRe)) : null);
export const storyTagText = (runner, key) => (runner.storyTag?.template ? fill(runner.storyTag.template, storyTokens(key)) : null);

// The story-tag error for one test file, or null when it is tagged (or its runner needs no tag).
export function tagError(config, file, text, key, runners = testRunners(config)) {
  const hit = runnerFor(config, file, runners);
  if (!hit || !holdsTests(hit.runner, text)) return null; // helpers and fixtures may mention a case id without holding tests
  const pattern = storyTagPattern(hit.runner, key);
  if (!pattern || pattern.test(text)) return null;
  return `${file}: tag the story's tests with ${storyTagText(hit.runner, key) ?? `/${pattern.source}/`} so they can be selected (${hit.unit === '.' ? 'runner' : `${hit.unit} runs with`} ${hit.runner.name}).`;
}

// The runs a set of test files needs: one per runner and unit, in runner order.
// { runs: [{ runner, unit, files, build: argv | null, run: argv }], unmatched: [files no runner takes] }
export function planRuns(config, files, key, { read = null, runners = testRunners(config) } = {}) {
  const groups = new Map();
  const unmatched = [];
  for (const file of files) {
    const hit = runnerFor(config, file, runners);
    if (!hit) {
      unmatched.push(file);
      continue;
    }
    if (read && hit.runner.testFile && !holdsTests(hit.runner, read(file) ?? '')) continue;
    const id = `${hit.runner.name}\u0000${hit.unit}`;
    if (!groups.has(id)) groups.set(id, { runner: hit.runner, unit: hit.unit, files: [] });
    groups.get(id).files.push(file);
  }
  const order = (g) => runners.indexOf(g.runner);
  const runs = [...groups.values()]
    .sort((a, b) => order(a) - order(b) || a.unit.localeCompare(b.unit))
    .map((g) => {
      const values = { ...storyTokens(key), unit: g.unit, files: g.files };
      return { ...g, build: g.runner.build?.length ? expandArgv(g.runner.build, values) : null, run: expandArgv(g.runner.run, values), runAll: g.runner.runAll?.length ? expandArgv(g.runner.runAll, values) : null };
    });
  return { runs, unmatched };
}

// What the automation agent is told about tagging, one line per runner.
export function taggingLines(config, key, runners = testRunners(config)) {
  const lines = [];
  for (const r of runners) {
    const tag = storyTagText(r, key);
    const tokens = { ...storyTokens(key), case: `${storyTokens(key).casePrefix}NN` };
    const parts = [tag ? `tag the story's tests with ${tag}` : null, r.storyTag?.caseTemplate ? `mark each test's case with ${fill(r.storyTag.caseTemplate, tokens)}` : null, r.storyTag?.note ? fill(r.storyTag.note, tokens) : null].filter(Boolean);
    if (parts.length) lines.push(`- ${r.name} (${r.match.join(', ')}): ${parts.join('; ')}.`);
    for (const note of r.notes ?? []) lines.push(`- ${r.name}: ${fill(note, tokens)}`);
  }
  return lines;
}

// The code fence language for a file in an agent prompt: its runner's `lang`, else its extension.
export function fenceLang(config, file, runners = []) {
  const runner = runners.find((r) => r.lang && runnerMatches(r, file));
  return runner?.lang ?? (path.extname(file).slice(1) || '');
}

// The test units that cover the services a change touches, for the whole-project runs before a PR (council C2:
// only the projects holding the story's tests ran, so a changed service could still break another of its test
// projects in CI). A unit covers a service when the project model names it (`testProjects` or `unitTests` of the
// service), or when its marker file (the test project's manifest) references the service's folder.
// files: the repository's tracked files. Returns [{ runner, unit, services: [names], build, runAll }].
export function coveringUnits(config, services, files, key, runners = testRunners(config)) {
  if (!services.length) return [];
  // A unit inside a service's own folder is application code, not a test project.
  const servicePaths = (config.project?.services ?? []).flatMap((s) => s.paths ?? []).filter((p) => p !== '**');
  const units = new Map();
  for (const runner of runners.filter((r) => !r.stack && r.runAll?.length)) {
    for (const file of files) {
      if (!runnerMatches(runner, file)) continue;
      const unit = unitOf(config, runner, file);
      if (unit == null || unit === '.' || units.has(unit)) continue;
      if (matchesAnyPath(`${unit}/x`, servicePaths)) continue;
      units.set(unit, { runner, unit, manifest: markerText(config, runner, unit) });
    }
  }
  const out = [];
  for (const u of units.values()) {
    const covered = services.filter((svc) => {
      const named = [svc.testProjects, svc.unitTests].flat().filter(Boolean).map((p) => posix(p).replace(/\/+$/, ''));
      if (named.includes(u.unit)) return true;
      const folders = (svc.paths ?? []).map((p) => posix(p).replace(/\/\*\*.*$/, '').split('/').pop()).filter((f) => f && f !== '**');
      return folders.some((f) => new RegExp(`[\\\\/]${f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([\\\\/"']|$)`, 'im').test(u.manifest));
    });
    if (!covered.length) continue;
    const values = { ...storyTokens(key), unit: u.unit, files: [] };
    out.push({ runner: u.runner, unit: u.unit, services: covered.map((s) => s.name), build: u.runner.build?.length ? expandArgv(u.runner.build, values) : null, runAll: expandArgv(u.runner.runAll, values) });
  }
  return out.sort((a, b) => a.unit.localeCompare(b.unit));
}

function markerText(config, runner, unit) {
  const markers = runner.discover?.marker ?? [];
  try {
    const name = fs.readdirSync(path.join(config.root, unit)).find((n) => markers.some((g) => matchGlob(n, g)));
    return name ? fs.readFileSync(path.join(config.root, unit, name), 'utf8') : '';
  } catch {
    return '';
  }
}

// Units (test projects) of the given files where one fixture type is set up per class in more than one class
// (runner.sharedFixture). The whole unit is read, not only the story's files, so a story that adds a class
// beside an existing one, or extends a project where this already happened, gets the error.
export function sharedFixtureErrors(config, files, runners = testRunners(config), { list = null } = {}) {
  const errors = [];
  const seen = new Set();
  for (const file of files) {
    const hit = runnerFor(config, file, runners);
    const rule = hit?.runner.sharedFixture;
    if (!rule?.perClass || seen.has(`${hit.runner.name}\0${hit.unit}`)) continue;
    seen.add(`${hit.runner.name}\0${hit.unit}`);
    const unitFiles = (list ?? ((unit) => {
      const r = spawnGit(config.root, ['ls-files', '-co', '--exclude-standard', '--', unit === '.' ? '.' : unit]);
      return r.split('\n').filter(Boolean);
    }))(hit.unit).filter((f) => runnerMatches(hit.runner, f) && !/(^|\/)(bin|obj)\//.test(f));
    const byType = new Map();
    const re = new RegExp(rule.perClass, 'g');
    for (const f of unitFiles) {
      let text;
      try {
        text = fs.readFileSync(path.join(config.root, f), 'utf8');
      } catch {
        continue;
      }
      for (const m of text.matchAll(re)) {
        const type = m[1];
        if (!type) continue;
        byType.set(type, [...(byType.get(type) ?? []), f]);
      }
    }
    for (const [type, where] of byType) {
      if (where.length < 2) continue;
      errors.push(`${hit.unit}: the fixture ${type} is set up per class in ${where.length} classes (${[...new Set(where)].join(', ')}), so each class starts its own instance and they run in parallel. Share one instance across the project${rule.note ? `: ${rule.note}` : ''}. This applies to existing classes too: fix the project, not only your new tests.`);
    }
  }
  return errors;
}

function spawnGit(cwd, args) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 120_000 });
  } catch {
    return '';
  }
}
