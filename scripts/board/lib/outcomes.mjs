// Late outcomes of pipeline-implemented stories, for the implement stage's decision log: when a card
// reaches Done, whether its PR merged, what humans committed on the branch before merge, and which
// later BUG-* stories name it. Appended to .factory/metrics/decision-outcomes.jsonl in this checkout
// (not committed here; it travels with the next commit that includes .factory/metrics/).
import fs from 'node:fs';
import path from 'node:path';
import { git, revExists } from '../../pipeline/lib/git.mjs';
import { metricsFile, readMetricsLocal } from '../../pipeline/lib/state.mjs';
import { appendJsonl, nowIso, readJson, readJsonl } from '../../pipeline/lib/util.mjs';
import { OUTCOMES_FILE, bugStoriesFor, humanCommitStats, lateOutcomeRecord } from '../../implement/lib/decisions.mjs';
import { hostFor } from '../../pipeline/lib/hosts/index.mjs';
import { setting } from '../../pipeline/lib/settings.mjs';

export function recordLateOutcome(config, key, { listStories, host = hostFor(config) }) {
  const run = readJson(path.join(config.root, config.stateDir, 'implement', `${key}.json`), null);
  if (!run?.branch) return null; // not implemented by `pipeline implement` on this machine
  const file = metricsFile(config, OUTCOMES_FILE);
  if (readMetricsLocal(config, OUTCOMES_FILE).some((r) => r.type === 'late' && r.story === key)) return null;
  // The branch's pull request on the code host, and its commits ({ sha, author }).
  const prsFor = (branch) => host.sync.pr.list({ state: 'all', head: branch });
  let prs = prsFor(run.branch);
  // A ticket delivered in a group or epic PR: that PR's head is the unit branch the story was based on and merged
  // into (dogfood C2: a ticket's auto-merged group PR was recorded as "PR not merged").
  const unitBranch = String(run.epicBranch ?? run.base ?? '').replace(/^origin\//, '');
  if (!prs.some((p) => p.state === 'merged') && unitBranch && unitBranch !== run.branch && unitBranch !== String(setting(config, 'baseRef')).replace(/^origin\//, '')) {
    const unitPrs = prsFor(unitBranch);
    if (unitPrs.length) prs = unitPrs;
  }
  const pr = prs.find((p) => p.state === 'merged') ?? prs[0] ?? null;
  git(config.root, ['fetch', '-q', 'origin', run.branch]);
  const prCommits = pr ? host.sync.pr.commits(pr.number).map((c) => ({ oid: c.sha, authors: c.author ? [{ login: c.author }] : [] })) : [];
  const commits = prCommits.map((c) => {
    const exists = revExists(config.root, c.oid);
    const lines = exists
      ? git(config.root, ['show', '--numstat', '--format=', c.oid]).stdout.split('\n').filter(Boolean).reduce((n, l) => n + l.split('\t').slice(0, 2).reduce((m, x) => m + (Number(x) || 0), 0), 0)
      : null;
    return { oid: c.oid, lines, authors: (c.authors ?? []).map((a) => a.login || a.email || a.name).filter(Boolean), exists };
  });
  const finalSha = run.finalSha && revExists(config.root, run.finalSha) ? run.finalSha : null;
  const isPipeline = (c) => (finalSha && c.exists ? git(config.root, ['merge-base', '--is-ancestor', c.oid, finalSha]).status === 0 : false);
  const stories = listStories(config).map((s) => ({ key: s.key, text: fs.existsSync(path.join(config.root, s.file)) ? fs.readFileSync(path.join(config.root, s.file), 'utf8') : '' }));
  const rec = lateOutcomeRecord({
    ts: nowIso(),
    key,
    decisionId: run.decisionId ?? run.orchestration?.decisionId ?? null,
    pr: pr?.url ?? null,
    prMerged: pr?.state === 'merged',
    stats: finalSha ? humanCommitStats(commits, { isPipeline }) : null,
    bugStories: bugStoriesFor(key, stories),
  });
  appendJsonl(file, rec);
  return rec;
}

// A ticket closed as not planned (or a duplicate) was abandoned, not delivered: it does not reach Done, and its
// record says so once instead of a late outcome (D-C7-3: spent held-out tickets were moved to Done and given
// late outcomes, noise in the outcome data).
export const abandonedReason = (item) => (['NOT_PLANNED', 'DUPLICATE'].includes(String(item?.stateReason ?? '').toUpperCase()) ? String(item.stateReason).toUpperCase() : null);

export function recordAbandoned(config, key, reason) {
  const file = metricsFile(config, OUTCOMES_FILE);
  if (readMetricsLocal(config, OUTCOMES_FILE).some((r) => (r.type === 'abandoned' || r.type === 'late') && r.story === key)) return null;
  const run = readJson(path.join(config.root, config.stateDir, 'implement', `${key}.json`), null);
  const rec = { type: 'abandoned', ts: nowIso(), story: key, reason: reason.toLowerCase(), decision_id: run?.decisionId ?? run?.orchestration?.decisionId ?? null };
  appendJsonl(file, rec);
  return rec;
}
