// Licences of what static analysis runs and loads. The factory is delivered to clients as paid work and runs on their
// private code, so a tool engine, a rule set or a data source may be enabled only under a licence that clearly allows
// that. The allowlist says how each licence may be used:
//   any      run, load as rules, read as data
//   data     read as data only (attribution licences for advisory databases)
//   execute  run an unmodified binary only (an engine under the LGPL: obligations begin on redistribution, which the
//            factory never does; it fetches the upstream release by pinned URL and checksum). Never rules.
// An item marked `licenceReview: "pending"` (enabled by the owner's decision while a lawyer reviews it) runs by
// default with a warning line in doctor and `factory analysis check`; `analysis.licenceReview: "strict"` turns every
// pending item off at once.
// Anything else needs an `analysis.acceptLicence` entry in .factory/config.json (governance: agents cannot change it)
// naming the tool or rule source and the licence a person accepted. Known-rejected sources fail even then, except those
// marked opt-in (a client's own licence decision).
export const ALLOWLIST = {
  MIT: 'any',
  'Apache-2.0': 'any',
  'BSD-2-Clause': 'any',
  'BSD-3-Clause': 'any',
  ISC: 'any',
  'CC0-1.0': 'any',
  'CC-BY-4.0': 'data',
  'LGPL-2.1-only': 'execute',
  'LGPL-2.1-or-later': 'execute',
  'LGPL-3.0-only': 'execute',
  'LGPL-3.0-or-later': 'execute',
};

const USE_OK = { execute: ['any', 'execute'], rules: ['any'], data: ['any', 'data'] };

// Sources that must never be a default or be fetched by a default configuration. `optIn: true`: a client may still
// accept it explicitly (acceptLicence with `rejected: true`), as their own licence decision.
export const REJECTED = [
  { id: 'semgrep-registry', test: (s) => /semgrep\/semgrep-rules|semgrep\.dev|^(p|r)\/|^auto$/i.test(s.repo ?? s.config ?? ''), why: 'Semgrep Rules License: internal use only, not for a service to clients', optIn: false },
  { id: 'opengrep-rules', test: (s) => /opengrep\/opengrep-rules/i.test(s.repo ?? ''), why: 'archived; LGPL with the Commons Clause (no selling of a service built on it)', optIn: false },
  { id: 'gitlab-lgpl-cc', test: (s) => /sast-rules/i.test(s.repo ?? '') && (s.include ?? []).some((f) => /(^|\/)rules\/lgpl-cc(\/|$)/.test(f)), why: 'GitLab sast-rules rules/lgpl-cc: Commons Clause', optIn: false },
  { id: 'gitlab-ee', test: (s) => /sast-rules/i.test(s.repo ?? '') && (s.include ?? []).some((f) => /(^|\/)rules\/gitlab(\/|$)/.test(f)), why: 'GitLab sast-rules rules/gitlab: GitLab Enterprise Edition licence', optIn: false },
  { id: 'gitlab-whole-repo', test: (s) => /sast-rules/i.test(s.repo ?? '') && !(s.include ?? []).length, why: 'GitLab sast-rules without an include list would load rules/lgpl-cc and rules/gitlab; name the MIT folders', optIn: false },
  { id: 'brakeman', test: (s) => /brakeman/i.test(s.id ?? '') || /brakeman/i.test(s.repo ?? ''), why: 'Brakeman licence treats use in a value-added service as commercial use', optIn: true },
  { id: 'codeql', test: (s) => /codeql/i.test(s.id ?? '') || /codeql/i.test(s.repo ?? ''), why: 'CodeQL CLI terms forbid closed-source code without paid GitHub Advanced Security', optIn: true },
  { id: 'bearer', test: (s) => /^bearer$/i.test(s.id ?? '') || /bearer\/bearer/i.test(s.repo ?? ''), why: 'Elastic License 2.0', optIn: true },
  { id: 'osv-wolfi-chainguard', test: (s) => /wolfi|chainguard/i.test(`${s.id ?? ''} ${(s.paths ?? []).join(' ')}`), why: 'Wolfi and Chainguard advisory data: CC-BY-NC-ND (an explicit non-commercial term)', optIn: false },
  { id: 'trailofbits-rules', test: (s) => /trailofbits\/semgrep-rules/i.test(s.repo ?? ''), why: 'AGPL-3.0', optIn: true },
];

const accepted = (acceptLicence, { tool = null, source = null, licence }) =>
  (acceptLicence ?? []).find((a) => a && a.licence === licence && (source ? a.source === source : a.tool === tool && !a.source));

// One row per tool engine, rule source and data source the resolved analysis enables:
// { kind: tool | rules | data, what, licence, use, ok, problem }.
export function licenceRows(resolved, { acceptLicence = [], review = 'default' } = {}) {
  if (!resolved) return [];
  const strict = review === 'strict';
  const rows = [];
  const check = ({ kind, what, licence, use, subject, key, review = null }) => {
    if (review === 'pending') {
      if (strict) rows.push({ kind, what, licence: licence ?? '(unstated)', use, ok: true, off: true, warning: 'off: legal review pending (analysis.licenceReview "strict")', problem: null });
      else rows.push({ kind, what, licence: licence ?? '(unstated)', use, ok: true, pending: true, warning: 'enabled by default, legal review pending', problem: null });
      if (!REJECTED.find((r) => r.test(subject))) return;
      rows.pop();
    }
    const rejected = REJECTED.find((r) => r.test(subject));
    if (rejected) {
      const ok = rejected.optIn && Boolean((acceptLicence ?? []).find((a) => a?.rejected === true && (a.source === key.source || a.tool === key.tool)));
      rows.push({ kind, what, licence: licence ?? '(unstated)', use, ok, problem: ok ? null : `rejected: ${rejected.why}${rejected.optIn ? ' (a client may accept it: analysis.acceptLicence with "rejected": true)' : ''}` });
      return;
    }
    if (!licence) {
      rows.push({ kind, what, licence: '(unstated)', use, ok: false, problem: 'no licence stated: set `licence` (an SPDX id or the licence\'s name)' });
      return;
    }
    const allowed = ALLOWLIST[licence];
    if (allowed && USE_OK[use].includes(allowed)) rows.push({ kind, what, licence, use, ok: true, problem: null });
    else if (accepted(acceptLicence, { ...key, licence })) rows.push({ kind, what, licence, use, ok: true, problem: null, acceptedBy: accepted(acceptLicence, { ...key, licence }).by ?? null });
    else rows.push({ kind, what, licence, use, ok: false, problem: allowed ? `${licence} allows ${allowed === 'execute' ? 'running an unmodified binary only' : 'data use only'}, not ${use === 'rules' ? 'loading as rules' : use}` : `${licence} is not on the factory's licence allowlist: a person accepts it in analysis.acceptLicence ({ ${key.source ? `"source": "${key.source}"` : `"tool": "${key.tool}"`}, "licence": "${licence}", "by": "<name>" })` });
  };
  for (const t of resolved.allTools?.values?.() ?? resolved.tools.values()) {
    if (t.builtin) continue;
    check({ kind: 'tool', what: t.id, licence: t.licence, use: 'execute', subject: { id: t.id, repo: t.install?.platforms ? Object.values(t.install.platforms)[0]?.url : '' }, key: { tool: t.id }, review: t.licenceReview });
    for (const s of t.rules ?? []) check({ kind: 'rules', what: `${t.id} rules ${s.id}${s.include?.length ? ` (${s.include.join(', ')})` : ''}`, licence: s.licence, use: 'rules', subject: s, key: { source: `${t.id}:${s.id}` }, review: s.licenceReview });
    for (const d of t.data ?? []) if (!d.excluded) check({ kind: 'data', what: `${t.id} data ${d.id}`, licence: d.licence, use: 'data', subject: d, key: { source: `${t.id}:${d.id}` }, review: d.licenceReview });
  }
  return rows;
}

export const licenceProblems = (resolved, opts) => licenceRows(resolved, opts).filter((r) => !r.ok).map((r) => `${r.what}: ${r.problem}`);

// The lines doctor and `factory analysis check` print: every licence, warnings for pending items, failures.
export const licenceLine = (r) => `${r.ok ? (r.pending ? 'WARN  ' : r.off ? 'off   ' : 'ok    ') : 'FAILED'}  licence ${r.kind} ${r.what}: ${r.licence}${r.warning ? ` (${r.warning})` : ''}${r.problem ? `: ${r.problem}` : ''}`;
