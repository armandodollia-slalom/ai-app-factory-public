// Jenkins as the CI system: a Multibranch Pipeline job builds this repository's branches and pull requests (the
// factory renders ci/jenkins/Jenkinsfile.factory for it); the head's run is the build of the PR's job (PR-<n> from the
// GitHub and Bitbucket branch sources, MR-<n> from GitLab's) or of the branch's job whose revision is the head. Docs read
// 2026-11-17: https://www.jenkins.io/doc/book/using/remote-access-api/ (…/api/json with ?tree=, Basic auth with an API
// token, no CSRF crumb needed for token auth), https://www.jenkins.io/doc/book/pipeline/multibranch/ (branch and PR job
// names). The PR head is read from SCMRevisionAction (revision.pullHash) or the git plugin's BuildData
// (lastBuiltRevision.SHA1); a build that merges the target branch first records the merge commit there, which is why
// pullHash is checked first.
//
// settings: { url, job ("folder/multibranch-job"), user ("${JENKINS_USER}"), token ("${JENKINS_API_TOKEN}"), expected }.
import { ciClient, run, secret } from './rest.mjs';

export const CAPABILITIES = { logs: true, expectedFromDefinition: 'partial', runsByCommit: true, reviewEvents: false, schedules: true, rerun: true, branchPipelines: true };
const RESULT = { SUCCESS: 'success', FAILURE: 'failure', UNSTABLE: 'failure', ABORTED: 'cancelled', NOT_BUILT: 'skipped' };
const TREE = 'builds[number,url,result,building,inProgress,timestamp,actions[revision[hash,pullHash],lastBuiltRevision[SHA1]]]{0,30}';

export function createJenkins(settings = {}, deps = {}) {
  const env = deps.env ?? process.env;
  const base = String(settings.url ?? '').replace(/\/+$/, '');
  const jobPath = String(settings.job ?? '').split('/').filter(Boolean).map((j) => `/job/${encodeURIComponent(j)}`).join('');
  const api = ciClient({ baseUrl: base || 'http://jenkins.invalid', token: secret(settings.token, 'ci.token', env), user: secret(settings.user, 'ci.user', env), product: 'Jenkins', send: deps.send });
  const need = () => {
    if (!base || !jobPath) throw new Error('Jenkins needs ci.url and ci.job (the Multibranch Pipeline job that builds this repository) in .factory/config.json');
  };
  const child = (name) => `${jobPath}/job/${encodeURIComponent(name)}`;
  const shaOf = (b) => {
    for (const a of b.actions ?? []) {
      if (a?.revision?.pullHash) return a.revision.pullHash;
    }
    for (const a of b.actions ?? []) if (a?.revision?.hash) return a.revision.hash;
    return (b.actions ?? []).find((a) => a?.lastBuiltRevision)?.lastBuiltRevision?.SHA1 ?? null;
  };
  const builds = (name) => {
    try {
      return api.json('GET', `${child(name)}/api/json?tree=${encodeURIComponent(TREE)}`)?.builds ?? [];
    } catch (error) {
      if (/not found|404/.test(error.message)) return [];
      throw error;
    }
  };
  const prNum = (pr) => String(pr ?? '').match(/(\d+)\/?$/)?.[1] ?? null;
  return {
    type: 'jenkins',
    label: 'Jenkins',
    capabilities: CAPABILITIES,
    pushEvents: null,
    prEvents: null,
    // The multibranch job's build of the head (and any job named in ci.expected).
    expected({ settings: s = {} } = {}) {
      need();
      const names = Array.isArray(settings.expected) ? settings.expected : Array.isArray(s.expected) ? s.expected : [settings.job];
      return names.map((n) => ({ id: n === settings.job ? 'jenkins' : `jenkins:${n}`, name: `Jenkins ${n}`, required: true }));
    },
    runs({ head = null, branch = null, pr = null } = {}) {
      need();
      const n = prNum(pr);
      const jobs = [...(n ? [`PR-${n}`, `MR-${n}`] : []), ...(branch ? [branch] : [])];
      const out = [];
      for (const name of jobs) {
        for (const b of builds(name)) {
          const sha = shaOf(b);
          if (head && sha && sha !== head) continue;
          if (head && !sha) continue;
          const status = b.building || b.inProgress ? 'running' : b.result ? 'completed' : 'queued';
          out.push(run(`${name}#${b.number}`, 'jenkins', `Jenkins ${settings.job} ${name} #${b.number}`, status, RESULT[b.result] ?? 'failure', { event: /^(PR|MR)-/.test(name) ? 'pull_request' : 'push', url: b.url, sha, createdAt: new Date(b.timestamp ?? 0).toISOString() }));
        }
      }
      return out;
    },
    log(runId) {
      need();
      const [name, number] = String(runId).split('#');
      return api.text(`${child(name)}/${encodeURIComponent(number)}/consoleText`);
    },
    rerun(runId) {
      need();
      const [name] = String(runId).split('#');
      api.request('POST', `${child(name)}/build`, { accept: '*/*' });
    },
    requiredChecks: () => (settings.statusContext ? [settings.statusContext] : []),
    // Its pipelines are required whole (or by the host's own policy): no job of it is left uncovered by name.
    uncoveredChecks: () => [],
    definitionFiles: () => ['ci/jenkins/Jenkinsfile.factory'],
  };
}
