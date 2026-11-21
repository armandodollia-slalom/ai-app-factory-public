// A code host or tracker that refuses the TEXT of a request (a content filter), told apart from a permission or rate
// limit error, and the deterministic way through it: the same request again with a body reduced step by step in a fixed
// order until the host accepts it. No agent takes part; the full text stays in the run records and the left-out sections
// follow as comments where the host accepts them.
//
// Shared by both adapter layers: the code host (pull requests, comments) and the tracker (tickets, comments).
//
// What a refusal looks like (dogfood C21/C22, GitHub): a bare "HTTP 403: 403 Forbidden" after a 60 s hang, no message
// and no rate-limit header, for a body holding one particular short text; the same call with that text left out is
// accepted. Other products answer a content filter with a message naming spam or content; a permission error names what
// is missing (scope, permission, token, ...), and a rate limit names the limit. A bare 403 cannot say which it is: it is
// classed "refused without a reason" and the reduction tells (a minimal body still refused is not about the content).
import { HostRefusedError } from './errors.mjs';

export { HostRefusedError };

const RATE = /rate.?limit|too many requests|retry.?after|abuse detection|secondary rate/i;
const CONTENT = /\bspam\b|content (?:filter|policy|was (?:blocked|rejected))|recogni[sz]ed as spam|prohibited (?:content|words?)|inappropriate content|flagged as/i;
const REASONED = /scope|permission|not accessible|must (?:have|be)|token|credential|unauthori[sz]ed|\bsso\b|saml|admin|access|not allowed|disabled|archived|suspended|\bplan\b|protected|locked|blocked user|not a collaborator|write access/i;

// The HTTP status a CLI's or adapter's message names: "HTTP 403", "(HTTP 403)", and the gh CLI's form for a non-JSON
// answer, "non-200 OK status code: 403 Forbidden body: ..." or "unexpected status code: 403" (held-out C22: a refused
// comment answered with an HTML page was recorded as failed).
export const httpStatusIn = (text) => Number(/\bHTTP (\d{3})\b|\bstatus code:?\s*(\d{3})\b/i.exec(String(text ?? ''))?.slice(1).find(Boolean)) || null;
const statusIn = httpStatusIn;
// An HTML error page in a message (a proxy's or the host's generic page): it names no reason the API would give.
const HTML_BODY = /(?:body:\s*)?"?<!DOCTYPE html[\s\S]*$|<html[\s\S]*$/i;

// True when the host refused the request's text: a message naming spam or a content filter (any 4xx), or a 403 that
// gives no reason at all. A rate limit or a 403 that names a permission is not one.
export function isContentRefusal({ status = null, text = '' } = {}) {
  const t = String(text ?? '');
  const s = status ?? statusIn(t);
  if (s === 429 || RATE.test(t)) return false;
  if (CONTENT.test(t) && (s == null || (s >= 400 && s < 500))) return true;
  if (s !== 403) return false;
  // What is left once the status, its standard phrase, request URLs and the CLI's own prefix are taken out.
  const said = t
    .replace(HTML_BODY, ' ')
    .replace(/\b(?:non-200 OK|unexpected)\s+status code:?\s*/gi, ' ')
    .replace(/\bbody:\s*/gi, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/\bHTTP 403\b|\b403\b|\bforbidden\b/gi, ' ')
    .replace(/\b(?:gh|git)?\s*(?:pr|issue|pull request|merge request)?\s*(?:create|comment|edit)?\s*failed\b/gi, ' ')
    .replace(/answered|check the (?:token|tracker\.auth)[^.]*/gi, ' ');
  return !REASONED.test(said);
}

// The error class for an error any adapter threw: true when it is a content refusal (by code, or by its message and status).
export function refusedError(error) {
  if (!error) return false;
  if (error.code === 'refused') return true;
  if (error.code === 'rate-limit' || error.code === 'not-found' || error.code === 'exists' || error.code === 'config' || error.code === 'network') return false;
  return isContentRefusal({ status: typeof error.status === 'number' && error.status >= 100 ? error.status : null, text: error.message });
}

// ---- The body, as blocks ----------------------------------------------------------------------------------------------
// A body is: a head (text before the first block), then blocks. A block is a marked section (`<!-- name:start -->` ..
// `<!-- name:end -->`), a heading section (a `## ` line up to the next `## ` line or marked section), or a `<sub>` note
// line. Hidden one-line markers (a tracker's metadata block) belong to no block and are always kept.
const START = /^<!-- ([\w-]+):start -->\s*$/;
const slug = (s) => String(s).toLowerCase().replace(/\(.*?\)/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

export function bodyBlocks(body) {
  const lines = String(body ?? '').split('\n');
  const head = [];
  const blocks = [];
  const kept = [];
  let cur = null;
  let inMeta = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // A multi-line hidden comment that is not a marked section (metadata): kept as it is, never dropped.
    if (inMeta || (/^<!--/.test(line) && !START.test(line) && !/-->\s*$/.test(line))) {
      kept.push(line);
      inMeta = !/-->\s*$/.test(line);
      continue;
    }
    const m = START.exec(line);
    if (m) {
      const end = lines.indexOf(`<!-- ${m[1]}:end -->`, i + 1);
      if (end > i) {
        const text = lines.slice(i, end + 1).join('\n');
        const h = /^##+ (.+)$/m.exec(text);
        blocks.push({ id: m[1], name: h ? h[1].trim() : m[1], text });
        cur = null;
        i = end;
        continue;
      }
    }
    if (/^## /.test(line)) {
      cur = { id: slug(line.slice(3)), name: line.slice(3).trim(), lines: [line] };
      blocks.push(cur);
      continue;
    }
    if (/^<sub>.*<\/sub>\s*$/.test(line)) {
      blocks.push({ id: 'notes', name: 'Notes on the demo video', text: line });
      cur = null;
      continue;
    }
    if (cur) cur.lines.push(line);
    else if (!blocks.length) head.push(line);
    else if (line.trim()) blocks.push((cur = { id: `text-${blocks.length}`, name: 'Further notes', lines: [line] }));
  }
  for (const b of blocks) if (b.lines) b.text = b.lines.join('\n').replace(/\n+$/, '');
  return { head: head.join('\n'), blocks: blocks.map(({ id, name, text }) => ({ id, name, text })), kept: kept.join('\n') };
}

// The order a pull request body is reduced in: what reviewers read last goes first. The demo media and the stage
// tables go first; the follow-ups, the behaviour changes outside the ticket and the run details last; the summary and the
// CI and gate evidence lines are never dropped.
export const PR_DROP_FIRST = ['pr-demo-video', 'pr-api-summary', 'notes', 'council-review', 'static-analysis'];
export const PR_DROP_LAST = ['follow-ups', 'pr-check-side-effects'];
export const PR_KEEP_LINE = /^- (Architecture review|Test plan and automated tests|CI before this PR|CI's analysis jobs before the push|Review gate, assessed before this PR opened):/;

// The head reduced to what is kept: every line before the first list item and the kept list lines (with their own
// continuation lines); other list items and their nested lines are "run details".
function headParts(head, keepLine) {
  const lines = head.split('\n');
  const kept = [];
  const details = [];
  let inList = false;
  let keeping = true;
  for (const line of lines) {
    if (/^- /.test(line)) {
      inList = true;
      keeping = keepLine.test(line);
    } else if (inList && !/^\s+\S/.test(line)) {
      // a line that is neither a list item nor nested ends the list item
      keeping = true;
    }
    (keeping ? kept : details).push(line);
  }
  return { kept: kept.join('\n'), details: details.join('\n') };
}

// The steps, each cumulative: [{ step, dropped: [ids], body, title }]. Step 0 is the full body. Then each block in the
// fixed order (`first`, then any other block from the end of the body back, then `last`), then the head's run details,
// then the shortest title (`minimalTitle`). Deterministic: the same body always gives the same steps.
export function reductionSteps(title, body, { first = PR_DROP_FIRST, last = PR_DROP_LAST, keepLine = PR_KEEP_LINE, minimalTitle = null } = {}) {
  const { head, blocks, kept } = bodyBlocks(body);
  const byId = (id) => blocks.filter((b) => b.id === id);
  const order = [];
  for (const id of first) order.push(...byId(id));
  const lastBlocks = last.flatMap(byId);
  for (const b of [...blocks].reverse()) if (!order.includes(b) && !lastBlocks.includes(b)) order.push(b);
  order.push(...lastBlocks);
  const hp = headParts(head, keepLine);
  const compose = (h, remaining) => [h.replace(/\n+$/, ''), ...remaining.map((b) => b.text), kept].filter((x) => x && x.trim()).join('\n\n');
  const steps = [{ step: 0, dropped: [], omitted: [], title, body: String(body ?? '') }];
  const dropped = [];
  for (const b of order) {
    dropped.push(b);
    steps.push({ step: steps.length, dropped: dropped.map((x) => x.id), omitted: [...dropped], title, body: compose(head, blocks.filter((x) => !dropped.includes(x))) });
  }
  if (hp.details.trim()) {
    const details = { id: 'run-details', name: 'Run details', text: hp.details.replace(/^\n+|\n+$/g, '') };
    steps.push({ step: steps.length, dropped: [...dropped.map((x) => x.id), 'run-details'], omitted: [...dropped, details], title, body: compose(hp.kept, []) });
  }
  if (minimalTitle && minimalTitle !== title) {
    const prev = steps.at(-1);
    steps.push({ ...prev, step: steps.length, dropped: [...prev.dropped, 'title'], title: minimalTitle });
  }
  return steps;
}

// The note an accepted, reduced body carries: what was left out, why, and where the full text is.
export function omittedNote(step, { recordsPath = null, comments = true } = {}) {
  if (!step?.omitted?.length && !step?.dropped?.includes('title')) return '';
  const names = step.omitted.map((b) => b.name);
  return `<!-- body-reduced:start -->\n> **Shortened.** The code host refused the full text of this description (a content filter: it refused the request without a reason), so it was sent again without: ${names.join('; ') || 'nothing'}${step.dropped.includes('title') ? ' (and with a shorter title)' : ''}.${recordsPath ? ` The full text is kept in the run records (\`${recordsPath}\`).` : ''}${comments && names.length ? ' The left-out sections follow as comments where the host accepts them.' : ''}\n<!-- body-reduced:end -->`;
}

// Sends `send({ title, body })` with the full text, then each reduction step while the host refuses the text. Any other
// error ends it at once (rethrown). Returns { result, step, attempts }; throws HostRefusedError (with `attempts`) when
// every step was refused. `note(step)` is added to every reduced body.
export function sendWithReduction(send, title, body, { steps = null, note = (s) => omittedNote(s), onAttempt = () => {}, ...opts } = {}) {
  const all = steps ?? reductionSteps(title, body, opts);
  const attempts = [];
  for (const s of all) {
    const sentBody = s.step === 0 ? s.body : [s.body, note(s)].filter(Boolean).join('\n\n');
    try {
      const result = send({ title: s.title, body: sentBody });
      if (result && typeof result.then === 'function') throw new Error('sendWithReduction: use sendWithReductionAsync for an async send');
      attempts.push({ step: s.step, dropped: s.dropped, bytes: Buffer.byteLength(sentBody), outcome: 'accepted' });
      onAttempt(attempts.at(-1));
      return { result, step: s, attempts, body: sentBody, title: s.title };
    } catch (error) {
      if (!refusedError(error)) throw error;
      attempts.push({ step: s.step, dropped: s.dropped, bytes: Buffer.byteLength(sentBody), outcome: 'refused', error: String(error.message).slice(0, 200) });
      onAttempt(attempts.at(-1));
    }
  }
  throw new HostRefusedError(`the host refused the text even with the shortest body (${attempts.length} attempt(s)): ${attempts.at(-1)?.error ?? ''}`, { attempts });
}

export async function sendWithReductionAsync(send, title, body, { steps = null, note = (s) => omittedNote(s), onAttempt = () => {}, ...opts } = {}) {
  const all = steps ?? reductionSteps(title, body, opts);
  const attempts = [];
  for (const s of all) {
    const sentBody = s.step === 0 ? s.body : [s.body, note(s)].filter(Boolean).join('\n\n');
    try {
      const result = await send({ title: s.title, body: sentBody });
      attempts.push({ step: s.step, dropped: s.dropped, bytes: Buffer.byteLength(sentBody), outcome: 'accepted' });
      onAttempt(attempts.at(-1));
      return { result, step: s, attempts, body: sentBody, title: s.title };
    } catch (error) {
      if (!refusedError(error)) throw error;
      attempts.push({ step: s.step, dropped: s.dropped, bytes: Buffer.byteLength(sentBody), outcome: 'refused', error: String(error.message).slice(0, 200) });
      onAttempt(attempts.at(-1));
    }
  }
  throw new HostRefusedError(`the host refused the text even with the shortest body (${attempts.length} attempt(s)): ${attempts.at(-1)?.error ?? ''}`, { attempts });
}

// The left-out sections, each posted as its own comment through `post(text)` (sync or async); one the host refuses too is
// recorded as refused, never retried. Returns [{ id, name, outcome, error? }].
export async function postOmitted(omitted, post, { header = 'Left out of the description because the code host refused its full text:' } = {}) {
  const out = [];
  for (const b of omitted ?? []) {
    try {
      await post(`${header}\n\n${b.text}`);
      out.push({ id: b.id, name: b.name, outcome: 'posted' });
    } catch (error) {
      out.push({ id: b.id, name: b.name, outcome: refusedError(error) ? 'refused' : 'failed', error: String(error.message).slice(0, 200) });
    }
  }
  return out;
}

export function postOmittedSync(omitted, post, { header = 'Left out of the description because the code host refused its full text:' } = {}) {
  const out = [];
  for (const b of omitted ?? []) {
    try {
      post(`${header}\n\n${b.text}`);
      out.push({ id: b.id, name: b.name, outcome: 'posted' });
    } catch (error) {
      out.push({ id: b.id, name: b.name, outcome: refusedError(error) ? 'refused' : 'failed', error: String(error.message).slice(0, 200) });
    }
  }
  return out;
}
