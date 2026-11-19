// Parser for Bandit's JSON report (`bandit -f json`): { results: [{ filename, line_number, test_id, issue_severity,
// issue_confidence, issue_text }] }. HIGH severity with MEDIUM or HIGH confidence is `error`, the rest `warning`.
export function parse(text) {
  const t = String(text ?? '');
  const i = t.indexOf('{');
  if (i < 0) return [];
  const doc = JSON.parse(t.slice(i));
  if (!Array.isArray(doc.results)) throw new Error('not a Bandit JSON report (no "results")');
  return doc.results.map((r) => ({ rule: r.test_id ?? 'bandit', level: r.issue_severity === 'HIGH' && r.issue_confidence !== 'LOW' ? 'error' : 'warning', file: r.filename ?? null, line: Number.isInteger(r.line_number) ? r.line_number : null, message: `${r.test_name ? `${r.test_name}: ` : ''}${r.issue_text ?? ''} (severity ${r.issue_severity}, confidence ${r.issue_confidence})`, snippet: null, key: null }));
}

export const sample = { text: JSON.stringify({ errors: [], results: [{ filename: 'app/db.py', line_number: 12, test_id: 'B608', test_name: 'hardcoded_sql_expressions', issue_severity: 'MEDIUM', issue_confidence: 'LOW', issue_text: 'Possible SQL injection vector through string-based query construction.' }, { filename: 'app/run.py', line_number: 4, test_id: 'B602', test_name: 'subprocess_popen_with_shell_equals_true', issue_severity: 'HIGH', issue_confidence: 'HIGH', issue_text: 'subprocess call with shell=True identified, security issue.' }] }), count: 2 };
