// GitLab CI as the CI system: the expected pipeline of a head is GitLab's own pipeline for it (the merge request
// pipeline, or the branch pipeline), as "Pipelines must succeed" sees it; runs, failed jobs' logs and retries come from
// the REST API v4. Docs read 2026-11-17: https://docs.gitlab.com/api/pipelines/ (list ?sha=&ref=, statuses created,
// waiting_for_resource, preparing, pending, running, success, failed, canceled, skipped, manual, scheduled; POST
// .../retry), https://docs.gitlab.com/api/jobs/ (pipeline jobs ?scope[]=failed, GET /jobs/:id/trace).
//
// settings: { url, repo ("group/project": the host's), token ("${GITLAB_TOKEN}"), expected }. deps: { send, env }.
import { UnsupportedError } from '../hosts/errors.mjs';
import { ciClient, run, secret } from './rest.mjs';

export const CAPABILITIES = { logs: true, expectedFromDefinition: true, runsByCommit: true, reviewEvents: false, schedules: 'partial', rerun: true, branchPipelines: true };
const STATUS = { created: 'queued', waiting_for_resource: 'queued', preparing: 'queued', pending: 'queued', scheduled: 'queued', manual: 'queued', running: 'running', success: 'completed', failed: 'completed', canceled: 'completed', skipped: 'completed' };
const CONCLUSION = { success: 'success', failed: 'failure', canceled: 'cancelled', skipped: 'skipped' };
export const PIPELINE = 'gitlab-pipeline';

export function createGitlabCi(settings = {}, deps = {}) {
  const config = deps.config ?? {};
  const url = String(settings.url ?? config.host?.url ?? 'https://gitlab.com').replace(/\/+$/, '');
  const repo = settings.project ?? settings.repo ?? config.host?.repo;
  const env = deps.env ?? process.env;
  const token = secret(settings.token, 'ci.token', env) ?? secret(config.host?.token, 'host.token', env) ?? env.GITLAB_TOKEN ?? env.CI_JOB_TOKEN ?? null;
  const api = ciClient({ baseUrl: `${url}/api/v4`, token, header: 'PRIVATE-TOKEN', product: 'GitLab CI', send: deps.send });
  const P = () => {
    if (!repo) throw new Error('the GitLab project is unknown: set host.repo (or ci.project) in .factory/config.json');
    return `/projects/${encodeURIComponent(repo)}`;
  };
  return {
    type: 'gitlab-ci',
    label: 'GitLab CI',
    capabilities: CAPABILITIES,
    pushEvents: ['push'],
    prEvents: null,
    // One pipeline per head: GitLab's merge request (or branch) pipeline is what "Pipelines must succeed" requires.
    expected() {
      return [{ id: PIPELINE, name: 'GitLab pipeline', required: true }];
    },
    runs({ head = null, branch = null, limit = 20 } = {}) {
      const q = new URLSearchParams({ per_page: String(limit ?? 20), order_by: 'id', sort: 'desc', ...(head ? { sha: head } : {}), ...(!head && branch ? { ref: branch } : {}) });
      return (api.json('GET', `${P()}/pipelines?${q}`) ?? []).map((p) => run(p.id, PIPELINE, `GitLab pipeline #${p.id}`, STATUS[p.status] ?? 'queued', CONCLUSION[p.status] ?? 'failure', { event: p.source === 'merge_request_event' ? 'pull_request' : p.source ?? 'push', url: p.web_url, sha: p.sha, createdAt: p.created_at }));
    },
    log(runId, { failedOnly = false } = {}) {
      const jobs = api.json('GET', `${P()}/pipelines/${runId}/jobs?per_page=100${failedOnly ? '&scope[]=failed' : ''}`) ?? [];
      return jobs.map((j) => `== ${j.name} (${j.status})\n${api.text(`${P()}/jobs/${j.id}/trace`)}`).join('\n');
    },
    rerun(runId) {
      api.json('POST', `${P()}/pipelines/${runId}/retry`);
    },
    // GitLab requires the whole pipeline ("Pipelines must succeed"), not named checks.
    requiredChecks: () => [],
    // Its pipelines are required whole (or by the host's own policy): no job of it is left uncovered by name.
    uncoveredChecks: () => [],
    definitionFiles: () => ['.gitlab-ci.yml'],
    unsupported: (what) => {
      throw new UnsupportedError(what);
    },
  };
}
