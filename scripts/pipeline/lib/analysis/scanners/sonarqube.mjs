// SonarQube Server / SonarQube Cloud in server mode: the scanner (sonar-scanner, run by the factory's CI job or the
// client's own) uploads; this adapter reads the pull request's quality gate and issues. Docs read 2026-11-17:
// https://next.sonarqube.com/sonarqube/web_api/api/qualitygates/project_status (projectKey, pullRequest | branch;
// projectStatus.status OK | ERROR | NONE), https://next.sonarqube.com/sonarqube/web_api/api/issues/search
// (componentKeys, pullRequest, p, ps <= 500; issues[].rule, severity BLOCKER..INFO, impacts[].severity HIGH..LOW,
// component "<project>:<path>", line, message, key, resolution FIXED | FALSE-POSITIVE | WONTFIX, issueStatus ACCEPTED |
// FALSE_POSITIVE). SonarQube Server does not return which commit a pull request analysis was of, so the head binding
// is the scanner's check on the host (checkName; required, the gate waits for it on the head).
import { ciClient, secret } from '../../ci/rest.mjs';

export const CAPABILITIES = { serverSide: true, prAnalysis: true, triageStates: true, sarif: false, shaBound: false };
const TRIAGE = { 'FALSE-POSITIVE': 'false-positive', FALSE_POSITIVE: 'false-positive', WONTFIX: 'accepted', ACCEPTED: 'accepted', FIXED: 'fixed' };

export function createSonarqube(s, deps = {}) {
  const token = secret(s.token, 'analysis.commercial.token', deps.env ?? process.env);
  const api = ciClient({ baseUrl: String(s.url ?? 'https://sonarcloud.io').replace(/\/+$/, ''), token, product: 'SonarQube', send: deps.send });
  const need = () => {
    if (!s.project) throw new Error('the SonarQube project key is unknown: set analysis.commercial.project');
    return encodeURIComponent(s.project);
  };
  const scope = ({ pr, branch }) => (pr ? `pullRequest=${encodeURIComponent(pr)}` : branch ? `branch=${encodeURIComponent(branch)}` : '');
  return {
    type: 'sonarqube',
    label: 'SonarQube',
    capabilities: CAPABILITIES,
    checkName: () => s.check ?? null,
    result({ pr = null, branch = null } = {}) {
      let gate;
      try {
        gate = api.json('GET', `/api/qualitygates/project_status?projectKey=${need()}&${scope({ pr, branch })}`);
      } catch (error) {
        if (error.code === 'not-found' || error.status === 404) return { status: 'pending', findings: [], note: 'no analysis of this pull request yet' };
        throw error;
      }
      const g = gate?.projectStatus?.status;
      const findings = [];
      for (let p = 1; p <= 20; p++) {
        const page = api.json('GET', `/api/issues/search?componentKeys=${need()}&${scope({ pr, branch })}&ps=500&p=${p}`);
        for (const i of page?.issues ?? []) {
          const sev = (i.impacts ?? []).map((x) => x.severity).find(Boolean) ?? i.severity ?? null;
          const t = TRIAGE[i.issueStatus] ?? TRIAGE[i.resolution] ?? null;
          findings.push({ rule: i.rule, severity: sev, level: ['BLOCKER', 'CRITICAL', 'HIGH'].includes(sev) ? 'error' : 'warning', path: String(i.component ?? '').replace(/^[^:]*:/, '') || null, line: i.line ?? null, message: i.message ?? i.rule, cwe: null, fingerprint: i.key, triage: t ?? 'open' });
        }
        const total = page?.paging?.total ?? page?.total ?? 0;
        if (p * 500 >= total) break;
      }
      return { status: 'complete', gate: g === 'ERROR' ? 'fail' : g === 'OK' ? 'pass' : null, url: s.url && s.project ? `${String(s.url).replace(/\/+$/, '')}/dashboard?id=${encodeURIComponent(s.project)}${pr ? `&pullRequest=${encodeURIComponent(pr)}` : ''}` : null, findings };
    },
  };
}
