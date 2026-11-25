// The clean-code seat (GEN-16) sits on every council. In the in-process fake agents of the stage tests it finds nothing
// unless the script names it (`<agent>@<seat>`), so a test's scripted members keep their own steps and counts.
export const APPROVED = 'AGENT_RESULT: {"verdict": "APPROVED", "score": 10, "summary": "nothing breaks the clean-code rules", "findings": []}';

// The run's answer when it is an unscripted clean-code seat, else null.
export function cleanCodeSeatAnswer(opts, script) {
  const env = opts.extraEnv ?? {};
  if (env.PIPELINE_COUNCIL_LENS !== 'clean-code' || script[`${opts.name}@${env.PIPELINE_COUNCIL_MEMBER}`]) return null;
  return { ok: true, status: 0, timedOut: false, output: APPROVED, version: 'v1', seconds: 0 };
}
