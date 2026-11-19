// Which code host, ticket tracker and CI system a repository uses, as the generator sees them: read from
// .factory/config.json (`host`, `tracker`, `ci.provider`) and, where a key is missing, derived from the
// `origin` remote. The adapters themselves (scripts/pipeline/lib/hosts/, scripts/board/lib/trackers/) do
// the API work; this module only names the products so `init`, `render` and `doctor` agree on them.
//
// Backward compatibility: a repository with no `host`, `tracker` or `ci` keys keeps meaning GitHub when its
// origin is GitHub (or there is no origin), with GitHub issues as the tracker and GitHub Actions as CI.
import { CI_FOR_HOST, CI_PROVIDERS, DEFAULT_URLS, detectHost, HOST_TYPES, originRemote as origin, resolveProducts, TRACKER_FOR_HOST, TRACKER_TYPES } from '../../pipeline/lib/products.mjs';
import fs from 'node:fs';
import path from 'node:path';

// Product names and defaults live in scripts/pipeline/lib/products.mjs, shared with the adapters.
export { CI_FOR_HOST, CI_PROVIDERS, TRACKER_FOR_HOST };
export const HOSTS = HOST_TYPES;
export const TRACKERS = TRACKER_TYPES;
export const DEFAULT_URL = DEFAULT_URLS;
// The environment variable a drafted config names for each product's token (`${NAME}` expansion).
export const TOKEN_VARS = { gitlab: 'GITLAB_TOKEN', 'azure-devops': 'AZURE_DEVOPS_TOKEN', bitbucket: 'BITBUCKET_TOKEN', jira: ['JIRA_EMAIL', 'JIRA_API_TOKEN'], 'azure-boards': 'AZURE_DEVOPS_TOKEN', linear: 'LINEAR_API_KEY', jenkins: 'JENKINS_API_TOKEN', circleci: 'CIRCLECI_TOKEN' };

// What the generator says about each CI system: doctor's fork-safety row and what a person does after `render`.
export const CI_INFO = {
  'github-actions': { label: 'GitHub Actions', safetyRow: 'workflows keep FACTORY_TOKEN from forks and outsiders', safetyNote: 'no pull_request_target / workflow_run with secrets; comment triggers check author_association' },
  'gitlab-ci': { label: 'GitLab CI', safetyNote: 'agent jobs skip merge requests from forks; keep secret variables masked' },
  'azure-pipelines': { label: 'Azure Pipelines', safetyNote: 'agent jobs skip pull requests from forks; keep "Make secrets available to builds of forks" off', afterRender: 'Azure Pipelines: create one pipeline per .azure-pipelines/factory-*.yml file and add the gate and review-quorum as build validations (docs/providers/ci/azure-pipelines.md).' },
  jenkins: { label: 'Jenkins', safetyNote: 'the factory pipeline runs only for branches of this repository (no fork PR builds with credentials); credentials come from the Jenkins credentials store', afterRender: 'Jenkins: create a Multibranch Pipeline job with script path ci/jenkins/Jenkinsfile.factory, a Pipeline job on the default branch with script path ci/jenkins/Jenkinsfile.factory-scheduled, and the secret-text credentials named in them (docs/providers/ci/jenkins.md).' },
  circleci: { label: 'CircleCI', safetyNote: 'keep "Pass secrets to builds from forked pull requests" off; contexts hold the tokens', afterRender: 'CircleCI: create the `factory` context with the secrets, and scheduled pipelines (Project settings > Triggers) with the parameter factory-job set to tracker (every 15 minutes), retro and graphify-prune (weekly) (docs/providers/ci/circleci.md).' },
  'bitbucket-pipelines': { label: 'Bitbucket Pipelines', safetyNote: 'secured repository variables are not passed to pull requests from forks', afterRender: 'Bitbucket Pipelines: add the schedules listed in bitbucket-pipelines.yml\'s comments under Pipelines > Schedules (docs/providers/ci/bitbucket-pipelines.md).' },
};

// Which CI system can run the pipelines of a repository on which host. `full`: pull request triggers,
// statuses and scheduled jobs. `partial`: works through a mirror or an external-repository integration,
// with limits (docs/hosts-and-trackers.md). `none`: the CI system cannot build that host's repositories.
// Jenkins builds any git host (its branch source plugins report statuses to GitHub, GitLab, Bitbucket and, with the Azure
// DevOps plugin, Azure Repos); CircleCI builds GitHub, GitLab and Bitbucket Cloud; `custom` is whatever the team runs.
export const CI_SUPPORT = {
  github: { 'github-actions': 'full', 'azure-pipelines': 'full', 'gitlab-ci': 'partial', jenkins: 'full', circleci: 'full', 'bitbucket-pipelines': 'none', custom: 'full' },
  gitlab: { 'github-actions': 'none', 'azure-pipelines': 'none', 'gitlab-ci': 'full', jenkins: 'full', circleci: 'full', 'bitbucket-pipelines': 'none', custom: 'full' },
  'azure-devops': { 'github-actions': 'none', 'azure-pipelines': 'full', 'gitlab-ci': 'partial', jenkins: 'partial', circleci: 'none', 'bitbucket-pipelines': 'none', custom: 'full' },
  bitbucket: { 'github-actions': 'none', 'azure-pipelines': 'full', 'gitlab-ci': 'none', jenkins: 'full', circleci: 'full', 'bitbucket-pipelines': 'full', custom: 'full' },
  custom: { 'github-actions': 'partial', 'azure-pipelines': 'partial', 'gitlab-ci': 'partial', jenkins: 'full', circleci: 'partial', 'bitbucket-pipelines': 'partial', custom: 'full' },
};

// The host of an origin remote: { type, url, repo } (and `guessed: true` for a self-hosted server that
// only its name or path gave away), or null. `configured` (the config's `host`) recognises a self-hosted
// GitLab or Azure DevOps Server by its base URL. The parsing is the host layer's (products.mjs detectHost).
export function parseRemote(remote, configured = {}) {
  return detectHost(remote, { type: configured?.type ?? null, url: configured?.url ?? null, markGuess: true });
}

export const originRemote = (root) => origin(root) || null;

const readConfig = (root) => {
  const file = path.join(root, '.factory/config.json');
  if (!fs.existsSync(file)) return {};
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
};

// What a repository uses: { host, tracker, ci } with each a type (or null for a tracker GitLab cannot
// default) and where it came from. `config` defaults to .factory/config.json; `remote` to origin.
export function products(root, { config = readConfig(root), remote = undefined } = {}) {
  const r = resolveProducts({ ...config, root }, { remote: remote === undefined ? originRemote(root) : remote });
  const { guessed: _g, ...host } = r.host;
  return { host: { ...host, repo: host.repo }, tracker: r.tracker, ci: r.ci, remote: r.remote };
}

// A problem with the combination, or null: an unknown name, or a CI system that cannot build that host.
export function comboProblem({ host, tracker, ci }) {
  if (!HOSTS.includes(host.type)) return `host.type "${host.type}" is not one of ${HOSTS.join(', ')}`;
  if (tracker.type && !TRACKERS.includes(tracker.type)) return `tracker.type "${tracker.type}" is not one of ${TRACKERS.join(', ')}`;
  if (!CI_PROVIDERS.includes(ci.provider)) return `ci.provider "${ci.provider}" is not one of ${CI_PROVIDERS.join(', ')}`;
  if (CI_SUPPORT[host.type][ci.provider] === 'none') return `${ci.provider} cannot build a repository on ${host.type}; use ${CI_FOR_HOST[host.type]} (docs/hosts-and-trackers.md)`;
  return null;
}

// The `${NAME}` variables a config value names (a token, a user).
export const envNames = (value) => [...String(value ?? '').matchAll(/\$\{(\w+)\}/g)].map((m) => m[1]);
