// What `factory render` writes for every CI system, parsed: YAML for GitHub Actions, GitLab CI, Azure Pipelines,
// CircleCI and Bitbucket Pipelines; the declarative Pipeline structure for Jenkins; the shared job script for the
// systems that call it. The pipelines cannot run here: these tests check their structure, the jobs every system gets,
// the secrets each takes from its own store, and that a team's own single definition file is never overwritten.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseDocument } from 'yaml';
import { check, readManifest, render } from '../lib/render.mjs';

const INSTALL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const ALL = { lsp: false, graphify: true, ci: true, agentFiles: false, gitHooks: false, demoVideo: true };

function repo(provider, { remote = 'https://bitbucket.org/ws/shop.git', files = {}, features = ALL } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `ci-render-${provider}-`)));
  spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  spawnSync('git', ['remote', 'add', 'origin', remote], { cwd: root });
  const config = { tracker: { type: 'jira', url: 'https://acme.atlassian.net', project: 'SHOP', auth: { user: '${JIRA_EMAIL}', token: '${JIRA_API_TOKEN}' } }, ci: { provider, url: 'https://ci.acme.io', job: 'team/shop' }, analysis: {} };
  for (const [rel, text] of Object.entries({ '.factory/factory.json': JSON.stringify({ version: '0.0.0', tools: ['claude'], features, owners: ['@acme'] }), '.factory/config.json': JSON.stringify(config), ...files })) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  }
  return root;
}
const read = (root, rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const yamlOk = (text, what) => {
  const doc = parseDocument(text);
  assert.deepEqual(doc.errors.map((e) => e.message), [], what);
  return doc.toJS();
};

// The declarative Pipeline's structure: balanced braces outside strings, one pipeline block, stages each with steps.
function groovyOk(text, what) {
  const code = text.replace(/\/\/.*$/gm, '').replace(/'(?:[^'\\]|\\.)*'/g, "''").replace(/"(?:[^"\\]|\\.)*"/g, '""');
  let depth = 0;
  for (const c of code) {
    if (c === '{') depth++;
    if (c === '}') depth--;
    assert.ok(depth >= 0, `${what}: a closing brace without an opening one`);
  }
  assert.equal(depth, 0, `${what}: unbalanced braces`);
  assert.match(code, /^pipeline \{/m, `${what}: one pipeline block`);
  assert.match(code, /^ {2}stages \{/m, `${what}: stages`);
  const stages = [...code.matchAll(/stage\((?:''|"")\) \{/g)].length;
  assert.equal([...code.matchAll(/steps \{/g)].length, stages, `${what}: every stage has steps`);
  return stages;
}

test('Jenkins: a declarative Jenkinsfile for pull requests and one for the schedules; credentials from the Jenkins store', () => {
  const root = repo('jenkins');
  render(root, INSTALL);
  const pr = read(root, 'ci/jenkins/Jenkinsfile.factory');
  assert.ok(groovyOk(pr, 'Jenkinsfile.factory') >= 6);
  for (const job of ['gate', 'lint', 'feature-verification', 'review-quorum', 'demo-video', 'pr-check']) assert.match(pr, new RegExp(`factory-ci\\.sh ${job}`), job);
  assert.match(pr, /JIRA_API_TOKEN = credentials\('jira-api-token'\)/);
  assert.match(pr, /stage\("Secret scan"\)/, 'the analysis jobs are stages');
  groovyOk(read(root, 'ci/jenkins/Jenkinsfile.factory-scheduled'), 'scheduled');
  assert.equal(spawnSync('bash', ['-n', path.join(root, '.factory/ci/factory-ci.sh')]).status, 0, 'the shared script parses');
  assert.deepEqual(check(root, INSTALL), []);
});

test('CircleCI: one config with the jobs, the workflows and the analysis jobs; secrets from a context; schedules are parameters', () => {
  const root = repo('circleci', { remote: 'git@github.com:acme/shop.git' });
  render(root, INSTALL);
  const cfg = yamlOk(read(root, '.circleci/config.yml'), 'config.yml');
  assert.equal(cfg.version, 2.1);
  for (const j of ['factory-gate', 'factory-lint', 'factory-feature-verification', 'review-quorum', 'factory-demo-video', 'factory-scheduled', 'factory-analysis-secrets']) assert.ok(cfg.jobs[j], j);
  const wf = cfg.workflows.factory.jobs.map((j) => Object.keys(j)[0]);
  assert.ok(wf.includes('factory-analysis-sast') && wf.includes('review-quorum'));
  assert.ok(cfg.workflows.factory.jobs.every((j) => Object.values(j)[0].context?.includes('factory')), 'every job reads the factory context');
  assert.deepEqual(check(root, INSTALL), []);
});

test('Bitbucket Pipelines: pull request pipeline with the analysis steps, custom pipelines for the schedules and the PR check', () => {
  const root = repo('bitbucket-pipelines');
  render(root, INSTALL);
  const cfg = yamlOk(read(root, 'bitbucket-pipelines.yml'), 'bitbucket-pipelines.yml');
  const pr = cfg.pipelines['pull-requests']['**'];
  const names = JSON.stringify(pr);
  for (const s of ['factory gate', 'review-quorum', 'feature verification', 'Secret scan', 'demo video']) assert.ok(names.includes(s), s);
  assert.deepEqual(Object.keys(cfg.pipelines.custom).sort(), ['factory-graphify-prune', 'factory-pr-check', 'factory-retro', 'factory-tracker']);
  assert.deepEqual(check(root, INSTALL), []);
});

test('a team\'s own single definition file is never overwritten: the factory\'s goes next to it and check says what to merge', () => {
  for (const [provider, own, copy, remote] of [['circleci', '.circleci/config.yml', '.circleci/factory.yml', 'git@github.com:acme/shop.git'], ['bitbucket-pipelines', 'bitbucket-pipelines.yml', 'bitbucket-pipelines.factory.yml', 'https://bitbucket.org/ws/shop.git']]) {
    const mine = provider === 'circleci' ? 'version: 2.1\njobs:\n  build:\n    docker: [{ image: cimg/base:current }]\n    steps: [checkout]\n' : 'pipelines:\n  default:\n    - step:\n        script: [make]\n';
    const root = repo(provider, { remote, files: { [own]: mine } });
    render(root, INSTALL);
    assert.equal(read(root, own), mine, `${provider}: untouched`);
    yamlOk(read(root, copy), copy);
    assert.match(check(root, INSTALL).map((p) => p.problem).join('\n'), /merge the factory's jobs/, provider);
    assert.ok(!Object.keys(readManifest(root).files).includes(own));
  }
});

test('demo video and code graph stages leave every definition when the feature is off', () => {
  for (const provider of ['jenkins', 'circleci', 'bitbucket-pipelines']) {
    const root = repo(provider, { features: { ...ALL, demoVideo: false, graphify: false } });
    render(root, INSTALL);
    const files = Object.keys(readManifest(root).files).filter((p) => /jenkins|circleci|bitbucket/.test(p));
    for (const f of files) {
      assert.doesNotMatch(read(root, f), /demo-video|demo video/i, `${provider} ${f}`);
      if (f.endsWith('.yml')) yamlOk(read(root, f), f);
      else groovyOk(read(root, f), f);
    }
  }
});

test('GitHub Actions, GitLab CI and Azure Pipelines definitions still parse (every file the factory writes)', () => {
  for (const [provider, remote] of [['github-actions', 'git@github.com:acme/shop.git'], ['gitlab-ci', 'git@gitlab.com:g/shop.git'], ['azure-pipelines', 'https://dev.azure.com/o/p/_git/shop']]) {
    const root = repo(provider, { remote });
    render(root, INSTALL);
    for (const f of Object.keys(readManifest(root).files).filter((p) => /\.ya?ml$/.test(p) && /\.github|\.gitlab|\.azure-pipelines/.test(p))) yamlOk(read(root, f), `${provider} ${f}`);
  }
});
