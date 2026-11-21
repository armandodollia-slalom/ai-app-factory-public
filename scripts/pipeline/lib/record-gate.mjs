// The scan gate on records that leave the machine (redact.mjs is the boundary; this is its git side). Before the
// harness commits, the staged records are redacted in place and scanned; before it pushes, the records the push carries
// are scanned. A hit that redaction cannot remove blocks (SecretGateError): it never goes out.
//
// Records: the pipeline's metrics, run records, lessons and test-plan records, the paths below.
import fs from 'node:fs';
import path from 'node:path';
import { git } from './git.mjs';
import { SecretGateError, genericHits, redactText } from './redact.mjs';

export const RECORD_PATHS = [/^\.factory\/metrics\//, /^\.factory\/lessons\//, /^\.github\/agents\/lessons\//, /^\.factory\/plans\/.*\.md$/, /^tests\/plans\//, /^\.agent-metrics\//];
export const isRecord = (p) => RECORD_PATHS.some((re) => re.test(p));

// Staged records: redacted in place (and staged again); anything still detected throws.
export function gateStagedRecords(cwd, { run = git } = {}) {
  const staged = run(cwd, ['diff', '--cached', '--name-only', '--diff-filter=AM']).stdout.split('\n').filter((p) => p && isRecord(p));
  const left = [];
  for (const rel of staged) {
    const abs = path.join(cwd, rel);
    let text;
    try {
      text = fs.readFileSync(abs, 'utf8');
    } catch {
      continue;
    }
    const r = redactText(text);
    if (r.text !== text) {
      fs.writeFileSync(abs, r.text);
      run(cwd, ['add', '--', rel]);
    }
    const hits = [...redactText(r.text).hits, ...genericHits(r.text)];
    if (hits.length) left.push(`${rel}: ${[...new Set(hits)].join(', ')}`);
  }
  if (left.length) throw new SecretGateError(`commit of records (${left.join('; ')})`, left);
  return staged.length;
}

// The records a push would carry (changed between `from` and HEAD): scanned at HEAD; a hit blocks the push.
export function gatePushedRecords(cwd, from, { run = git } = {}) {
  const r = run(cwd, ['diff', '--name-only', '--diff-filter=AM', `${from}`, 'HEAD']);
  if (r.status !== 0) return 0;
  const files = r.stdout.split('\n').filter((p) => p && isRecord(p));
  const left = [];
  for (const rel of files) {
    const text = run(cwd, ['show', `HEAD:${rel}`]).stdout ?? '';
    const hits = [...redactText(text).hits, ...genericHits(text)];
    if (hits.length) left.push(`${rel}: ${[...new Set(hits)].join(', ')}`);
  }
  if (left.length) throw new SecretGateError(`push of records (${left.join('; ')})`, left);
  return files.length;
}

// The base a push is measured from: the remote branch when it exists, else the merge-base with the default branch.
export function pushBase(cwd, branch, { run = git } = {}) {
  for (const ref of [`origin/${branch}`, 'origin/HEAD', 'origin/main']) {
    const m = run(cwd, ['merge-base', ref, 'HEAD']);
    if (m.status === 0 && m.stdout.trim()) return m.stdout.trim();
  }
  return null;
}
