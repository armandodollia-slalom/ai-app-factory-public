// Bitbucket Pipelines as the CI system: the head's run is the pipeline whose target commit is the head (a pull request
// pipeline or a branch pipeline); logs are its steps' logs. Docs read 2026-11-17:
// https://developer.atlassian.com/cloud/bitbucket/rest/api-group-pipelines/ (GET /repositories/{ws}/{repo}/pipelines/
// sorted by -created_on; state.name PENDING|IN_PROGRESS|COMPLETED, state.result.name SUCCESSFUL|FAILED|ERROR|STOPPED|
// EXPIRED; GET .../pipelines/{uuid}/steps/ and .../steps/{step_uuid}/log). The commit filter of the list is unreliable
// for pull request pipelines (Atlassian BCLOUD-23160: they record a short hash), so the latest pipelines are listed and
// matched by hash prefix here. Re-running a pipeline has no API: capability rerun is off.
//
// settings: the host's repo ("workspace/repository") and token (`${BITBUCKET_TOKEN}`, scope pipeline:read), or
// ci.repo / ci.token.
import { UnsupportedError } from '../hosts/errors.mjs';
import { apiBase } from '../hosts/bitbucket.mjs';
import { ciClient, run, secret } from './rest.mjs';

export const CAPABILITIES = { logs: true, expectedFromDefinition: true, runsByCommit: true, reviewEvents: false, schedules: 'partial', rerun: false, branchPipelines: true };
const STATE = { PENDING: 'queued', IN_PROGRESS: 'running', PAUSED: 'running', HALTED: 'running', COMPLETED: 'completed' };
const RESULT = { SUCCESSFUL: 'success', FAILED: 'failure', ERROR: 'failure', STOPPED: 'cancelled', EXPIRED: 'cancelled' };
export const PIPELINE = 'bitbucket-pipeline';
const sameCommit = (a, b) => Boolean(a && b) && (a.startsWith(b) || b.startsWith(a));

export function createBitbucketPipelines(settings = {}, deps = {}) {
  const config = deps.config ?? {};
  const env = deps.env ?? process.env;
  const repo = settings.repo ?? config.host?.repo ?? null;
  const token = secret(settings.token, 'ci.token', env) ?? secret(config.host?.token, 'host.token', env) ?? env.BITBUCKET_TOKEN ?? null;
  const user = secret(settings.user ?? config.host?.user, 'host.user', env);
  const api = ciClient({ baseUrl: apiBase(config.host?.url), token, user, product: 'Bitbucket Pipelines', send: deps.send });
  const R = () => {
    if (!repo) throw new Error('the Bitbucket repository is unknown: set host.repo ("workspace/repository") in .factory/config.json');
    return `/repositories/${repo.split('/').map(encodeURIComponent).join('/')}`;
  };
  const enc = encodeURIComponent;
  return {
    type: 'bitbucket-pipelines',
    label: 'Bitbucket Pipelines',
    capabilities: CAPABILITIES,
    pushEvents: null,
    prEvents: null,
    // One pipeline per head: bitbucket-pipelines.yml's pull request pipeline (or the branch's).
    expected() {
      return [{ id: PIPELINE, name: 'Bitbucket pipeline', required: true }];
    },
    runs({ head = null, branch = null, limit = 50 } = {}) {
      const q = new URLSearchParams({ sort: '-created_on', pagelen: String(Math.min(limit ?? 50, 100)), ...(!head && branch ? { 'target.branch': branch } : {}) });
      const list = api.json('GET', `${R()}/pipelines/?${q}`)?.values ?? [];
      return list
        .filter((p) => !head || sameCommit(p.target?.commit?.hash, head))
        .map((p) => run(p.uuid, PIPELINE, `Bitbucket pipeline #${p.build_number}`, STATE[p.state?.name] ?? 'queued', RESULT[p.state?.result?.name] ?? 'failure', { event: /pullrequest/.test(p.target?.type ?? '') ? 'pull_request' : 'push', url: repo ? `https://bitbucket.org/${repo}/pipelines/results/${p.build_number}` : null, sha: p.target?.commit?.hash ?? null, createdAt: p.created_on }));
    },
    log(runId, { failedOnly = false } = {}) {
      const steps = api.json('GET', `${R()}/pipelines/${enc(runId)}/steps/`)?.values ?? [];
      return steps
        .filter((s) => !failedOnly || ['FAILED', 'ERROR'].includes(s.state?.result?.name))
        .map((s) => `== ${s.name ?? s.uuid}\n${api.text(`${R()}/pipelines/${enc(runId)}/steps/${enc(s.uuid)}/log`, { accept: '*/*' })}`)
        .join('\n');
    },
    rerun() {
      throw new UnsupportedError('Bitbucket Pipelines has no API to re-run a pipeline: a person reruns it from the pipeline page');
    },
    requiredChecks: () => [],
    // Its pipelines are required whole (or by the host's own policy): no job of it is left uncovered by name.
    uncoveredChecks: () => [],
    definitionFiles: () => ['bitbucket-pipelines.yml'],
  };
}
