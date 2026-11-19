// The Follow-ups list of a PR body (single ticket and epic): what the run left out of the PR on purpose.

// Follow-ups that name the same thing in other words (several subtasks and the PR check each list it: four
// entries for two issues on a C7 PR) become one entry. Same ticket, and most of the shorter title's words shared.
const FOLLOW_UP_STOP = new Set(['a', 'an', 'the', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'is', 'are', 'not', 'no', 'does', 'do', 'with', 'by', 'it', 'its', 'make']);
const followUpWords = (t) => new Set(String(t ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ').filter((w) => w.length > 1 && !FOLLOW_UP_STOP.has(w)).map((w) => w.replace(/(ies|es|s)$/, '')));
// Whether two titles name the same problem: most of the shorter one's words are shared.
export function sameProblem(a, b) {
  const x = followUpWords(a);
  const y = followUpWords(b);
  const n = Math.min(x.size, y.size);
  return n >= 2 && [...x].filter((w) => y.has(w)).length / n >= 0.6;
}

export function dedupeFollowUps(followUps) {
  const out = [];
  for (const u of followUps) {
    const same = out.find((o) => (o.ticket ?? null) === (u.ticket ?? null) && sameProblem(o.title, u.title));
    if (same) same.also = [...(same.also ?? []), u.title];
    else out.push({ ...u });
  }
  return out;
}

export const followUpLine = (u) => `- ${u.ticket ? `${u.ticket}: ` : ''}${u.title}${u.reason ? ` (${u.reason})` : ''}${u.also?.length ? ` (also raised as: ${u.also.join('; ')})` : ''}`;
