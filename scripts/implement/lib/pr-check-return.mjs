// What the PR check's upheld findings are about decides who fixes them (owner instruction, dogfood C15: "if the PR checker
// finds a problem it should send it back to the implementation stack"). A finding about the production change (wrong
// behaviour, an unmet Expected or acceptance line, behaviour the ticket did not ask for, a design or flow defect) goes back
// to the implementation stage: the implementer gets it as its fix list, and the change passes the same stack as any
// implementation work (static analysis, the pair verifier or council, the architecture review, feature verification)
// before the PR check sits again on the new head. Findings confined to tests, docs, PR text, video or style stay with the
// PR check's light fixer. The rule is the harness's, by what the finding is about and which file it names; it changes
// only through implement.prCheck.returnToImplementation in .factory/config.json (governance).
//
// Only findings at minSeverity (major) or worse go back: a minor finding about the production change stays with the PR
// check's fixer, as before (dogfood C15: a bug's PR check passed at 9/10, and each return's new minor polish cost a full
// pass through the stack until the story escalated at the limit).

import { severityAtLeast } from '../../pipeline/lib/severity.mjs';

export const RETURN_DEFAULTS = {
  enabled: true,
  // Returns to implementation per story; each also counts against maxAgentRunsPerStory and the story's wall clock.
  maxReturns: 2,
  // The least severe finding about the production change that returns; below it, the PR check's fixer handles it.
  minSeverity: 'major',
  // Lenses whose findings are about the production change.
  implementationLenses: ['acceptance', 'flow', 'design', 'correctness', 'security', 'ui', 'rewrite'],
  // Lenses whose findings stay with the light fixer (when they name no production file).
  lightLenses: ['video', 'style', 'test-value'],
  // A finding that names only files matching these is confined to tests, docs or pipeline records: light path.
  lightPaths: ['tests/**', 'test/**', 'e2e/**', '**/*.spec.*', '**/*.test.*', '**/*Tests/**', '**/*.Tests/**', '**/*.md', 'docs/**', '.factory/plans/**', '.factory/stack/scenarios/**', '.factory/metrics/**'],
};

export const returnSettings = (config) => ({ ...RETURN_DEFAULTS, ...(config.implement?.prCheck?.returnToImplementation ?? {}) });

const globRe = (g) => new RegExp(`^${String(g).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*\//g, '\uE000').replace(/\*\*/g, '.*').replace(/\*/g, '[^/]*').replace(/\uE000/g, '(?:.*/)?')}$`);

// Paths a finding's text names (a finding without a file often names the one it is about in its title).
const PATH_RE = /(?:^|[\s`'"(])((?:[\w.-]+\/)*[\w.-]+\.(?:cs|ts|tsx|js|mjs|razor|css|md|json|ya?ml|cshtml|html|py|sql))\b/g;
const pathsIn = (f) => [...new Set([f.title, f.issue, f.fix, f.reason, f.detail].filter((x) => typeof x === 'string').flatMap((t) => [...t.matchAll(PATH_RE)].map((m) => m[1])))];

// The finding's files, repository-relative: the ones it names, else the paths its text mentions.
const filesOf = (f, root) => {
  const named = [f.file, ...(Array.isArray(f.files) ? f.files : [])].filter((x) => typeof x === 'string' && x.trim());
  return (named.length ? named : pathsIn(f)).map((x) => normalizePath(x, root));
};
const normalizePath = (x, root) => {
  let p = x.trim().replace(/:\d+(?:[-:]\d+)?$/, '').replace(/\\/g, '/');
  if (root && p.startsWith(`${root.replace(/\\/g, '/')}/`)) p = p.slice(root.length + 1);
  return p.replace(/^\.\//, '');
};

// What would resolve a finding (dogfood C23: "error branches are not tested" went to the implementer, who writes no
// tests, twice, and the ticket ran out of returns). The judge or council member names it in `resolves` (code, tests,
// plan, records; several for a mixed finding); without it the harness reads the finding: its action, its text (a gap in
// the tests, a test to remove), the files it names. Shared by every stage that hands a finding to an agent
// (finding-route.mjs).
export { resolvesOf, TEST_GAP_RE } from '../../pipeline/lib/finding-route.mjs';
import { resolvesOf } from '../../pipeline/lib/finding-route.mjs';

const isLight = (files, settings) => files.length > 0 && files.every((p) => settings.lightPaths.some((g) => globRe(g).test(p)));

// The route of one finding, or of one part of a mixed finding (`part`: code, tests, plan or records):
// 'implementation' (the implementer and the whole stack), 'tests' (test plan and test automation, the finding a required
// case) or 'light' (the PR check's fixer), and why. memberLenses maps a council member's name (the PR check names its
// critic after the member) to its lens at the prCheck stage.
export function routeFinding(f, { settings = RETURN_DEFAULTS, memberLenses = {}, root = null, part = null } = {}) {
  const lens = memberLenses[f.lens] ?? f.lens ?? null;
  const files = filesOf(f, root);
  const light = isLight(files, settings);
  const minor = settings.minSeverity && f.severity && !severityAtLeast(f.severity, settings.minSeverity);
  const resolves = part ? [part] : resolvesOf(f, { files, lens });
  const back = (why) => (minor ? { route: 'light', lens, resolves, why: `${why}, ${f.severity} (below returnToImplementation.minSeverity ${settings.minSeverity}): the PR check's fixer` } : { route: 'implementation', lens, resolves, why });
  if (!resolves.includes('code')) {
    if (resolves.includes('tests') || resolves.includes('plan')) {
      // Fixing a test the branch already has stays with the fixer; a missing test is a required case for test automation.
      if (light && !resolves.includes('plan')) return { route: 'light', lens, resolves, why: `a test finding confined to ${files.join(', ')}` };
      if (minor) return { route: 'light', lens, resolves, why: `a test gap, ${f.severity} (below returnToImplementation.minSeverity ${settings.minSeverity}): the PR check's fixer` };
      return { route: 'tests', lens, resolves, why: `resolved by ${resolves.join(' and ')}: a required case for the test plan and test automation` };
    }
    if (resolves.includes('records')) return { route: 'light', lens, resolves, why: 'resolved by the records or the PR text' };
  }
  if (f.action === 'rewrite') return back('a rewrite of what the change built');
  if (settings.implementationLenses.includes(lens)) {
    if (light && !f.resolvesGiven) return { route: 'light', lens, resolves, why: `${lens} finding confined to ${files.join(', ')} (tests, docs or records)` };
    return back(`${lens} finding about the production change`);
  }
  if (settings.lightLenses.includes(lens) && !f.resolvesGiven) return { route: 'light', lens, resolves, why: `${lens} finding` };
  // An unknown lens: the full stack, which is never wrong, only slower.
  return back(`finding of lens ${lens ?? 'unknown'}`);
}

// Splits the findings fix mode would act on. A mixed finding (code and tests) is split: its code part returns to the
// implementer, its test part becomes a required case; both keep the finding's id (`part` tells them apart).
export function routeFindings(findings, opts = {}) {
  const out = { implementation: [], tests: [], light: [] };
  for (const f of findings ?? []) {
    const given = Array.isArray(f.resolves) ? f.resolves.length > 0 : Boolean(f.resolves);
    const g = { ...f, resolvesGiven: given };
    const resolves = resolvesOf(g, { files: filesOf(g, opts.root), lens: opts.memberLenses?.[f.lens] ?? f.lens });
    const parts = resolves.includes('code') && resolves.some((r) => r === 'tests' || r === 'plan') ? ['code', resolves.includes('plan') ? 'plan' : 'tests'] : [null];
    for (const part of parts) {
      const r = routeFinding(g, { ...opts, part });
      out[r.route].push({ ...f, route: r.route, routeWhy: r.why, routeLens: r.lens, resolves: r.resolves, ...(part ? { part } : {}) });
    }
  }
  return out;
}

// "Returned, nothing addressed" (dogfood C23): the PR check upholds again a finding an earlier return was sent for, and
// either that return went where the finding cannot be resolved (a test gap to the implementer), or nothing of the kind
// that resolves it changed since the return began. The harness decides what happens, never the return budget silently:
// a wrong route is re-routed once, free; a right route that changed nothing escalates with that reason.
//   changed: repository files changed since the return's head (records excluded by the caller or here).
export function unaddressed(findings, returns, { changed = [], settings = RETURN_DEFAULTS, root = null } = {}) {
  const out = [];
  const last = returns?.at(-1);
  if (!last) return out;
  const files = changed.filter((p) => !p.startsWith('.factory/'));
  const tests = files.filter((p) => settings.lightPaths.some((g) => globRe(g).test(p)) && !/\.md$/.test(p));
  const code = files.filter((p) => !settings.lightPaths.some((g) => globRe(g).test(p)));
  const allPlans = changed.filter((p) => p.startsWith('.factory/plans/') || /(^|\/)tests\/plans\//.test(p));
  for (const f of findings) {
    const sent = (last.findings ?? []).find((x) => x.id === f.id && (!f.part || !x.part || x.part === f.part));
    if (!sent) continue;
    const sentRoute = sent.route ?? 'implementation';
    const want = f.route;
    const named = filesOf(f, root);
    if (sentRoute !== want) {
      out.push({ ...f, sentRoute, kind: 'wrong-route', why: `return ${last.n} sent ${f.id} to ${sentRoute === 'implementation' ? 'the implementer' : 'test automation'}, which cannot resolve it (it is resolved by ${(f.resolves ?? []).join(' and ')})` });
      continue;
    }
    // A test return answers with tests or plan cases (the files a test gap names are usually the code under test); an
    // implementation return with the production files the finding names, else with any production file.
    const touched = want === 'tests' ? tests.length + allPlans.length > 0 : want === 'implementation' ? (named.length ? named.some((p) => changed.includes(p)) : code.length > 0) : true;
    if (!touched) out.push({ ...f, sentRoute, kind: 'nothing-changed', why: `return ${last.n} sent ${f.id} to ${want === 'tests' ? 'test automation' : 'the implementer'} and nothing of what resolves it changed since (${want === 'tests' ? 'no test or plan file' : 'no production file'}${named.length ? `; it names ${named.join(', ')}` : ''})` });
  }
  return out;
}

// Whether a return is the one free re-route: some findings were sent where they cannot be resolved, every finding of
// this return goes where those now go, and no earlier return was free.
export const freeReroute = (toReturn, rerouted, returns) => rerouted.length > 0 && !(returns ?? []).some((e) => e.free) && toReturn.every((f) => rerouted.some((r) => r.route === f.route));

// The implementer's fix list for a return.
export function returnTask({ key, findings, n, max, round = null }) {
  const lines = findings.map((f) => `- ${f.id} [${f.severity}${f.routeLens ? `, ${f.routeLens}` : ''}] ${f.title}${f.file ? ` (${f.file})` : ''}${f.fix ? `\n  Fix: ${f.fix}` : ''}${f.reason || f.detail ? `\n  Why: ${String(f.reason || f.detail).slice(0, 600)}` : ''}`);
  return [
    `The PR check${round ? ` (round ${round})` : ''} upheld these findings about the production change of ${key}. They come back to you (return ${n} of at most ${max}): fix the implementation so each one is resolved. The ticket is the answer: behaviour no line of the ticket asks for is removed, not defended. Do not edit tests or the test plan; feature verification updates them after your change.`,
    '',
    ...lines,
  ].join('\n');
}

// The PR check on a story that came back: the same findings must not come back unchanged. Two returns for the same ids
// in a row mean the stack cannot resolve them.
export const sameAsLast = (findings, last) => Boolean(last?.length) && findings.length > 0 && findings.every((f) => last.includes(f.id));
