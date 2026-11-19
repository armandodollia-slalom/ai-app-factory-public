// CircleCI as the CI system: the head's pipeline is the CircleCI pipeline whose vcs.revision is the head; the expected
// pipelines are its workflows as `.circleci/config.yml` at that head declares them. Docs read 2026-11-17:
// https://circleci.com/docs/api/v2/ (GET /project/{slug}/pipeline?branch=&page-token=, vcs.revision; GET
// /pipeline/{id}/workflow; GET /workflow/{id}/job; POST /workflow/{id}/rerun {from_failed}; the Circle-Token header).
// API v2 has no job log endpoint: a failed job's output is read from API v1.1 (GET /project/{vcs}/{org}/{repo}/{n}:
// steps[].actions[].output_url), which this adapter does without a live check (logs: partial).
//
// settings: { token ("${CIRCLECI_TOKEN}"), project (the project slug: gh/org/repo, bb/workspace/repo, or circleci/<org
// id>/<project id> for GitLab and GitHub App projects), expected }.
import { createRequire } from 'node:module';
import { hostFor } from '../hosts/index.mjs';
import { ciClient, run, secret } from './rest.mjs';

const requireHere = createRequire(import.meta.url);
let yamlLib = null;
const YAML = { parse: (text) => (yamlLib ??= requireHere('yaml')).parse(text) };

export const CAPABILITIES = { logs: 'partial', expectedFromDefinition: true, runsByCommit: true, reviewEvents: false, schedules: 'partial', rerun: true, branchPipelines: true };
const STATUS = { success: ['completed', 'success'], failed: ['completed', 'failure'], error: ['completed', 'failure'], failing: ['completed', 'failure'], unauthorized: ['completed', 'failure'], canceled: ['completed', 'cancelled'], running: ['running', null], on_hold: ['queued', null], not_run: ['queued', null] };

export function createCircleci(settings = {}, deps = {}) {
  const config = deps.config ?? {};
  const env = deps.env ?? process.env;
  const token = secret(settings.token, 'ci.token', env) ?? env.CIRCLECI_TOKEN ?? env.CIRCLE_TOKEN ?? null;
  const slug = settings.project ?? (config.host?.repo ? `${{ github: 'gh', bitbucket: 'bb' }[config.host?.type ?? 'github'] ?? 'gh'}/${config.host.repo}` : null);
  // CircleCI cloud, or a CircleCI server installation (ci.url: https://<server>/api).
  const api = ciClient({ baseUrl: String(settings.url ?? 'https://circleci.com/api').replace(/\/+$/, ''), token, header: 'Circle-Token', product: 'CircleCI', send: deps.send });
  const need = () => {
    if (!slug) throw new Error('the CircleCI project is unknown: set ci.project (gh/org/repo, bb/workspace/repo or circleci/<org>/<project>) in .factory/config.json');
    return slug;
  };
  const host = () => deps.host ?? hostFor(config, deps.gh ? { gh: deps.gh } : {}).sync;
  return {
    type: 'circleci',
    label: 'CircleCI',
    capabilities: CAPABILITIES,
    pushEvents: null,
    prEvents: null,
    // The workflows `.circleci/config.yml` declares at the head (ci.expected names them instead when it is set).
    expected({ head, settings: s = {} } = {}) {
      if (Array.isArray(settings.expected)) return settings.expected.map((n) => ({ id: n, name: n, required: true }));
      const text = host().repo.file('.circleci/config.yml', head);
      if (text == null) return [];
      let doc;
      try {
        doc = YAML.parse(text);
      } catch {
        return [{ id: '.circleci/config.yml', name: '.circleci/config.yml', required: true, unreadable: true }];
      }
      return Object.entries(doc?.workflows ?? {})
        .filter(([name, w]) => name !== 'version' && w && typeof w === 'object' && !(s.ignoreNames ?? []).includes(name))
        // A workflow only a schedule starts is not expected on a pull request.
        .filter(([, w]) => !(w.triggers ?? []).every((t) => t?.schedule) || !(w.triggers ?? []).length)
        .map(([name]) => ({ id: name, name, required: true }));
    },
    runs({ head = null, branch = null } = {}) {
      const out = [];
      let token_ = null;
      for (let page = 0; page < 3; page++) {
        const q = new URLSearchParams({ ...(branch ? { branch } : {}), ...(token_ ? { 'page-token': token_ } : {}) });
        const res = api.json('GET', `/v2/project/${need()}/pipeline?${q}`);
        const pipelines = (res?.items ?? []).filter((p) => !head || p.vcs?.revision === head);
        for (const p of pipelines) {
          for (const w of api.json('GET', `/v2/pipeline/${p.id}/workflow`)?.items ?? []) {
            const [status, conclusion] = STATUS[w.status] ?? ['queued', null];
            out.push(run(w.id, w.name, w.name, status, conclusion, { event: 'pull_request', url: `https://app.circleci.com/pipelines/${need()}/${p.number}/workflows/${w.id}`, sha: p.vcs?.revision, createdAt: w.created_at }));
          }
        }
        if (!head || pipelines.length || !res?.next_page_token) {
          if (!res?.next_page_token || pipelines.length) break;
        }
        token_ = res.next_page_token;
      }
      return out;
    },
    // The failed jobs' step output through API v1.1 (v2 has no logs endpoint).
    log(workflowId, { failedOnly = true } = {}) {
      const jobs = (api.json('GET', `/v2/workflow/${workflowId}/job`)?.items ?? []).filter((j) => !failedOnly || ['failed', 'infrastructure_fail', 'timedout'].includes(j.status));
      const [vcs, org, repo] = need().split('/');
      const parts = [];
      for (const j of jobs.filter((x) => x.job_number != null)) {
        const detail = api.json('GET', `/v1.1/project/${{ gh: 'github', bb: 'bitbucket' }[vcs] ?? vcs}/${org}/${repo}/${j.job_number}`);
        for (const step of detail?.steps ?? []) {
          for (const a of step.actions ?? []) {
            if (!a.output_url || (failedOnly && a.status === 'success')) continue;
            try {
              const lines = JSON.parse(api.text(a.output_url, { accept: 'application/json' }));
              parts.push(`== ${j.name} / ${step.name}\n${lines.map((l) => l.message).join('')}`);
            } catch {
              parts.push(`== ${j.name} / ${step.name}: output not readable`);
            }
          }
        }
      }
      return parts.join('\n');
    },
    rerun(workflowId) {
      api.json('POST', `/v2/workflow/${workflowId}/rerun`, { from_failed: true });
    },
    requiredChecks: () => [],
    // Its pipelines are required whole (or by the host's own policy): no job of it is left uncovered by name.
    uncoveredChecks: () => [],
    definitionFiles: () => ['.circleci/config.yml'],
  };
}
