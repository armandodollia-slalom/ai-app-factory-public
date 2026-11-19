// Secret findings judged by their value, not by the file they sit in. The value rule itself lives in decide.mjs, the one
// decision the local slots and the generated CI script share; this module adds what only the machine needs (which tools
// are secret tools, whether a value lives only in history).
import { findingLine, matchedSecret, settleSecretFindings, valueCandidates, valueOnBase, whereInWorktree, whereOnRev } from './decide.mjs';

export { findingLine, matchedSecret, settleSecretFindings, valueCandidates, valueOnBase, whereInWorktree, whereOnRev };

// A tool whose findings are secret values: a security tool that reads commits (its worktreeRun reads files not committed yet).
export const isSecretTool = (tool) => Boolean(tool?.worktreeRun) && (tool.lens ?? 'security') === 'security';

const COMMIT = /^[0-9a-f]{40}$/;

// The values a finding's line can hold: the matched secret and the span's candidates.
export function findingValues(cwd, f) {
  const text = findingLine(cwd, f);
  const at = { column: f?.column ?? null, endColumn: f?.endColumn ?? null };
  const secret = matchedSecret(text, at);
  return [...new Set([...(secret ? [secret] : []), ...valueCandidates(text, at)])];
}

// Whether a history finding's value is gone from the working tree (it lives only in commits): null when its value
// cannot be read from the commit the scanner named. The value is the matched secret itself when the span names it (a
// base value sharing the span, still in the files, does not keep a replaced secret "in the files": held-out C20).
export function onlyInHistory(cwd, f) {
  if (!COMMIT.test(String(f?.vendorFingerprint ?? ''))) return null;
  const secret = matchedSecret(findingLine(cwd, f), { column: f?.column ?? null, endColumn: f?.endColumn ?? null });
  const values = secret ? [secret] : findingValues(cwd, f);
  if (!values.length) return null;
  return whereInWorktree(cwd, values).length === 0;
}
