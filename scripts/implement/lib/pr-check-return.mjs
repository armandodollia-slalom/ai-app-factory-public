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

// 'implementation' or 'light', and why. memberLenses maps a council member's name (the PR check names its critic after
// the member) to its lens at the prCheck stage.
export function routeFinding(f, { settings = RETURN_DEFAULTS, memberLenses = {}, root = null } = {}) {
  const lens = memberLenses[f.lens] ?? f.lens ?? null;
  const files = filesOf(f, root);
  const light = files.length > 0 && files.every((p) => settings.lightPaths.some((g) => globRe(g).test(p)));
  const minor = settings.minSeverity && f.severity && !severityAtLeast(f.severity, settings.minSeverity);
  const back = (why) => (minor ? { route: 'light', lens, why: `${why}, ${f.severity} (below returnToImplementation.minSeverity ${settings.minSeverity}): the PR check's fixer` } : { route: 'implementation', lens, why });
  if (f.action === 'rewrite') return back('a rewrite of what the change built');
  if (settings.implementationLenses.includes(lens)) {
    if (light) return { route: 'light', lens, why: `${lens} finding confined to ${files.join(', ')} (tests, docs or records)` };
    return back(`${lens} finding about the production change`);
  }
  if (settings.lightLenses.includes(lens)) return { route: 'light', lens, why: `${lens} finding` };
  // An unknown lens: the full stack, which is never wrong, only slower.
  return back(`finding of lens ${lens ?? 'unknown'}`);
}

// Splits the findings fix mode would act on.
export function routeFindings(findings, opts = {}) {
  const out = { implementation: [], light: [] };
  for (const f of findings ?? []) {
    const r = routeFinding(f, opts);
    out[r.route].push({ ...f, route: r.route, routeWhy: r.why, routeLens: r.lens });
  }
  return out;
}

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
