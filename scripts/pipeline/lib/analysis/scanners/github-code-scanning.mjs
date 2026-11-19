// GitHub code scanning (CodeQL or any SARIF upload) in server mode: GitHub's own workflow scans; this adapter reads the
// analyses and alerts of the pull request. Docs read 2026-11-17:
// https://docs.github.com/en/rest/code-scanning/code-scanning (GET /repos/{owner}/{repo}/code-scanning/analyses ?ref
// &tool_name: commit_sha, ref, created_at; GET .../code-scanning/alerts ?pr &state &tool_name: number, state open |
// dismissed | fixed, dismissed_reason "false positive" | "won't fix" | "used in tests", rule { id, severity,
// security_severity_level, tags }, most_recent_instance { location { path, start_line }, commit_sha, message }).
// Needs a token with security_events read (classic) or "Code scanning alerts: read"; 403 without GitHub Advanced
// Security on a private repository. A pull request is analysed at its merge ref, so the analysis commit is not the
// head: the head binding is the CodeQL check on the head (checkName, required).
import { ciClient, secret } from '../../ci/rest.mjs';

export const CAPABILITIES = { serverSide: true, prAnalysis: true, triageStates: true, sarif: true, shaBound: false };
const DISMISSED = { 'false positive': 'false-positive', "won't fix": 'accepted', 'used in tests': 'accepted' };

export function createGithubCodeScanning(s, deps = {}) {
  const env = deps.env ?? process.env;
  const token = secret(s.token, 'analysis.commercial.token', env) ?? env.GITHUB_TOKEN ?? env.GH_TOKEN ?? null;
  const api = ciClient({ baseUrl: String(s.url ?? 'https://api.github.com').replace(/\/+$/, ''), token, product: 'GitHub code scanning', send: deps.send });
  const tool = s.toolName ?? 'CodeQL';
  const repo = () => {
    if (!s.repo) throw new Error('the repository is unknown (host.repo)');
    return s.repo;
  };
  const read = (p) => {
    try {
      return api.json('GET', p);
    } catch (error) {
      if (error.status === 403) throw new Error(`GitHub code scanning is not readable for ${repo()}: GitHub Advanced Security may be off, or the token lacks security_events read (${error.message.split('\n')[0]})`, { cause: error });
      throw error;
    }
  };
  return {
    type: 'github-code-scanning',
    label: 'GitHub code scanning',
    capabilities: CAPABILITIES,
    checkName: () => s.check ?? tool,
    result({ pr = null, branch = null } = {}) {
      const ref = pr ? `refs/pull/${pr}/merge` : `refs/heads/${branch}`;
      let analyses;
      try {
        analyses = read(`/repos/${repo()}/code-scanning/analyses?ref=${encodeURIComponent(ref)}&tool_name=${encodeURIComponent(tool)}&per_page=5`);
      } catch (error) {
        if (error.status === 404 || error.code === 'not-found') return { status: 'pending', findings: [], note: 'no analysis of this ref yet' };
        throw error;
      }
      if (!analyses?.length) return { status: 'pending', findings: [] };
      const findings = [];
      for (let page = 1; page <= 20; page++) {
        const list = read(`/repos/${repo()}/code-scanning/alerts?${pr ? `pr=${pr}` : `ref=${encodeURIComponent(ref)}`}&tool_name=${encodeURIComponent(tool)}&per_page=100&page=${page}`) ?? [];
        for (const a of list) {
          const inst = a.most_recent_instance ?? {};
          findings.push({ rule: a.rule?.id ?? 'unknown', severity: a.rule?.security_severity_level ?? a.rule?.severity ?? null, level: a.rule?.severity === 'error' ? 'error' : a.rule?.severity === 'note' ? 'note' : 'warning', path: inst.location?.path ?? null, line: inst.location?.start_line ?? null, message: inst.message?.text ?? a.rule?.description ?? a.rule?.id, cwe: (a.rule?.tags ?? []).find((t) => /cwe/i.test(t)) ?? null, fingerprint: String(a.number), triage: a.state === 'dismissed' ? DISMISSED[a.dismissed_reason] ?? 'accepted' : a.state === 'fixed' ? 'fixed' : 'open', commit: inst.commit_sha ?? null });
        }
        if (list.length < 100) break;
      }
      return { status: 'complete', analysisId: analyses[0].id ?? null, url: analyses[0].url ?? null, findings };
    },
  };
}
