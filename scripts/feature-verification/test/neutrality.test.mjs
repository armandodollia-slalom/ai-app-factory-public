// Language neutrality: the same engine, described only by .factory/config.json, drives a Rust workspace
// and a Java project (Maven and Gradle modules). No toolchain is needed: `cargo`, `mvn` and `./gradlew`
// are fake commands that record how they were called. Covers the precheck's test-runner selection and
// runs, UI-story detection, unit-test selection, review-gate systems and frontend/backend classification.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { unitTestRuns } from '../../implement/lib/orchestrate.mjs';
import { isUiStory, uiRules } from '../../implement/lib/plan.mjs';
import { planExamples } from '../../implement/lib/tasks.mjs';
import { pathLikeRegex } from '../../implement/lib/project.mjs';
import { INSTALL_ROOT, loadConfig } from '../../pipeline/lib/config.mjs';
import { frontendPathsOf } from '../../pr-check/lib/context.mjs';
import { classifyFiles } from '../../pr-video/lib/api-summary.mjs';
import { gateSystemsSettings, systemsTouched } from '../../review-gate/lib/systems.mjs';
import { planContentSha, readPlan, stampIndex } from '../lib/plans.mjs';
import { precheckAutomation } from '../lib/workflows.mjs';

const temps = [];
const PATH_BEFORE = process.env.PATH;
after(() => {
  process.env.PATH = PATH_BEFORE;
  temps.forEach((d) => fs.rmSync(d, { recursive: true, force: true }));
});

const write = (root, rel, text, mode) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), text, mode ? { mode } : undefined);
};
const fakeTool = (name) => `#!/bin/sh\necho "${name} $*" >> "$FAKE_TOOL_LOG"\ncase "$*" in *"$FAKE_TOOL_FAIL"*) [ -n "$FAKE_TOOL_FAIL" ] && { echo "${name}: 1 test failed" >&2; exit 1; };; esac\nexit 0\n`;

// A git repository whose only description is its .factory/config.json, a story with a verified plan, and
// fake build tools first on PATH.
function repo(overlay, { key, files, tools }) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fv-neutral-')));
  temps.push(root);
  spawnSync('git', ['init', '-q', '-b', 'main', root]);
  write(root, '.factory/config.json', JSON.stringify(overlay, null, 2));
  for (const [rel, text] of Object.entries(files)) write(root, rel, text);
  for (const tool of tools) write(root, tool.includes('/') ? tool : `.bin/${tool}`, fakeTool(path.basename(tool)), 0o755);
  process.env.PATH = `${path.join(root, '.bin')}${path.delimiter}${PATH_BEFORE}`;
  process.env.FAKE_TOOL_LOG = path.join(root, 'tools.log');
  delete process.env.FAKE_TOOL_FAIL;
  const config = loadConfig('feature-verification', root);
  const story = { key, slug: `${key}-coupons`, file: `.factory/state/board/${key}/story.md`, planDir: `${config.featureVerification.plansDir}/${key}-coupons`, scenario: key.toLowerCase() };
  write(root, story.file, `# ${key}: [BE - api] - Coupons\n\n## Acceptance Criteria\n\n- a coupon applies\n`);
  const caseFile = (n, type, extra = '') => `---\nid: TC-${key}-0${n}\ntype: ${type}\n${extra}covers: AC1\nlayer: unit\n---\n\n# TC-${key}-0${n}: case ${n}\n\n## Why\n\nBecause.\n\n## Preconditions\n\nNone.\n\n## Steps\n\n1. Do it.\n\n## Expected result\n\nIt works.\n`;
  write(root, `${story.planDir}/TC-${key}-01-applies.md`, caseFile(1, 'happy'));
  write(root, `${story.planDir}/TC-${key}-02-expired.md`, caseFile(2, 'sad', 'sad-path: validation\n'));
  write(root, `${story.planDir}/_index.md`, `# Test plan\n\n- TC-${key}-01\n- TC-${key}-02\n`);
  stampIndex(config, story, {});
  stampIndex(config, story, { 'plan-sha': planContentSha(readPlan(config, story)), 'verified-score': 10 });
  const calls = () => (fs.existsSync(process.env.FAKE_TOOL_LOG) ? fs.readFileSync(process.env.FAKE_TOOL_LOG, 'utf8').trim().split('\n').filter(Boolean) : []);
  const reset = () => fs.rmSync(process.env.FAKE_TOOL_LOG, { force: true });
  return { root, config, story, calls, reset };
}

const implementConfig = (root) => loadConfig('implement', root);

// Dogfood C2: BUG-18's tests passed alone (story filter) and failed in CI, which runs the whole test project.
test('after the story run passes, each unit\'s whole test project runs as CI runs it; its failure is a finding', async () => {
  const overlay = {
    project: { name: 'ledger', languages: ['rust'], services: [{ name: 'api', kind: 'backend', paths: ['crates/api/**'], unitTests: 'crates/api' }] },
    implement: { unitTests: { cmd: 'cargo test --manifest-path {project}/Cargo.toml --lib' } },
    featureVerification: { precheck: { scenarioFile: null }, slots: { enabled: false } },
  };
  const r = repo(overlay, {
    key: 'RS-2',
    tools: ['cargo'],
    files: {
      'Cargo.toml': '[workspace]\nmembers = ["crates/api"]\n',
      'crates/api/Cargo.toml': '[package]\nname = "api"\n',
      'crates/api/tests/a.rs': '// TC-RS-2-01\n#[test]\nfn tc_rs_2_01_applies() {}\n// TC-RS-2-02\n#[test]\nfn tc_rs_2_02_expired() {}\n',
    },
  });
  const ok = await precheckAutomation(r.config, r.story, { fix: false });
  assert.deepEqual(ok.errors, []);
  assert.ok(r.calls().includes('cargo test --manifest-path crates/api/Cargo.toml'), r.calls().join(' | '));
  r.reset();
  process.env.FAKE_TOOL_FAIL = 'crates/api/Cargo.toml';
  const whole = await precheckAutomation(r.config, r.story, { fix: false });
  delete process.env.FAKE_TOOL_FAIL;
  assert.equal(whole.errors.length, 1);
});

// Council C2: only the test projects holding the story's tests ran before the PR; a changed service could still break
// another test project that covers it, and CI found out.
test('before the PR, every other test project that covers a touched service also runs in full; its failure is a finding', async () => {
  const overlay = {
    project: { name: 'ledger', languages: ['rust'], services: [{ name: 'api', kind: 'backend', paths: ['crates/api/**'], unitTests: 'crates/api' }, { name: 'billing', kind: 'backend', paths: ['crates/billing/**'] }] },
    featureVerification: { precheck: { scenarioFile: null }, slots: { enabled: false } },
  };
  const r = repo(overlay, {
    key: 'RS-3',
    tools: ['cargo'],
    files: {
      'Cargo.toml': '[workspace]\nmembers = ["crates/*"]\n',
      'crates/api/Cargo.toml': '[package]\nname = "api"\n',
      'crates/api/src/lib.rs': 'pub fn apply() {}\n',
      'crates/billing/Cargo.toml': '[package]\nname = "billing"\n',
      'crates/billing/src/lib.rs': 'pub fn bill() {}\n',
      'tests-it/api-it/Cargo.toml': '[package]\nname = "api-it"\n[dependencies]\napi = { path = "../../crates/api" }\n',
      'tests-it/api-it/tests/it.rs': '#[test]\nfn whole_flow() {}\n',
      'tests-it/billing-it/Cargo.toml': '[package]\nname = "billing-it"\n[dependencies]\nbilling = { path = "../../crates/billing" }\n',
      'tests-it/billing-it/tests/it.rs': '#[test]\nfn bills() {}\n',
    },
  });
  const sh = (...args) => spawnSync('git', args, { cwd: r.root, encoding: 'utf8' });
  sh('-c', 'user.email=t@example.com', '-c', 'user.name=t', 'add', '-A');
  sh('-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-q', '-m', 'base');
  process.env.PIPELINE_BASE_REF = 'main';
  try {
    const config = loadConfig('feature-verification', r.root);
    write(r.root, 'crates/api/src/lib.rs', 'pub fn apply() { /* changed */ }\n');
    write(r.root, 'crates/api/tests/a.rs', '// TC-RS-3-01\n#[test]\nfn tc_rs_3_01_applies() {}\n// TC-RS-3-02\n#[test]\nfn tc_rs_3_02_expired() {}\n');
    const ok = await precheckAutomation(config, r.story, { fix: false });
    assert.deepEqual(ok.errors, []);
    const calls = r.calls();
    assert.ok(calls.includes('cargo test --manifest-path crates/api/Cargo.toml'), 'the story\'s own project, in full');
    assert.ok(calls.includes('cargo test --manifest-path tests-it/api-it/Cargo.toml --no-run --quiet'), 'a covering project is built first');
    assert.ok(calls.includes('cargo test --manifest-path tests-it/api-it/Cargo.toml'), calls.join(' | '));
    assert.ok(!calls.some((c) => c.includes('billing-it')), 'a project that covers no touched service does not run');
    const runs = fs.readFileSync(path.join(r.root, '.factory/metrics/full-project-runs.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(runs.map((x) => [x.unit, x.why, x.status]), [['crates/api', "holds the story's tests", 0], ['tests-it/api-it', 'covers api', 0]]);
    r.reset();
    process.env.FAKE_TOOL_FAIL = 'api-it/Cargo.toml';
    const failed = await precheckAutomation(config, r.story, { fix: false });
    assert.equal(failed.errors.length, 1);
    assert.match(failed.errors[0], /tests-it\/api-it \(covers api\)/);
  } finally {
    delete process.env.PIPELINE_BASE_REF;
    delete process.env.FAKE_TOOL_FAIL;
  }
});

test('a Rust workspace: cargo runs the story\'s tests per crate; UI stories, unit tests and systems come from the project model', async () => {
  const overlay = {
    project: {
      name: 'ledger',
      languages: ['rust'],
      services: [
        { name: 'api', kind: 'backend', paths: ['crates/api/**'], unitTests: 'cargo test --manifest-path crates/api/Cargo.toml --lib', dependsOn: ['core'] },
        { name: 'core', kind: 'library', paths: ['crates/core/**'], unitTests: 'crates/core' },
        { name: 'web', kind: 'frontend', paths: ['web/**'] },
      ],
      frontendPaths: ['.css'],
    },
    implement: { unitTests: { cmd: 'cargo test --manifest-path {project}/Cargo.toml --lib' } },
    featureVerification: { precheck: { scenarioFile: null, runFullProjects: false }, slots: { enabled: false } },
  };
  const r = repo(overlay, {
    key: 'RS-1',
    tools: ['cargo'],
    files: {
      'Cargo.toml': '[workspace]\nmembers = ["crates/api", "crates/core"]\n',
      'crates/api/Cargo.toml': '[package]\nname = "api"\n',
      'crates/api/tests/coupons.rs': '// TC-RS-1-01\n#[test]\nfn tc_rs_1_01_applies() {}\n',
      'crates/api/tests/common/mod.rs': 'pub fn server() {} // shared by TC-RS-1-01 and TC-RS-1-02\n',
      'crates/core/Cargo.toml': '[package]\nname = "core"\n',
      'crates/core/src/lib.rs': '#[cfg(test)]\nmod tests {\n    // TC-RS-1-02\n    #[test]\n    fn expired_is_rejected() {}\n}\n',
    },
  });

  // Precheck: the untagged file is reported in the runner's own words, before anything runs.
  const untagged = await precheckAutomation(r.config, r.story, { fix: false });
  assert.deepEqual(untagged.errors, ['crates/api/tests/common/mod.rs: tag the story\'s tests with a test function named `tc_rs_1_NN_<what_it_checks>` so they can be selected (crates/api runs with cargo-test).', 'crates/core/src/lib.rs: tag the story\'s tests with a test function named `tc_rs_1_NN_<what_it_checks>` so they can be selected (crates/core runs with cargo-test).']);
  assert.deepEqual(r.calls(), []);

  // Tagged: one build per crate, then one run per crate, selected by the story's name prefix.
  write(r.root, 'crates/core/src/lib.rs', '#[cfg(test)]\nmod tests {\n    // TC-RS-1-02\n    #[test]\n    fn tc_rs_1_02_expired_is_rejected() {}\n}\n');
  write(r.root, 'crates/api/tests/common/mod.rs', 'pub fn server() {}\n');
  const ok = await precheckAutomation(r.config, r.story, { fix: false });
  assert.deepEqual(ok.errors, []);
  assert.deepEqual([...ok.tests.keys()], ['crates/api/tests/coupons.rs', 'crates/core/src/lib.rs']);
  assert.deepEqual(r.calls().slice(0, 2), ['cargo test --manifest-path crates/api/Cargo.toml --no-run --quiet', 'cargo test --manifest-path crates/core/Cargo.toml --no-run --quiet'], 'builds first, one crate after another');
  assert.deepEqual(r.calls().slice(2).sort(), ['cargo test --manifest-path crates/api/Cargo.toml tc_rs_1_', 'cargo test --manifest-path crates/core/Cargo.toml tc_rs_1_']);

  // A failing run comes back as feedback with the command that failed.
  r.reset();
  process.env.FAKE_TOOL_FAIL = 'crates/core/Cargo.toml tc_rs_1_';
  const failed = await precheckAutomation(r.config, r.story, { fix: false });
  assert.equal(failed.errors.length, 1);
  assert.match(failed.errors[0], /`cargo test --manifest-path crates\/core\/Cargo\.toml tc_rs_1_` failed:\ncargo: 1 test failed/);
  delete process.env.FAKE_TOOL_FAIL;

  // The implement stage on the same description.
  const impl = implementConfig(r.root);
  const rules = uiRules(impl);
  assert.deepEqual(rules, { titleTags: ['FE'], components: ['web'], filePatterns: ['.css', 'web/**'] });
  assert.ok(isUiStory('# RS-2: [BE - api, web] - Coupon box\n', rules));
  assert.ok(isUiStory('# RS-3: [BE - api] - Coupons\n\nChange `web/src/cart.rs`.', rules));
  assert.ok(!isUiStory('# RS-4: [BE - api] - Coupons\n\nChange `crates/api/src/lib.rs`; the web app calls it later.', rules));
  assert.deepEqual(unitTestRuns(impl, ['crates/core/src/lib.rs'], { cwd: r.root }).map((u) => u.cmd), ['cargo test --manifest-path crates/api/Cargo.toml --lib', 'cargo test --manifest-path crates/core/Cargo.toml --lib'], 'a library change also runs its dependants');
  assert.deepEqual(unitTestRuns(impl, ['web/src/cart.rs', 'README.md'], { cwd: r.root }), []);
  assert.deepEqual(planExamples(impl.project), { service: 'api', owns: 'crates/api/**' });
  assert.deepEqual([...'blocked: I need crates/core/src/money.rs and web/Trunk.toml, also Cargo.lock.'.matchAll(pathLikeRegex(impl.project, { extensions: ['lock'] }))].map((m) => m[1].replace(/[.]+$/, '')), ['crates/core/src/money.rs', 'web/Trunk.toml', 'Cargo.lock']);

  // Review gate systems, PR check and PR video classification.
  const touched = systemsTouched(['crates/api/src/lib.rs', 'crates/core/src/lib.rs', 'web/index.html', 'docs/a.md', 'justfile'], gateSystemsSettings(impl));
  assert.deepEqual(touched.names, ['api', 'web', 'Other'], 'a library only api uses is part of api, not a system of its own');
  assert.equal(touched.shared, false);
  const twoUsers = { ...impl, project: { ...impl.project, services: impl.project.services.map((s) => (s.name === 'web' ? { ...s, dependsOn: ['core'] } : s)) } };
  const both = systemsTouched(['crates/core/src/lib.rs'], gateSystemsSettings(twoUsers));
  assert.deepEqual(both.names, ['core']);
  assert.equal(both.shared, true, 'a library two services use is shared');
  assert.deepEqual(frontendPathsOf(impl), ['.css', 'web/**']);
  assert.deepEqual(classifyFiles(['web/src/cart.rs'], impl), { frontend: true, backend: false, video: true, api: false });
  assert.deepEqual(classifyFiles(['crates/api/src/lib.rs', 'README.md'], impl), { frontend: false, backend: true, video: false, api: true });
});

test('a Java project: Maven and Gradle modules each get their own JUnit runner and story selection', async () => {
  const overlay = {
    project: {
      name: 'shop-jvm',
      languages: ['java'],
      services: [
        { name: 'orders', kind: 'backend', paths: ['orders-service/**'], unitTests: 'orders-service' },
        { name: 'billing', kind: 'worker', paths: ['billing/**'], unitTests: './gradlew -q -p billing test' },
        { name: 'admin-ui', kind: 'frontend', paths: ['admin-ui/**'] },
      ],
      frontendPaths: ['.tsx'],
    },
    implement: { unitTests: { cmd: 'mvn -q -f {project}/pom.xml test' }, uiStory: { titleTags: ['UI'] }, reviewGate: { systems: [{ name: 'Payments', paths: ['billing/**', 'orders-service/src/main/java/shop/pay/**'], shared: true }] } },
    featureVerification: { precheck: { scenarioFile: null, runFullProjects: false }, slots: { enabled: false } },
  };
  const r = repo(overlay, {
    key: 'JV-1',
    tools: ['mvn', './gradlew'],
    files: {
      'orders-service/pom.xml': '<project/>',
      'orders-service/src/test/java/shop/CouponTest.java': '@Tag("JV-1")\nclass CouponTest {\n  @Test @DisplayName("TC-JV-1-01 applies") void applies() {}\n}\n',
      'billing/build.gradle.kts': 'plugins { java }\n',
      'billing/src/test/java/shop/InvoiceJv1StoryTest.java': 'class InvoiceJv1StoryTest {\n  @Test @DisplayName("TC-JV-1-02 expired") void expired() {}\n}\n',
    },
  });
  const pre = await precheckAutomation(r.config, r.story, { fix: false });
  assert.deepEqual(pre.errors, []);
  assert.deepEqual(r.calls().slice(0, 2), ['mvn -q -f orders-service/pom.xml test-compile', 'gradlew -q -p billing testClasses']);
  assert.deepEqual(r.calls().slice(2).sort(), ['gradlew -q -p billing test --tests *Jv1StoryTest*', 'mvn -q -f orders-service/pom.xml test -Dgroups=JV-1 -Dsurefire.failIfNoSpecifiedTests=false']);

  // The Maven module's tag and the Gradle module's class name are different rules for the same story.
  write(r.root, 'orders-service/src/test/java/shop/CouponTest.java', 'class CouponTest {\n  @Test @DisplayName("TC-JV-1-01 applies") void applies() {}\n}\n');
  r.reset();
  const untagged = await precheckAutomation(r.config, r.story, { fix: false });
  assert.deepEqual(untagged.errors, ['orders-service/src/test/java/shop/CouponTest.java: tag the story\'s tests with @Tag("JV-1") so they can be selected (orders-service runs with junit-maven).']);
  assert.deepEqual(r.calls(), []);

  const impl = implementConfig(r.root);
  const rules = uiRules(impl);
  assert.deepEqual(rules, { titleTags: ['UI'], components: ['admin-ui'], filePatterns: ['.tsx', 'admin-ui/**'] });
  assert.ok(isUiStory('# JV-2: [UI - admin-ui] - Coupon list\n', rules));
  assert.ok(isUiStory('# JV-3: [BE - orders] - Coupons\n\nAdd `shared/CouponBadge.tsx`.', rules));
  assert.ok(!isUiStory('# JV-4: [FE - orders] - Coupons\n\nChange `orders-service/src/main/java/shop/Coupon.java`.', rules), 'this repository tags UI stories [UI], not [FE]');
  assert.deepEqual(unitTestRuns(impl, ['orders-service/src/main/java/shop/Coupon.java', 'billing/src/main/java/shop/Invoice.java'], { cwd: r.root }).map((u) => u.cmd), ['./gradlew -q -p billing test', 'mvn -q -f orders-service/pom.xml test']);
  assert.deepEqual(systemsTouched(['billing/src/main/java/shop/Invoice.java', 'orders-service/src/main/java/shop/Coupon.java'], gateSystemsSettings(impl)).names, ['Payments', 'Other'], 'explicit implement.reviewGate.systems replace the derived ones');
  assert.deepEqual(classifyFiles(['admin-ui/src/App.tsx', 'orders-service/src/main/java/shop/Coupon.java'], impl), { frontend: true, backend: true, video: true, api: true });
});

test('the engine defaults name no language, framework, product or repository', () => {
  const banned = /dotnet|csproj|\.slnf?\b|slnx|razor|blazor|webapp|catalog|basket|ordering|eshop|aspire|xunit|mstest|\bTrait\b|armandodollia|cargo|maven|gradle|pytest|playwright|"src\/|"tests\//i;
  for (const stage of ['implement', 'feature-verification', 'pr-check', 'pr-video', 'board']) {
    // The light fixer's test and docs paths, a UI verifier's report folders, the demo recording command and the PR check's shared-file patterns were the
    // engine's own defaults in code before they moved into the default settings files (GEN-6): conventions, not a stack.
    const doc = JSON.parse(fs.readFileSync(path.join(INSTALL_ROOT, 'scripts', stage, 'config.json'), 'utf8'));
    delete doc.prCheck?.returnToImplementation?.lightPaths;
    delete doc.implement?.ui?.artifactDirs;
    delete doc.prVideo?.recordCmd;
    delete doc.prCheck?.infraPaths;
    const text = JSON.stringify(doc, null, 2);
    const hits = text.split('\n').filter((line) => banned.test(line));
    // `evidence.playwright` is the (null) key the board's evidence capture reads; see the report.
    assert.deepEqual(hits.filter((l) => !/^\s*"playwright": null,?$/.test(l)), [], `scripts/${stage}/config.json`);
  }
  const bare = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fv-bare-')));
  temps.push(bare);
  spawnSync('git', ['init', '-q', bare]);
  const impl = loadConfig('implement', bare);
  assert.deepEqual([impl.implement.prepareCmd, impl.implement.checks, impl.implement.unitTests.cmd, impl.implement.ui.teststackCmd, impl.implement.reviewGate.systems], [null, [], null, null, null]);
  assert.deepEqual(unitTestRuns(impl, ['a/b.c'], { cwd: bare }), []);
  assert.deepEqual(systemsTouched(['a/b.c'], gateSystemsSettings(impl)).names, ['Other']);
  const fv = loadConfig('feature-verification', bare);
  assert.deepEqual([fv.featureVerification.precheck.testRunners, fv.featureVerification.precheck.validateScenario, fv.project.testRoots, fv.featureVerification.testExtensions, Object.keys(fv.featureVerification.precheck.lint)], [null, null, [], [], ['.md']]);
  assert.equal(loadConfig('board', bare).board.projectNumber, null, 'no board until the repository names one');
});
