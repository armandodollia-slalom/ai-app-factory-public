// Auto-merge of a PR the gate cleared (PR severity Low, every ticket high confidence, no human reopens,
// checks green, `implement.autoMerge.enabled`). Every merge goes through mergePr (github.mjs), which
// picks the identity (`implement.autoMerge.identity`: gh-user today, a GitHub App with a ruleset bypass
// once approvals from people are required, or the pipeline's PR bot). The PR is labeled `auto-merged`; its cards reach Done
// through the existing `closed` event of `board sync` once GitHub closes the issues.
import { MARKER, approvalsLabel, renderNotice } from './gate.mjs';
import { autoMergeArmed, disableAutoMerge, editPrLabels, mergePr, prHost, upsertComment } from './github.mjs';
import { botEnvSync } from '../../pipeline/lib/bot.mjs';

// Merges and records it. When GitHub has not cleared the merge yet, the PR waits (approvals:0) and `board sync`
// tries again; when GitHub refuses, the notice says the merge failed and why, and `board sync` tries again too.
// A merge failure never becomes a review requirement (dogfood C6: a refused `--auto` turned two Low,
// confidence-90 bug fixes into "1 approval required").
// Returns { decision, state, merged, problems }, or { decidedAgain } when `boundary` (the merge boundary, called right
// before the host's merge call) stopped the merge with a new decision: nothing was labelled or noted, the caller applies it.
export function autoMergePr(config, gh, a, decision, state, reviewContext, { boundary = null } = {}) {
  const s = config.implement.reviewGate;
  const repo = config.board.repo;
  const zero = approvalsLabel(s, 0);
  const failedLabel = s.labels?.mergeFailed ?? 'merge-failed';
  const humanLabel = s.labels?.needsHuman ?? 'needs-human';
  const stale = (reviewContext.currentLabels ?? []).filter((l) => (l.startsWith(approvalsLabel(s, '')) && l !== zero) || l === humanLabel);
  const label = (add, remove) => {
    try {
      editPrLabels(prHost(config, gh), repo, a.pr, { add, remove: remove.filter((l) => !add.includes(l)) });
      return null;
    } catch (error) {
      return `label: ${error.message.split('\n')[0]}`;
    }
  };
  const notice = (d, st) => {
    try {
      upsertComment(prHost(config, gh), repo, a.pr, MARKER, renderNotice(a, d, st));
      return null;
    } catch (error) {
      return `notice: ${error.message.split('\n')[0]}`;
    }
  };
  // A merge that ends waiting or failed did not arm the host's auto-merge: one armed earlier is cancelled too.
  const disarm = (d) => {
    try {
      disarmUnlessMerging(prHost(config, gh), repo, a.pr, d, { headSha: a.headSha });
      return null;
    } catch (error) {
      return `auto-merge not disarmed: ${error.message.split('\n')[0]}`;
    }
  };
  let how;
  try {
    how = mergePr(config, repo, a.pr, config.implement.autoMerge, { bot: () => botEnvSync(config), headSha: a.headSha ?? null, gh, boundary });
  } catch (error) {
    const cause = error.message.split('\n')[0];
    const d = { ...decision, action: 'merge-failed', approvals: 0, triggers: [], reasons: [...(decision.reasons ?? []), `merge failed: ${cause}`] };
    const st = { ...state, action: 'merge-failed', approvals: 0, required: false, triggers: [], mergeError: { cause, at: new Date().toISOString() } };
    const problems = [`merge failed: ${cause}`, label([zero, failedLabel], [...stale]), notice(d, st), disarm(d)].filter(Boolean);
    return { decision: d, state: st, merged: false, problems };
  }
  if (how.decidedAgain) return { decidedAgain: how.decidedAgain, merged: false, problems: [] };
  if (how.pending) {
    const why = `GitHub has not cleared the merge yet (${how.status}); \`board sync\` checks this head again and merges it once GitHub does`;
    const d = { ...decision, action: 'wait', approvals: 0, reasons: [why] };
    const st = { ...state, action: 'wait', approvals: 0, required: false, triggers: [], mergeError: null, pendingMerge: { status: how.status, at: new Date().toISOString() } };
    const problems = [label([zero], [...stale, failedLabel]), notice(d, st), disarm(d)].filter(Boolean);
    return { decision: d, state: st, merged: false, problems: [`merge pending (${how.status})`, ...problems] };
  }
  const merged = { ...state, action: 'auto-merge', mergeError: null, merge: { identity: how.identity, method: how.method, merged: Boolean(how.merged), mergedAt: how.mergedAt ?? null, auto: Boolean(how.autoMerge) } };
  const problems = [label([s.labels?.autoMerged ?? 'auto-merged', zero], [...stale, failedLabel]), notice(decision, merged)].filter(Boolean);
  return { decision, state: merged, merged: Boolean(how.merged), problems };
}

// The host's own auto-merge, armed earlier (implement.autoMerge.native) only when the gate decided auto-merge, merges
// whatever head is there once the required checks pass: whenever the gate does not clear the head it just assessed (a
// person's rejection read now included), it is disarmed (council C9). Armed, or not readable, it is cancelled; a cancel
// that fails on an armed PR throws, so the caller reports it. A host that cannot cancel is never armed (mergePr).
// `target`: a gh runner (with `repo`) or the gate's code host (prHost(config, gh)).
export function disarmUnlessMerging(target, repo, pr, decision, { log = () => {}, headSha = null } = {}) {
  if (decision.action === 'auto-merge') return false;
  const host = target;
  const armed = autoMergeArmed(host, repo, pr);
  if (armed === false || (host.capabilities ?? {}).cancelAutoMerge === false) return false;
  const cancelled = disableAutoMerge(host, repo, pr);
  if (armed && cancelled === false) throw new Error(`the host's auto-merge is armed on ${pr} and could not be cancelled`);
  if (armed) log(`${pr}: the host's auto-merge was armed; disarmed (${decision.action} for head ${headSha ?? '?'})`);
  return Boolean(armed);
}
