// The PR body once a ticket waits for a person (council C7): #119's body still said "done … PASS 10/10" and listed the
// owner question as a follow-up after the check ended QUESTION. The body states the decision first, the stories table
// shows each ticket's current outcome (and PR check verdict), and follow-ups that became questions are removed.
const START = '<!-- pipeline-decision:start -->';
const END = '<!-- pipeline-decision:end -->';

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function withDecision(body, { keys = [], outcome, reason, issues = [], prCheck = null, dropIds = [] }) {
  let text = String(body ?? '').replace(/\r\n/g, '\n');
  text = text.replace(new RegExp(`${escapeRe(START)}[\\s\\S]*?${escapeRe(END)}\\n*`), '');
  const block = [START, `> **Needs a person's decision: not delivered.** ${keys.join(', ')}: ${String(reason ?? outcome).replace(/\s+/g, ' ').trim()}. The options are on the ticket${issues.length ? ` (${issues.map((n) => `#${n}`).join(', ')})` : ''} and in this PR's comments. Do not merge until a person decides.`, END, ''].join('\n');
  const lines = text.split('\n');
  // The stories table: the Outcome column (and the PR check column, when given) of each ticket's row.
  const header = lines.findIndex((l) => /^\|.*\bOutcome\b.*\|/.test(l));
  if (header >= 0) {
    const cols = lines[header].split('|').map((c) => c.trim());
    const outcomeCol = cols.indexOf('Outcome');
    const checkCol = cols.indexOf('PR check');
    for (let i = header + 2; i < lines.length && lines[i].startsWith('|'); i++) {
      const cells = lines[i].split('|');
      const first = String(cells[1] ?? '').trim();
      if (!keys.some((k) => new RegExp(`^${escapeRe(k)}\\b`).test(first))) continue;
      if (outcomeCol > 0) cells[outcomeCol] = ` ${outcome} `;
      if (prCheck && checkCol > 0) cells[checkCol] = ` ${prCheck} `;
      lines[i] = cells.join('|');
    }
  }
  const kept = lines.filter((l) => !(dropIds.length && /^\s*[-*] /.test(l) && dropIds.some((id) => new RegExp(`\\(PR check (?:before this PR )?${escapeRe(id)}[:,]`).test(l))));
  return `${block}\n${kept.join('\n').replace(/^\n+/, '')}`;
}

// The verdict the PR body states, refreshed from the latest check of an open PR (council C8 audit: #137's body said
// "PASS 10/10" after a later re-check ended ACCEPTED 9/10). The stories table's "PR check" column for the checked
// tickets and a single ticket's "- PR check (…): VERDICT n/10" line (with its open-findings sub-list) are rewritten.
export function withCheckVerdict(body, { keys = [], verdict, score, openFindings = [], when = null, head = null }) {
  const label = `${verdict} ${score}/10`;
  const lines = String(body ?? '').replace(/\r\n/g, '\n').split('\n');
  const header = lines.findIndex((l) => /^\|.*\bPR check\b.*\|/.test(l));
  if (header >= 0) {
    const cols = lines[header].split('|').map((c) => c.trim());
    const col = cols.indexOf('PR check');
    for (let i = header + 2; i < lines.length && lines[i].startsWith('|'); i++) {
      const cells = lines[i].split('|');
      if (col > 0 && keys.some((k) => String(cells[1] ?? '').trim().startsWith(k))) {
        cells[col] = ` ${label} `;
        lines[i] = cells.join('|');
      }
    }
  }
  const at = lines.findIndex((l) => /^- PR check( \(.*\))?: /.test(l));
  if (at >= 0) {
    let end = at + 1;
    while (end < lines.length && /^ {2,}- /.test(lines[end])) end++;
    const open = openFindings.map((f) => `  - ${f.severity ?? ''} ${f.lens ? `[${f.lens}] ` : ''}${f.title ?? f.id}`);
    lines.splice(at, end - at, `- PR check (latest full check of this PR${when ? `, ${when}` : ''}${head ? `, head ${String(head).slice(0, 7)}` : ''}): ${label}${open.length ? ', open findings:' : ''}`, ...open);
  }
  return lines.join('\n');
}

// A check scoped to a CI fix (it judged only the fix for failing or retried CI checks) never replaces the full check's
// verdict, and the full check's open findings stay open (council C9: #196 read "PASS 10/10" from the narrow check while
// the full check's ACCEPTED 9/10 and a style finding still in the code were listed as follow-ups). It gets a line of
// its own under the full check's, saying what it covered; the "whole test projects" line points at the CI fix.
const SCOPED = /^- Check after the CI fixing round /;
export function withScopedCheck(body, { verdict, score, ids = [], when = null, head = null }) {
  const lines = String(body ?? '').replace(/\r\n/g, '\n').split('\n').filter((l) => !SCOPED.test(l));
  const line = `- Check after the CI fixing round (${[when, head ? `head ${String(head).slice(0, 7)}` : null].filter(Boolean).join(', ')}): ${verdict} ${score}/10 on the fix for ${ids.join(', ') || 'the failing CI checks'} only. It does not replace the full check above: the full check's verdict and open findings stand until a full check clears them.`;
  let at = lines.findIndex((l) => /^- PR check( \(.*\))?: /.test(l));
  if (at >= 0) {
    at += 1;
    while (at < lines.length && /^ {2,}- /.test(lines[at])) at++;
    lines.splice(at, 0, line);
  } else lines.unshift(line, '');
  const whole = lines.findIndex((l) => /^- Whole test projects run before this PR/.test(l) && !/CI then failed/.test(l));
  if (whole >= 0) lines[whole] = `${lines[whole].replace(/:$/, '')} (CI then failed on the PR; see "Changed by the PR check"):`;
  return lines.join('\n');
}
