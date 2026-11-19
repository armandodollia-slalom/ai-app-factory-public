// Veracode Pipeline Scan's results.json (--json_output_file) as factory findings. Unverified against a live scan: the
// fields are the ones Veracode's own SARIF converter reads (findings[].issue_id, title, issue_type, severity 0-5,
// cwe_id, files.source_file.file / line, display_text), docs/providers/commercial-scanners.md.
const SEV = ['info', 'low', 'low', 'medium', 'high', 'critical'];

export function parse(text) {
  const t = String(text ?? '').trim();
  if (!t) throw new Error('empty Pipeline Scan report (the scan did not write results.json)');
  const doc = JSON.parse(t);
  if (!Array.isArray(doc.findings)) throw new Error('not a Pipeline Scan report (no "findings")');
  return doc.findings.map((f) => {
    const src = f.files?.source_file ?? {};
    const sev = Number(f.severity);
    const vendorSeverity = Number.isInteger(sev) && sev >= 0 && sev <= 5 ? SEV[sev] : null;
    return {
      rule: f.cwe_id ? `CWE-${f.cwe_id}` : String(f.issue_type_id ?? f.issue_type ?? 'veracode'),
      level: sev >= 4 ? 'error' : sev >= 3 ? 'warning' : 'note',
      file: src.file ?? null,
      line: Number.isInteger(Number(src.line)) && Number(src.line) > 0 ? Number(src.line) : null,
      message: String(f.title ?? f.issue_type ?? 'Veracode finding') + (src.function_name ? ` in ${src.function_name}` : ''),
      snippet: null,
      key: null,
      ...(vendorSeverity ? { vendorSeverity } : {}),
      ...(f.cwe_id ? { cwe: `CWE-${Number(f.cwe_id)}` } : {}),
      ...(f.issue_id !== undefined ? { vendorFingerprint: String(f.issue_id) } : {}),
    };
  });
}

export const sample = {
  text: JSON.stringify({ scan_id: 'sample', findings: [{ issue_id: 1001, title: 'SQL Injection', issue_type: 'Improper Neutralization of Special Elements used in an SQL Command', issue_type_id: 'taint', severity: 4, cwe_id: '89', files: { source_file: { file: 'src/Orders/Repo.cs', line: 42, function_name: 'Find' } } }] }),
  count: 1,
};
