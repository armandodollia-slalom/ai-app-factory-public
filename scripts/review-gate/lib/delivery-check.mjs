// The delivery check before anything merges (council C8): a CI gate that ran on the PR's head passes its decision
// (or null when it found nothing); otherwise, with green checks on a head nobody checked, the gate runs the retry check
// itself. A run that died before its CI gate, or a PR the pipeline did not wait for, therefore never auto-merges on a
// retry-only pass: `decideGate` merges only a head whose delivery check ran.
import { ciFlaky } from '../../implement/lib/ci-wait.mjs';

export function applyDeliveryCheck(a, prior, { gh, repo, pr, delivery = undefined, retryCheck = ciFlaky, log = () => {} } = {}) {
  if (delivery !== undefined) {
    a.delivery = delivery;
    a.deliveryChecked = a.headSha ?? null;
    return a;
  }
  if (a.headSha && prior?.deliveryChecked === a.headSha) {
    a.deliveryChecked = a.headSha;
    return a;
  }
  if (a.ci !== 'success' || !a.headSha || !retryCheck) return a;
  let flaky = null;
  try {
    flaky = retryCheck(gh, repo, pr);
  } catch {
    flaky = null;
  }
  if (!Array.isArray(flaky)) return a;
  a.deliveryChecked = a.headSha;
  if (flaky.length) {
    a.delivery = { state: 'flaky', outcome: 'ci-flaky', reason: `CI green only with retries (${flaky.join('; ')}): not delivered`, flaky, failing: flaky.map((t) => `flaky: ${t}`), fixerNotes: [], findings: flaky.map((t, i) => ({ id: `CI-FLAKY-${i + 1}`, severity: 'major', title: `A test passes only on a retry: ${t}` })) };
    log(`${pr}: green, but ${flaky.length} test(s) passed only on a retry; held for a person`);
  }
  return a;
}
