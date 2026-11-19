// Hosts, trackers and CI providers as the generator sees them: which product a remote names, what `init`
// drafts, what `render` writes for GitHub Actions, GitLab CI and Azure Pipelines (and that GitHub's output
// did not change), that the generated YAML is structurally sound, and doctor's per-product rows against
// fake adapters. The pipelines themselves cannot run here: these tests check their structure only.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse, parseDocument } from 'yaml';
import { detect, loadPacks } from '../lib/detect.mjs';
import { draftConfig, draftProducts } from '../lib/init.mjs';
import { check, readManifest, render, uninstall } from '../lib/render.mjs';
import { comboProblem, parseRemote, products } from '../lib/hosting.mjs';
import { loadAdapter, productRows } from '../lib/adapters.mjs';
import { sweep } from '../lib/automations.mjs';
import { workflowProblems } from '../lib/workflow-safety.mjs';

const INSTALL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const FACTORY = path.join(INSTALL, 'bin/factory.mjs');
const packs = loadPacks(INSTALL);
const ALL = { lsp: true, graphify: true, ci: true, agentFiles: true, gitHooks: true, demoVideo: true };

function repo(files = {}, { remote = null, pin = { version: '0.0.0', tools: ['claude'], features: ALL, owners: ['@acme'] }, config = null } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'factory-prov-')));
  spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  if (remote) spawnSync('git', ['remote', 'add', 'origin', remote], { cwd: root });
  const all = { ...files, ...(pin ? { '.factory/factory.json': JSON.stringify(pin) } : {}), ...(config ? { '.factory/config.json': JSON.stringify(config) } : {}) };
  for (const [rel, text] of Object.entries(all)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  }
  return root;
}
const read = (root, rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const exists = (root, rel) => fs.existsSync(path.join(root, rel));
const fixture = (name) => JSON.parse(fs.readFileSync(path.join(INSTALL, 'scripts/factory/test/fixtures', name), 'utf8'));
const ciPart = (manifest) => Object.fromEntries(Object.entries(manifest.files).filter(([p]) => /^\.github\/(workflows|actions)\//.test(p)));

// ---- GitHub: the regression baseline ------------------------------------------------------------------

test('GitHub Actions: render writes the same workflow and action files, byte for byte, as before the provider move', () => {
  // The fixtures were written by the render of v0.2.68 (the GitHub-only line before the provider merge), except the gate and
  // demo video workflows, which deliberately changed in round C16 (implement.preOpen: they also run on story-branch pushes
  // and a PR's run reuses the push run), and the graphify cache prune workflow, whose default branch now reaches its run
  // step through env (as every ref name does) and which, since owner requirement C18, pushes a branch instead of opening a
  // pull request; those entries are the current render, checked below.
  for (const [name, features] of [['all', ALL], ['default', {}]]) {
    const root = repo({}, { remote: 'https://github.com/acme/shop.git', pin: { version: '0.0.0', tools: ['claude'], features, owners: ['@acme'] } });
    render(root, INSTALL);
    assert.deepEqual(ciPart(readManifest(root)), fixture(`github-actions-render-${name}.json`), name);
    const gate = parse(read(root, '.github/workflows/factory-gate.yml'));
    assert.deepEqual(gate.on.push.branches, ['feat/**', 'epic/**', 'bugfix/**'], 'story branches run the gate before their PR');
    assert.equal(gate.jobs.reuse.if, "github.event_name == 'pull_request'");
    assert.ok(Object.entries(gate.jobs).filter(([k]) => k !== 'reuse').every(([, j]) => j.needs.includes('reuse') && /^\$\{\{ !cancelled\(\) && needs\.reuse\.outputs\.reused != 'true'/.test(j.if)), 'every other job stands down only on a verified reuse');
    // The same with the new keys spelled out, and with legacy board keys: nothing changes.
    const before = readManifest(root).files;
    fs.writeFileSync(path.join(root, '.factory/config.json'), JSON.stringify({ host: { type: 'github', repo: 'acme/shop' }, ci: { provider: 'github-actions' }, tickets: { repo: 'acme/shop' }, board: { owner: 'acme', repo: 'acme/shop' } }));
    const again = render(root, INSTALL);
    assert.deepEqual(again.written, [], `${name}: explicit GitHub settings render nothing new`);
    assert.deepEqual(readManifest(root).files, before);
    assert.deepEqual(check(root, INSTALL), []);
  }
  // No remote at all: GitHub, as today.
  const bare = repo({}, { pin: { version: '0.0.0', tools: ['claude'], features: ALL } });
  render(bare, INSTALL);
  assert.deepEqual(ciPart(readManifest(bare)), fixture('github-actions-render-all.json'));
});

// ---- remotes ------------------------------------------------------------------------------------------

test('parseRemote: GitHub, GitLab and Azure DevOps remotes in https, ssh and legacy forms, and self-hosted servers', () => {
  const cases = [
    ['https://github.com/acme/shop.git', { type: 'github', url: 'https://github.com', repo: 'acme/shop' }],
    ['git@github.com:acme/shop.git', { type: 'github', url: 'https://github.com', repo: 'acme/shop' }],
    ['ssh://git@github.com/acme/shop', { type: 'github', url: 'https://github.com', repo: 'acme/shop' }],
    ['https://gitlab.com/group/sub/shop.git', { type: 'gitlab', url: 'https://gitlab.com', repo: 'group/sub/shop' }],
    ['git@gitlab.com:group/shop.git', { type: 'gitlab', url: 'https://gitlab.com', repo: 'group/shop' }],
    ['ssh://git@gitlab.com:2222/group/sub/shop.git', { type: 'gitlab', url: 'https://gitlab.com', repo: 'group/sub/shop' }],
    ['https://acme@dev.azure.com/acme/Shop%20Project/_git/web', { type: 'azure-devops', url: 'https://dev.azure.com', repo: 'acme/Shop Project/web' }],
    ['https://dev.azure.com/acme/Shop/_git/Shop', { type: 'azure-devops', url: 'https://dev.azure.com', repo: 'acme/Shop/Shop' }],
    ['https://dev.azure.com/acme/_git/Shop', { type: 'azure-devops', url: 'https://dev.azure.com', repo: 'acme/Shop/Shop' }],
    ['git@ssh.dev.azure.com:v3/acme/Shop/web', { type: 'azure-devops', url: 'https://dev.azure.com', repo: 'acme/Shop/web' }],
    ['https://acme.visualstudio.com/Shop/_git/web', { type: 'azure-devops', url: 'https://dev.azure.com', repo: 'acme/Shop/web' }],
    ['https://acme.visualstudio.com/DefaultCollection/Shop/_git/web', { type: 'azure-devops', url: 'https://dev.azure.com', repo: 'acme/Shop/web' }],
    ['acme@vs-ssh.visualstudio.com:v3/acme/Shop/web', { type: 'azure-devops', url: 'https://dev.azure.com', repo: 'acme/Shop/web' }],
    // Unconfigured self-hosted servers are guessed and marked.
    ['https://gitlab.example.com/platform/shop.git', { type: 'gitlab', url: 'https://gitlab.example.com', repo: 'platform/shop', guessed: true }],
    ['https://tfs.example.com/tfs/Main/Shop/_git/web', { type: 'azure-devops', url: 'https://tfs.example.com/tfs', repo: 'Main/Shop/web', guessed: true }],
    ['https://example.com/a/b.git', null],
    ['', null],
  ];
  for (const [remote, want] of cases) assert.deepEqual(parseRemote(remote), want, remote);
  // Configured self-hosted base URLs, with a path prefix, and an ssh remote of the same server.
  assert.deepEqual(parseRemote('https://code.example.com/gitlab/platform/shop.git', { type: 'gitlab', url: 'https://code.example.com/gitlab' }), { type: 'gitlab', url: 'https://code.example.com/gitlab', repo: 'platform/shop' });
  assert.deepEqual(parseRemote('git@code.example.com:platform/shop.git', { type: 'gitlab', url: 'https://code.example.com/gitlab/' }), { type: 'gitlab', url: 'https://code.example.com/gitlab', repo: 'platform/shop' });
  assert.deepEqual(parseRemote('https://ado.example.com/tfs/Main/Shop/_git/web', { type: 'azure-devops', url: 'https://ado.example.com/tfs' }), { type: 'azure-devops', url: 'https://ado.example.com/tfs', repo: 'Main/Shop/web' });
  assert.deepEqual(parseRemote('https://ghe.example.com/acme/shop.git', { type: 'github', url: 'https://ghe.example.com' }), { type: 'github', url: 'https://ghe.example.com', repo: 'acme/shop' });
});

test('products: config keys win, the remote fills the rest, legacy board keys mean GitHub, CI follows the host', () => {
  const p = (config, remote) => products('/nonexistent', { config, remote });
  assert.deepEqual([p({}, null).host.type, p({}, null).tracker.type, p({}, null).ci.provider], ['github', 'github', 'github-actions']);
  const gl = p({}, 'git@gitlab.com:g/shop.git');
  assert.deepEqual([gl.host.type, gl.host.repo, gl.tracker.type, gl.ci.provider], ['gitlab', 'g/shop', 'gitlab', 'gitlab-ci'], 'GitLab issues are the GitLab host\'s own board');
  const ado = p({}, 'https://dev.azure.com/o/P/_git/r');
  assert.deepEqual([ado.tracker.type, ado.ci.provider], ['azure-boards', 'azure-pipelines']);
  const mixed = p({ host: { type: 'azure-devops' }, tracker: { type: 'jira' } }, 'https://dev.azure.com/o/P/_git/r');
  assert.deepEqual([mixed.host.type, mixed.tracker.type, mixed.ci.provider, mixed.host.source], ['azure-devops', 'jira', 'azure-pipelines', 'config']);
  assert.equal(p({ board: { owner: 'a' } }, null).tracker.type, 'github');
  assert.equal(p({ ci: { provider: 'azure-pipelines' } }, 'https://github.com/a/b').ci.provider, 'azure-pipelines');
  assert.match(comboProblem(p({ ci: { provider: 'github-actions' } }, 'https://gitlab.com/g/p')), /cannot build a repository on gitlab/);
  assert.equal(comboProblem(p({ ci: { provider: 'azure-pipelines' } }, 'https://github.com/a/b')), null);
  assert.match(comboProblem(p({ tracker: { type: 'trello' } }, null)), /tracker.type "trello"/);
});

test('init drafts host, tracker (when the host has one) and ci.provider from the remote; GitHub keeps tickets and board', () => {
  assert.deepEqual(draftProducts(null), {});
  assert.deepEqual(draftProducts(parseRemote('https://github.com/acme/shop')), { host: { type: 'github', repo: 'acme/shop' }, ci: { provider: 'github-actions' } });
  assert.deepEqual(draftProducts(parseRemote('git@gitlab.com:g/s/shop.git')), { host: { type: 'gitlab', url: 'https://gitlab.com', repo: 'g/s/shop', token: '${GITLAB_TOKEN}' }, ci: { provider: 'gitlab-ci' }, tracker: { type: 'gitlab', project: 'g/s/shop', auth: { token: '${GITLAB_TOKEN}' } } });
  assert.deepEqual(draftProducts(parseRemote('https://dev.azure.com/acme/Shop/_git/web')), {
    host: { type: 'azure-devops', url: 'https://dev.azure.com', repo: 'acme/Shop/web', token: '${AZURE_DEVOPS_TOKEN}' },
    tracker: { type: 'azure-boards', url: 'https://dev.azure.com/acme', project: 'Shop', auth: { token: '${AZURE_DEVOPS_TOKEN}' } },
    ci: { provider: 'azure-pipelines' },
  });
  assert.match(draftProducts(parseRemote('https://gitlab.example.com/p/s')).host.$comment, /Guessed/);

  const gh = draftConfig(detect(repo({ 'main.go': 'package main\n' }, { remote: 'git@github.com:acme/shop.git', pin: null }), packs), packs);
  assert.deepEqual([gh.tickets, gh.board, gh.host, gh.ci], [{ repo: 'acme/shop' }, { owner: 'acme', repo: 'acme/shop' }, { type: 'github', repo: 'acme/shop' }, { provider: 'github-actions' }]);
  const gl = draftConfig(detect(repo({ 'main.go': 'package main\n' }, { remote: 'https://gitlab.com/g/shop.git', pin: null }), packs), packs);
  assert.equal(gl.tickets, undefined, 'no GitHub board keys for a GitLab repository');
  assert.equal(gl.tracker?.type, 'gitlab', 'GitLab: its own issues are drafted, for the interview to confirm');
  assert.equal(gl.ci.provider, 'gitlab-ci');
});

test('factory init on a GitLab clone: GitLab CI files, the root include, .gitlab/CODEOWNERS, and the toolchain script', () => {
  const root = repo({ 'main.go': 'package main\n' }, { remote: 'git@gitlab.com:platform/shop.git', pin: null });
  const r = spawnSync(process.execPath, [FACTORY, 'init', '--tools', 'claude', '--with', 'demoVideo'], { cwd: root, encoding: 'utf8', env: { ...process.env, PIPELINE_ROOT: '' } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Code host gitlab \(platform\/shop\), tracker gitlab, CI gitlab-ci/);
  const config = JSON.parse(read(root, '.factory/config.json'));
  assert.equal(config.host.token, '${GITLAB_TOKEN}');
  assert.ok(exists(root, '.gitlab/ci/factory-gate.yml') && !exists(root, '.github/workflows'));
  assert.match(read(root, '.gitlab-ci.yml'), /include:\n {2}- local: \.gitlab\/ci\/factory\.yml/);
  assert.match(read(root, '.gitlab/CODEOWNERS'), /^\/\.factory\/ @platform$/m);
  assert.ok(exists(root, '.factory/ci/toolchain.sh') && !exists(root, '.github/actions/factory-toolchain'));
  // GitLab issues drafted as the board (the tracker sweep runs on a schedule for them too).
  assert.deepEqual([config.tracker.type, config.tracker.project, config.tracker.auth.token], ['gitlab', 'platform/shop', '${GITLAB_TOKEN}']);
  fs.writeFileSync(path.join(root, '.factory/config.json'), JSON.stringify({ ...config, tracker: { type: 'jira', url: 'https://acme.atlassian.net', project: 'SHOP', auth: { user: '${JIRA_EMAIL}', token: '${JIRA_API_TOKEN}' } } }));
  assert.equal(spawnSync(process.execPath, [FACTORY, 'render'], { cwd: root, encoding: 'utf8' }).status, 0);
  assert.ok(exists(root, '.gitlab/ci/factory-tracker.yml'));
  assert.equal(spawnSync(process.execPath, [FACTORY, 'check'], { cwd: root, encoding: 'utf8' }).status, 0);
});

// ---- GitLab CI ----------------------------------------------------------------------------------------

const GITLAB_CONFIG = { host: { type: 'gitlab', repo: 'g/shop', token: '${GITLAB_TOKEN}' }, tracker: { type: 'jira', url: 'https://acme.atlassian.net', project: 'SHOP', auth: { user: '${JIRA_EMAIL}', token: '${JIRA_API_TOKEN}' } } };

// Every job of an included file set, with `extends` resolved (hash merge, arrays replaced), as GitLab does.
function gitlabJobs(root, rootFile = '.gitlab-ci.yml') {
  const docs = {};
  const load = (rel) => {
    assert.ok(exists(root, rel), `included file ${rel} is rendered`);
    const doc = parseDocument(read(root, rel));
    assert.deepEqual(doc.errors, [], `${rel} parses`);
    const data = doc.toJS({ maxAliasCount: -1 });
    docs[rel] = data;
    for (const inc of [data.include ?? []].flat()) load(typeof inc === 'string' ? inc : inc.local);
  };
  load(rootFile);
  const all = Object.assign({}, ...Object.values(docs).map(({ include: _i, ...rest }) => rest));
  const merge = (a, b) => (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b) ? Object.fromEntries([...new Set([...Object.keys(a), ...Object.keys(b)])].map((k) => [k, k in b ? merge(a[k], b[k]) : a[k]])) : b ?? a);
  const resolve = (name, seen = []) => {
    const job = all[name];
    assert.ok(job, `extends: ${name} is defined (${seen.join(' <- ')})`);
    if (!job.extends) return job;
    const { extends: base, ...own } = job;
    return merge([base].flat().reduce((acc, b) => merge(acc, resolve(b, [...seen, name])), {}), own);
  };
  return { files: Object.keys(docs), jobs: Object.fromEntries(Object.keys(all).filter((k) => !k.startsWith('.') && !['stages', 'variables', 'default', 'workflow'].includes(k)).map((k) => [k, resolve(k)])) };
}

test('GitLab CI: every rendered file parses, includes resolve to rendered files, every job has a stage, rules and a script', () => {
  const root = repo({}, { remote: 'https://gitlab.com/g/shop.git', config: GITLAB_CONFIG });
  render(root, INSTALL);
  const { files, jobs } = gitlabJobs(root);
  const rendered = Object.keys(readManifest(root).files).filter((p) => p.startsWith('.gitlab/ci/'));
  assert.deepEqual(files.slice(1).sort(), rendered.sort(), 'the root include reaches every rendered file and nothing else');
  assert.deepEqual(Object.keys(jobs).sort(), ['factory-feature-verification', 'factory-gate', 'factory-graphify-cache-prune', 'factory-lint', 'factory-pr-check', 'factory-pr-demo-video', 'factory-retro', 'factory-tracker', 'review-quorum']);
  for (const [name, job] of Object.entries(jobs)) {
    assert.equal(job.stage, 'test', `${name}: a stage every pipeline has`);
    assert.match(job.image, /^node:20/, name);
    assert.ok(Array.isArray(job.rules) && job.rules.length, `${name}: runs only when asked (rules)`);
    for (const rule of job.rules) assert.match(rule.if, /\$CI_PIPELINE_SOURCE ==/, name);
    assert.ok(Array.isArray(job.script) && job.script.every((s) => typeof s === 'string' && s.trim()), `${name}: script lines are strings (anchors resolved)`);
    assert.ok(job.before_script.join('\n').includes('fetch --quiet --depth 1 "$source" "refs/tags/v$version"'), `${name}: installs the pinned factory (its release tag)`);
    assert.ok(job.before_script.join('\n').includes('FACTORY_TOKEN'), `${name}: a private factory through FACTORY_TOKEN`);
  }
  const mr = (j) => jobs[j].rules.some((r) => r.if.includes('"merge_request_event"'));
  for (const j of ['factory-gate', 'factory-lint', 'factory-feature-verification', 'review-quorum', 'factory-pr-demo-video', 'factory-pr-check']) assert.ok(mr(j), `${j} runs on merge request pipelines`);
  for (const [j, key] of [['factory-retro', 'retro'], ['factory-tracker', 'tracker'], ['factory-graphify-cache-prune', 'graphify-cache-prune']]) assert.ok(jobs[j].rules.every((r) => r.if.includes('"schedule"') && r.if.includes(`$FACTORY_JOB == "${key}"`)), `${j} is scheduled`);
  assert.match(jobs['factory-pr-check'].rules[0].if, /CI_MERGE_REQUEST_LABELS =~ .*ai-pr-check/);
  assert.ok(jobs['factory-pr-check'].before_script.join('\n').includes('@anthropic-ai/claude-code'), 'the PR check installs the agent CLI');
  assert.equal(jobs['review-quorum'].variables.FACTORY_FROM_BASE, '1', 'the quorum runs the target branch\'s factory');
  assert.deepEqual(jobs['factory-feature-verification'].needs, ['factory-gate']);
  for (const f of rendered) assert.doesNotMatch(read(root, f), /factory:secrets|\.github\//, `${f}: no GitHub path, no unexpanded marker`);
  assert.deepEqual(check(root, INSTALL), []);
  // As on GitHub Actions: the toolchain before the stack's drift, no npm update notice, forks kept out of agent jobs.
  const gate = jobs['factory-gate'].script.join('\n');
  assert.ok(gate.indexOf('toolchain.sh') >= 0 && gate.indexOf('toolchain.sh') < gate.indexOf('teststack drift'), 'the toolchain is installed before drift');
  assert.match(jobs['factory-gate'].before_script.join('\n'), /--no-update-notifier/);
  assert.match(jobs['factory-pr-check'].rules[0].if, /\$CI_MERGE_REQUEST_SOURCE_PROJECT_ID == \$CI_PROJECT_ID/);
  assert.deepEqual(workflowProblems(root), [], 'the rendered GitLab CI files are fork-safe');
  fs.writeFileSync(path.join(root, '.gitlab/ci/factory-pr-check.yml'), read(root, '.gitlab/ci/factory-pr-check.yml').replace(' && $CI_MERGE_REQUEST_SOURCE_PROJECT_ID == $CI_PROJECT_ID', ''));
  assert.match(workflowProblems(root).map((p) => `${p.path}: ${p.problem}`).join('\n'), /factory-pr-check\.yml: job factory-pr-check runs the agent .* fork/);
});

test('GitLab CI: the team\'s .gitlab-ci.yml keeps its content; an own include: list is reported, not duplicated; uninstall takes the block back', () => {
  const team = 'stages: [build, test]\n\nbuild:\n  stage: build\n  script: [make]\n';
  const root = repo({ '.gitlab-ci.yml': team }, { remote: 'https://gitlab.com/g/shop.git', config: GITLAB_CONFIG });
  render(root, INSTALL);
  const text = read(root, '.gitlab-ci.yml');
  assert.ok(text.startsWith(team), 'the team\'s pipeline is kept as it was');
  assert.deepEqual(parse(text).include, [{ local: '.gitlab/ci/factory.yml' }]);
  assert.ok(gitlabJobs(root).jobs.build, 'the team\'s own job is still there');
  assert.deepEqual(check(root, INSTALL), []);

  // A stages: list without `test` would make the factory's jobs invalid.
  fs.writeFileSync(path.join(root, '.gitlab-ci.yml'), text.replace('stages: [build, test]', 'stages: [build, deploy]'));
  assert.match(check(root, INSTALL).map((p) => p.problem).join('\n'), /no `test` stage/);

  // An include: list of the team's own: the block only says what to add, and check reports it until then.
  const own = repo({ '.gitlab-ci.yml': 'include:\n  - template: Security/SAST.gitlab-ci.yml\n' }, { remote: 'https://gitlab.com/g/shop.git', config: GITLAB_CONFIG });
  render(own, INSTALL);
  assert.doesNotThrow(() => parse(read(own, '.gitlab-ci.yml')), 'still one include: key');
  assert.match(check(own, INSTALL).map((p) => p.problem).join('\n'), /does not name \.gitlab\/ci\/factory\.yml/);
  fs.writeFileSync(path.join(own, '.gitlab-ci.yml'), read(own, '.gitlab-ci.yml').replace('  - template: Security/SAST.gitlab-ci.yml\n', '  - template: Security/SAST.gitlab-ci.yml\n  - local: .gitlab/ci/factory.yml\n'));
  assert.deepEqual(check(own, INSTALL), []);

  uninstall(root, INSTALL);
  assert.equal(read(root, '.gitlab-ci.yml').trim(), team.replace('stages: [build, test]', 'stages: [build, deploy]').trim());
  assert.ok(!exists(root, '.gitlab'), 'no generated file or empty folder left');
});

// ---- Azure Pipelines ----------------------------------------------------------------------------------

const AZURE_CONFIG = { host: { type: 'azure-devops', repo: 'acme/Shop/web', token: '${AZURE_DEVOPS_TOKEN}' }, tracker: { type: 'jira', url: 'https://jira.example.com', project: 'SHOP', auth: { token: '${JIRA_TOKEN}' } } };

test('Azure Pipelines: every rendered file parses, templates resolve to rendered files with matching parameters, secrets are mapped', () => {
  const root = repo({}, { remote: 'https://dev.azure.com/acme/Shop/_git/web', config: AZURE_CONFIG });
  render(root, INSTALL);
  const rendered = Object.keys(readManifest(root).files).filter((p) => p.startsWith('.azure-pipelines/'));
  const pipelines = rendered.filter((p) => !p.includes('/templates/'));
  assert.deepEqual(pipelines.map((p) => path.basename(p)).sort(), ['factory-graphify-cache-prune.yml', 'factory-pr-check.yml', 'factory-pr-demo-video.yml', 'factory-pr.yml', 'factory-retro.yml', 'factory-review-quorum.yml', 'factory-tracker.yml']);
  const used = new Set();
  for (const file of rendered) {
    const doc = parseDocument(read(root, file));
    assert.deepEqual(doc.errors, [], `${file} parses`);
    assert.doesNotMatch(read(root, file), /factory:secrets/, `${file}: marker expanded`);
    const data = doc.toJS();
    if (file.includes('/templates/')) {
      assert.ok(Array.isArray(data.steps) && data.steps.length, `${file}: a steps template`);
      continue;
    }
    assert.equal(data.trigger, 'none', `${file}: no CI trigger on pushes`);
    assert.ok('pr' in data, `${file}: says whether it runs for pull requests`);
    assert.equal(data.pool.vmImage, 'ubuntu-latest');
    assert.ok(Array.isArray(data.jobs) && data.jobs.length, file);
    const declared = new Set((data.parameters ?? []).map((p) => p.name));
    for (const job of data.jobs) {
      assert.match(job.job, /^\w+$/, `${file}: job ids are identifiers`);
      for (const dep of [job.dependsOn ?? []].flat()) assert.ok(data.jobs.some((j) => j.job === dep), `${file}: ${job.job} depends on a job of the file`);
      for (const step of job.steps) {
        if (step.template) {
          const target = path.posix.join(path.posix.dirname(file), step.template);
          assert.ok(rendered.includes(target), `${file}: template ${step.template} is rendered`);
          used.add(target);
          const tpl = parse(read(root, target));
          const accepts = new Set((tpl.parameters ?? []).map((p) => p.name));
          for (const p of Object.keys(step.parameters ?? {})) assert.ok(accepts.has(p), `${file}: ${target} declares parameter ${p}`);
        }
        for (const ref of JSON.stringify(step).matchAll(/\$\{\{ parameters\.(\w+) \}\}/g)) assert.ok(declared.has(ref[1]), `${file}: parameter ${ref[1]} is declared`);
        if (step.bash && /factory /.test(step.bash) && !file.includes('graphify')) {
          assert.equal(step.env?.AZURE_DEVOPS_TOKEN, '$(System.AccessToken)', `${file}: ${step.displayName} acts as the build service`);
          assert.equal(step.env?.JIRA_TOKEN, '$(JIRA_TOKEN)', `${file}: ${step.displayName} gets the tracker's secret`);
        }
      }
      const first = job.steps[0];
      if (!file.includes('graphify')) assert.equal(first.template, 'templates/factory-setup.yml', `${file}: ${job.job} installs the factory first`);
    }
  }
  assert.deepEqual([...used].sort(), rendered.filter((p) => p.includes('/templates/')).sort(), 'every template is used');
  const quorum = parse(read(root, '.azure-pipelines/factory-review-quorum.yml'));
  assert.equal(quorum.jobs[0].displayName, 'review-quorum');
  assert.equal(quorum.jobs[0].steps[0].parameters.fromBase, true);
  assert.ok(!exists(root, '.github/CODEOWNERS') && !Object.keys(readManifest(root).files).some((p) => /CODEOWNERS/.test(p)), 'Azure DevOps has no CODEOWNERS');
  assert.deepEqual(check(root, INSTALL), []);
  // As on GitHub Actions: the release tag fetched, the toolchain before the stack's drift, forks kept out of agent jobs.
  assert.match(read(root, '.azure-pipelines/templates/factory-setup.yml'), /fetch --quiet --depth 1 "\$source" "refs\/tags\/v\$version"[\s\S]*--no-update-notifier/);
  const gate = parse(read(root, '.azure-pipelines/factory-pr.yml')).jobs[0].steps[1].bash;
  assert.ok(gate.indexOf('toolchain.sh') >= 0 && gate.indexOf('toolchain.sh') < gate.indexOf('teststack drift'), 'the toolchain is installed before drift');
  assert.deepEqual(workflowProblems(root), [], 'the rendered pipelines are fork-safe');
  fs.writeFileSync(path.join(root, '.azure-pipelines/factory-pr-check.yml'), read(root, '.azure-pipelines/factory-pr-check.yml').replace(/\n {2}condition: and\(succeeded\(\), ne\(variables\['System\.PullRequest\.IsFork'\], 'True'\)\)/, ''));
  assert.match(workflowProblems(root).map((p) => `${p.path}: ${p.problem}`).join('\n'), /factory-pr-check\.yml: job pr_check runs the agent .* forks/);
  fs.rmSync(path.join(root, '.azure-pipelines/factory-pr-check.yml'));
  uninstall(root, INSTALL);
  assert.ok(!exists(root, '.azure-pipelines'));
});

test('every provider renders the same set of jobs, and the setup equivalents', () => {
  const jobsOf = {
    'github-actions': (root) => Object.keys(readManifest(root).files).filter((p) => /^\.github\/(workflows|actions)\//.test(p)).map((p) => p.replace(/^\.github\/(workflows\/factory-|actions\/)/, '').replace(/(\/action)?\.yml$/, '')),
    'gitlab-ci': (root) => Object.keys(gitlabJobs(root).jobs).concat(['setup-factory', 'setup-agent-cli'].filter(() => /\.factory-agent-cli:/.test(read(root, '.gitlab/ci/factory-setup.yml')))),
    'azure-pipelines': (root) => Object.keys(readManifest(root).files).filter((p) => p.startsWith('.azure-pipelines/')).flatMap((p) => (p.endsWith('factory-pr.yml') ? ['gate', 'lint', 'feature-verification'] : [path.basename(p, '.yml').replace(/^factory-/, '')])),
  };
  // One name per job across providers.
  const canon = (n) => n.replace(/^factory-/, '').replace(/^feature-verification-check$/, 'feature-verification').replace(/^board-epic-assign$|^board-escalation-resolve$|^tracker-sweep$/, 'tracker').replace(/^pr-demo-video$/, 'demo-video').replace(/^pr$/, 'gate').replace(/^agent-cli$/, 'setup-agent-cli').replace(/^setup$/, 'setup-factory');
  const want = ['demo-video', 'feature-verification', 'gate', 'graphify-cache-prune', 'lint', 'pr-check', 'retro', 'review-quorum', 'setup-agent-cli', 'setup-factory', 'tracker'];
  const configs = { 'github-actions': {}, 'gitlab-ci': GITLAB_CONFIG, 'azure-pipelines': AZURE_CONFIG };
  for (const [provider, config] of Object.entries(configs)) {
    const root = repo({}, { config: { ...config, ci: { provider } } });
    render(root, INSTALL);
    let names = jobsOf[provider](root).map(canon);
    // GitHub's lint job lives in gate.yml.
    if (provider === 'github-actions') names = [...names, 'lint'];
    assert.deepEqual([...new Set(names)].sort(), want, provider);
  }
});

test('GitHub Actions with another tracker: the tracker sweep instead of the issue workflows, and its secrets mapped', () => {
  const root = repo({}, { remote: 'https://github.com/acme/shop.git', config: { tracker: { type: 'jira', url: 'https://acme.atlassian.net', project: 'SHOP', auth: { user: '${JIRA_EMAIL}', token: '${JIRA_API_TOKEN}' } } } });
  render(root, INSTALL);
  const files = Object.keys(readManifest(root).files);
  assert.ok(files.includes('.github/workflows/factory-tracker-sweep.yml'));
  assert.ok(!files.some((f) => /board-epic-assign|board-escalation-resolve/.test(f)));
  for (const f of ['factory-tracker-sweep.yml', 'factory-feature-verification-check.yml', 'factory-pr-check.yml', 'factory-retro.yml']) {
    const text = read(root, `.github/workflows/${f}`);
    assert.match(text, /^ +JIRA_API_TOKEN: \$\{\{ secrets\.JIRA_API_TOKEN \}\}$/m, f);
    assert.match(text, /^ +JIRA_EMAIL: \$\{\{ secrets\.JIRA_EMAIL \}\}$/m, f);
    assert.doesNotThrow(() => parse(text), f);
  }
  // Azure Pipelines building a GitHub repository: a supported combination.
  const az = repo({}, { remote: 'https://github.com/acme/shop.git', config: { ci: { provider: 'azure-pipelines' } } });
  render(az, INSTALL);
  assert.ok(exists(az, '.azure-pipelines/factory-pr.yml') && !exists(az, '.github/workflows'));
  assert.ok(exists(az, '.github/CODEOWNERS'), 'GitHub still reads CODEOWNERS');
  assert.match(read(az, '.azure-pipelines/factory-pr.yml'), /^ +GH_TOKEN: \$\(GH_TOKEN\)$/m, 'gh gets its token on Azure Pipelines');
});

test('switching ci.provider removes the old provider\'s files and writes the new one\'s', () => {
  const root = repo({}, { remote: 'https://github.com/acme/shop.git' });
  render(root, INSTALL);
  assert.ok(exists(root, '.github/workflows/factory-gate.yml'));
  fs.writeFileSync(path.join(root, '.factory/config.json'), JSON.stringify({ ci: { provider: 'azure-pipelines' } }));
  const r = render(root, INSTALL);
  assert.ok(r.removed.includes('.github/workflows/factory-gate.yml'));
  assert.ok(!exists(root, '.github/workflows') && exists(root, '.azure-pipelines/factory-pr.yml'));
  assert.deepEqual(check(root, INSTALL), []);
});

// ---- doctor rows and automations, against fake adapters ---------------------------------------------

const fakeHost = (over = {}) => ({ type: 'gitlab', identity: async () => ({ login: 'bot', id: 1 }), repo: { defaultBranch: async () => 'main', branchProtection: async () => ({ enforced: true, requiredChecks: ['review-quorum'], requiredApprovals: 1 }), ...(over.repo ?? {}) }, ...over.top });
const fakeTracker = (over = {}) => ({ type: 'jira', webUrl: 'https://acme.atlassian.net', reachable: async () => ({ ok: true }), board: { setup: async () => ({ url: 'https://acme.atlassian.net/projects/SHOP', done: ['project SHOP found'], manual: [] }) }, ...over });
const loader = (adapters) => async (kind) => (adapters[kind] ? { available: true, create: () => adapters[kind] } : { available: false, reason: `adapter not available: ${kind}` });
const rowOf = (rows, re) => rows.find(([what]) => re.test(what));

test('doctor rows: token variables, reachability, permissions and the required check per product, through hostFor/trackerFor', async () => {
  const config = { host: { type: 'gitlab', repo: 'g/shop', token: '${GITLAB_TOKEN}' }, tracker: { type: 'jira', url: 'https://acme.atlassian.net', project: 'SHOP', auth: { user: '${JIRA_EMAIL}', token: '${JIRA_API_TOKEN}' } } };
  const env = { GITLAB_TOKEN: 'x', JIRA_EMAIL: 'x', JIRA_API_TOKEN: 'x' };
  let r = await productRows('/nonexistent', config, { load: loader({ host: fakeHost(), tracker: fakeTracker() }), env });
  assert.ok(r.rows.every(([, ok]) => ok), JSON.stringify(r.rows));
  assert.deepEqual(r.warnings, []);
  assert.match(rowOf(r.rows, /GitLab API reachable/)[2], /as bot/);
  assert.ok(rowOf(r.rows, /review-quorum/));

  // Missing variables; the adapters not part of this install.
  r = await productRows('/nonexistent', config, { load: loader({}), env: {} });
  assert.deepEqual(rowOf(r.rows, /GitLab token variable/).slice(0, 2), ['GitLab token variable', false]);
  assert.match(rowOf(r.rows, /GitLab token variable/)[2], /GITLAB_TOKEN not set/);
  assert.match(rowOf(r.rows, /GitLab adapter/)[2], /adapter not available/);
  assert.match(rowOf(r.rows, /Jira adapter/)[2], /adapter not available/);

  // An auth failure, a tracker that does not answer, a board missing fields, an unenforced check.
  r = await productRows('/nonexistent', config, {
    load: loader({ host: fakeHost({ top: { identity: async () => { throw new Error('401 Unauthorized'); } } }), tracker: fakeTracker({ reachable: async () => ({ ok: false, reason: '403 from /rest/api/3/myself' }) }) }),
    env,
  });
  assert.deepEqual(rowOf(r.rows, /GitLab API reachable/).slice(1), [false, '401 Unauthorized']);
  assert.deepEqual(rowOf(r.rows, /Jira API reachable/).slice(1), [false, '403 from /rest/api/3/myself']);
  r = await productRows('/nonexistent', config, {
    load: loader({ host: fakeHost({ repo: { branchProtection: async () => ({ enforced: true, requiredChecks: ['build'] }), permissions: async () => ({ push: false }) } }), tracker: fakeTracker({ board: { setup: async () => ({ url: null, done: ['project SHOP found'], manual: ['create the custom field "Severity"', 'add the Blocked status to the workflow'] }) } }) }),
    env,
  });
  assert.match(r.warnings.map((w) => w.join(' ')).join('\n'), /review-quorum.*required checks: build/);
  assert.equal(rowOf(r.rows, /may push/)[1], false);
  assert.match(rowOf(r.rows, /lanes, types and fields/)[2], /by hand: create the custom field "Severity"; add the Blocked status/);
  // A host that cannot report permissions (Azure DevOps): a warning that says what to check, not a failure.
  const unsupported = Object.assign(new Error('Azure DevOps cannot report a token\'s permissions: give the PAT the Code (Read & write) scope'), { name: 'UnsupportedError' });
  r = await productRows('/nonexistent', config, { load: loader({ host: fakeHost({ repo: { permissions: async () => { throw unsupported; } } }), tracker: fakeTracker() }), env });
  assert.ok(r.rows.every(([, ok]) => ok), JSON.stringify(r.rows));
  assert.match(r.warnings.map((w) => w.join(' ')).join('\n'), /may push.*Code \(Read & write\)/);

  // Bitbucket without a tracker; an impossible CI for the host.
  r = await productRows('/nonexistent', { host: { type: 'bitbucket', token: '${GITLAB_TOKEN}' }, ci: { provider: 'github-actions' } }, { load: loader({ host: fakeHost() }), env });
  assert.equal(rowOf(r.rows, /ticket tracker/)[1], false);
  assert.equal(rowOf(r.rows, /^host bitbucket/)[1], false);

  // GitHub everywhere: only the combination row (gh rows are doctor's own).
  r = await productRows(repo({}, { remote: 'https://github.com/a/b' }), {}, { load: loader({}), env: {} });
  assert.equal(r.rows.length, 1);
  assert.ok(r.rows[0][1]);
});

test('the adapter loader reports a module that is missing instead of failing', async () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-noadapters-'));
  assert.match((await loadAdapter('host', empty)).reason, /adapter not available: scripts\/pipeline\/lib\/hosts\/index\.mjs is not part of this install/);
  const broken = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-adapters-'));
  fs.mkdirSync(path.join(broken, 'scripts/board/lib/trackers'), { recursive: true });
  fs.writeFileSync(path.join(broken, 'scripts/board/lib/trackers/index.mjs'), 'export const nothing = 1;\n');
  assert.match((await loadAdapter('tracker', broken)).reason, /does not export trackerFor/);
  // A fresh folder: ES modules are cached by URL.
  const good = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-adapters-'));
  fs.mkdirSync(path.join(good, 'scripts/board/lib/trackers'), { recursive: true });
  fs.writeFileSync(path.join(good, 'scripts/board/lib/trackers/index.mjs'), 'export const trackerFor = (c) => ({ type: c.tracker.type });\n');
  const ok = await loadAdapter('tracker', good);
  assert.equal(ok.create({ tracker: { type: 'jira' } }).type, 'jira');
});

test('automations: open epics get sync-epic, blocked tickets get resolve-check (with --label once a person marked them resolved)', async () => {
  const lists = [];
  const tracker = { tickets: { list: async (q) => (lists.push(q), q.type === 'epic' ? [{ id: 'SHOP-1', key: 'SHOP-1' }] : [{ id: 'SHOP-7', labels: ['needs-human'] }, { id: 'SHOP-9', labels: ['needs-human', 'escalation-resolved'] }]) } };
  const ran = [];
  const done = await sweep({ board: { blockedLabel: 'needs-human', resolvedLabel: 'escalation-resolved' } }, { tracker, run: async (args) => (ran.push(args.join(' ')), args[1] === 'SHOP-9' ? 1 : 0) });
  assert.deepEqual(lists, [{ type: 'epic', state: 'open' }, { state: 'open', label: 'needs-human' }]);
  assert.deepEqual(ran, ['sync-epic SHOP-1', 'resolve-check SHOP-7', 'resolve-check SHOP-9 --label']);
  assert.deepEqual([done.epics, done.escalations, done.failed], [1, 2, ['resolve-check SHOP-9 --label (exit 1)']]);
});

test('GitHub Actions: no rendered run step expands a branch or ref name inline (it goes through env, so a crafted branch name cannot inject a command)', () => {
  const root = repo({}, { remote: 'https://github.com/acme/shop.git', pin: { version: '0.0.0', tools: ['claude'], features: ALL, owners: ['@acme'] } });
  render(root, INSTALL);
  const dir = path.join(root, '.github/workflows');
  const bad = [];
  for (const f of fs.readdirSync(dir).filter((x) => x.startsWith('factory-'))) {
    const doc = parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    for (const [id, job] of Object.entries(doc.jobs ?? {}))
      for (const step of job.steps ?? []) if (/\$\{\{[^}]*(head_ref|base_ref|head\.ref|ref_name|default_branch|head_branch|\.title|\.body)/.test(String(step.run ?? ''))) bad.push(`${f} ${id}: ${step.name ?? step.run}`);
  }
  assert.deepEqual(bad, []);
});
