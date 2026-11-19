// The decision table for a secret finding: the verdict and the way out for every (value, location, place).
//
// value     new           a real-looking value the base does not hold
//           on-base       the matched secret itself is on the base at the merge-base (decide.mjs valueOnBase)
//           shares-span   a base value shares the line or the match span with a value the base does not hold: judged as
//                         that other value (new, or fake by the rule below), never as on-base
//           allow-listed  a value on the repository's allow-list (analysis.secrets.allow) or holding the factory's
//                         placeholder marker: the scanner does not report it at all
//           fake-flagged  a value the scanner flags that is fake by the table's rule (isFakeValue): only in test files
//                         of the change (tests, specs, scenarios, plans), not on the base, and not any credential the
//                         harness can see (an environment variable's value: every host and bot token it reads)
// location  uncommitted | unpushed (committed, on no remote) | pushed-no-pr | pr-open
// place     local | ci: the verdict never depends on it (both run decide.mjs on the same tree); CI has no way out of
//           its own: a red job goes back to the harness, which takes this table's way out before or after the push.
//
// Ways out: implementer (the fixing round replaces the value; the commit gate holds the file out of commits until then),
// fold-unpushed (the harness folds the branch's unpushed commits, same tree), fold-branch (the harness folds the story
// branch's commits since the base and pushes with a lease: own branch, no PR, fake value only), escalate (a person: a
// pushed value that may be real must be rotated, and an open PR's history is never rewritten).
import { spawnSync } from 'node:child_process';
import { FAKE_SECRET_MARKER } from './config.mjs';
import { findingValues } from './secrets.mjs';
import { valueOnBase, whereOnRev } from './decide.mjs';

export const VALUES = ['new', 'on-base', 'shares-span', 'allow-listed', 'fake-flagged'];
export const LOCATIONS = ['uncommitted', 'unpushed', 'pushed-no-pr', 'pr-open'];
export const PLACES = ['local', 'ci'];

const CELLS = {
  'allow-listed': () => ({ verdict: 'pass', wayOut: [], why: 'the scanner does not report a value on the allow-list' }),
  'on-base': () => ({ verdict: 'note', wayOut: [], why: 'a copy of a value the base already holds: a note naming where it lives, not a new secret of this change' }),
  new: (location) => ({
    verdict: 'block',
    wayOut: { uncommitted: ['implementer'], unpushed: ['implementer', 'fold-unpushed'], 'pushed-no-pr': ['escalate'], 'pr-open': ['escalate'] }[location],
    why: { uncommitted: 'a new secret: the commit gate holds the file; the fixing round replaces the value', unpushed: 'a new secret in a commit no remote has: the value is replaced, then the unpushed commits fold into one', 'pushed-no-pr': 'a value that may be a real credential is on the remote: a person rotates it and decides on the history', 'pr-open': 'a value that may be a real credential is on an open PR: a person rotates it; an open PR\'s history is never rewritten' }[location],
  }),
  'fake-flagged': (location) => ({
    verdict: 'block',
    wayOut: { uncommitted: ['implementer'], unpushed: ['implementer', 'fold-unpushed'], 'pushed-no-pr': ['implementer', 'fold-branch'], 'pr-open': ['escalate'] }[location],
    why: { uncommitted: `a fake value the scanner flags: replaced by one holding "${FAKE_SECRET_MARKER}" or an allow-listed value`, unpushed: 'a fake value in a commit no remote has: replaced, then the unpushed commits fold into one', 'pushed-no-pr': 'a fake value on the story\'s own pushed branch with no PR: replaced, then the branch folds into one commit and is pushed with a lease', 'pr-open': 'an open PR\'s history is never rewritten: a person decides (the value is fake, nothing to rotate)' }[location],
  }),
};
CELLS['shares-span'] = (location, { fake = false } = {}) => ({ ...CELLS[fake ? 'fake-flagged' : 'new'](location), sharesSpan: true });

// One cell. `place` is accepted and checked, never used: the table has no place-dependent verdict by construction.
export function secretCell({ value, location, place = 'local', fake = false }) {
  if (!VALUES.includes(value)) throw new Error(`unknown value class ${value}`);
  if (!LOCATIONS.includes(location)) throw new Error(`unknown location ${location}`);
  if (!PLACES.includes(place)) throw new Error(`unknown place ${place}`);
  return { value, location, place, ...CELLS[value](location, { fake }) };
}

// Test files of a change: where a fake value belongs (tests, specs, e2e, fixtures, test plans, stack scenarios).
const TEST_PATH = /(?:^|\/)(?:tests?|e2e|__tests__|specs?|fixtures?|testdata)\/|(?:^|\/)\.factory\/(?:plans|stack\/scenarios)\/|\.(?:spec|test)\.[^/]+$|(?:^|\/)[^/]*\.(?:Tests?|UnitTests|FunctionalTests|IntegrationTests)\//i;
export const isTestPath = (file) => TEST_PATH.test(String(file ?? ''));

// The credentials the harness can see, read in this process only (never logged): environment variable values that look
// like a credential (every host and bot token the factory reads comes from one), plus any the caller adds.
export function visibleCredentials({ env = process.env, extra = [] } = {}) {
  const looks = (v) => typeof v === 'string' && v.length >= 12 && !/\s/.test(v) && /[0-9]/.test(v) && /[A-Za-z]/.test(v);
  return [...new Set([...Object.values(env), ...extra].filter(looks))];
}

// The value class of a flagged finding (the scanner reported it, so never allow-listed here) and whether its new values
// are fake by the table's rule: the finding sits in a test file of the change and none of the values the base does not
// hold is, or is part of, a credential the harness can see. `credentials`: visibleCredentials().
export function valueClass(cwd, f, { mergeBase, credentials = [] }) {
  if (valueOnBase(cwd, f, mergeBase).length) return { value: 'on-base', fake: false };
  const values = findingValues(cwd, f);
  const fresh = mergeBase ? values.filter((v) => !whereOnRev(cwd, mergeBase, [v]).length) : values;
  const fake = isTestPath(f?.file) && fresh.length > 0 && !fresh.some((v) => credentials.some((c) => c.includes(v) || v.includes(c)));
  if (fresh.length < values.length) return { value: 'shares-span', fake };
  return { value: fake ? 'fake-flagged' : 'new', fake };
}

export const isFakeValue = (cwd, f, opts) => valueClass(cwd, f, opts).fake;

// The location of a finding's value: still in the files and not committed, in a commit no remote has, pushed with no
// PR, or on an open PR. `prOpen`: whether the story's PR is open (null: unknown, treated as open).
export function valueLocation(cwd, f, { prOpen = null } = {}) {
  const commit = /^[0-9a-f]{40}$/.test(String(f?.vendorFingerprint ?? '')) ? f.vendorFingerprint : null;
  if (!commit) return 'uncommitted';
  const remotes = spawnSync('git', ['branch', '-r', '--contains', commit], { cwd, encoding: 'utf8', timeout: 120_000 });
  const pushed = remotes.status === 0 && String(remotes.stdout).trim().length > 0;
  if (!pushed) return 'unpushed';
  return prOpen === false ? 'pushed-no-pr' : 'pr-open';
}

// The table's answer for one finding on this machine: { value, location, verdict, wayOut, why, fake }.
export function judgeSecret(cwd, f, { mergeBase, credentials = [], prOpen = null, place = 'local' } = {}) {
  const v = valueClass(cwd, f, { mergeBase, credentials });
  return { ...secretCell({ value: v.value, location: valueLocation(cwd, f, { prOpen }), place, fake: v.fake }), fake: v.fake };
}
