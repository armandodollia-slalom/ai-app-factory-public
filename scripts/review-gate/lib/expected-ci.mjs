// Which CI a pull request's head must have run before anything may call it green or merge it (council C9). The logic
// lives in the CI layer: scripts/pipeline/lib/ci/evidence.mjs (provider-neutral: expected pipelines against the head's
// runs, fail closed) and the CI adapters (scripts/pipeline/lib/ci/<provider>.mjs: what each CI system's definitions
// expect for a head). This module keeps the gate's names for them.
//
// `target` is a gh runner (GitHub with GitHub Actions, with `repo`) or the { host, ci } pair of ciTarget(config).
import { ciTarget } from '../../pipeline/lib/ci/index.mjs';
import { headPipelines } from '../../pipeline/lib/ci/evidence.mjs';

export { combine, describeWorkflows, evaluateRuns } from '../../pipeline/lib/ci/evidence.mjs';
export { expectedWorkflows, globRegex, triggers, workflowApplies } from '../../pipeline/lib/ci/index.mjs';

// The head's CI as the CI definitions say: { state: success | failure | pending | none | unknown, head, expected,
// missing, running, failing, error }.
export function headWorkflows(target, repo, pr, { settings = {}, head = null, activities = null } = {}) {
  return headPipelines(ciTarget(target, repo), pr, { settings, head, activities });
}
