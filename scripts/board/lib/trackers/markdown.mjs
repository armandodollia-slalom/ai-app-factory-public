// Markdown <-> the body formats of the REST trackers, through one small document tree:
//   Jira Cloud: Atlassian Document Format (ADF, JSON)      mdToAdf / adfToMd
//   Jira Data Center: wiki markup                           mdToWiki / wikiToMd
//   Azure Boards: HTML                                      mdToHtml / htmlToMd
//
// The factory writes Markdown (the story format of docs/ai-pipeline/writing-stories.md): headings,
// paragraphs, bullet and numbered lists (nested), tables, fenced code, block quotes, rules, bold,
// italics, strike, inline code, links and images. Raw HTML blocks (the hidden `<!-- ... -->` markers of
// the Decisions and Triage sections) have no equivalent in ADF or wiki markup; they travel as a code
// block in the language `factory-html`, so they survive a round trip and stay recognisable.
//
// Round trip: md -> X -> md gives the canonical Markdown (`*` bullets, `1.` numbers, `| --- |` tables,
// ``` fences, `**bold**`, `_italic_`). The story template is already canonical, so it comes back byte for
// byte, and a second round trip of anything is stable (tested in trackers.test.mjs).

export const RAW_HTML_LANG = 'factory-html';

// ---------------------------------------------------------------------------------------------
// Markdown -> tree
// ---------------------------------------------------------------------------------------------

const FENCE = /^(\s*)(`{3,}|~{3,})\s*([^`\s]*)\s*$/;
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const LIST = /^(\s*)([*+-]|\d{1,9}[.)])(\s+|$)/;
const TABLE_SEP = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;
const HTML_START = /^\s*<(!--|\/?(details|summary|div|table|thead|tbody|tr|td|th|p|pre|section|article|ul|ol|li|h[1-6]|blockquote|hr|br|img|center|figure|sub|sup|picture|video|source)(\s|>|\/>|$))/i;

const isBlank = (l) => !l.trim();
const indentOf = (l) => /^\s*/.exec(l)[0].replace(/\t/g, '    ').length;

export function parseMarkdown(text) {
  const lines = String(text ?? '').replace(/\r\n/g, '\n').split('\n');
  return parseBlocks(lines);
}

function startsBlock(line, next) {
  return FENCE.test(line) || HEADING.test(line) || RULE.test(line) || /^\s*>/.test(line) || LIST.test(line) || HTML_START.test(line) || (/^\s*\|/.test(line) && next != null && TABLE_SEP.test(next));
}

function parseBlocks(lines) {
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (isBlank(line)) {
      i++;
      continue;
    }
    let m;
    if ((m = FENCE.exec(line))) {
      const fence = m[2];
      const body = [];
      i++;
      while (i < lines.length && !(lines[i].trim().startsWith(fence[0].repeat(fence.length)) && /^\s*[`~]+\s*$/.test(lines[i]))) body.push(lines[i++]);
      i++;
      const lang = m[3] || null;
      blocks.push(lang === RAW_HTML_LANG ? { type: 'html', text: body.join('\n') } : { type: 'code', lang, text: body.join('\n') });
      continue;
    }
    if ((m = HEADING.exec(line))) {
      blocks.push({ type: 'heading', level: m[1].length, children: parseInline(m[2]) });
      i++;
      continue;
    }
    if (RULE.test(line) && !LIST.test(line.replace(/^(\s*[-*_]\s){3,}.*/, ''))) {
      blocks.push({ type: 'rule' });
      i++;
      continue;
    }
    if (/^\s*>/.test(line)) {
      const inner = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) inner.push(lines[i++].replace(/^\s*>\s?/, ''));
      blocks.push({ type: 'quote', children: parseBlocks(inner) });
      continue;
    }
    if (/^\s*\|/.test(line) && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1])) {
      const header = splitRow(line);
      i += 2;
      const rows = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) rows.push(splitRow(lines[i++]));
      blocks.push({ type: 'table', header: header.map(parseInline), rows: rows.map((r) => header.map((_, k) => parseInline(r[k] ?? ''))) });
      continue;
    }
    if (HTML_START.test(line)) {
      const body = [];
      if (/^\s*<!--/.test(line)) {
        while (i < lines.length) {
          body.push(lines[i]);
          if (lines[i++].includes('-->')) break;
        }
        // Text right after a comment on the same block (`<!-- a -->` lines) stays one block until a blank.
        while (i < lines.length && /^\s*<!--.*-->\s*$/.test(lines[i])) body.push(lines[i++]);
      } else while (i < lines.length && !isBlank(lines[i])) body.push(lines[i++]);
      blocks.push({ type: 'html', text: body.join('\n') });
      continue;
    }
    if (LIST.test(line)) {
      const r = parseList(lines, i);
      blocks.push(r.list);
      i = r.next;
      continue;
    }
    const para = [];
    while (i < lines.length && !isBlank(lines[i]) && (para.length === 0 || !startsBlock(lines[i], lines[i + 1]))) para.push(lines[i++].trim());
    blocks.push({ type: 'paragraph', children: parseInline(para.join('\n')) });
  }
  return blocks;
}

function splitRow(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  const cells = [];
  let cur = '';
  for (let k = 0; k < s.length; k++) {
    if (s[k] === '\\' && s[k + 1] === '|') {
      cur += '|';
      k++;
    } else if (s[k] === '|') {
      cells.push(cur.trim());
      cur = '';
    } else cur += s[k];
  }
  cells.push(cur.trim());
  return cells;
}

function parseList(lines, start) {
  const first = LIST.exec(lines[start]);
  const baseIndent = indentOf(first[1]);
  const ordered = /\d/.test(first[2]);
  const list = { type: 'list', ordered, start: ordered ? Number.parseInt(first[2], 10) : null, items: [] };
  let i = start;
  while (i < lines.length) {
    const m = LIST.exec(lines[i]);
    if (!m || indentOf(m[1]) !== baseIndent || /\d/.test(m[2]) !== ordered) break;
    const contentIndent = m[0].length;
    const body = [lines[i].slice(m[0].length)];
    i++;
    while (i < lines.length) {
      const l = lines[i];
      if (isBlank(l)) {
        // A blank line continues the item only when indented content follows.
        let j = i;
        while (j < lines.length && isBlank(lines[j])) j++;
        if (j < lines.length && indentOf(lines[j]) >= contentIndent && !(LIST.test(lines[j]) && indentOf(LIST.exec(lines[j])[1]) <= baseIndent)) {
          for (; i < j; i++) body.push('');
          continue;
        }
        break;
      }
      const lm = LIST.exec(l);
      if (lm && indentOf(lm[1]) <= baseIndent) break;
      if (indentOf(l) >= contentIndent || lm) body.push(l.slice(Math.min(indentOf(l), contentIndent)));
      else if (!startsBlock(l, lines[i + 1])) body.push(l.trim()); // lazy continuation
      else break;
      i++;
    }
    list.items.push({ children: parseBlocks(body) });
  }
  return { list, next: i };
}

// Inline Markdown -> nodes: text, strong, em, strike, code, link, image.
export function parseInline(src) {
  const s = String(src ?? '');
  const out = [];
  let text = '';
  const flush = () => {
    if (text) out.push({ type: 'text', text });
    text = '';
  };
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    const rest = s.slice(i);
    let m;
    if (c === '\\' && /[\\`*_{}[\]()#+\-.!|~<>]/.test(s[i + 1] ?? '')) {
      text += s[i + 1];
      i += 2;
      continue;
    }
    if (c === '`') {
      const run = /^`+/.exec(rest)[0];
      const close = s.indexOf(run, i + run.length);
      if (close > 0) {
        let code = s.slice(i + run.length, close);
        if (code.startsWith(' ') && code.endsWith(' ') && code.trim()) code = code.slice(1, -1);
        flush();
        out.push({ type: 'code', text: code });
        i = close + run.length;
        continue;
      }
    }
    if ((m = /^!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/.exec(rest))) {
      flush();
      out.push({ type: 'image', alt: m[1], src: m[2] });
      i += m[0].length;
      continue;
    }
    if (c === '[' && (m = /^\[((?:[^[\]\\]|\\.|\[[^\]]*\])*)\]\(([^)\s]*)(?:\s+"[^"]*")?\)/.exec(rest))) {
      flush();
      out.push({ type: 'link', href: m[2], children: parseInline(m[1]) });
      i += m[0].length;
      continue;
    }
    if (c === '<' && (m = /^<(https?:\/\/[^>\s]+)>/.exec(rest))) {
      flush();
      out.push({ type: 'link', href: m[1], children: [{ type: 'text', text: m[1] }], auto: true });
      i += m[0].length;
      continue;
    }
    if (rest.startsWith('~~')) {
      const close = s.indexOf('~~', i + 2);
      if (close > i + 2) {
        flush();
        out.push({ type: 'strike', children: parseInline(s.slice(i + 2, close)) });
        i = close + 2;
        continue;
      }
    }
    if ((rest.startsWith('**') || rest.startsWith('__')) && s[i + 2] && !/\s/.test(s[i + 2])) {
      const d = rest.slice(0, 2);
      const close = findClose(s, d, i + 2);
      if (close > 0) {
        flush();
        out.push({ type: 'strong', children: parseInline(s.slice(i + 2, close)) });
        i = close + 2;
        continue;
      }
    }
    if ((c === '*' || c === '_') && s[i + 1] && !/\s/.test(s[i + 1]) && s[i + 1] !== c && !(c === '_' && /[A-Za-z0-9]/.test(s[i - 1] ?? ''))) {
      const close = findClose(s, c, i + 1);
      if (close > 0) {
        flush();
        out.push({ type: 'em', children: parseInline(s.slice(i + 1, close)) });
        i = close + 1;
        continue;
      }
    }
    text += c;
    i++;
  }
  flush();
  return mergeInline(out);
}

function findClose(s, d, from) {
  for (let k = from; k <= s.length - d.length; k++) {
    if (s[k] === '\\') {
      k++;
      continue;
    }
    if (s[k] === '`') {
      const run = /^`+/.exec(s.slice(k))[0];
      const close = s.indexOf(run, k + run.length);
      if (close > 0) {
        k = close + run.length - 1;
        continue;
      }
    }
    if (s.startsWith(d, k) && !/\s/.test(s[k - 1]) && k > from) {
      if (d.length === 1 && s[k + 1] === d) {
        k++;
        continue;
      }
      if (d === '_' && /[A-Za-z0-9]/.test(s[k + 1] ?? '')) continue;
      return k;
    }
  }
  return -1;
}

const WRAPS = ['strong', 'em', 'strike'];
export function mergeInline(nodes) {
  const out = [];
  for (const n of nodes) {
    const prev = out.at(-1);
    if (n.type === 'text' && !n.text) continue;
    if (prev && n.type === 'text' && prev.type === 'text') prev.text += n.text;
    else if (prev && WRAPS.includes(n.type) && prev.type === n.type) prev.children = mergeInline([...prev.children, ...n.children]);
    else if (prev && n.type === 'link' && prev.type === 'link' && prev.href === n.href && !n.auto && !prev.auto) prev.children = mergeInline([...prev.children, ...n.children]);
    else out.push(WRAPS.includes(n.type) || n.type === 'link' ? { ...n, children: mergeInline(n.children ?? []) } : { ...n });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Tree -> Markdown (canonical)
// ---------------------------------------------------------------------------------------------

export function renderMarkdown(blocks) {
  return `${blocks.map((b) => mdBlock(b)).join('\n\n')}\n`;
}

function mdBlock(b) {
  switch (b.type) {
    case 'heading':
      return `${'#'.repeat(b.level)} ${mdInline(b.children)}`;
    case 'paragraph':
      return mdInline(b.children);
    case 'rule':
      return '---';
    case 'code': {
      const fence = b.text.includes('```') ? '````' : '```';
      return `${fence}${b.lang ?? ''}\n${b.text}\n${fence}`;
    }
    case 'html':
      return b.text;
    case 'quote':
      return b.children
        .map(mdBlock)
        .join('\n\n')
        .split('\n')
        .map((l) => (l ? `> ${l}` : '>'))
        .join('\n');
    case 'table': {
      const cell = (c) => mdInline(c).replace(/\|/g, '\\|').replace(/\n/g, ' ');
      return [`| ${b.header.map(cell).join(' | ')} |`, `| ${b.header.map(() => '---').join(' | ')} |`, ...b.rows.map((r) => `| ${r.map(cell).join(' | ')} |`)].join('\n');
    }
    case 'list':
      return b.items
        .map((item, k) => {
          const marker = b.ordered ? `${(b.start ?? 1) + k}.` : '*';
          const pad = ' '.repeat(marker.length + 1);
          const inner = item.children.map(mdBlock);
          // Tight items: a paragraph and its nested list sit on consecutive lines.
          const text = inner.reduce((acc, part, j) => (j === 0 ? part : `${acc}${item.children[j].type === 'list' && item.children[j - 1].type === 'paragraph' ? '\n' : '\n\n'}${part}`), '');
          return `${marker} ${text.split('\n').map((l, j) => (j === 0 || !l ? l : pad + l)).join('\n')}`;
        })
        .join('\n');
    default:
      return '';
  }
}

export function mdInline(nodes) {
  return (nodes ?? []).map(mdNode).join('');
}

function mdNode(n) {
  switch (n.type) {
    case 'text':
      return mdText(n.text);
    case 'strong':
      return `**${mdInline(n.children)}**`;
    case 'em':
      return `_${mdInline(n.children)}_`;
    case 'strike':
      return `~~${mdInline(n.children)}~~`;
    case 'code': {
      const run = '`'.repeat((n.text.match(/`+/g) ?? []).reduce((m, r) => Math.max(m, r.length), 0) + 1);
      return run.length > 1 || n.text.startsWith('`') ? `${run} ${n.text} ${run}` : `\`${n.text}\``;
    }
    case 'link':
      return n.auto ? `<${n.href}>` : `[${mdInline(n.children)}](${n.href})`;
    case 'image':
      return `![${n.alt ?? ''}](${n.src})`;
    default:
      return '';
  }
}

// Text is written as is when it reads back as the same text; otherwise the characters that would
// start markup are escaped.
function mdText(text) {
  const plain = parseInline(text);
  if (plain.length === 1 && plain[0].type === 'text' && plain[0].text === text) return text;
  if (!text) return '';
  return text.replace(/([\\`*_[\]~<])/g, '\\$1');
}

// ---------------------------------------------------------------------------------------------
// ADF (Jira Cloud)
// ---------------------------------------------------------------------------------------------

export function mdToAdf(markdown) {
  return { version: 1, type: 'doc', content: parseMarkdown(markdown).map(adfBlock) };
}

const adfText = (text, marks) => ({ type: 'text', text, ...(marks.length ? { marks } : {}) });

function adfInline(nodes, marks = []) {
  const out = [];
  for (const n of nodes) {
    if (n.type === 'text') {
      const parts = n.text.split('\n');
      parts.forEach((p, k) => {
        if (k) out.push({ type: 'hardBreak' });
        if (p) out.push(adfText(p, marks));
      });
    } else if (n.type === 'code') out.push(adfText(n.text, [...marks.filter((m) => m.type === 'link'), { type: 'code' }]));
    else if (n.type === 'strong') out.push(...adfInline(n.children, [...marks, { type: 'strong' }]));
    else if (n.type === 'em') out.push(...adfInline(n.children, [...marks, { type: 'em' }]));
    else if (n.type === 'strike') out.push(...adfInline(n.children, [...marks, { type: 'strike' }]));
    else if (n.type === 'link') out.push(...adfInline(n.children, [{ type: 'link', attrs: { href: n.href } }, ...marks]));
    else if (n.type === 'image') out.push(adfText(n.alt || n.src, [{ type: 'link', attrs: { href: n.src, title: 'image' } }]));
  }
  return out;
}

function adfBlock(b) {
  switch (b.type) {
    case 'heading':
      return { type: 'heading', attrs: { level: b.level }, content: adfInline(b.children) };
    case 'paragraph':
      if (b.children.length === 1 && b.children[0].type === 'image') return { type: 'mediaSingle', attrs: { layout: 'center' }, content: [{ type: 'media', attrs: { type: 'external', url: b.children[0].src, alt: b.children[0].alt ?? '' } }] };
      return { type: 'paragraph', content: adfInline(b.children) };
    case 'rule':
      return { type: 'rule' };
    case 'code':
      return { type: 'codeBlock', attrs: b.lang ? { language: b.lang } : {}, content: b.text ? [{ type: 'text', text: b.text }] : [] };
    case 'html':
      return { type: 'codeBlock', attrs: { language: RAW_HTML_LANG }, content: [{ type: 'text', text: b.text }] };
    case 'quote':
      return { type: 'blockquote', content: b.children.map(adfBlock) };
    case 'list':
      return {
        type: b.ordered ? 'orderedList' : 'bulletList',
        ...(b.ordered ? { attrs: { order: b.start ?? 1 } } : {}),
        content: b.items.map((it) => ({ type: 'listItem', content: it.children.length ? it.children.map(adfBlock) : [{ type: 'paragraph', content: [] }] })),
      };
    case 'table':
      return {
        type: 'table',
        attrs: { isNumberColumnEnabled: false, layout: 'default' },
        content: [
          { type: 'tableRow', content: b.header.map((c) => ({ type: 'tableHeader', attrs: {}, content: [{ type: 'paragraph', content: adfInline(c) }] })) },
          ...b.rows.map((r) => ({ type: 'tableRow', content: r.map((c) => ({ type: 'tableCell', attrs: {}, content: [{ type: 'paragraph', content: adfInline(c) }] })) })),
        ],
      };
    default:
      return { type: 'paragraph', content: [] };
  }
}

export function adfToMd(doc) {
  if (doc == null) return '';
  if (typeof doc === 'string') return doc;
  const blocks = (doc.content ?? []).flatMap(fromAdfBlock);
  return blocks.length ? renderMarkdown(blocks) : '';
}

function fromAdfInline(nodes) {
  const out = [];
  for (const n of nodes ?? []) {
    if (n.type === 'hardBreak') out.push({ type: 'text', text: '\n' });
    else if (n.type === 'text') {
      const marks = n.marks ?? [];
      let node = marks.some((m) => m.type === 'code') ? { type: 'code', text: n.text } : { type: 'text', text: n.text };
      for (const t of ['strike', 'em', 'strong']) if (marks.some((m) => m.type === t)) node = { type: t, children: [node] };
      const link = marks.find((m) => m.type === 'link');
      if (link) node = link.attrs?.title === 'image' ? { type: 'image', src: link.attrs.href, alt: n.text === link.attrs.href ? '' : n.text } : { type: 'link', href: link.attrs?.href ?? '', children: [node] };
      out.push(node);
    } else if (n.type === 'mention') out.push({ type: 'text', text: n.attrs?.text ?? `@${n.attrs?.id ?? ''}` });
    else if (n.type === 'emoji') out.push({ type: 'text', text: n.attrs?.text ?? n.attrs?.shortName ?? '' });
    else if (n.type === 'inlineCard') out.push({ type: 'link', href: n.attrs?.url ?? '', children: [{ type: 'text', text: n.attrs?.url ?? '' }], auto: true });
    else if (n.type === 'date') out.push({ type: 'text', text: new Date(Number(n.attrs?.timestamp)).toISOString().slice(0, 10) });
    else if (n.type === 'status') out.push({ type: 'text', text: n.attrs?.text ?? '' });
    else if (n.content) out.push(...fromAdfInline(n.content));
  }
  return mergeInline(out);
}

function fromAdfBlock(n) {
  switch (n.type) {
    case 'heading':
      return [{ type: 'heading', level: n.attrs?.level ?? 1, children: fromAdfInline(n.content) }];
    case 'paragraph':
      return [{ type: 'paragraph', children: fromAdfInline(n.content) }];
    case 'rule':
      return [{ type: 'rule' }];
    case 'codeBlock': {
      const text = (n.content ?? []).map((t) => t.text ?? '').join('');
      return n.attrs?.language === RAW_HTML_LANG ? [{ type: 'html', text }] : [{ type: 'code', lang: n.attrs?.language ?? null, text }];
    }
    case 'blockquote':
    case 'panel':
      return [{ type: 'quote', children: (n.content ?? []).flatMap(fromAdfBlock) }];
    case 'bulletList':
    case 'orderedList':
      return [{ type: 'list', ordered: n.type === 'orderedList', start: n.type === 'orderedList' ? (n.attrs?.order ?? 1) : null, items: (n.content ?? []).map((it) => ({ children: (it.content ?? []).flatMap(fromAdfBlock) })) }];
    case 'taskList':
      return [{ type: 'list', ordered: false, start: null, items: (n.content ?? []).map((it) => ({ children: [{ type: 'paragraph', children: [{ type: 'text', text: it.attrs?.state === 'DONE' ? '[x] ' : '[ ] ' }, ...fromAdfInline(it.content)] }] })) }];
    case 'mediaSingle':
    case 'mediaGroup':
      return (n.content ?? []).map((m) => ({ type: 'paragraph', children: [{ type: 'image', src: m.attrs?.url ?? m.attrs?.id ?? '', alt: m.attrs?.alt ?? '' }] }));
    case 'table': {
      const rows = (n.content ?? []).map((r) => (r.content ?? []).map((c) => fromAdfInline((c.content ?? []).flatMap((p) => (p.type === 'paragraph' ? [...(p.content ?? [])] : p.content ?? [])))));
      if (!rows.length) return [];
      return [{ type: 'table', header: rows[0], rows: rows.slice(1).map((r) => rows[0].map((_, k) => r[k] ?? [])) }];
    }
    case 'expand':
    case 'nestedExpand':
    case 'layoutSection':
    case 'layoutColumn':
      return (n.content ?? []).flatMap(fromAdfBlock);
    default:
      return n.content ? [{ type: 'paragraph', children: fromAdfInline(n.content) }] : [];
  }
}

// ---------------------------------------------------------------------------------------------
// Jira wiki markup (Data Center)
// ---------------------------------------------------------------------------------------------

export function mdToWiki(markdown) {
  return `${parseMarkdown(markdown).map((b) => wikiBlock(b)).join('\n\n')}\n`;
}

const wikiEscape = (t) => t.replace(/([\\*_{}[\]!|^~+?-])/g, (m, c, off, s) => {
  // `-` and `+` only mark up a word that starts with them; `?` only as `??`.
  if ((c === '-' || c === '+') && !(off === 0 || /\s/.test(s[off - 1])) && !(off === s.length - 1 || /\s/.test(s[off + 1]))) return c;
  if (c === '-' && /\s/.test(s[off + 1] ?? ' ') && (off === 0 || /\s/.test(s[off - 1]))) return c;
  if (c === '?' && s[off + 1] !== '?' && s[off - 1] !== '?') return c;
  return `\\${c}`;
});

function wikiInline(nodes) {
  return (nodes ?? [])
    .map((n) => {
      switch (n.type) {
        case 'text':
          return wikiEscape(n.text).replace(/\n/g, '\\\\\n');
        case 'strong':
          return `*${wikiInline(n.children)}*`;
        case 'em':
          return `_${wikiInline(n.children)}_`;
        case 'strike':
          return `-${wikiInline(n.children)}-`;
        case 'code':
          return `{{${n.text.replace(/([{}])/g, '\\$1')}}}`;
        case 'link':
          return n.auto ? `[${n.href}]` : `[${wikiInline(n.children)}|${n.href}]`;
        case 'image':
          return `!${n.src}${n.alt ? `|alt=${n.alt.replace(/[|!,]/g, ' ')}` : ''}!`;
        default:
          return '';
      }
    })
    .join('');
}

function wikiBlock(b, prefix = '') {
  switch (b.type) {
    case 'heading':
      return `h${b.level}. ${wikiInline(b.children)}`;
    case 'paragraph':
      return wikiInline(b.children);
    case 'rule':
      return '----';
    case 'code':
      return `{code${b.lang ? `:${b.lang}` : ''}}\n${b.text}\n{code}`;
    case 'html':
      return `{code:${RAW_HTML_LANG}}\n${b.text}\n{code}`;
    case 'quote':
      return `{quote}\n${b.children.map((c) => wikiBlock(c)).join('\n\n')}\n{quote}`;
    case 'table':
      return [`||${b.header.map((c) => wikiInline(c) || ' ').join('||')}||`, ...b.rows.map((r) => `|${r.map((c) => wikiInline(c) || ' ').join('|')}|`)].join('\n');
    case 'list': {
      const p = `${prefix}${b.ordered ? '#' : '*'}`;
      return b.items
        .map((it) => {
          const [first, ...more] = it.children;
          const head = `${p} ${first && first.type !== 'list' ? wikiBlock(first).replace(/\n/g, '\\\\ ') : ''}`;
          const tail = (first?.type === 'list' ? it.children : more).map((c) => (c.type === 'list' ? wikiBlock(c, p) : `${p} ${wikiBlock(c).replace(/\n/g, '\\\\ ')}`));
          return [head, ...tail].join('\n');
        })
        .join('\n');
    }
    default:
      return '';
  }
}

export function wikiToMd(wiki) {
  const blocks = parseWiki(String(wiki ?? ''));
  return blocks.length ? renderMarkdown(blocks) : '';
}

function parseWiki(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    let m;
    if (!line.trim()) {
      i++;
      continue;
    }
    if ((m = /^\s*\{(code|noformat)(?::([^}|]*))?[^}]*\}\s*(.*)$/.exec(line))) {
      const tag = m[1];
      const body = m[3] ? [m[3]] : [];
      i++;
      while (i < lines.length && !lines[i].includes(`{${tag}}`)) body.push(lines[i++]);
      if (i < lines.length) {
        const before = lines[i].slice(0, lines[i].indexOf(`{${tag}}`));
        if (before) body.push(before);
      }
      i++;
      const lang = tag === 'code' && m[2] ? m[2].replace(/^language=/, '') : null;
      blocks.push(lang === RAW_HTML_LANG ? { type: 'html', text: body.join('\n') } : { type: 'code', lang, text: body.join('\n') });
      continue;
    }
    if (/^\s*\{quote\}/.test(line)) {
      const body = [line.replace(/^\s*\{quote\}/, '')];
      i++;
      while (i < lines.length && !lines[i].includes('{quote}')) body.push(lines[i++]);
      if (i < lines.length) body.push(lines[i].replace('{quote}', ''));
      i++;
      blocks.push({ type: 'quote', children: parseWiki(body.join('\n')) });
      continue;
    }
    if ((m = /^\s*h([1-6])\.\s+(.*)$/.exec(line))) {
      blocks.push({ type: 'heading', level: Number(m[1]), children: parseWikiInline(m[2]) });
      i++;
      continue;
    }
    if (/^\s*bq\.\s/.test(line)) {
      blocks.push({ type: 'quote', children: [{ type: 'paragraph', children: parseWikiInline(line.replace(/^\s*bq\.\s+/, '')) }] });
      i++;
      continue;
    }
    if (/^\s*-{4,}\s*$/.test(line)) {
      blocks.push({ type: 'rule' });
      i++;
      continue;
    }
    if (/^\s*\|/.test(line)) {
      const rows = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) rows.push(lines[i++]);
      const cells = (row) => splitWikiRow(row.trim()).map((c) => parseWikiInline(c.trim()));
      const header = /^\s*\|\|/.test(rows[0]) ? cells(rows[0]) : null;
      const body = (header ? rows.slice(1) : rows).map(cells);
      const head = header ?? body.shift() ?? [];
      blocks.push({ type: 'table', header: head, rows: body.map((r) => head.map((_, k) => r[k] ?? [])) });
      continue;
    }
    if (/^\s*[*#-]+\s/.test(line) && !/^\s*-{4,}/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*[*#-]+\s/.test(lines[i])) {
        const mm = /^\s*([*#-]+)\s+(.*)$/.exec(lines[i++]);
        items.push({ path: mm[1].replace(/-/g, '*'), text: mm[2] });
      }
      blocks.push(...buildWikiList(items, 0));
      continue;
    }
    const para = [];
    while (i < lines.length && lines[i].trim() && !/^\s*(\{(code|noformat|quote)|h[1-6]\.\s|bq\.\s|-{4,}\s*$|\||[*#-]+\s)/.test(lines[i])) para.push(lines[i++]);
    if (!para.length) para.push(lines[i++]);
    blocks.push({ type: 'paragraph', children: parseWikiInline(para.join('\n').replace(/\\\\\n/g, '\n')) });
  }
  return blocks;
}

function splitWikiRow(row) {
  const cells = [];
  let cur = '';
  let depth = 0;
  for (let k = 0; k < row.length; k++) {
    const c = row[k];
    if (c === '\\' && k + 1 < row.length) {
      cur += c + row[++k];
      continue;
    }
    if (c === '[' || c === '{') depth++;
    if ((c === ']' || c === '}') && depth) depth--;
    if (c === '|' && !depth) {
      cells.push(cur);
      cur = '';
      while (row[k + 1] === '|') k++;
      continue;
    }
    cur += c;
  }
  if (cur.trim()) cells.push(cur);
  return cells.slice(cells[0] === '' ? 1 : 0).filter((_, k, a) => !(k === a.length - 1 && a[k] === ''));
}

function buildWikiList(items, depth) {
  const lists = [];
  let k = 0;
  while (k < items.length) {
    const ordered = items[k].path[depth] === '#';
    const list = { type: 'list', ordered, start: ordered ? 1 : null, items: [] };
    while (k < items.length && items[k].path.length > depth && (items[k].path[depth] === '#') === ordered) {
      if (items[k].path.length === depth + 1) {
        list.items.push({ children: [{ type: 'paragraph', children: parseWikiInline(items[k].text.replace(/\\\\ ?/g, '\n')) }] });
        k++;
      } else {
        const nested = [];
        while (k < items.length && items[k].path.length > depth + 1) nested.push(items[k++]);
        if (!list.items.length) list.items.push({ children: [] });
        list.items.at(-1).children.push(...buildWikiList(nested, depth + 1));
      }
    }
    if (!list.items.length) k++;
    else lists.push(list);
  }
  return lists;
}

export function parseWikiInline(src) {
  const s = String(src ?? '');
  const out = [];
  let text = '';
  const flush = () => {
    if (text) out.push({ type: 'text', text });
    text = '';
  };
  const boundaryBefore = (k) => k === 0 || /[\s([{>|]/.test(s[k - 1]);
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    const rest = s.slice(i);
    let m;
    if (c === '\\' && i + 1 < s.length) {
      if (s[i + 1] === '\\') {
        text += '\n';
        i += 2;
        continue;
      }
      text += s[i + 1];
      i += 2;
      continue;
    }
    if ((m = /^\{\{((?:\\.|[^}])*)\}\}/.exec(rest))) {
      flush();
      out.push({ type: 'code', text: m[1].replace(/\\([{}])/g, '$1') });
      i += m[0].length;
      continue;
    }
    if ((m = /^\[([^\]|]*)\|([^\]]+)\]/.exec(rest))) {
      flush();
      out.push({ type: 'link', href: m[2].trim(), children: parseWikiInline(m[1]) });
      i += m[0].length;
      continue;
    }
    if ((m = /^\[((?:https?:\/\/|mailto:)[^\]]+)\]/.exec(rest))) {
      flush();
      out.push({ type: 'link', href: m[1], children: [{ type: 'text', text: m[1] }], auto: true });
      i += m[0].length;
      continue;
    }
    if ((m = /^!([^\s!|]+)(?:\|([^!]*))?!/.exec(rest))) {
      flush();
      const alt = /alt=([^,]*)/.exec(m[2] ?? '')?.[1]?.trim() ?? '';
      out.push({ type: 'image', src: m[1], alt });
      i += m[0].length;
      continue;
    }
    const wrap = { '*': 'strong', _: 'em', '-': 'strike', '+': null, '^': null, '~': null }[c];
    if (wrap && boundaryBefore(i) && s[i + 1] && !/\s/.test(s[i + 1])) {
      let close = -1;
      for (let k = i + 1; k < s.length; k++) {
        if (s[k] === '\\') {
          k++;
          continue;
        }
        if (s[k] === c && !/\s/.test(s[k - 1]) && (k + 1 >= s.length || /[\s.,;:!?)\]}|'"]/.test(s[k + 1]) || s[k + 1] === c)) {
          close = k;
          break;
        }
      }
      if (close > i + 1) {
        flush();
        out.push({ type: wrap, children: parseWikiInline(s.slice(i + 1, close)) });
        i = close + 1;
        continue;
      }
    }
    text += c;
    i++;
  }
  flush();
  return mergeInline(out);
}

// ---------------------------------------------------------------------------------------------
// HTML (Azure Boards)
// ---------------------------------------------------------------------------------------------

const escHtml = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function mdToHtml(markdown) {
  return parseMarkdown(markdown).map(htmlBlock).join('\n');
}

function htmlInline(nodes) {
  return (nodes ?? [])
    .map((n) => {
      switch (n.type) {
        case 'text':
          return escHtml(n.text).replace(/\n/g, '<br>');
        case 'strong':
          return `<strong>${htmlInline(n.children)}</strong>`;
        case 'em':
          return `<em>${htmlInline(n.children)}</em>`;
        case 'strike':
          return `<del>${htmlInline(n.children)}</del>`;
        case 'code':
          return `<code>${escHtml(n.text)}</code>`;
        case 'link':
          return `<a href="${escHtml(n.href)}"${n.auto ? ' data-auto="1"' : ''}>${htmlInline(n.children)}</a>`;
        case 'image':
          return `<img src="${escHtml(n.src)}" alt="${escHtml(n.alt ?? '')}">`;
        default:
          return '';
      }
    })
    .join('');
}

function htmlBlock(b) {
  switch (b.type) {
    case 'heading':
      return `<h${b.level}>${htmlInline(b.children)}</h${b.level}>`;
    case 'paragraph':
      return `<p>${htmlInline(b.children)}</p>`;
    case 'rule':
      return '<hr>';
    case 'code':
      return `<pre><code${b.lang ? ` class="language-${escHtml(b.lang)}"` : ''}>${escHtml(b.text)}</code></pre>`;
    case 'html':
      return `<pre><code class="language-${RAW_HTML_LANG}">${escHtml(b.text)}</code></pre>`;
    case 'quote':
      return `<blockquote>${b.children.map(htmlBlock).join('\n')}</blockquote>`;
    case 'list': {
      const tag = b.ordered ? 'ol' : 'ul';
      const start = b.ordered && (b.start ?? 1) !== 1 ? ` start="${b.start}"` : '';
      return `<${tag}${start}>${b.items.map((it) => `<li>${it.children.map((c, k) => (c.type === 'paragraph' && k === 0 ? htmlInline(c.children) : htmlBlock(c))).join('')}</li>`).join('')}</${tag}>`;
    }
    case 'table':
      return `<table><thead><tr>${b.header.map((c) => `<th>${htmlInline(c)}</th>`).join('')}</tr></thead><tbody>${b.rows.map((r) => `<tr>${r.map((c) => `<td>${htmlInline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
    default:
      return '';
  }
}

const VOID = new Set(['br', 'hr', 'img', 'input', 'meta', 'link', 'col', 'area', 'base', 'wbr', 'source']);
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };
const decode = (t) => t.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*);/gi, (m, e) => (e[0] === '#' ? String.fromCodePoint(e[1].toLowerCase() === 'x' ? Number.parseInt(e.slice(2), 16) : Number(e.slice(1))) : ENTITIES[e.toLowerCase()] ?? m));

// A small HTML parser: elements { tag, attrs, children } and text { text }; comments are kept.
export function parseHtml(html) {
  const root = { tag: '#root', attrs: {}, children: [] };
  const stack = [root];
  const re = /<!--([\s\S]*?)-->|<\/\s*([a-zA-Z][\w-]*)\s*>|<([a-zA-Z][\w-]*)((?:\s+[^\s=>/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/?)>|([^<]+|<)/g;
  let m;
  while ((m = re.exec(String(html ?? '')))) {
    const top = stack.at(-1);
    if (m[1] != null) top.children.push({ comment: m[1] });
    else if (m[2]) {
      const tag = m[2].toLowerCase();
      const at = stack.map((n) => n.tag).lastIndexOf(tag);
      if (at > 0) stack.length = at;
    } else if (m[3]) {
      const tag = m[3].toLowerCase();
      const attrs = {};
      for (const a of m[4].matchAll(/([^\s=>/]+)(?:\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) attrs[a[1].toLowerCase()] = decode(a[3] ?? a[4] ?? a[5] ?? '');
      // An open <p> or <li> closes when a block of the same kind starts.
      if (['p', 'li', 'tr', 'td', 'th'].includes(tag)) {
        const at = stack.map((n) => n.tag).lastIndexOf(tag);
        if (at > 0 && (tag !== 'li' || !stack.slice(at).some((n) => ['ul', 'ol'].includes(n.tag)))) stack.length = at;
      }
      const el = { tag, attrs, children: [] };
      stack.at(-1).children.push(el);
      if (!VOID.has(tag) && !m[5]) stack.push(el);
    } else top.children.push({ text: decode(m[6]) });
  }
  return root;
}

const BLOCK_TAGS = new Set(['p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'pre', 'blockquote', 'hr', 'table', 'section', 'article', 'details', 'summary']);

export function htmlToMd(html) {
  const blocks = fromHtmlBlocks(parseHtml(html).children);
  return blocks.length ? renderMarkdown(blocks) : '';
}

function fromHtmlInline(nodes, { pre = false } = {}) {
  const out = [];
  for (const n of nodes) {
    if (n.comment != null) continue;
    if (n.text != null) {
      out.push({ type: 'text', text: pre ? n.text : n.text.replace(/\s+/g, ' ') });
      continue;
    }
    const kids = () => fromHtmlInline(n.children, { pre });
    switch (n.tag) {
      case 'br':
        out.push({ type: 'text', text: '\n' });
        break;
      case 'strong':
      case 'b':
        out.push({ type: 'strong', children: kids() });
        break;
      case 'em':
      case 'i':
        out.push({ type: 'em', children: kids() });
        break;
      case 'del':
      case 's':
      case 'strike':
        out.push({ type: 'strike', children: kids() });
        break;
      case 'code':
        out.push({ type: 'code', text: textOf(n) });
        break;
      case 'a':
        out.push({ type: 'link', href: n.attrs.href ?? '', children: kids(), ...(n.attrs['data-auto'] ? { auto: true } : {}) });
        break;
      case 'img':
        out.push({ type: 'image', src: n.attrs.src ?? '', alt: n.attrs.alt ?? '' });
        break;
      default:
        out.push(...kids());
    }
  }
  return mergeInline(out);
}

const textOf = (n) => (n.text != null ? n.text : n.comment != null ? '' : (n.children ?? []).map(textOf).join(''));

function trimInline(nodes) {
  const out = nodes.map((n) => ({ ...n }));
  while (out.length && out[0].type === 'text' && !out[0].text.trim()) out.shift();
  while (out.length && out.at(-1).type === 'text' && !out.at(-1).text.trim()) out.pop();
  if (out[0]?.type === 'text') out[0].text = out[0].text.replace(/^ +/, '');
  if (out.at(-1)?.type === 'text') out.at(-1).text = out.at(-1).text.replace(/ +$/, '');
  return out.map((n) => (n.type === 'text' ? { ...n, text: n.text.replace(/ *\n */g, '\n') } : n));
}

function fromHtmlBlocks(nodes) {
  const blocks = [];
  let inline = [];
  const flush = () => {
    const children = trimInline(fromHtmlInline(inline));
    if (children.length) blocks.push({ type: 'paragraph', children });
    inline = [];
  };
  for (const n of nodes) {
    if (n.comment != null) {
      flush();
      blocks.push({ type: 'html', text: `<!--${n.comment}-->` });
      continue;
    }
    if (n.text != null || !BLOCK_TAGS.has(n.tag)) {
      inline.push(n);
      continue;
    }
    flush();
    const tag = n.tag;
    if (/^h[1-6]$/.test(tag)) blocks.push({ type: 'heading', level: Number(tag[1]), children: trimInline(fromHtmlInline(n.children)) });
    else if (tag === 'p') {
      const children = trimInline(fromHtmlInline(n.children));
      if (children.length) blocks.push({ type: 'paragraph', children });
    } else if (tag === 'hr') blocks.push({ type: 'rule' });
    else if (tag === 'pre') {
      const code = n.children.find((c) => c.tag === 'code');
      const lang = /language-([\w-]+)/.exec(code?.attrs?.class ?? '')?.[1] ?? null;
      const text = textOf(code ?? n).replace(/\n$/, '');
      blocks.push(lang === RAW_HTML_LANG ? { type: 'html', text } : { type: 'code', lang, text });
    } else if (tag === 'blockquote') blocks.push({ type: 'quote', children: fromHtmlBlocks(n.children) });
    else if (tag === 'ul' || tag === 'ol') {
      const items = n.children.filter((c) => c.tag === 'li').map((li) => ({ children: fromHtmlBlocks(li.children) }));
      blocks.push({ type: 'list', ordered: tag === 'ol', start: tag === 'ol' ? Number(n.attrs.start ?? 1) : null, items });
    } else if (tag === 'table') {
      const rows = [];
      const walk = (x) => {
        for (const c of x.children ?? []) {
          if (c.tag === 'tr') rows.push(c.children.filter((d) => d.tag === 'td' || d.tag === 'th').map((d) => trimInline(fromHtmlInline(d.children))));
          else if (c.children) walk(c);
        }
      };
      walk(n);
      if (rows.length) blocks.push({ type: 'table', header: rows[0], rows: rows.slice(1).map((r) => rows[0].map((_, k) => r[k] ?? [])) });
    } else blocks.push(...fromHtmlBlocks(n.children));
  }
  flush();
  return blocks;
}
