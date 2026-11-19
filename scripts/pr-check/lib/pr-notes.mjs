// What a fix-mode PR check changed on an open PR reaches the PR body and the ticket (council C4 / D-C8-1: a fixer
// restricted a fix to admins, but the PR body still described the weaker fix and listed the restriction as a
// follow-up, and the check escalated over its own stale description; the fixer may not edit the story file).
// The harness writes a "Changed by the PR check" section, drops the Follow-ups it resolved, and posts the same
// note on each ticket's issue.
import { sameProblem } from '../../implement/lib/follow-ups.mjs';

const START = '<!-- pr-check-fixes:start -->';
const END = '<!-- pr-check-fixes:end -->';
const one = (t) => String(t ?? '').replace(/\s+/g, ' ').trim();

// Findings the fixer fixed across the rounds (id, severity, title), its notes, and what it left.
export function fixesOf(history = []) {
  const titles = new Map(history.flatMap((h) => (h.upheld ?? []).map((f) => [f.id, f])));
  const fixed = new Map();
  for (const h of history) for (const id of h.fix?.fixed ?? []) if (titles.has(id)) fixed.set(id, titles.get(id));
  const notes = history.map((h) => one(h.fix?.summary)).filter((s) => s && !/^committed before/.test(s));
  // Corrected Notes bullets the fixer gave (last one per field wins).
  const replacements = new Map();
  for (const h of history) for (const n of h.fix?.notes ?? []) if (/^(Decisions|Deviations|Code map)$/i.test(String(n.field))) replacements.set(String(n.field).toLowerCase(), { field: String(n.field), text: one(n.text) });
  const notFixed = new Map();
  for (const h of history) for (const n of h.fix?.notFixed ?? []) if (n?.id && !fixed.has(n.id)) notFixed.set(n.id, one(n.reason));
  return { fixed: [...fixed.values()], notes, replacements: [...replacements.values()], notFixed: [...notFixed].map(([id, reason]) => ({ id, reason })) };
}

export function fixNote({ fixed, notes, notFixed }, commits = []) {
  if (!fixed.length && !notFixed.length) return '';
  return [
    '## Changed by the PR check',
    '',
    `The PR check's fixer changed this PR after it opened${commits.length ? ` (${commits.join(', ')})` : ''}. The description above was written before these changes; where they differ, this section is current.`,
    '',
    ...fixed.map((f) => `- Fixed ${f.id} [${f.severity}]: ${one(f.title)}`),
    ...(notes.length ? ['', `Fixer's notes: ${notes.join(' ')}`] : []),
    ...(notFixed.length ? ['', 'Not fixed (for a person):', ...notFixed.map((n) => `- ${n.id}: ${n.reason}`)] : []),
  ].join('\n');
}

// The PR body with the section replaced (or added before the demo video block or at the end), and the Follow-ups
// that a fixed finding resolved removed.
export function withFixNote(body, note, fixed = []) {
  let text = String(body ?? '');
  const at = text.indexOf(START);
  const end = text.indexOf(END);
  if (at >= 0 && end > at) text = `${text.slice(0, at).trimEnd()}\n\n${text.slice(end + END.length).trimStart()}`;
  // Follow-ups lines that name a problem the fixer fixed.
  const lines = text.split('\n');
  let inFollowUps = false;
  const kept = lines.filter((l) => {
    if (/^##\s/.test(l)) inFollowUps = /^##\s+Follow-ups/i.test(l);
    if (!inFollowUps || !/^-\s/.test(l)) return true;
    const title = l.replace(/^-\s+(?:[A-Z][A-Z0-9]*-\d+:\s+)?/, '').replace(/\s*\(.*$/, '');
    return !fixed.some((f) => sameProblem(title, f.title));
  });
  text = kept.join('\n').replace(/## Follow-ups \(not in this PR\)\n+(?=##|<!--|$)/, '');
  if (!note) return text;
  const block = `${START}\n${note}\n${END}`;
  const video = text.indexOf('<!-- pr-demo-video:start -->');
  return video >= 0 ? `${text.slice(0, video).trimEnd()}\n\n${block}\n\n${text.slice(video)}` : `${text.trimEnd()}\n\n${block}\n`;
}

// The story's Implementation Notes with the PR check's note (replaced, not repeated). The fixer may not edit the
// story; the harness records what the fix changed so the notes match the code (council C5: the published notes of a
// security fix described a claim type the fixer had removed).
const NSTART = '<!-- pr-check-notes:start -->';
const NEND = '<!-- pr-check-notes:end -->';
export function withNotesUpdate(story, fixes, commits = []) {
  if (!fixes.fixed.length) return story;
  const block = [
    NSTART,
    `* **Changed by the PR check${commits.length ? ` (${commits.join(', ')})` : ''}:** where this differs from the Decisions, Deviations or Code map above, this is current.`,
    ...fixes.fixed.map((f) => `  * Fixed ${f.id}: ${one(f.title)}`),
    ...(fixes.notes.length ? [`  * What the fixer changed: ${fixes.notes.join(' ')}`] : []),
    NEND,
  ].join('\n');
  let text = String(story).replace(/\r\n/g, '\n');
  // Bullets the fix made untrue are replaced with the fixer's corrected text.
  for (const r of fixes.replacements ?? []) {
    const re = new RegExp(`^\\* \\*\\*${r.field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:\\*\\*.*$`, 'im');
    if (re.test(text)) text = text.replace(re, `* **${r.field}:** ${r.text}`);
  }
  const a = text.indexOf(NSTART);
  const b = text.indexOf(NEND);
  if (a >= 0 && b > a) return `${text.slice(0, a)}${block}${text.slice(b + NEND.length)}`;
  const lines = text.split('\n');
  const start = lines.findIndex((l) => /^##\s+Implementation Notes\b/i.test(l));
  if (start < 0) return `${text.trimEnd()}\n\n## Implementation Notes\n\n${block}\n`;
  let end = lines.findIndex((l, i) => i > start && /^##\s/.test(l));
  if (end < 0) end = lines.length;
  while (end > start + 1 && !lines[end - 1].trim()) end -= 1;
  lines.splice(end, 0, block);
  return `${lines.join('\n').trimEnd()}\n`;
}

// Plan case files the fixer added or changed in this round get `kept-for: <finding ids>` (feature verification keeps
// them through a re-plan).
export function stampKeptCases(files, ids, { read, write }) {
  const stamped = [];
  for (const file of files.filter((f) => /(^|\/)TC-[A-Z][A-Z0-9]*-\d+-\d+[^/]*\.md$/.test(f))) {
    const text = read(file);
    if (text == null || !text.startsWith('---\n') || /^kept-for:/m.test(text.split('\n---')[0])) continue;
    write(file, text.replace(/^---\n/, `---\nkept-for: ${ids.join(', ')}\n`));
    stamped.push(file);
  }
  return stamped;
}

export { sideEffectsSection, withSideEffects } from '../../implement/lib/side-effects.mjs';
