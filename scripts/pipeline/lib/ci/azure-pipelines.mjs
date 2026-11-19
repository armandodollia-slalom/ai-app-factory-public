// Azure Pipelines as the CI system: the pipelines a pull request's head must run are the branch's Build validation
// policies (each policy's build definition, blocking or optional); runs are the builds of the PR's merge ref whose
// triggerInfo names the head as pr.sourceSha (Azure builds the merge commit, sourceVersion is not the head); logs come
// from the build timeline. Docs read 2026-11-17: https://learn.microsoft.com/rest/api/azure/devops/build/builds/list
// (branchName, repositoryId, queryOrder, status notStarted|inProgress|completed|cancelling|postponed, result
// succeeded|partiallySucceeded|failed|canceled, triggerInfo), .../build/timeline/get, .../build/builds/get-build-log,
// .../policy/configurations/list (Build policy type 0609b952-1397-4640-95ec-e00a01b2c241), .../builds/update-build (retry).
//
// settings: { url, repo ("organization/project/repository": the host's), token ("${AZURE_DEVOPS_TOKEN}"), project }.
import { ciClient, run, secret } from './rest.mjs';

export const CAPABILITIES = { logs: true, expectedFromDefinition: true, runsByCommit: true, reviewEvents: false, schedules: true, rerun: true, branchPipelines: false };
export const BUILD_POLICY = '0609b952-1397-4640-95ec-e00a01b2c241';
const STATUS = { notStarted: 'queued', postponed: 'queued', inProgress: 'running', cancelling: 'running', completed: 'completed' };
const RESULT = { succeeded: 'success', partiallySucceeded: 'failure', failed: 'failure', canceled: 'cancelled' };
const API = 'api-version=7.1';

export function createAzurePipelines(settings = {}, deps = {}) {
  const config = deps.config ?? {};
  const url = String(settings.url ?? config.host?.url ?? 'https://dev.azure.com').replace(/\/+$/, '');
  const [org, project, repository] = String(settings.repo ?? config.host?.repo ?? '').split('/');
  const env = deps.env ?? process.env;
  const token = secret(settings.token, 'ci.token', env) ?? secret(config.host?.token, 'host.token', env) ?? env.AZURE_DEVOPS_TOKEN ?? env.SYSTEM_ACCESSTOKEN ?? null;
  const api = ciClient({ baseUrl: url, token, user: '', product: 'Azure Pipelines', send: deps.send });
  const P = () => {
    if (!org || !project) throw new Error('the Azure DevOps project is unknown: set host.repo ("organization/project/repository") in .factory/config.json');
    return `/${encodeURIComponent(org)}/${encodeURIComponent(project)}/_apis`;
  };
  let repoId = null;
  const repositoryId = () => (repoId ??= api.json('GET', `${P()}/git/repositories/${encodeURIComponent(repository)}?${API}`)?.id);
  const prNum = (pr) => String(pr ?? '').match(/(\d+)\/?$/)?.[1] ?? null;
  return {
    type: 'azure-pipelines',
    label: 'Azure Pipelines',
    capabilities: CAPABILITIES,
    prEvents: null,
    // The Build validation policies of the target branch: each build definition a PR into it must pass (a non-blocking
    // policy is expected only once it runs).
    expected({ base }) {
      const list = api.json('GET', `${P()}/policy/configurations?repositoryId=${repositoryId()}&refName=${encodeURIComponent(`refs/heads/${base}`)}&policyType=${BUILD_POLICY}&${API}`)?.value ?? [];
      return list.filter((p) => p.isEnabled && !p.isDeleted).map((p) => ({ id: `def-${p.settings?.buildDefinitionId}`, name: p.settings?.displayName || `build definition ${p.settings?.buildDefinitionId}`, required: Boolean(p.isBlocking) }));
    },
    runs({ head = null, branch = null, pr = null, limit = 50 } = {}) {
      const n = prNum(pr);
      const ref = n ? `refs/pull/${n}/merge` : branch ? `refs/heads/${branch}` : null;
      const q = `repositoryId=${repositoryId()}&repositoryType=TfsGit${ref ? `&branchName=${encodeURIComponent(ref)}` : ''}&queryOrder=queueTimeDescending&$top=${limit ?? 50}&${API}`;
      const builds = api.json('GET', `${P()}/build/builds?${q}`)?.value ?? [];
      return builds
        .filter((b) => !head || b.triggerInfo?.['pr.sourceSha'] === head || b.sourceVersion === head)
        .map((b) => run(b.id, `def-${b.definition?.id}`, b.definition?.name ?? `build ${b.id}`, STATUS[b.status] ?? 'queued', RESULT[b.result] ?? 'failure', { event: b.reason === 'pullRequest' ? 'pull_request' : b.reason ?? 'push', url: b._links?.web?.href ?? null, sha: b.triggerInfo?.['pr.sourceSha'] ?? b.sourceVersion, createdAt: b.queueTime }));
    },
    log(runId, { failedOnly = false } = {}) {
      const records = api.json('GET', `${P()}/build/builds/${runId}/timeline?${API}`)?.records ?? [];
      const logs = records.filter((r) => r.log?.id && (!failedOnly || r.result === 'failed'));
      return logs.map((r) => `== ${r.name} (${r.result ?? r.state})\n${api.text(`${P()}/build/builds/${runId}/logs/${r.log.id}?${API}`)}`).join('\n');
    },
    rerun(runId) {
      api.json('PATCH', `${P()}/build/builds/${runId}?retry=true&${API}`, {});
    },
    // The required builds are the Build validation policies, not names a host rule lists.
    requiredChecks: () => [],
    // Its pipelines are required whole (or by the host's own policy): no job of it is left uncovered by name.
    uncoveredChecks: () => [],
    definitionFiles: () => [],
  };
}
