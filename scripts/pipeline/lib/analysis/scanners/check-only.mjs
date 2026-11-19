// A server-mode scanner whose findings API the factory does not read (Snyk, Checkmarx One, Veracode): the vendor's own
// integration scans and reports a check on the head; that check is the evidence (checkName, required: missing or
// running is pending, red is failure). Findings, severities and triage stay in the vendor's UI; for them in the fix loop,
// run the scanner in local mode as well.
export const CAPABILITIES = { serverSide: 'partial', prAnalysis: true, triageStates: false, sarif: false, shaBound: false };

export function createCheckOnly(s) {
  return {
    type: 'check-only',
    label: `${s.vendor ?? s.scanner} (its check on the head)`,
    capabilities: CAPABILITIES,
    checkOnly: true,
    checkName: () => s.check ?? null,
    result: () => ({ status: 'complete', findings: [], note: 'the result is the vendor\'s check on the head' }),
  };
}
