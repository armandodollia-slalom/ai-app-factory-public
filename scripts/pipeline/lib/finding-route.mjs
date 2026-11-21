// What would resolve a finding, decided by the harness for every stage that hands a finding to an agent (dogfood C23:
// a PR-check finding asking for tests went to the implementer, who writes no tests, and test automation never saw it).
//
//   code     the production change (the implementer, a pair, a review fix)
//   tests    an automated test that is missing or must be removed (test automation; a required case)
//   plan     a test-plan case (the test planner)
//   records  the PR text, records, docs or the video (the PR check's fixer)
//
// The judge or council member says it in `resolves` (one value, a list, or "code and tests" for a mixed finding). Without
// it the harness reads the finding: its action, its words (a gap in the tests, a test to remove), the files it names.
// Every stage routes by the result: a test gap never reaches an agent that writes production code only, and a production
// defect never reaches an agent that writes tests only (routeToRole).

export const RESOLVES = ['code', 'tests', 'plan', 'records'];

const ALIASES = [
  [/^(code|production|production code|implementation|product|src)$/, 'code'],
  [/^(tests?|test code|automated tests?|test automation|e2e|regression tests?)$/, 'tests'],
  [/^(plan|test plan|test-plan|cases?|test cases?)$/, 'plan'],
  [/^(records?|records\/pr text|pr text|pr body|pr|docs?|documentation|video|evidence)$/, 'records'],
];

const norm = (v) => {
  const t = String(v ?? '').trim().toLowerCase();
  for (const [re, to] of ALIASES) if (re.test(t)) return to;
  return null;
};

// The judge's own values, normalised; [] when it gave none.
export function resolvesGiven(f) {
  const raw = Array.isArray(f?.resolves) ? f.resolves : f?.resolves ? [f.resolves] : [];
  return [...new Set(raw.flatMap((v) => String(v).split(/\s*(?:,|\+|&|\band\b)\s*/)).map(norm).filter(Boolean))];
}

const W = "[\\w'’-]+";
// A finding that says a test is missing: "is not tested", "untested", "no browser regression", "the regression remains
// absent", "add the required no-match browser regression", "not exercised by any test", "coverage gap".
export const TEST_GAP_RE = new RegExp(
  [
    `\\b(?:un|not |never |isn't |aren't |is not |are not |nor )tested\\b`,
    `\\bno (?:${W} ){0,3}(?:tests?|regressions?|specs?|coverage)\\b`,
    `\\b(?:tests?|regressions?|specs?|coverage) (?:${W} ){0,2}(?:missing|absent|lacking)\\b`,
    `\\bmissing (?:${W} ){0,3}(?:tests?|regressions?|specs?|coverage)\\b`,
    `\\b(?:add|write|cover with) (?:the |a |an )?(?:${W} ){0,4}(?:tests?|regressions?|specs?|test cases?)\\b`,
    `\\bnot (?:exercised|covered|asserted) by (?:any |a |an )?(?:${W} )?(?:tests?|specs?)\\b`,
    `\\b(?:lacks?|without) (?:a |an |any )?(?:${W} )?(?:tests?|regressions?|coverage)\\b`,
    `\\bcoverage gap\\b`,
    // "the regression required by X is not covered", "TC-1 is still uncovered", "coverage was explicitly required",
    // "not covered by any test", "the spec never exercises the PAR path" (dogfood C24: the bug-fix pair got these).
    `\\b(?:tests?|regressions?|specs?|coverage|scenarios?|cases?|TC-[\\w-]+)\\b[^.;\\n]{0,160}?\\b(?:is |are |remains? |stays? |still |left )?(?:not |un)covered\\b`,
    `\\b(?:not |un)covered (?:by|in) (?:any |a |an |the )?(?:${W} ){0,2}(?:tests?|specs?|regressions?|e2e|suite)\\b`,
    `\\b(?:coverage|regressions?|tests?) (?:${W} ){0,5}(?:was |is |were |are )?(?:explicitly |still )?(?:required|requested|needed)\\b`,
    `\\b(?:tests?|specs?|TC-[\\w-]+) (?:${W} ){0,3}(?:does not|doesn't|do not|don't|never|still bypass(?:es)?|bypass(?:es)?|skips?) (?:exercises?|covers?|asserts?|reach(?:es)?|tests?|hits?|the\\b)`,
  ].join('|'),
  'i',
);

// Whether a finding's words say a test is missing (the wording, read when the judge gave no `resolves`).
export const isTestGap = (text) => TEST_GAP_RE.test(String(text ?? ''));

// The words of a finding, from whichever field the stage used (`reason` in recorded pair verdicts, `issue` in the
// review, `title`/`detail` at the PR check).
export const findingText = (f) => [f?.title, f?.issue, f?.text, f?.detail, f?.reason].filter((x) => typeof x === 'string').join(' \n ');
// A finding that asks to remove a test.
const TEST_REMOVE_RE = new RegExp(`\\b(?:remove|delete|drop) (?:the |a |an )?(?:${W} ){0,4}(?:tests?|specs?)\\b`, 'i');
// A finding about a test-plan case.
const PLAN_RE = /\b(?:test plan|plan case|TC-[A-Z0-9]+-\d+)\b/i;
// Words that ask for a production change in a finding's fix.
// Case-insensitive: a fix often starts with the verb ("Handle the unsupported provider ...", dogfood C24).
const CODE_ASK_WORDS = /\b(?:change|return|render|show|display|handle|validate|implement|refactor|rename the (?:endpoint|route|method)|move the (?:logic|check)|catch|throw)\b/i;
const CODE_ASK_RE = { test: (t) => CODE_ASK_WORDS.test(t) || /\buse [A-Z]\w+\./.test(t) };

const TEST_FILE_RE = /(^|\/)(tests?|e2e)\/|\.(spec|test)\.[a-z]+$|Tests?\/|\.Tests\//;
const RECORD_FILE_RE = /\.md$|^docs\/|^\.factory\/(metrics|state)\//;

// The kinds of work that resolve a finding, in RESOLVES order.
// The lens is the stage's business (a video lens is light at the PR check by its settings, not here).
export function resolvesOf(f, { files = null } = {}) {
  const given = resolvesGiven(f);
  if (given.length) return RESOLVES.filter((r) => given.includes(r));
  if (f?.action === 'delete-test') return ['tests'];
  if (f?.action === 'rewrite') return ['code'];
  const text = findingText(f);
  const fix = typeof f?.fix === 'string' ? f.fix : '';
  const named = files ?? [f?.file, ...(Array.isArray(f?.files) ? f.files : [])].filter((x) => typeof x === 'string' && x.trim());
  const prodNamed = named.some((p) => !TEST_FILE_RE.test(p) && !RECORD_FILE_RE.test(p));
  const gap = TEST_GAP_RE.test(text) || TEST_REMOVE_RE.test(text) || (!text.trim() && TEST_GAP_RE.test(fix));
  if (gap) {
    const out = PLAN_RE.test(`${text} ${fix}`) && /\bcase\b/i.test(`${text} ${fix}`) ? ['plan', 'tests'] : ['tests'];
    // Mixed: the finding also asks for a production change ("handle the null and add a test").
    if (prodNamed && CODE_ASK_RE.test(fix)) return ['code', ...out];
    return out;
  }
  if (named.length && named.every((p) => /\.factory\/plans\/|(^|\/)tests\/plans\//.test(p))) return ['plan'];
  if (named.length && named.every((p) => TEST_FILE_RE.test(p))) return ['tests'];
  if (named.length && named.every((p) => RECORD_FILE_RE.test(p))) return ['records'];
  return ['code'];
}

// Roles and what they can act on. A stage asks before it hands a finding over; what the role cannot act on goes where it
// can be resolved (the stage's `elsewhere`), never silently into the role's fix list.
export const ROLE_ACTS_ON = {
  implementer: ['code'],
  'pair-implementer': ['code'],
  'ui-pair': ['code'],
  'backend-pair': ['code'],
  'test-planner': ['plan'],
  'test-automation': ['tests', 'plan'],
  'pr-check-fixer': ['code', 'tests', 'plan', 'records'],
};

// Splits findings by whether `role` can act on them: { mine, elsewhere }. A mixed finding is in both, each part marked.
// For a pair, `ui`/`backend` scope: a finding that names only files of the other side is elsewhere.
export function routeToRole(findings, role, { sideOf = null, side = null } = {}) {
  const acts = ROLE_ACTS_ON[role] ?? ['code'];
  const out = { mine: [], elsewhere: [] };
  for (const f of findings ?? []) {
    const resolves = resolvesOf(f);
    const mine = resolves.filter((r) => acts.includes(r));
    const other = resolves.filter((r) => !acts.includes(r));
    let sideMismatch = false;
    if (sideOf && side) {
      const files = [f?.file, ...(Array.isArray(f?.files) ? f.files : [])].filter((x) => typeof x === 'string' && x.trim());
      sideMismatch = files.length > 0 && files.every((p) => sideOf(p) && sideOf(p) !== side);
    }
    if (mine.length && !sideMismatch) out.mine.push({ ...f, resolves: mine });
    if (other.length || sideMismatch) out.elsewhere.push({ ...f, resolves: sideMismatch ? resolves : other, why: sideMismatch ? `names only files of the ${sideOf(f.file ?? f.files?.[0])} side` : `resolved by ${other.join(' and ')}, which ${role} cannot change` });
  }
  return out;
}

// A pair's blocking findings, split by who can act on them (dogfood C23 class: a finding sent to an agent whose role
// cannot act on it). `mine`: the pair's own files and production code. `otherSide`: findings that name only files another
// subtask owns (a UI finding to the backend pair); they go to the orchestrator's integration step. `tests`: test gaps;
// they become required cases for feature verification. A mixed finding keeps its code part with the pair.
//   ownerOf(file) -> subtask id or null; self: this subtask's id.
export function pairHandoff(findings, { ownerOf, self }) {
  const out = { mine: [], otherSide: [], tests: [] };
  for (const f of findings ?? []) {
    // The harness's own findings, tool findings and a test the pair itself deleted stay with the pair.
    if (f?.harness || f?.protected || f?.source === 'tool' || String(f?.id ?? '').startsWith('tool:') || ['build', 'scope', 'stack', 'protected-test'].includes(f?.category) || f?.action === 'delete-test') {
      out.mine.push(f);
      continue;
    }
    const files = [f?.file, ...(Array.isArray(f?.files) ? f.files : [])].filter((x) => typeof x === 'string' && x.trim());
    const owners = files.map((p) => ownerOf(p));
    if (files.length && owners.every((o) => o && o !== self)) {
      out.otherSide.push({ ...f, owner: owners[0], why: `names only files of subtask ${[...new Set(owners)].join(', ')}` });
      continue;
    }
    // The judge's `resolves` decides first; without it, only a missing test (by its words) goes to feature
    // verification; a test to remove or restore is the pair's.
    const given = resolvesGiven(f).length > 0;
    const text = findingText(f);
    const resolves = resolvesOf(f).filter((r) => given || r === 'code' || r === 'records' || isTestGap(text));
    if (!resolves.length) {
      out.mine.push(f);
      continue;
    }
    if (resolves.includes('code')) out.mine.push(f);
    if (resolves.some((r) => r === 'tests' || r === 'plan')) out.tests.push({ ...f, why: 'a test gap: test automation writes the tests' });
    if (!resolves.includes('code') && resolves.includes('records')) out.mine.push(f);
  }
  return out;
}
