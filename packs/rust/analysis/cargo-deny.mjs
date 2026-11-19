// Parser for `cargo deny --format json check ...`: one JSON object per line on stderr; diagnostics have
// { type: "diagnostic", fields: { severity, message, code, advisory?: { id, package }, labels } }. An advisory is
// identified by its id and crate, so the same advisory at the merge-base is the same finding.
export function parse(text) {
  const out = [];
  for (const line of String(text ?? '').split('\n')) {
    const l = line.trim();
    if (!l.startsWith('{')) continue;
    let d;
    try {
      d = JSON.parse(l);
    } catch {
      continue;
    }
    if (d.type !== 'diagnostic' || !d.fields) continue;
    const f = d.fields;
    if (!['error', 'warning'].includes(f.severity)) continue;
    const adv = f.advisory ?? null;
    const crate = adv?.package ?? /crate\s+'?([\w-]+)/.exec(f.labels?.[0]?.message ?? '')?.[1] ?? null;
    out.push({ rule: adv?.id ?? f.code ?? 'cargo-deny', level: f.severity, file: 'Cargo.lock', line: null, message: `${f.message}${crate ? ` (${crate})` : ''}`, snippet: null, key: `${f.code ?? 'deny'}:${crate ?? ''}:${adv?.id ?? f.message}` });
  }
  return out;
}

export const sample = { text: ['{"type":"summary","fields":{}}', JSON.stringify({ type: 'diagnostic', fields: { severity: 'error', code: 'vulnerability', message: 'Out-of-bounds read', advisory: { id: 'RUSTSEC-2020-0001', package: 'some-crate' }, labels: [] } }), JSON.stringify({ type: 'diagnostic', fields: { severity: 'help', code: 'note', message: 'n', labels: [] } })].join('\n'), count: 1 };
