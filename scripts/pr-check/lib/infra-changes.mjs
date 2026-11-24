// Changes to what every test, build or CI run uses, listed by the harness from the diff, whatever the critics say
// (council C8/C12: #154 changed the Catalog functional tests' shared collection and the flow critic never named it).
// An existing test fixture, collection, runner setting, project or package file, container file or CI workflow that
// the PR modifies or deletes, and a project, package or CI file it adds, is a behaviour change outside the ticket's
// lines: it changes what runs for everyone. New test files of the PR's own (specs, test cases) are not listed.
import { git } from '../../pipeline/lib/git.mjs';
import { defaultSettings } from '../../pipeline/lib/settings.mjs';

// The default patterns (shared test setup, build and dependencies, CI) are `prCheck.infraPaths` in scripts/pr-check/config.json.
export const INFRA_PATTERNS = defaultSettings().prCheck.infraPaths.map((p) => new RegExp(p));

// Kinds: what the harness says each one changes.
const kindOf = (file) =>
  /\.github\/workflows|gitlab-ci|azure-pipelines|Jenkinsfile/.test(file)
    ? 'CI'
    : /Fixture|Collection|TestBase|TestSetup|WebApplicationFactory|xunit\.runner|runsettings|conftest|pytest\.ini|global-(setup|teardown)|\.config\.[cm]?[jt]s$/.test(file)
      ? 'shared test setup'
      : 'build and dependencies';

// [{ status: 'A'|'M'|'D'|'R', file }] -> side-effect lines.
const isTestFile = (f) => /(^|\/)tests?\/|[Tt]ests?\.(cs|[cm]?[jt]s|py|java|kt)$|\.(spec|test)\.[cm]?[jt]sx?$|_test\.(go|py)$/.test(f);
const dirOf = (f) => f.split('/').slice(0, -1).join('/');

export function infraSideEffects(changes, { patterns = INFRA_PATTERNS } = {}) {
  const out = [];
  // Existing test files the PR changes, by directory: a new fixture or collection beside one of them reaches tests that
  // ran without it before (#154: a new collection that the existing Catalog API tests were moved into).
  const changedTestDirs = new Set(changes.filter((c) => c.status === 'M' && isTestFile(c.file)).map((c) => dirOf(c.file)));
  for (const { status, file } of changes) {
    if (/^\.factory\//.test(file) || !patterns.some((re) => re.test(file))) continue;
    // A test fixture the PR adds only for its own new tests is not shared; added build and CI files always are.
    if (status === 'A' && kindOf(file) === 'shared test setup' && !changedTestDirs.has(dirOf(file))) continue;
    const verb = status === 'A' ? (kindOf(file) === 'shared test setup' ? 'added and used by existing tests' : 'added') : status === 'D' ? 'deleted' : 'changed';
    out.push(`${kindOf(file)}: ${file} ${verb} (it affects every test or build that uses it, not only this ticket's)`);
  }
  return out;
}

export function diffStatus(root, baseRev) {
  const r = git(root, ['diff', '--name-status', '-M', baseRev]);
  if (r.status !== 0) return [];
  return String(r.stdout)
    .split('\n')
    .filter(Boolean)
    .map((l) => l.split('\t'))
    .map(([s, a, b]) => ({ status: s[0], file: (b ?? a).replace(/\\/g, '/') }));
}
