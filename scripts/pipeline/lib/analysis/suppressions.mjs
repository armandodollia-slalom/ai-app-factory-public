// Inline suppressions a change adds (`#pragma warning disable`, `eslint-disable`, `# nosec`, `//nolint`, ...): the
// patterns are data (analysis.suppressions.inline, the packs' own, and SUPPRESSIONS_DEFAULT). They are not findings a
// tool can prove wrong; they are evidence for the council members, who ask for a justification.
import fs from 'node:fs';
import path from 'node:path';
import { git } from '../git.mjs';

// The added lines of the change from `base` (working tree), as [{ file, line, text, id }] for every pattern they match.
export function addedSuppressions(cwd, base, patterns = []) {
  if (!base || !patterns.length) return [];
  const compiled = patterns.map((p) => ({ id: p.id, re: new RegExp(p.pattern) }));
  const r = git(cwd, ['diff', '-U0', '--no-ext-diff', '--no-color', base, '--', '.', ':(exclude).factory/**']);
  if (r.status !== 0) return [];
  const out = [];
  let file = null;
  let line = 0;
  for (const raw of r.stdout.split('\n')) {
    if (raw.startsWith('+++ ')) {
      file = raw.startsWith('+++ b/') ? raw.slice(6) : null;
      continue;
    }
    const h = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (h) {
      line = Number(h[1]);
      continue;
    }
    if (!file || !raw.startsWith('+') || raw.startsWith('+++')) continue;
    const text = raw.slice(1);
    for (const p of compiled) if (p.re.test(text)) out.push({ file, line, text: text.trim().slice(0, 200), id: p.id });
    line++;
  }
  // Untracked files count whole.
  for (const f of git(cwd, ['ls-files', '--others', '--exclude-standard']).stdout.split('\n').filter((x) => x && !x.startsWith('.factory/'))) {
    let lines;
    try {
      lines = fs.readFileSync(path.join(cwd, f), 'utf8').split(/\r?\n/);
    } catch {
      continue;
    }
    lines.forEach((text, i) => {
      for (const p of compiled) if (p.re.test(text)) out.push({ file: f, line: i + 1, text: text.trim().slice(0, 200), id: p.id });
    });
  }
  return out;
}

// The suppressions as evidence text for a member or an implementer.
export function suppressionsText(list) {
  if (!list?.length) return '';
  return [
    `This change adds ${list.length} inline suppression(s) of analysis findings. Each one needs a justification next to it (why the finding does not apply here); one without is a finding of your lens to raise:`,
    ...list.slice(0, 30).map((s) => `- ${s.file}:${s.line} (${s.id}): \`${s.text}\``),
    ...(list.length > 30 ? [`- ... and ${list.length - 30} more`] : []),
  ].join('\n');
}
