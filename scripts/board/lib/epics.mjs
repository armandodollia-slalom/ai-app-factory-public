// The rolling evidence comment on an epic issue: one comment, edited in place and found by a hidden
// marker, with a section per story (lane, PR or branch, feature video, screenshots, API evidence) and,
// for an epic delivered as one branch, the epic PR and its video. Its data travels in the marker, so
// any machine can update its own story's section without losing the others. Large evidence (API
// requests and responses) stays on the story issue and is linked from here.
import { issueComments } from './flow.mjs';
import { trackerFor } from './trackers/index.mjs';

const DATA = /<!-- pipeline-epic-evidence:(\{[\s\S]*?\}) -->/;
const MAX_CHARS = 60000;

export function parseEpicEvidence(body) {
  const m = DATA.exec(body ?? '');
  if (!m) return null;
  try {
    const data = JSON.parse(m[1]);
    return { epic: data.epic ?? {}, stories: data.stories ?? {} };
  } catch {
    return null;
  }
}

// Merges one story's (or the epic's) evidence into the comment data. Empty values never erase what a
// section already has, so a later status update keeps the PR and video links.
// A bug epic delivers its tickets as several PR groups: `group` ({ id, pr, branch, title, tickets })
// adds or updates one group's PR under epic.groups.
export function mergeEpicEvidence(data, { key, story = {}, epic = {}, group = null } = {}) {
  const keep = (old, patch) => ({ ...old, ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v != null && !(Array.isArray(v) && !v.length))) });
  const out = { epic: keep(data?.epic ?? {}, epic), stories: { ...(data?.stories ?? {}) } };
  if (group?.id) out.epic.groups = { ...(out.epic.groups ?? {}), [group.id]: keep(out.epic.groups?.[group.id] ?? {}, group) };
  if (key) out.stories[key] = keep(out.stories[key] ?? {}, story);
  return out;
}

const link = (label, url) => (url ? `[${label}](${url})` : null);

export function renderEpicEvidence(config, data, { maxChars = MAX_CHARS } = {}) {
  const lane = (c) => config.board.columns[c] ?? c ?? '-';
  const head = ['## Pipeline evidence', '', '_Updated by the AI pipeline as its stories move; one section per story. Large evidence is linked from the story issue._', ''];
  if (data.epic.pr || data.epic.video) head.push(`**Epic delivery:** ${[link('pull request', data.epic.pr), data.epic.branch ? `branch \`${data.epic.branch}\`` : null, link('video', data.epic.video)].filter(Boolean).join(' · ')}`, '');
  const groups = Object.entries(data.epic.groups ?? {});
  if (groups.length) {
    head.push('**PR groups:**', '');
    for (const [id, g] of groups.sort(([a], [b]) => a.localeCompare(b))) {
      head.push(`- \`${id}\`${g.title ? ` ${g.title}` : ''}${g.tickets?.length ? ` (${g.tickets.join(', ')})` : ''}: ${[link('pull request', g.pr), g.branch ? `branch \`${g.branch}\`` : null].filter(Boolean).join(' · ')}`);
      // Follow-ups the group's PR left out on purpose (the implementers' and the PR check judge's), to be filed.
      for (const u of g.followUps ?? []) head.push(`  - Follow-up to file: ${u}`);
    }
    head.push('');
  }
  const keys = Object.keys(data.stories).sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
  const full = (key) => {
    const s = data.stories[key];
    const lines = [`### ${key}${s.number ? ` (#${s.number})` : ''}: ${lane(s.status)}`, ''];
    const code = s.pr ? `PR: ${s.pr}${s.epicBranch ? ` (merged into \`${s.epicBranch}\`)` : ''}` : s.branch ? `Branch: \`${s.branch}\`` : null;
    if (code) lines.push(`- ${code}`);
    if (s.video) lines.push(`- Feature video: ${s.video}`);
    if (s.screenshots?.length) lines.push(`- Screenshots: ${s.screenshots.map((u, i) => link(String(i + 1), u)).join(' ')}`);
    if (s.apiEvidence) lines.push(`- API evidence: ${link('requests and responses', s.apiEvidence)}`);
    if (s.note) lines.push(`- ${s.note}`);
    return [...lines, ''].join('\n');
  };
  // Over the comment limit, every story shrinks to one line of links.
  const compact = (key) => {
    const s = data.stories[key];
    return `- **${key}**${s.number ? ` (#${s.number})` : ''}: ${lane(s.status)}${[link('PR', s.pr), link('video', s.video), link('API evidence', s.apiEvidence)].filter(Boolean).map((l) => ` · ${l}`).join('')}`;
  };
  // `--` cannot appear inside an HTML comment; JSON reads the escaped form back.
  const marker = `<!-- pipeline-epic-evidence:${JSON.stringify(data).replace(/--/g, '-\\u002d')} -->`;
  let body = [...head, ...keys.map(full), marker].join('\n');
  if (body.length > maxChars) body = [...head, ...keys.map(compact), '', marker].join('\n');
  return body;
}

// The epic ticket a story ticket is a child of: { number, url } or null.
export const parentOf = (config, number) => trackerFor(config).tickets.parent(number);

// The epic evidence comment's data, or null when the epic has none yet.
export function readEpicEvidence(config, epicNumber) {
  const existing = issueComments(config, epicNumber).find((c) => DATA.test(c.body ?? ''));
  return existing ? parseEpicEvidence(existing.body) : null;
}

// Creates or edits the epic's evidence comment. `storyNumber` finds the epic (its parent) when
// `epicNumber` is not given. Returns { epic, url, created } or null when the story has no epic.
export function upsertEpicEvidence(config, { storyNumber = null, epicNumber = null, key = null, story = {}, epic = {}, group = null }) {
  const number = epicNumber ?? (storyNumber ? parentOf(config, storyNumber)?.number : null);
  if (!number) return null;
  const tracker = trackerFor(config);
  const existing = tracker.tickets.comments(number).find((c) => DATA.test(c.body ?? ''));
  const data = mergeEpicEvidence(parseEpicEvidence(existing?.body), { key, story: key ? { ...story, ...(storyNumber ? { number: storyNumber } : {}), updatedAt: new Date().toISOString() } : {}, epic, group });
  const body = renderEpicEvidence(config, data);
  if (existing?.id) {
    tracker.tickets.editComment(number, existing.id, body);
    return { epic: number, url: existing.url, created: false };
  }
  return { epic: number, url: tracker.tickets.comment(number, body).url, created: true };
}

// The PR body's "## Follow-ups (not in this PR)" section, up to the next heading.
export function followUpsFromPrBody(body) {
  const lines = String(body ?? '').split('\n');
  const at = lines.findIndex((l) => /^## Follow-ups \(not in this PR\)/.test(l));
  if (at < 0) return '';
  const out = [];
  for (const line of lines.slice(at + 1)) {
    if (/^\s*[-*] /.test(line) || (out.length && /^\s{2,}\S/.test(line))) out.push(line);
    else if (out.length || /^\S/.test(line)) break;
  }
  return out.join('\n').trim();
}

// Council C6: a follow-up that stays outside the PR is filed as an issue of its own, so it is tracked, not only listed.
// One issue per follow-up title (an open issue with the same title is reused), at most `max` per PR.
export function fileFollowUps(config, followUps, { pr = null, key = null, tracker = null, gh = null, max = 10, log = () => {} } = {}) {
  const items = String(followUps ?? '').split('\n').map((l) => l.replace(/^\s*[-*]\s+/, '').trim()).filter(Boolean).slice(0, max);
  const filed = [];
  let t;
  try {
    t = tracker ?? trackerFor(config, gh ? { gh } : {});
  } catch (error) {
    log(`follow-ups not filed (${error.message.split('\n')[0]})`);
    return filed;
  }
  for (const item of items) {
    const title = `Follow-up: ${item.replace(/\s*\(.*$/, '').replace(/^[A-Z][A-Z0-9]*-\d+:\s*/, '').slice(0, 120)}`;
    try {
      const existing = t.tickets.search({ text: title, state: 'open' }).find((i) => i.title === title);
      if (existing) {
        filed.push({ title, url: existing.url, existing: true });
        continue;
      }
      const created = t.tickets.create({ title, body: `${item}\n\nLeft out of ${pr ?? 'the PR'}${key ? ` for ${key}` : ''} on purpose; filed by the pipeline so it is tracked.`, addToBoard: false });
      if (created?.url) filed.push({ title, url: created.url, existing: false });
    } catch (error) {
      log(`follow-up not filed (${error.message.split('\n')[0]}): ${title}`);
    }
  }
  return filed;
}
