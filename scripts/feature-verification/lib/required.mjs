// Required cases: test gaps a later stage upheld (the PR check, the architecture review) that only the test plan and
// test automation can close (dogfood C23: "error branches are not tested" was returned to the implementer twice; test
// automation re-sat without the finding and approved, and the ticket ran out of returns).
//
// The harness records each as { id, source, title, fix, reason, head, at } in the story's feature verification state.
// The planner and the automation agent get them as items to cover; both verifiers see them and are told they cannot
// approve while one is unmet. The harness does not trust the verifier on it: a required case is met only when
//   plan stage:        a case file of the plan names the finding id (`covers: <id>` in its front matter or text), and
//   automation stage:  a test file implements that case and the test file is new or changed since the finding was
//                      recorded (`head`).
// An unmet item is a blocking gap and caps the verdict below the pass mark.

import { git } from '../../pipeline/lib/git.mjs';
import { loadState, updateState } from '../../pipeline/lib/state.mjs';
import { caseIdsIn } from '../../pipeline/lib/stories.mjs';
import { automationFiles, readPlan } from './plans.mjs';

export const requiredFor = (config, key) => (key ? loadState(config, key).required ?? [] : []);

// Adds items (same id replaces) and invalidates what was verified without them.
export function addRequired(config, key, items, { head = null } = {}) {
  const at = new Date().toISOString();
  updateState(config, key, (s) => {
    const list = Array.isArray(s.required) ? s.required : [];
    for (const it of items) {
      const entry = { id: String(it.id), source: it.source ?? 'pr-check', title: String(it.title ?? '').slice(0, 300), fix: it.fix ? String(it.fix).slice(0, 600) : null, reason: it.reason ? String(it.reason).slice(0, 600) : null, head: it.head ?? head, at };
      const i = list.findIndex((x) => x.id === entry.id);
      if (i >= 0) list[i] = entry;
      else list.push(entry);
    }
    s.required = list;
    s.automation = { ...(s.automation ?? {}), verifiedHash: null };
  });
  return requiredFor(config, key);
}

const casesFor = (plan, id) => plan.cases.filter((c) => c.text.includes(id));

function changedSince(config, head, file) {
  if (!head) return true;
  const r = git(config.root, ['diff', '--name-only', head, '--', file]);
  if (r.status !== 0) return true;
  if (r.stdout.trim()) return true;
  // Untracked (new, not yet committed) counts as changed.
  return git(config.root, ['ls-files', '--others', '--exclude-standard', '--', file]).stdout.trim() !== '';
}

// The required items still unmet at a stage, each with why.
export function unmetRequired(config, story, stage, { required = requiredFor(config, story.key), plan = null, tests = null } = {}) {
  if (!required.length) return [];
  const p = plan ?? readPlan(config, story);
  const out = [];
  for (const item of required) {
    const cases = casesFor(p, item.id);
    if (!cases.length) {
      out.push({ ...item, why: `no case of the plan names ${item.id}` });
      continue;
    }
    if (stage !== 'automation') continue;
    const map = tests ?? automationFiles(config, story).tests;
    const ids = new Set(cases.flatMap((c) => [...caseIdsIn(c.name, story.key)]));
    const files = [...map.entries()].filter(([, set]) => [...set].some((x) => ids.has(x))).map(([f]) => f);
    if (!files.length) out.push({ ...item, why: `no test implements ${[...ids].join(', ')}` });
    else if (!files.some((f) => changedSince(config, item.head, f))) out.push({ ...item, why: `the tests for ${[...ids].join(', ')} (${files.join(', ')}) did not change since ${item.id} was recorded` });
  }
  return out;
}

const line = (it) => `- ${it.id} (${it.source}): ${it.title}${it.fix ? `\n  Fix asked: ${it.fix}` : ''}${it.why ? `\n  Unmet: ${it.why}` : ''}`;

// For the producer (planner or automation agent).
export function requiredProducerText(required, stage) {
  if (!required.length) return '';
  return [
    '',
    '### Required cases (upheld by a later stage; you cannot finish without them)',
    '',
    stage === 'plan'
      ? 'Each item below is a gap in the tests that a later stage upheld. Add or update a case for each, and name the item\'s id in that case (front matter `covers: <id>`). Keep the case concrete: the input, the state, and what the test must assert.'
      : 'Each item below is a gap in the tests that a later stage upheld. Implement the plan case that names its id; the test must be new or changed for it, and must fail if the behaviour it covers breaks.',
    '',
    ...required.map(line),
  ].join('\n');
}

// For the verifier: it sees every item and cannot approve while one is unmet.
export function requiredVerifierText(required, stage) {
  if (!required.length) return '';
  return [
    '',
    '### Required cases (a later stage upheld these gaps)',
    '',
    `You cannot score ${stage === 'plan' ? 'the plan' : 'the tests'} at the pass mark while any item below is unmet. For each, check that ${stage === 'plan' ? 'a case names its id and would catch the gap' : 'a test implements the case that names its id and asserts the behaviour the item asks for'}; list an unmet one as a gap with the item's id in \`detail\`. The harness also checks it and caps the score.`,
    '',
    ...required.map(line),
  ].join('\n');
}

// The verdict with unmet required items as blocking gaps; capped below the pass mark when any is unmet.
export function enforceRequired(verdict, unmet, { requiredScore, stage }) {
  if (!unmet.length || !verdict) return verdict;
  const gaps = [...(verdict.gaps ?? []), ...unmet.map((it) => ({ case: null, category: 'other', subtype: 'required-case-unmet', detail: `Required case ${it.id} (${it.source}: ${it.title}) is unmet: ${it.why}.`, location: null, root_stage: stage }))];
  const score = Math.min(verdict.score ?? 0, requiredScore - 1);
  return { ...verdict, gaps, score, passed: false, requiredUnmet: unmet.map((it) => it.id) };
}
