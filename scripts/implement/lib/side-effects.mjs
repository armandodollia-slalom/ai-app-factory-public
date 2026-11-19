// Behaviour the PR changes outside its tickets' lines (council C7: #130's pageSize=0 now answers 400, #137's app-wide
// not-found page; neither PR description said so). The section is rewritten from the last check.
const SIDE_START = '<!-- pr-check-side-effects:start -->';
const SIDE_END = '<!-- pr-check-side-effects:end -->';
// The same behaviour change said twice in other words (dogfood C14: the flow critic of the report round and of a fix
// round each described a story's LOWER() name filter and its shared test collection) is listed once: two items whose
// significant words overlap enough are one item, and the more detailed (longer) wording is kept.
const STOP = new Set('a an and are as at be by for from in into is it its no not now of on one or the their them they this to was were with without same plus only when then than also'.split(' '));
const words = (x) => new Set(String(x).toLowerCase().replace(/[`'"()[\]{}]/g, ' ').split(/[^a-z0-9.#/_-]+/).map((w) => w.replace(/^[-.]+|[-.]+$/g, '')).filter((w) => w.length > 2 && !STOP.has(w)));
export function sameChange(a, b) {
  const x = words(a);
  const y = words(b);
  if (!x.size || !y.size) return false;
  let both = 0;
  for (const w of x) if (y.has(w)) both++;
  // Measured on C14's lists: the duplicates overlap 0.58-0.60 of the shorter item's words, distinct items 0.25 at most.
  return both / Math.min(x.size, y.size) >= 0.5;
}
export function dedupeSideEffects(list = []) {
  const out = [];
  for (const item of list.map((x) => String(x).trim()).filter(Boolean)) {
    const i = out.findIndex((kept) => kept === item || sameChange(kept, item));
    if (i < 0) out.push(item);
    else if (item.length > out[i].length) out[i] = item;
  }
  return out;
}

export function sideEffectsSection(input = []) {
  const list = dedupeSideEffects(input);
  if (!list.length) return '';
  return [SIDE_START, '## Behaviour changes outside the ticket\'s lines', '', 'What this PR changes that no Expected or acceptance line asks for (from the PR check\'s flow critic). Review each one; the ticket\'s owner decides whether it stays.', '', ...list.map((x) => `- ${x}`), SIDE_END].join('\n');
}
export function withSideEffects(body, list = []) {
  const text = String(body ?? '').replace(/\r\n/g, '\n');
  const re = new RegExp(`\\n*${SIDE_START}[\\s\\S]*?${SIDE_END}`);
  const section = sideEffectsSection(list);
  if (re.test(text)) return section ? text.replace(re, `\n\n${section}`) : text.replace(re, '').replace(/\n+$/, '');
  return section ? `${text.replace(/\s+$/, '')}\n\n${section}\n` : text;
}
