import fs from 'node:fs';
import path from 'node:path';
import { runAgent, runAgentAsync } from '../../pipeline/lib/agents.mjs';
import { contestedText, councilFor, councilMemory, fixesFile, memoryFile, nameFindings, memberRunEnv, memberScore, memberTask, mergeCouncil, planCases, recordCouncilRound, rewriteText, runCouncil, testProtection, adjudicate } from '../../pipeline/lib/council.mjs';
import { runIntercomDiscussion } from '../../pipeline/lib/intercom.mjs';
import { logDecision } from '../../pipeline/lib/decisions.mjs';
import { orchestratorRun } from '../../pipeline/lib/orchestrator.mjs';
import { selectCouncil, ticketShape } from '../../pipeline/lib/selection.mjs';
import { metricsFile } from '../../pipeline/lib/state.mjs';
import { appendJsonl, extractResult, log, nowIso } from '../../pipeline/lib/util.mjs';
import { resolvesGiven } from '../../pipeline/lib/finding-route.mjs';
import { automationFiles } from './plans.mjs';
import { enforceRequired, requiredFor, requiredVerifierText, unmetRequired } from './required.mjs';
import { setting } from '../../pipeline/lib/settings.mjs';

export const VERIFIER = { plan: 'test-plan-verifier', automation: 'test-automation-verifier' };
export const PRODUCER = { plan: 'test-planner', automation: 'test-automation' };

export { metricsFile };

export function attributedAgent(stage, rootStage) {
  if (stage === 'plan' || rootStage === 'plan') return PRODUCER.plan;
  return PRODUCER.automation;
}

// The score a test stage's council must reach (testPlan.councilPassScore, testAutomation.councilPassScore).
export const stagePassScore = (config, stage) => ((COUNCIL_STAGE[stage] ?? stage) === 'testPlan' ? setting(config, 'testPlan.councilPassScore') : setting(config, 'testAutomation.councilPassScore'));

const NO_DETAIL = '(no detail given)';

export function normalizeVerdict(config, stage, raw, { uiCases = [] } = {}) {
  const categories = config.featureVerification.categories[stage];
  const required = stagePassScore(config, stage);
  // One decimal place (council scores may be 9.5). A missing or invalid score (memberScore) is no score: the verdict
  // fails whatever the pass score, before anything is normalized.
  const given = memberScore(raw);
  let score = given ?? 0;
  const gaps = (Array.isArray(raw?.gaps) ? raw.gaps : []).map((gap) => {
    const known = categories.includes(gap?.category);
    return {
      case: gap?.case ?? null,
      category: known ? gap.category : 'other',
      subtype: known ? gap?.subtype ?? null : gap?.category ?? gap?.subtype ?? null,
      detail: String(gap?.detail ?? '').trim() || NO_DETAIL,
      location: gap?.location ?? null,
      root_stage: stage === 'automation' && gap?.root_stage === 'plan' ? 'plan' : stage,
      // Only the automation verifier may say a gap is the code's (feature verification then reports a product bug).
      ...(stage === 'automation' && resolvesGiven(gap).length === 1 && resolvesGiven(gap)[0] === 'code' ? { resolves: 'code' } : {}),
    };
  });
  // UI cases (tests that recorded video): the verifier must say, per case, which keyframe it opened and what it
  // shows. A case it did not look at, or whose evidence does not show the asserted state, caps the score below
  // the pass mark (council C1: a feature's verifier opened three of five UI cases, misjudged one, and gave 10).
  const evidence = new Map((Array.isArray(raw?.evidence) ? raw.evidence : []).filter((e) => e?.case).map((e) => [String(e.case), e]));
  for (const id of uiCases) {
    const e = evidence.get(id);
    if (!e || !String(e.keyframe ?? '').trim() || !String(e.shows ?? '').trim()) {
      gaps.push({ case: id, category: 'visual-mismatch', subtype: 'evidence-not-reviewed', detail: `No evidence entry for UI case ${id}: the verifier must name the keyframe it opened and say what it shows.`, location: null, root_stage: stage });
      score = Math.min(score, required - 1);
    } else if (e.ok === false) {
      if (!gaps.some((g) => g.case === id && g.category === 'visual-mismatch')) {
        gaps.push({ case: id, category: 'visual-mismatch', subtype: 'state-not-shown', detail: `The evidence of ${id} does not show its asserted state: ${String(e.shows).slice(0, 300)}`, location: e.keyframe ?? null, root_stage: stage });
      }
      score = Math.min(score, required - 1);
    }
  }
  if (given === null) gaps.push({ case: null, category: 'other', subtype: 'no-score', detail: `The verifier gave no valid score (${JSON.stringify(raw?.score ?? null)}): a score from 0 to 10 is required.`, location: null, root_stage: stage });
  if (score < required && gaps.length === 0) {
    gaps.push({ case: null, category: 'other', subtype: 'unexplained-score', detail: `Verifier scored ${score}/10 without listing gaps.`, location: null, root_stage: stage });
  }
  // At or above the required score the verdict passes even with gaps listed: they are minor by the
  // verifier's own rubric, stay in the metrics and are passed on as non-blocking notes.
  return { score, gaps, summary: String(raw?.summary ?? ''), passed: given !== null && score >= required, evidence: [...evidence.values()] };
}

// Runs one verifier round in a fresh process and records the outcome for observability.
export function runVerifier(config, { stage, story, round, task, producerVersion, metrics = true, uiCases = [] }) {
  const name = VERIFIER[stage];
  let attempt = 0;
  let result;
  let verdict = null;
  while (attempt <= config.agent.resultParseRetries) {
    result = runAgent(config, {
      name,
      task,
      mode: 'read',
      timeoutSec: config.featureVerification.timeoutsSec.verifier,
      usage: { stage: `${stage}-verify`, story: story.key, round },
    });
    const raw = extractResult(result.output);
    if (raw) {
      verdict = normalizeVerdict(config, stage, raw, { uiCases });
      break;
    }
    attempt++;
    log(`${name} returned no parsable AGENT_RESULT (attempt ${attempt}).`);
  }
  if (!verdict) return { error: 'verifier produced no parsable result', output: result?.output ?? '' };

  if (metrics) {
    const ts = nowIso();
    const common = { ts, stage, story: story.key, round, agent_prompt_ver: producerVersion, verifier_ver: result.version, cli: result.cli ?? null, entry: result.entry ?? null };
    appendJsonl(metricsFile(config, 'verifier-runs.jsonl'), { ...common, score: verdict.score, passed: verdict.passed, gaps: verdict.gaps.length });
    appendJsonl(
      metricsFile(config, 'verifier-denials.jsonl'),
      verdict.gaps.map((gap) => ({ ...common, score: verdict.score, ...gap, attributed_agent: attributedAgent(stage, gap.root_stage) })),
    );
    logDecision(config, {
      stage: `${stage}-verify`,
      story: story.key,
      round,
      agent: name,
      agentVer: result.version,
      subject: PRODUCER[stage],
      subject_ver: producerVersion ?? null,
      decision: verdict.passed ? 'approved' : 'denied',
      reason: verdict.summary || null,
      score: verdict.score,
      items: verdict.gaps.map(({ detail, ...gap }) => ({ ...gap, reason: detail, subject: attributedAgent(stage, gap.root_stage) })),
    });
  }
  log(`${name} round ${round}: ${verdict.score}/10, ${verdict.gaps.length} gap(s)`);
  return { ...verdict, verifierVersion: result.version };
}

export function formatGaps(gaps) {
  return gaps
    .map((g, i) => `${i + 1}. ${g.id ? `\`${g.id}\` ` : ''}[${g.category}${g.subtype ? `/${g.subtype}` : ''}] ${g.case ?? '(plan-wide)'}${g.location ? ` @ ${g.location}` : ''}: ${g.detail}`)
    .join('\n');
}

// The council stage of each feature verification verifier (testPlan, testAutomation).
export const COUNCIL_STAGE = { plan: 'testPlan', automation: 'testAutomation' };

// One verifier round: the stage's council (runVerifier is the retro audit's own re-check, unchanged).
// A gap that only says a keyframe or the video does not show the URL (dogfood C15, C17, C23: several blocking automation
// rounds) is presentation, not behaviour: since 0.2.85 the fixture draws the URL on every keyframe and in the video
// itself. When the case's recorded steps prove the navigation (its test navigates or asserts the URL), the gap is a note,
// not a blocking finding; a verdict whose only gaps were such notes passes.
export const URL_CAPTION_GAP = /\b(?:url|address(?: bar)?|captions?|route|path)\b[\s\S]{0,160}(?:\b(?:keyframes?|frames?|video|screenshots?)\b|\.png\b)|(?:\b(?:keyframes?|frames?|video|screenshots?)\b|\.png\b)[\s\S]{0,160}\b(?:url|address(?: bar)?|captions?|path)\b/i;
const NOT_SHOWN = /\b(?:not|no|never|missing|absent|without|lacks?|doesn't|does not|cannot|can't|isn't|is not)\b/i;
const NAVIGATES = /\b(?:toHaveURL|waitForURL|waitForNavigation)\s*\(|\.goto\s*\(/;

export function navigationProof(config, story, { files = null, read = (f) => fs.readFileSync(path.join(config.root, f), 'utf8') } = {}) {
  let map;
  return (caseId) => {
    try {
      map ??= files ?? automationFiles(config, story).tests;
    } catch {
      return false;
    }
    for (const [file, ids] of map) {
      if (caseId && !ids.has(caseId)) continue;
      try {
        if (NAVIGATES.test(read(file))) return true;
      } catch {
        // unreadable: no proof
      }
    }
    return false;
  };
}

export function demoteUrlCaptionGaps(verdict, { navigationProven, requiredScore }) {
  const noise = (verdict.gaps ?? []).filter((g) => URL_CAPTION_GAP.test(g.detail ?? '') && NOT_SHOWN.test(g.detail ?? '') && navigationProven(g.case));
  if (!noise.length) return verdict;
  const gaps = verdict.gaps.filter((g) => !noise.includes(g));
  const notes = [...(verdict.notes ?? []), ...noise.map((g) => ({ ...g, demoted: 'url-caption: the recorded steps prove the navigation, and the fixture draws the URL on every keyframe' }))];
  // Never over an open owner question from a council discussion.
  const pass = !gaps.length && !verdict.passed && !verdict.ownerQuestions?.length;
  return { ...verdict, gaps, notes, demotedUrlCaption: noise.length, ...(pass ? { score: Math.max(verdict.score ?? 0, requiredScore), passed: true } : {}) };
}

// Required cases (required.mjs): the verifier sees every one, and the harness caps the verdict while one is unmet.
export async function verifyRound(config, opts) {
  // The stage's seats for the story: picked once by the stage's orchestrator under the selection rules, kept.
  if (opts.story?.key) await selectCouncil(config, COUNCIL_STAGE[opts.stage], { subject: opts.story.key, shape: ticketShape({ key: opts.story.key, test: true }), run: (o) => runAgentAsync(config, { ...o, cwd: config.root, timeoutSec: 300 }) });
  const council = councilFor(config, COUNCIL_STAGE[opts.stage], { subject: opts.story?.key });
  const required = opts.story?.key ? requiredFor(config, opts.story.key) : [];
  const o = required.length ? { ...opts, task: `${opts.task}\n${requiredVerifierText(required, opts.stage)}` } : opts;
  // Every verifier stage is a council (its own verifier alone unless testPlan/testAutomation.councilMembers seats more).
  let verdict = await councilVerifier(config, { ...o, council });
  if (opts.stage === 'automation' && verdict && !verdict.error && opts.story) verdict = demoteUrlCaptionGaps(verdict, { navigationProven: navigationProof(config, opts.story), requiredScore: stagePassScore(config, opts.stage) });
  if (!required.length || verdict?.error) return verdict;
  return enforceRequired(verdict, unmetRequired(config, opts.story, opts.stage, { required }), { requiredScore: stagePassScore(config, opts.stage), stage: opts.stage });
}

// A council round of a feature verification verifier: every member scores the plan or the tests with the stage's own
// contract (score and gaps), the harness merges them, and the result has runVerifier's shape: { score, gaps, passed,
// summary } with the standing findings as gaps; minor, outvoted, protected and superseded ones are `notes`.
// `late` (council.mjs lateBox) carries a non-blocking member's late result from one round to the next as feedback.
export async function councilVerifier(config, { stage, story, round, task, producerVersion, metrics = true, uiCases = [], council, runMember = null, late = null }) {
  const name = VERIFIER[stage];
  // Each member runs on its seat's pool entry; a council of one is the stage's own verifier on its own entry.
  const call = runMember ?? ((m, t, o) => runAgentAsync(config, { name, task: t, mode: 'read', entry: m.entry, timeoutSec: m.timeoutSec ?? config.featureVerification.timeoutsSec.verifier, extraEnv: memberRunEnv(m), intercom: o?.intercom ?? null, usage: { stage: `${stage}-verify`, story: story.key, round, step: o?.purpose === 'intercom' ? `intercom-${m.name}` : m.name } }));
  const memory = councilMemory({ file: memoryFile(config.root, config.stateDir, { stage: COUNCIL_STAGE[stage], story: story.key }), cwd: config.root, round, fixes: fixesFile(config.root, config.stateDir, { stage: COUNCIL_STAGE[stage], story: story.key }) });
  const readOnly = { cwd: config.root, exclude: [config.metricsDir, config.stateDir, ...(config.implExclude ?? [])] };
  const out = await runCouncil({
    council,
    round,
    retries: config.agent.resultParseRetries,
    taskFor: (m) => memberTask(task, { council, member: m, round, earlier: memory.text }),
    run: call,
    parse: (output) => {
      const raw = extractResult(output);
      if (!raw) return null;
      const v = normalizeVerdict(config, stage, raw, { uiCases });
      const rawGaps = Array.isArray(raw.gaps) ? raw.gaps : [];
      // A gap is often an absence (a case or a test the story needs and nothing covers): its detail, which names what is
      // missing, is its evidence when the member gives none of its own (the council's rule 4 would make it a question).
      const findings = v.gaps.map((g, i) => {
        const r = i < rawGaps.length && rawGaps[i] && typeof rawGaps[i] === 'object' ? rawGaps[i] : {};
        const evidence = r.evidence ?? (g.detail && g.detail !== NO_DETAIL ? g.detail : undefined);
        return { ...g, id: r.id, lens: r.lens, severity: ['blocking', 'major', 'minor'].includes(r.severity) ? r.severity : v.score >= council.councilPassScore ? 'minor' : 'blocking', action: r.action, test: r.test, deletes: r.deletes, approach: r.approach, why: r.why, covers: r.covers, evidence, detail: g.detail, file: g.location };
      });
      // No valid score is no score (memberScore): the member does not pass, never a normalized 0 that a pass score of 0 accepts.
      return { score: memberScore(raw) === null ? null : v.score, verdict: v.passed && v.score >= council.councilPassScore ? 'APPROVED' : 'CHANGES_REQUESTED', summary: v.summary, findings, disputes: raw.disputes, followUps: raw.followUps };
    },
    readOnly,
    onLate: late?.push,
  });
  const cases = planCases(config.root, config.featureVerification.plansDir, story.key);
  // A split in the members' discussion is ruled by the stage's orchestrator.
  const intercom = await runIntercomDiscussion({ config, council, results: out.results, subject: story.key, ruler: (task) => runAgentAsync(config, { ...orchestratorRun(config, COUNCIL_STAGE[stage]), task, mode: 'read', cwd: config.root, timeoutSec: 300, usage: { stage: `${stage}-verify`, story: story.key, round, step: 'intercom-ruling' } }), stage: COUNCIL_STAGE[stage], round, violation: out.violation, readOnly, reviewed: task, run: call });
  const mergeOpts = { protect: (f) => testProtection(f, { keys: [story.key], cases }), violation: out.violation, feedback: late?.take() ?? [], earlier: memory, root: config.root, ...(intercom ? { intercom } : {}) };
  const merged = await adjudicate({
    config,
    council,
    merged: mergeCouncil(council, out.results, mergeOpts),
    remerge: (adjudications) => mergeCouncil(council, out.results, { ...mergeOpts, adjudications }),
    run: runMember ?? ((m, t) => runAgentAsync(config, { name, task: t, mode: 'read', entry: m.entry, timeoutSec: m.timeoutSec ?? config.featureVerification.timeoutsSec.verifier, extraEnv: memberRunEnv(m), usage: { stage: `${stage}-verify`, story: story.key, round, step: `adjudication-${m.name}` } })),
    stage: COUNCIL_STAGE[stage],
    story: story.key,
    round,
    retries: config.agent.resultParseRetries,
    readOnly: { cwd: config.root, exclude: [config.metricsDir, config.stateDir, ...(config.implExclude ?? [])] },
  });
  if (!merged.error) memory.remember(nameFindings(merged.findings, `${COUNCIL_STAGE[stage]}-r${round}`));
  recordCouncilRound(config, { stage: COUNCIL_STAGE[stage], story: story.key, round, council, merged });
  if (merged.error) return { error: `verifier council: ${merged.error}`, output: merged.summary };
  const asGap = (f) => ({
    ...(f.id ? { id: f.id } : {}),
    case: f.case ?? null,
    category: config.featureVerification.categories[stage].includes(f.category) ? f.category : 'other',
    subtype: f.subtype ?? (f.action !== 'fix' ? f.action : null),
    detail: `${f.action === 'rewrite' ? rewriteText(f) : f.action === 'delete-test' ? `DELETE TEST ${f.test || ''}: ${f.detail || f.text}` : f.detail || f.text}${contestedText(f)}${f.members?.length > 1 ? ` [raised by ${f.members.join(', ')}]` : ''}`,
    location: f.location ?? f.file ?? null,
    root_stage: f.root_stage ?? stage,
  });
  const gaps = merged.findings.map(asGap);
  const notes = merged.notes.map((f) => ({ ...asGap(f), ...(f.pendingOwner ? { pendingOwner: true } : {}), note: f.pendingOwner ? f.notUpheld : f.protected ? `not acted on: ${f.protected}` : f.notUpheld ? `not upheld: ${f.notUpheld}` : f.supersededBy ? `superseded by ${f.supersededBy}` : f.feedback ? `feedback from non-blocking member ${f.member}` : 'minor' }));
  const verdict = { score: merged.score ?? 0, gaps, notes, summary: merged.summary, passed: merged.pass, evidence: [], ...(merged.ownerQuestions?.length ? { ownerQuestions: merged.ownerQuestions } : {}), council: merged };
  if (metrics) {
    const common = { ts: nowIso(), stage, story: story.key, round, agent_prompt_ver: producerVersion, verifier_ver: 'council', cli: 'council' };
    appendJsonl(metricsFile(config, 'verifier-runs.jsonl'), { ...common, score: verdict.score, passed: verdict.passed, gaps: gaps.length, members: merged.members.map(({ name, cli, model, score }) => ({ name, cli, model, score })) });
    appendJsonl(metricsFile(config, 'verifier-denials.jsonl'), gaps.map((gap) => ({ ...common, score: verdict.score, ...gap, attributed_agent: attributedAgent(stage, gap.root_stage) })));
    // The stage's own verdict in the decision log, for any council size (the retro reads why plans and tests were denied).
    logDecision(config, {
      stage: `${stage}-verify`,
      story: story.key,
      round,
      agent: name,
      agentVer: 'council',
      subject: PRODUCER[stage],
      subject_ver: producerVersion ?? null,
      decision: verdict.passed ? 'approved' : 'denied',
      // A council of one's reason is its member's own summary; a larger council's is the merge's.
      reason: (council.sole || council.shadow ? out.results.find((r) => r.member.blocking)?.summary : null) || verdict.summary || null,
      score: verdict.score,
      items: gaps.map(({ detail, ...gap }) => ({ ...gap, reason: detail, subject: attributedAgent(stage, gap.root_stage) })),
    });
  }
  log(`${name} council round ${round}: ${verdict.passed ? 'passed' : 'not passed'} (lowest ${verdict.score}/10), ${gaps.length} gap(s)`);
  return { ...verdict, verifierVersion: 'council' };
}
