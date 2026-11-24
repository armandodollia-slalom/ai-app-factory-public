// The static analysis CI jobs on every CI system this line renders for (GitHub Actions, GitLab CI, Azure Pipelines):
// one provider-neutral job list, one generated Node script, each provider's file from `factory render`, and nothing at
// all without an analysis section. The full analysis feature (fix loop, reports, licences, doctor) is on
// feature/analysis (dogfood/eshop line); this is its CI slice for the adapters line.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import YAML from 'yaml';
import { INSTALL_ROOT } from '../lib/config.mjs';
import { renderAzurePipelines, renderGithubActions, renderGitlabCi, AZURE_FILE, CI_SCRIPT, GITHUB_WORKFLOW, GITLAB_FILE } from '../lib/analysis/ci.mjs';
import { resolveAnalysis } from '../lib/analysis/config.mjs';
import { outputs } from '../../factory/lib/render.mjs';

const tmp = (p) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));
const write = (root, rel, text) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), text);
};
const PIN = { version: '0.3.0', tools: ['claude'], features: { lsp: false, graphify: false, ci: true, agentFiles: false, gitHooks: false, demoVideo: false } };

function repo(config) {
  const root = tmp('anci-');
  spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  write(root, '.factory/config.json', JSON.stringify(config));
  write(root, '.factory/factory.json', JSON.stringify(PIN));
  return root;
}

test('the packs\' jobs are rendered for each CI system and only call the generated script', () => {
  const a = resolveAnalysis({ root: '/r', project: { languages: ['dotnet'] }, featureVerification: { precheck: {} }, analysis: {} });
  const jobs = a.ci.jobs;
  assert.deepEqual(jobs.map((j) => j.id), ['secrets', 'dependencies', 'sast', 'workflows']);
  const gh = YAML.parse(renderGithubActions(jobs));
  assert.deepEqual(gh.permissions, { contents: 'read' });
  for (const j of Object.values(gh.jobs)) assert.doesNotMatch(j.steps.find((s) => s.run).run, /\$\{\{/);
  const gl = YAML.parse(renderGitlabCi(jobs));
  for (const j of Object.values(gl)) {
    assert.equal(j.stage, 'test');
    assert.match(j.script.join('\n'), /node \.factory\/bin\/analysis\/ci\.mjs --job \S+ --base "origin\/\$CI_MERGE_REQUEST_TARGET_BRANCH_NAME"/);
    assert.equal(j.rules[0].if, '$CI_PIPELINE_SOURCE == "merge_request_event"');
  }
  const az = YAML.parse(renderAzurePipelines(jobs));
  assert.equal(az.trigger, 'none');
  assert.deepEqual(az.jobs.map((j) => j.job), ['secrets', 'dependencies', 'sast', 'workflows']);
  for (const j of az.jobs) assert.ok(j.steps.every((s) => !s.task || s.task === 'NodeTool@0'), 'only built-in Azure tasks');
});

test('render: each provider gets its analysis file and the shared script; GitLab includes it from the root include', () => {
  const config = { analysis: {} };
  const github = outputs(repo({ ...config, ci: { provider: 'github-actions' } }), INSTALL_ROOT, PIN).map((o) => o.path);
  assert.ok(github.includes(GITHUB_WORKFLOW) && github.includes(CI_SCRIPT));
  const glRoot = repo({ ...config, ci: { provider: 'gitlab-ci' } });
  const gitlab = outputs(glRoot, INSTALL_ROOT, PIN);
  assert.ok(gitlab.some((o) => o.path === GITLAB_FILE) && gitlab.some((o) => o.path === CI_SCRIPT));
  assert.match(gitlab.find((o) => o.path === '.gitlab/ci/factory.yml').content, /- local: \.gitlab\/ci\/factory-analysis\.yml/);
  assert.doesNotMatch(gitlab.find((o) => o.path === '.gitlab/ci/factory.yml').content, /\.factory\/bin/);
  const azure = outputs(repo({ ...config, ci: { provider: 'azure-pipelines' } }), INSTALL_ROOT, PIN).map((o) => o.path);
  assert.ok(azure.includes(AZURE_FILE) && azure.includes(CI_SCRIPT));
  // Without an analysis section nothing is added on any provider.
  for (const provider of ['github-actions', 'gitlab-ci', 'azure-pipelines']) assert.ok(!outputs(repo({ ci: { provider } }), INSTALL_ROOT, PIN).some((o) => o.path.includes('analysis')), provider);
});
