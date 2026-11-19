// `factory review-gate enforce`: the repository setting that makes the review gate binding, on the code
// host (scripts/pipeline/lib/hosts: `host.repo.enforceReviewGate`):
// - GitHub: one ruleset on the default branch (required review-quorum check from GitHub Actions, and the CI
//   checks of `requiredChecksFor`; with CODEOWNERS and a code owner other than the pipeline's PR author,
//   code-owner review; admins may bypass). A private repository on a free plan is refused.
// - GitLab: "Pipelines must succeed" (the review-quorum job runs in the merge request pipeline) and, with
//   CODEOWNERS, code owner approval on the protected default branch (Premium).
// - Azure DevOps: a blocking Status policy for review-quorum on the default branch; required reviewers by
//   path (Azure's code owners) are listed for a person.
// It changes a repository setting, so it is run by a person (setup-board skill), never by an agent.
import { desiredRuleset, hostOf, RULESET_NAME } from '../../pipeline/lib/hosts/index.mjs';
import { ciFor, defaultRequiredChecks } from '../../pipeline/lib/ci/index.mjs';

export { desiredRuleset, RULESET_NAME };

// The CI checks a host should require next to review-quorum come from the CI adapter (GitHub Actions: the jobs of
// every pull-request workflow that runs for every PR; scripts/pipeline/lib/ci/github-actions.mjs).
export { defaultRequiredChecks };

// The checks a repository's ruleset should require: the configured list, else the default above.
export const requiredChecksFor = (config) => {
  if (Array.isArray(config.implement?.reviewGate?.requiredChecks)) return config.implement.reviewGate.requiredChecks;
  try {
    return ciFor(config).requiredChecks?.(config.root) ?? [];
  } catch {
    return [];
  }
};

/**
 * enforce(host, { codeOwners, dryRun }) with a code host (hostFor(config)), or enforce(gh, "owner/name",
 * { codeOwners, dryRun }) with a gh runner (GitHub, as before the adapters; tests). Returns
 * { action: 'created'|'updated'|'unchanged'|'would-create'|'would-update', ruleset?, summary, manual }.
 */
export function enforce(target, repo, options) {
  if (typeof target === 'function') return hostOf(target, { repo }).repo.enforceReviewGate(options ?? {});
  return target.repo.enforceReviewGate(repo ?? {});
}
