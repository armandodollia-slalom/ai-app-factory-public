// What the factory asks the code host about the repository it is installed in (doctor, `review-gate enforce`),
// through the host contract (scripts/pipeline/lib/hosts, providers/contracts.mjs): whether the default branch requires
// the review-quorum check, the CI checks and code-owner review, and whether the host's auto-merge is allowed. The words
// for where a host keeps its rules come from the host adapter (`hints`), so every host gets the same verdict.
import { hostOf, hostFor } from '../../pipeline/lib/hosts/index.mjs';
import { originRepo } from '../../pipeline/lib/products.mjs';

export { originRepo };

const hintsOf = (host) => ({ checked: 'the branch rules', enforce: 'the review gate\'s rule on the default branch', settings: 'the repository settings', autoMerge: 'the repository settings', ...(host.hints ?? {}) });

// [ok, note] for the default branch's rules, or null when the host cannot be asked. `target`: a code host (sync), a
// repository config, or a repository slug with an optional gh runner (GitHub; tests). `review`: { satisfiable, reason }
// of code-owner review (review-gate/lib/codeowners.mjs). `requiredChecks`: the CI checks the rule should require.
// The checks a host rule requires that no workflow of the checkout provides (null `provided`: the CI system cannot say,
// nothing is flagged). review-quorum is posted by the review gate itself. Such a check holds every PR for ever (dogfood:
// a release removed the CI demo-video workflow and its `record` job stayed required).
export function unprovidedRequired(required = [], provided = null) {
  if (!Array.isArray(provided)) return [];
  const have = new Set(provided);
  return required.filter((c) => c !== 'review-quorum' && !have.has(c) && !provided.some((p) => c.startsWith(`${p} (`) || c.startsWith(`${p} / `)));
}
export const unprovidedText = (repo, branch, stale) => `${repo}'s ${branch} requires ${stale.map((c) => `"${c}"`).join(', ')}, which no workflow in this checkout provides: every PR waits for ${stale.length === 1 ? 'it' : 'them'} for ever. Run 'factory review-gate enforce --dry-run', then 'factory review-gate enforce' (it requires exactly the checks the shipped workflows run); a rule it does not own (classic branch protection) is changed by hand`;

export function reviewEnforcement(target, gh = null, { review = null, requiredChecks = [], provided = null } = {}) {
  if (!target) return null;
  let host;
  let bp;
  try {
    host = hostOf(target, { gh: typeof gh === 'function' ? gh : null });
    bp = host.repo.branchProtection();
  } catch {
    return null;
  }
  if (!bp) return null;
  const repo = String(host.repo);
  const label = host.label ?? 'The code host';
  const hints = hintsOf(host);
  if (bp.unavailable) {
    if (bp.reason === 'plan') return [false, `${label} cannot require it on ${repo}: ${bp.detail ?? 'its plan has no branch rules'}, so review-quorum and CODEOWNERS are advisory (an owner decision: ${hints.planDecision ?? 'change the plan, or accept advisory review'})`];
    return [false, `could not read the branch rules of ${repo}: ${bp.reason}`];
  }
  const name = bp.branch;
  const checks = bp.requiredChecks ?? [];
  // A host whose rule is "the whole pipeline must pass" (bp.pipelineGate) requires every job of it, review-quorum too.
  const has = (c) => bp.pipelineGate || checks.includes(c);
  const codeOwners = Boolean(bp.codeOwnerReview);
  if (codeOwners && review && !review.satisfiable) return [false, `${repo}'s ${name} requires code-owner review, but nobody can give it on the pipeline's PRs: ${review.reason}. Until then 'factory review-gate enforce' leaves the rule out`];
  const ownersWanted = review ? review.satisfiable : true;
  // The CI checks too (council C9): with review-quorum alone a host merges a head whose CI has not run.
  const ciMissing = requiredChecks.filter((c) => !has(c));
  const stale = bp.pipelineGate ? [] : unprovidedRequired(checks, provided);
  if (stale.length) return [false, unprovidedText(repo, name, stale)];
  const missing = [!has('review-quorum') && 'the review-quorum status check', ciMissing.length && `the CI checks ${ciMissing.join(', ')}`, ownersWanted && !codeOwners && host.capabilities?.codeOwners !== false && 'code-owner review'].filter(Boolean);
  if (missing.length) return [false, `${repo}'s ${name} does not require ${missing.join(' or ')} (checked ${hints.checked}): run 'factory review-gate enforce' (${hints.enforce}), or add them in ${hints.settings}`];
  const via = (bp.via ?? []).join(' and ') || 'no rule';
  return [true, `${repo}'s ${name} requires review-quorum${requiredChecks.length ? ` and the CI checks ${requiredChecks.join(', ')}` : ''}${codeOwners ? ' and code-owner review' : ` (code-owner review is not required: ${review?.reason ?? 'no code owners'})`} (${via})`];
}

// Whether the host's own auto-merge is allowed: [ok, note], or null when it cannot be asked. The review gate merges a
// cleared PR directly when nothing is pending and retries at each `board sync` otherwise, so it works either way; with
// the setting on, the host merges the PR the moment its checks finish (dogfood C6: the setting was off, nothing checked
// it, and two qualifying bug fixes waited).
export function autoMergeSetting(target, gh = null) {
  if (!target) return null;
  let host;
  let allowed;
  try {
    host = hostOf(target, { gh: typeof gh === 'function' ? gh : null });
    allowed = host.repo.settings?.()?.autoMergeAllowed;
  } catch {
    return null;
  }
  if (allowed == null) return null;
  const repo = String(host.repo);
  const hints = hintsOf(host);
  if (allowed) return [true, `${repo} allows auto-merge: ${host.label ?? 'the host'} merges a PR the review gate cleared as soon as its checks pass`];
  return [false, `${repo} has "Allow auto-merge" off: the review gate merges a cleared PR only when its checks are already green and otherwise waits for the next \`board sync\`. Turn it on in ${typeof hints.autoMerge === 'function' ? hints.autoMerge(repo) : hints.autoMerge}`];
}

// The code host of a checkout (null when it cannot be built: no origin, an unknown host).
export function checkoutHost(root, config = {}) {
  try {
    return hostFor({ ...(config ?? {}), root }).sync;
  } catch {
    return null;
  }
}
