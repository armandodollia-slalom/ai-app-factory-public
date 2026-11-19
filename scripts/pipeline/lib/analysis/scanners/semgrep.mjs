// Semgrep AppSec Platform in server mode: `semgrep ci` (the factory's CI job or the client's) scans and uploads; this
// adapter reads the pull request's findings. Docs read 2026-11-17: https://semgrep.dev/api/v1/docs/#tag/Finding
// (GET /api/v1/deployments/{deploymentSlug}/findings ?repos &ref &dedup &page &page_size; findings[]: rule_name,
// severity low | medium | high | critical, state, triage_state untriaged | ignored | reviewing | fixing |
// provisionally_ignored, triage_reason, location { file_path, line }, rule { cwe_names }, match_based_id; Bearer
// SEMGREP_APP_TOKEN with the Web API scope). The findings are of the ref, not of a commit: the head binding is
// Semgrep's check on the head (checkName, required).
import { ciClient, secret } from '../../ci/rest.mjs';

export const CAPABILITIES = { serverSide: true, prAnalysis: true, triageStates: true, sarif: true, shaBound: false };
const TRIAGE = { ignored: 'accepted', provisionally_ignored: 'accepted' };

export function createSemgrep(s, deps = {}) {
  const token = secret(s.token, 'analysis.commercial.token', deps.env ?? process.env);
  const api = ciClient({ baseUrl: String(s.url ?? 'https://semgrep.dev').replace(/\/+$/, ''), token, product: 'Semgrep', send: deps.send });
  const need = (v, what) => {
    if (!v) throw new Error(`the Semgrep ${what} is unknown: set analysis.commercial.${what === 'deployment' ? 'deployment' : 'project'}`);
    return encodeURIComponent(v);
  };
  return {
    type: 'semgrep',
    label: 'Semgrep',
    capabilities: CAPABILITIES,
    checkName: () => s.check ?? null,
    result({ pr = null, branch = null } = {}) {
      const ref = pr ? String(s.refTemplate ?? 'refs/pull/{pr}/merge').replace('{pr}', pr) : branch;
      const findings = [];
      for (let page = 0; page < 20; page++) {
        const r = api.json('GET', `/api/v1/deployments/${need(s.deployment, 'deployment')}/findings?repos=${need(s.project, 'project')}&ref=${encodeURIComponent(ref)}&dedup=true&page=${page}&page_size=500`);
        for (const f of r?.findings ?? []) {
          if (f.state && f.state !== 'unresolved') continue;
          findings.push({ rule: f.rule_name ?? f.rule?.name ?? 'semgrep', severity: f.severity ?? null, level: ['high', 'critical'].includes(f.severity) ? 'error' : 'warning', path: f.location?.file_path ?? null, line: f.location?.line ?? null, message: f.rule_message ?? f.rule?.message ?? f.rule_name, cwe: (f.rule?.cwe_names ?? [])[0] ?? null, fingerprint: f.match_based_id ?? String(f.id), triage: TRIAGE[f.triage_state] ?? (f.triage_reason === 'false_positive' ? 'false-positive' : 'open') });
        }
        if ((r?.findings ?? []).length < 500) break;
      }
      return { status: 'complete', findings };
    },
  };
}
