#!/usr/bin/env node
// Builds docs/pipeline-explorer.html: one self-contained page (no build step for the reader, no network) that reads its
// flow data and its evaluator from inline scripts, because a page opened from disk (file://) cannot fetch a local JSON.
//
//   node scripts/docs/build-explorer.mjs              inline docs/pipeline-flow.json and scripts/docs/lib/flow-eval.mjs
//   node scripts/docs/build-explorer.mjs --check      exit 1 when the page's inlined copies differ from them
//   node scripts/docs/build-explorer.mjs --mermaid    print the Mermaid spine (marked block) and the node-to-page table
//
// The copies sit between marker comments: <!-- flow-data:start --> ... <!-- flow-data:end --> and
// <!-- flow-eval:start --> ... <!-- flow-eval:end -->.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeText } from '../pipeline/lib/redact.mjs';
import { SPINE_END, SPINE_START, mermaidSpine, nodeTable } from './lib/spine.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const PATHS = {
  html: path.join(ROOT, 'docs/pipeline-explorer.html'),
  data: path.join(ROOT, 'docs/pipeline-flow.json'),
  evaluator: path.join(ROOT, 'scripts/docs/lib/flow-eval.mjs'),
};
const MARK = {
  data: ['<!-- flow-data:start -->', '<!-- flow-data:end -->'],
  evaluator: ['<!-- flow-eval:start -->', '<!-- flow-eval:end -->'],
};

// The data as an inline JSON script: `<` escaped as \u003c, so no `</script>` can close it early; JSON.parse gives the
// same value back.
export const dataScript = (json) => `<script id="flow-data" type="application/json">${JSON.stringify(JSON.parse(json)).replace(/</g, '\\u003c')}</script>`;

// The evaluator module as a classic script exposing `FlowEval` (its exports), so the page works from file://, where
// module scripts with inline imports are not an option.
export function evaluatorScript(source) {
  const names = [...source.matchAll(/^export (?:async )?(?:function|const|let) (\w+)/gm)].map((m) => m[1]);
  const body = source.replace(/^export (?=(?:async )?(?:function|const|let) )/gm, '');
  return `<script>\nconst FlowEval = (() => {\n${body.trimEnd()}\nreturn { ${names.join(', ')} };\n})();\n</script>`;
}

const between = (html, [start, end]) => {
  const s = html.indexOf(start);
  const e = html.indexOf(end);
  if (s < 0 || e < s) throw new Error(`markers ${start} ... ${end} not found in the page`);
  return { s, e, inner: html.slice(s + start.length, e) };
};

export function inline(html, { data, evaluator }) {
  let out = html;
  for (const [key, text] of [['data', dataScript(data)], ['evaluator', evaluatorScript(evaluator)]]) {
    const { s, e } = between(out, MARK[key]);
    out = `${out.slice(0, s + MARK[key][0].length)}\n${text}\n${out.slice(e)}`;
  }
  return out;
}

// What the page carries now: { data (parsed), evaluator (the inline script text) }.
export function extract(html) {
  const data = between(html, MARK.data).inner;
  const json = /<script id="flow-data" type="application\/json">([\s\S]*)<\/script>/.exec(data)?.[1];
  return { data: json ? JSON.parse(json) : null, evaluator: between(html, MARK.evaluator).inner.trim() };
}

export function spineMarkdown(flow) {
  return `${SPINE_START}\n\n\`\`\`mermaid\n${mermaidSpine(flow)}\n\`\`\`\n\n${SPINE_END}\n\n${nodeTable(flow)}\n`;
}

function main(argv) {
  const read = (p) => fs.readFileSync(p, 'utf8');
  const sources = { data: read(PATHS.data), evaluator: read(PATHS.evaluator) };
  if (argv.includes('--mermaid')) {
    process.stdout.write(spineMarkdown(JSON.parse(sources.data)));
    return 0;
  }
  const html = read(PATHS.html);
  const built = inline(html, sources);
  if (argv.includes('--check')) {
    if (built === html) return 0;
    console.error('docs/pipeline-explorer.html is out of date: run node scripts/docs/build-explorer.mjs');
    return 1;
  }
  // Through the redaction boundary like every writer (redaction-guard.test.mjs); the page carries no secrets, so the
  // text is unchanged (the --check run and the tests compare it byte for byte).
  if (built !== html) writeText(PATHS.html, built);
  console.log(built === html ? 'docs/pipeline-explorer.html is up to date' : 'docs/pipeline-explorer.html rebuilt');
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
