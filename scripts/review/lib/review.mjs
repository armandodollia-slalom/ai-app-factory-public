import { raiseUserErrors } from '../../pipeline/lib/user-errors.mjs';
import { resolvesOf } from '../../pipeline/lib/finding-route.mjs';
import { addRequired } from '../../feature-verification/lib/required.mjs';
import { evidenceText, readReport } from '../../pipeline/lib/analysis/report.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { runAgent, runAgentAsync } from '../../pipeline/lib/agents.mjs';
import { changedSince, contestedText, councilMemory, fixDeclarationText, fixesFile, memoryFile, nameFindings, councilActionsText, councilFor, memberRunEnv, guardProtectedTests, protectedTestFinding, runDetachedMember, takeLate, councilRounds, disputesFor, memberScore, memberTask, mergeCouncil, planCases, recordCouncilRound, rewriteText, runCouncil, testProtection, adjudicate } from '../../pipeline/lib/council.mjs';
import { ownerQuestionsText, runIntercomDiscussion } from '../../pipeline/lib/intercom.mjs';
import { logDecision } from '../../pipeline/lib/decisions.mjs';
import { decisionsBlock, readDecisions } from '../../pipeline/lib/human-decisions.mjs';
import { git, implChanges, implDiff, mergeBase } from '../../pipeline/lib/git.mjs';
import { policyPython } from '../../pipeline/lib/python.mjs';
import { nextAttempt, runDied } from '../../pipeline/lib/recovery.mjs';
import { clearEscalation, escalate, loadState, lockFile, metricsFile, readMetricsLocal, updateState } from '../../pipeline/lib/state.mjs';
import { acquireLock, appendJsonl, extractResult, isProcessAlive, lockHolder, log, nowIso, readJson, readJsonl, releaseLock, run, selfProcess, writeJson } from '../../pipeline/lib/util.mjs';
import { formatDisputes, ruleDisputes } from '../../implement/lib/disputes.mjs';

const fence = (text, lang = '') => `\`\`\`\`${lang}\n${text.replace(/\r\n/g, '\n').trimEnd()}\n\`\`\`\``;
const block = (reason) => ({ decision: 'block', reason });
const notice = (message) => ({ systemMessage: message });
export const REVIEWS_FILE = 'arch-reviews.jsonl';

// What each finding contributes to arch-reviews.jsonl; `fv lessons` turns recurring ones into implementer lessons.
const loggedFinding = (f) => ({
  severity: f.severity,
  category: f.category,
  ...(f.rule ? { rule: f.rule } : {}),
  file: f.file ?? null,
  line: f.line ?? null,
  issue: f.issue ? String(f.issue).slice(0, 300) : null,
});

// Why the reviewer approved or blocked the implementer, with each finding's reason and fix (decision log).
function logReviewDecision(config, story, round, { agent, agentVer, verdict, summary, findings, ...extra }) {
  logDecision(config, {
    stage: 'review',
    story: story.key,
    round,
    agent,
    agentVer,
    subject: 'implementer',
    decision: verdict === 'APPROVED' ? 'approved' : 'changes-requested',
    reason: summary || null,
    ...extra,
    items: findings.map((f) => ({
      severity: f.severity ?? null,
      category: f.category ?? null,
      rule: f.rule ?? null,
      repeat: f.repeat ?? undefined,
      file: f.file ?? null,
      line: f.line ?? null,
      reason: f.issue ?? null,
      fix: f.fix ?? null,
    })),
  });
}

// Disputes the implementer raised against the last round's findings (nits, scope creep), written by the
// implement runner (scripts/implement/lib/implement.mjs) and ruled on by the next reviewer round. The
// file also keeps how often each finding was re-asserted: twice and it stays blocking.
export const reviewDisputesFile = (config, key) => path.join(config.root, config.stateDir, 'review', `${key}.disputes.json`);
export const readReviewDisputes = (config, key) => ({ open: [], overruled: [], state: {}, ...readJson(reviewDisputesFile(config, key), {}) });

function disputesBlock(d) {
  // A council member's own block: the disputes of findings it raised (councilArchitectureReview).
  if (d.forMember) return d.forMember;
  if (!d.open.length && !d.overruled.length) return [];
  return [
    '',
    '### Implementer disputes of your last findings',
    '',
    'The implementer did not act on these findings and says why. Rule on each: re-raise the finding (keep its id) only when the story\'s acceptance criteria, correctness, security or the mockup require it, and give the `evidence` (the criterion or the concrete failure). A disputed finding re-raised without evidence does not block. You may also list `disputes: [{"finding": "<id>", "decision": "accepted" | "reasserted", "evidence": "<why>"}]` in your result.',
    '',
    formatDisputes(d.open, d.overruled),
  ];
}

// The projects this change adds whose class the architecture policy derived (not listed in its profile).
export function derivedClassesBlock(derived) {
  if (!derived?.length) return [];
  return ['', '### New projects and their derived classes', '', 'The architecture policy classified these projects from the projects themselves. Check that each class matches what the project is and does, and that no code was put in a project of a more permissive class to stay out of a rule:', '', ...derived.map((d) => `- ${d.summary}`)];
}

// The review's round limit: its council's when one sits for the review, else review.maxRounds.
export const reviewMaxRounds = (config) => councilRounds(config, 'review', config.review.maxRounds);

// The static analysis report the pipeline wrote for this commit (any slot), as evidence: the reviewers do not run the
// tools again and do not raise what they already report. Nothing without analysis or without a report.
function analysisBlock(config) {
  try {
    const sha = git(config.root, ['rev-parse', 'HEAD']).stdout.trim();
    const report = sha ? readReport(config, sha, 'story', { any: true }) : null;
    return report ? ['', evidenceText(report)] : [];
  } catch {
    return [];
  }
}

function reviewTask(config, story, round, derived = [], disputes = null) {
  const conventions = (config.review.conventions ?? ['AGENTS.md', 'CONTRIBUTING.md']).filter((f) => fs.existsSync(path.join(config.root, f)));
  return [
    `Story: ${story.key} (${story.file})`,
    `Review round: ${round} of at most ${reviewMaxRounds(config)}`,
    `Repository conventions to apply: ${conventions.join(', ') || '(none)'}; graphify-out/ may be queried with \`graphify query\`.`,
    '',
    '### Story',
    '',
    fence(fs.readFileSync(path.join(config.root, story.file), 'utf8'), 'markdown'),
    ...decisionsBlock(readDecisions(path.join(config.root, story.file)), 'verify'),
    '',
    '### Implementation diff (tests and plans excluded)',
    '',
    fence(implDiff(config), 'diff'),
    ...derivedClassesBlock(derived),
    ...analysisBlock(config),
    ...disputesBlock(disputes ?? readReviewDisputes(config, story.key)),
  ].join('\n');
}

// Applies the reviewer's rulings on the implementer's disputes: an accepted dispute (or a finding raised
// again without evidence) becomes minor; one re-asserted with evidence stays blocking, and after
// MAX_REASSERTS it can no longer be disputed. Clears the open disputes and keeps the counts.
export function applyReviewDisputes(config, key, { verdict, findings, disputes }) {
  const d = readReviewDisputes(config, key);
  if (!d.open.length && !d.overruled.length) return { verdict, findings, rulings: [] };
  const state = new Map(Object.entries(d.state));
  const ruled = ruleDisputes({ verdict, findings, disputes }, d.open, state, d.overruled);
  const blocking = ruled.verdict.findings.some((f) => f.severity === 'blocking');
  const next = blocking ? 'CHANGES_REQUESTED' : ruled.rulings.some((r) => r.ruling === 'accepted') ? 'APPROVED' : verdict;
  writeJson(reviewDisputesFile(config, key), { open: [], overruled: [], state: Object.fromEntries(state), rulings: ruled.rulings });
  return { verdict: next, findings: ruled.verdict.findings, rulings: ruled.rulings };
}

// The members that raised each finding of the last council review round, so a dispute goes only to them.
const councilFindingsFile = (config, key) => path.join(config.root, config.stateDir, 'review', `${key}.council.json`);

// One review round by a council (council.stages.review): the members review in parallel, each in a fresh process,
// and the harness merges them. The result has the shape architectureReview returns; disputes are ruled on by the
// members that raised the finding and then applied as for a single reviewer.
export async function councilArchitectureReview(config, story, round, { derivedClasses = [], council = councilFor(config, 'review'), runMember = null } = {}) {
  const d = readReviewDisputes(config, story.key);
  const raisedBy = readJson(councilFindingsFile(config, story.key), { findings: [] }).findings;
  const norm = (t) => String(t ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
  const withMembers = (list) => list.map((x) => ({ ...x, members: raisedBy.find((f) => f.id === x.id || (f.issue && norm(f.issue) === norm(x.issue)))?.members }));
  const open = withMembers(d.open);
  // A non-blocking member runs detached (council-member.mjs): the review's process ends with its round, and a member
  // still running then finishes on its own; its result is feedback for the next round (takeLate).
  const lateDir = path.join(config.root, config.stateDir, 'council', `review-${story.key}`);
  const opts = (m, task, o = null) => ({ name: 'architecture-reviewer', mode: 'read', model: m.model, cli: m.cli === 'custom' ? null : m.cli, effort: m.effort, cmd: m.cli === 'custom' ? m.cmd : null, timeoutSec: m.timeoutSec ?? config.review.timeoutSec, task, extraEnv: memberRunEnv(m), intercom: o?.intercom ?? null, usage: { stage: 'review', story: story.key, round, step: o?.purpose === 'intercom' ? `intercom-${m.name}` : m.name } });
  // The detached job file holds the member's env as configured (`${NAME}` references unexpanded): the runner expands it,
  // so no value read from the environment is ever written to disk.
  // A follow-up question to a member (its `resolves`) runs attached: it is not a round's result file.
  const call = runMember ?? ((m, task, o) => (m.blocking || o?.purpose ? runAgentAsync(config, opts(m, task, o)) : runDetachedMember({ root: config.root, stageDir: 'review', dir: lateDir, round, member: m, run: { ...opts(m, task), extraEnv: { PIPELINE_COUNCIL_MEMBER: m.name } } })));
  const parse = (output) => {
    const raw = extractResult(output);
    if (!raw || !['APPROVED', 'CHANGES_REQUESTED'].includes(raw.verdict)) return null;
    const findings = (Array.isArray(raw.findings) ? raw.findings : []).map((f) => ({ ...f, severity: ['blocking', 'major', 'minor'].includes(f?.severity) ? f.severity : 'blocking' }));
    return { score: memberScore(raw), verdict: raw.verdict, summary: String(raw.summary ?? ''), findings, disputes: raw.disputes, followUps: raw.followUps };
  };
  const feedback = takeLate(lateDir, round, council.members, parse);
  // What earlier rounds upheld, with their agreed fixes: the members read it, and the merge settles a later objection to such a fix.
  const memory = councilMemory({ file: memoryFile(config.root, config.stateDir, { stage: 'review', story: story.key }), cwd: config.root, round, fixes: fixesFile(config.root, config.stateDir, { stage: 'review', story: story.key }) });
  const readOnly = { cwd: config.root, exclude: [config.metricsDir, config.stateDir, ...(config.implExclude ?? [])] };
  const out = await runCouncil({
    council,
    round,
    retries: config.agent.resultParseRetries,
    taskFor: (m) => {
      const mine = disputesFor(m, open, (list) => disputesBlock({ open: list, overruled: d.overruled }));
      return memberTask(reviewTask(config, story, round, derivedClasses, { open: [], overruled: [], forMember: mine ? (Array.isArray(mine) ? mine : [mine]) : [] }), { council, member: m, round, earlier: memory.text });
    },
    run: call,
    parse,
    readOnly,
  });
  // A detached member's result used in this round is consumed here; a late one stays for the next round.
  for (const r of out.results) if (r.res?.resultFile) fs.rmSync(r.res.resultFile, { force: true });
  // No model of this stage rules on a split: it becomes an owner question.
  const intercom = await runIntercomDiscussion({ config, council, results: out.results, subject: story.key, stage: 'review', round, violation: out.violation, readOnly, reviewed: mergeBase(config.root, config.baseRef), run: call });
  const mergeOpts = { protect: (f) => testProtection(f, { keys: [story.key], cases: planCases(config.root, config.plansDir, story.key) }), violation: out.violation, changed: changedSince(config.root, mergeBase(config.root, config.baseRef), git), feedback, earlier: memory, root: config.root, ...(intercom ? { intercom } : {}) };
  // A scope objection on lines declared for an earlier upheld finding stands unless every blocking member accepts, asked
  // fresh, that the finding's agreed fix requires it (council.mjs adjudicate).
  const merged = await adjudicate({
    config,
    council,
    merged: mergeCouncil(council, out.results, mergeOpts),
    remerge: (adjudications) => mergeCouncil(council, out.results, { ...mergeOpts, adjudications }),
    run: runMember ?? ((m, task) => runAgentAsync(config, { ...opts(m, task), usage: { stage: 'review', story: story.key, round, step: `adjudication-${m.name}` } })),
    stage: 'review',
    story: story.key,
    round,
    retries: config.agent.resultParseRetries,
    readOnly: { cwd: config.root, exclude: [config.metricsDir, config.stateDir, ...(config.implExclude ?? [])] },
  });
  recordCouncilRound(config, { stage: 'review', story: story.key, round, council, merged });
  if (merged.error) return { verdict: 'ERROR', findings: [], summary: `architecture review council: ${merged.error}`, council: merged };
  nameFindings(merged.findings, `review-r${round}`);
  const issue = (f) => `${f.action === 'rewrite' ? rewriteText(f) : f.action === 'delete-test' ? `DELETE TEST ${f.test || ''}${f.file ? ` in ${f.file}` : ''}: ${f.text}` : f.text}${contestedText(f)}${f.protected ? ` (not acted on: ${f.protected})` : f.notUpheld ? ` (not upheld: ${f.notUpheld})` : f.supersededBy ? ` (superseded by rewrite ${f.supersededBy})` : f.feedback ? ` (feedback from non-blocking member ${f.member})` : ''}${f.members?.length > 1 ? ` [raised by ${f.members.join(', ')}]` : ''}`;
  const all = [...merged.findings.map((f) => ({ ...f, severity: 'blocking' })), ...merged.notes.map((f) => ({ ...f, severity: 'minor' }))].map((f) => ({ ...f, issue: issue(f), category: f.category ?? f.lens }));
  if ((merged.ownerQuestions ?? []).length) {
    return { verdict: 'ESCALATE', findings: all, summary: merged.summary, council: merged, contradictions: merged.contradictions, ownerQuestions: merged.ownerQuestions };
  }
  if (!merged.pass && !merged.findings.length) return { verdict: 'ERROR', findings: [], summary: `architecture review council gave no verdict: ${merged.summary}`, council: merged };
  // A finding the council discussion disposed of stays in the record only: never lifted, disputed or handed off.
  const lifted = raiseUserErrors(all.filter((f) => !f.disposition), { to: 'blocking' });
  const ruled = applyReviewDisputes(config, story.key, { verdict: merged.pass ? 'APPROVED' : 'CHANGES_REQUESTED', findings: lifted.findings, disputes: merged.disputes });
  const handed = handOffTestGaps(config, story, ruled.findings, round);
  const findings = [...handed.findings, ...all.filter((f) => f.disposition)];
  if (handed.count && !findings.some((f) => f.severity === 'blocking')) ruled.verdict = 'APPROVED';
  // Remembered after the rulings: a finding its raisers withdrew on a dispute was not upheld.
  memory.remember(findings.filter((f) => f.severity === 'blocking'));
  const verdict = ruled.verdict === 'APPROVED' && findings.some((f) => f.severity === 'blocking') ? 'CHANGES_REQUESTED' : ruled.verdict;
  writeJson(councilFindingsFile(config, story.key), { round, findings: findings.filter((f) => f.severity === 'blocking').map((f) => ({ id: f.id ?? null, issue: f.issue, members: f.members ?? [] })) });
  appendJsonl(metricsFile(config, REVIEWS_FILE), { ts: nowIso(), story: story.key, round, verdict, reviewer: 'council', reviewer_ver: null, findings: findings.map(loggedFinding) });
  logReviewDecision(config, story, round, { agent: 'council', agentVer: null, verdict, summary: merged.summary, findings, ...(ruled.rulings.length ? { disputes: ruled.rulings.map((r) => ({ finding: r.id, kind: r.kind, ruling: r.ruling, reason: r.reason, evidence: r.evidence ?? null })) } : {}) });
  return { verdict, findings, summary: merged.summary, council: merged, contradictions: merged.contradictions };
}

// The review sees the implementation without its tests (they are written after it approves), so a blocking finding that
// only asks for tests cannot be resolved by the implementer it would go back to (dogfood C23 class). It becomes a required
// case for the test plan and test automation (feature-verification/lib/required.mjs) and stops blocking here.
export function handOffTestGaps(config, story, findings, round, { add = addRequired } = {}) {
  const out = [];
  const items = [];
  for (const f of findings) {
    if (f.severity !== 'blocking') {
      out.push(f);
      continue;
    }
    const r = resolvesOf({ ...f, issue: f.issue ?? f.text });
    if (r.includes('code') || !r.some((x) => x === 'tests' || x === 'plan')) {
      out.push(f);
      continue;
    }
    items.push({ id: f.id ?? `review-r${round}-${items.length + 1}`, source: `architecture review round ${round}`, title: String(f.issue ?? f.text ?? '').slice(0, 300), fix: f.fix ?? null });
    out.push({ ...f, severity: 'minor', handedOff: 'feature-verification' });
  }
  if (items.length) {
    add(config, story.key, items);
    log(`${story.key}: ${items.length} review finding(s) only ask for tests; handed to feature verification as required cases`);
  }
  return { findings: out, count: items.length };
}

// One review round by a fresh reviewer process that sees only the story and the diff.
export function architectureReview(config, story, round, { derivedClasses = [] } = {}) {
  for (let attempt = 0; attempt <= config.agent.resultParseRetries; attempt++) {
    const result = runAgent(config, {
      name: 'architecture-reviewer',
      mode: 'read',
      model: config.agent.models.reviewer,
      timeoutSec: config.review.timeoutSec,
      task: reviewTask(config, story, round, derivedClasses),
      usage: { stage: 'review', story: story.key, round },
    });
    const raw = extractResult(result.output);
    if (raw && ['APPROVED', 'CHANGES_REQUESTED'].includes(raw.verdict)) {
      const lifted = raiseUserErrors(Array.isArray(raw.findings) ? raw.findings : [], { to: 'blocking' });
      for (const f of lifted.raised) log(`${story.key}: review finding raised to blocking: ${String(f.issue ?? '').slice(0, 140)} (${f.raisedReason})`);
      const ruled = applyReviewDisputes(config, story.key, { verdict: raw.verdict, findings: lifted.findings, disputes: raw.disputes });
      const handed = handOffTestGaps(config, story, ruled.findings, round);
      const findings = handed.findings;
      if (handed.count && !findings.some((f) => f.severity === 'blocking')) ruled.verdict = 'APPROVED';
      const verdict = ruled.verdict === 'APPROVED' && findings.some((f) => f.severity === 'blocking') ? 'CHANGES_REQUESTED' : ruled.verdict;
      appendJsonl(metricsFile(config, REVIEWS_FILE), {
        ts: nowIso(),
        story: story.key,
        round,
        verdict,
        reviewer_ver: result.version,
        findings: findings.map(loggedFinding),
      });
      logReviewDecision(config, story, round, { agent: 'architecture-reviewer', agentVer: result.version, verdict, summary: String(raw.summary ?? ''), findings, ...(ruled.rulings.length ? { disputes: ruled.rulings.map((r) => ({ finding: r.id, kind: r.kind, ruling: r.ruling, reason: r.reason, evidence: r.evidence ?? null })) } : {}) });
      return { verdict, findings, summary: String(raw.summary ?? '') };
    }
  }
  return { verdict: 'ERROR', findings: [], summary: 'architecture reviewer produced no parsable result' };
}

// Policy-pack gate: the Arch_review_Agent (architecture-policy/agents in the factory install) evaluates the
// deterministic rules of the repository's own policy (.factory/policy) before the LLM reviewer. Its history
// store records every denial per requesting agent, which feeds the agent's lessons (arch_review.py get_lessons).

// The engine is part of the factory install, not of the repository under review: `review.policy.agent` is
// looked up in the install root first, then in the repository (a repository may carry its own).
export function policyAgent(config) {
  const agent = config.review.policy.agent;
  if (path.isAbsolute(agent)) return agent;
  const roots = [config.installRoot, config.root].filter(Boolean);
  return roots.map((r) => path.resolve(r, agent)).find((f) => fs.existsSync(f)) ?? path.resolve(roots[0], agent);
}

// The policy content is the repository's: $ARCH_POLICY_DIR when set, else `review.policy.dir` in the checkout
// under review (a story worktree reviews against its own copy).
export function policyDir(config) {
  return path.resolve(config.root, process.env.ARCH_POLICY_DIR || config.review.policy.dir || '.factory/policy');
}

function runPolicy(config, template, input) {
  const p = config.review.policy;
  const values = { agent: policyAgent(config), policyDir: policyDir(config), workspace: config.root };
  const [cmd, ...args] = template.map((a) => a.replace(/\{(agent|policyDir|workspace)\}/g, (_, key) => values[key]));
  // The engine reads where the policy and the code are from its environment, so a custom command needs no flags.
  const options = { cwd: config.root, input, timeoutSec: p.timeoutSec, env: { ...process.env, ARCH_POLICY_DIR: values.policyDir, ARCH_WORKSPACE: values.workspace } };
  // `python`/`python3` in the command template means the factory's policy interpreter (python.mjs).
  if (cmd === 'python' || cmd === 'python3') {
    const py = policyPython();
    if (!py.cmd) return { status: 127, stdout: '', stderr: `no Python with pyyaml and jsonschema (tried ${py.tried.join('; ')}); run \`factory python setup\` or set FACTORY_PYTHON` };
    return run(py.cmd, args, options);
  }
  return run(cmd, args, options);
}

// The requester's recurring denials from the policy history, as prompt-ready guidance (empty when none).
function policyLessons(config) {
  const p = config.review.policy;
  if (!p.lessonsCommand) return '';
  const result = runPolicy(config, p.lessonsCommand, JSON.stringify({ agent: p.requester, limit: p.maxLessons ?? 5 }));
  try {
    return String(JSON.parse(result.stdout).prompt ?? '').trim();
  } catch {
    return '';
  }
}

// A policy names its own rule categories; `review.policy.categories` maps them to the reviewer's.
function policyFinding(config, item) {
  const patterns = item.patterns?.length ? ` Approved pattern(s): ${item.patterns.join(', ')}.` : '';
  const repeat = item.repeat_mistake ? ' (repeat mistake: this agent was denied for this rule before)' : '';
  return {
    severity: item.outcome === 'BLOCK' ? 'blocking' : 'minor',
    category: config.review.policy.categories?.[item.category] ?? 'fit',
    rule: item.rule_id,
    repeat: Boolean(item.repeat_mistake),
    // The finding needs a person (the policy profile must be extended): no code change can clear it.
    needsPerson: Boolean(item.needs_person),
    file: item.file ?? null,
    line: item.line ?? null,
    issue: `${item.rule_id} ${item.rule_title}: ${item.message}${repeat}`,
    fix: `${item.fix ?? ''}${patterns} Details: python "${policyAgent(config)}" explain_finding '{"finding_id": "${item.finding_id}"}'`.trim(),
  };
}

// {path: A|M|D|R} for the story's changed files: git's status against the base (untracked files are added).
export function changedWithStatus(config, files, base) {
  if (!base) return files;
  const status = {};
  for (const line of git(config.root, ['diff', '--name-status', '-M', base]).stdout.split('\n').filter(Boolean)) {
    const parts = line.split('\t');
    status[parts.at(-1)] = parts[0][0] === 'C' ? 'A' : parts[0][0];
  }
  return Object.fromEntries(files.map((f) => [f, status[f] ?? 'A']));
}

export function policyReview(config, story, round, { files, base, previousReviewId = null } = {}) {
  const p = config.review.policy;
  if (!p?.enabled) return { verdict: 'SKIPPED', findings: [], summary: 'policy review disabled' };
  if (!fs.existsSync(policyAgent(config))) return { verdict: 'SKIPPED', findings: [], summary: `${p.agent} not found` };
  // No policy.yaml: nothing is configured, whether or not a Python can run the factory's engine (a custom
  // policy command decides that itself).
  const engineCommand = ['python', 'python3'].includes(p.command?.[0]);
  if (engineCommand && !process.env.ARCH_POLICY_DIR && !fs.existsSync(path.join(policyDir(config), 'policy.yaml'))) {
    return { verdict: 'SKIPPED', notConfigured: true, findings: [], summary: `no architecture policy configured (${path.relative(config.root, policyDir(config)) || '.'}/policy.yaml not found)` };
  }
  const input = JSON.stringify({
    requester: { agent: p.requester, task_id: story.key, iteration: round },
    checkpoint: 'code_review',
    intent: `Implementation of story ${story.key} (${story.file})`,
    // With their git status (A/M/D/R) against the base: a file the story adds is not an edit of an existing one.
    changed_files: changedWithStatus(config, files, base),
    ...(base ? { base } : {}),
    ...(previousReviewId ? { previous_review_id: previousReviewId } : {}),
    options: { semantic: p.semantic ?? 'auto' },
  });
  const result = runPolicy(config, p.command, input);
  let response;
  try {
    response = JSON.parse(result.stdout);
  } catch {
    response = null;
  }
  // A repository without .factory/policy has no policy: the engine says so and nothing is enforced.
  if (response?.decision === 'NOT_CONFIGURED') {
    return { verdict: 'SKIPPED', notConfigured: true, findings: [], summary: `no architecture policy configured (${path.relative(config.root, policyDir(config)) || '.'}/policy.yaml not found)` };
  }
  if (!response || !['PASS', 'WARN', 'BLOCK'].includes(response.decision)) {
    const why = response?.message ?? (result.stderr.trim().split('\n').at(-1) || `exit ${result.status}`);
    return { verdict: 'ERROR', findings: [], summary: `policy review failed: ${why}` };
  }
  // needs_review items are pending semantic judgments, not findings; the LLM reviewer covers that ground.
  const items = (response.action_items ?? []).filter((i) => ['BLOCK', 'WARN'].includes(i.outcome) && i.status !== 'needs_review');
  const findings = items.map((item) => policyFinding(config, item));
  let verdict = response.decision === 'BLOCK' ? 'CHANGES_REQUESTED' : 'APPROVED';
  // Blocking findings only a person can clear (a project no classification convention fits): escalate with the
  // explanation instead of sending the agent round a fix loop it cannot win.
  const blocking = findings.filter((f) => f.severity === 'blocking');
  if (verdict === 'CHANGES_REQUESTED' && blocking.length && blocking.every((f) => f.needsPerson)) verdict = 'ESCALATE';
  if (verdict === 'CHANGES_REQUESTED') {
    appendJsonl(metricsFile(config, REVIEWS_FILE), {
      ts: nowIso(),
      story: story.key,
      round,
      verdict,
      reviewer: 'arch-review-agent',
      reviewer_ver: response.agent_version ?? null,
      review_id: response.review_id,
      findings: findings.map(loggedFinding),
    });
  }
  logReviewDecision(config, story, round, {
    agent: 'arch-review-agent',
    agentVer: response.agent_version ?? null,
    verdict,
    summary: String(response.summary ?? ''),
    findings,
    policy_decision: response.decision,
    review_id: response.review_id ?? null,
  });
  // A repeated mistake means the findings alone did not stick; hand the agent its lessons from the history.
  const lessons = verdict === 'CHANGES_REQUESTED' && findings.some((f) => f.repeat) ? policyLessons(config) : '';
  return { verdict, findings, summary: String(response.summary ?? ''), reviewId: response.review_id, decision: response.decision, lessons, derivedClasses: response.derived_classes ?? [] };
}

// One review round: the policy gate first, then (unless it blocked) the LLM architecture-reviewer.
export async function reviewRound(config, story, round) {
  const state = loadState(config, story.key);
  const { base, files } = implChanges(config);
  // With a review council (which can ask for tests to be deleted), a protected test the change deleted is put back and
  // the round asks for the change again: another story's test, one kept for an upheld finding, the only cover of a line.
  if (base && councilFor(config, 'review')) {
    const restored = guardProtectedTests({ cwd: config.root, from: base, keys: [story.key], cases: planCases(config.root, config.plansDir, story.key) });
    if (restored.length) {
      log(`${story.key}: restored ${restored.length} protected test file(s): ${restored.map((v) => v.file).join(', ')}`);
      return { verdict: 'CHANGES_REQUESTED', findings: restored.map(protectedTestFinding), summary: 'Protected tests were deleted; the harness restored them.' };
    }
  }
  const policy = policyReview(config, story, round, { files, base, previousReviewId: state.review.policyReviewId });
  if (policy.reviewId) updateState(config, story.key, (s) => (s.review.policyReviewId = policy.reviewId));
  if (policy.verdict === 'CHANGES_REQUESTED' || policy.verdict === 'ESCALATE') return { ...policy, summary: `Architecture Policy Pack: ${policy.summary}` };
  const llm = councilFor(config, 'review') ? await councilArchitectureReview(config, story, round, { derivedClasses: policy.derivedClasses ?? [] }) : architectureReview(config, story, round, { derivedClasses: policy.derivedClasses ?? [] });
  // A configured policy that could not run is never skipped silently: the change cannot be approved until it
  // runs (no Python with the modules, a broken policy). With no policy there is nothing to run.
  if (policy.verdict === 'ERROR' && !policy.notConfigured) {
    log(`${story.key}: Architecture Policy Pack could not run: ${policy.summary}`);
    return { verdict: 'CHANGES_REQUESTED', findings: [{ severity: 'blocking', category: 'fit', file: null, line: null, issue: `The architecture policy (${path.relative(config.root, policyDir(config))}) could not run: ${policy.summary}`, fix: 'Make the policy engine runnable (`factory doctor` names the problem; `factory python setup` installs its Python), then finish again. Nothing in the code needs to change for this finding.' }], summary: `Architecture Policy Pack could not run: ${policy.summary}` };
  }
  const skipped = policy.notConfigured;
  if (skipped) log(`${story.key}: Architecture Policy Pack skipped: ${policy.summary}`);
  const note = skipped ? ` (Architecture Policy Pack skipped: ${policy.summary})` : '';
  return { ...llm, findings: [...llm.findings, ...policy.findings], summary: `${llm.summary}${note}` };
}

// Only code agents are reviewed: the main session (Stop) or a subagent whose type is listed in
// review.codeAgents (SubagentStop). Pipeline child agents never reach here (PIPELINE_CHILD).
export function isCodeAgentStop(config, payload = {}) {
  if (payload.hook_event_name !== 'SubagentStop' || !payload.agent_type) return true;
  return (config.review.codeAgents ?? []).includes(payload.agent_type);
}

const formatFindings = (findings) =>
  findings
    .map((f, i) => `${i + 1}. ${f.id ? `\`${f.id}\` ` : ''}[${f.severity ?? 'blocking'}] ${f.file ?? ''}${f.line ? `:${f.line}` : ''} ${f.issue ?? ''}${f.fix ? `\n   Fix: ${f.fix}` : ''}`)
    .join('\n');

export function resetReview(config, story) {
  updateState(config, story.key, (s) => Object.assign(s.review, { rounds: 0, lastHash: null, lastVerdict: null, lastReason: null, unchangedBlocks: 0, policyReviewId: null, inProgress: null, recoveries: 0 }));
}

// A review round records itself in review.inProgress (and holds the review lock) while it runs, so
// a round cut short by a crash, kill or reboot is found again: the next Stop reruns it, at most
// recovery.maxAttempts times for the same code before it escalates.
const reviewLock = (config, story) => lockFile(config, story.key, 'review');

export function interruptedReview(config, story) {
  const { inProgress } = loadState(config, story.key).review;
  return runDied(config, inProgress && { ...inProgress, status: 'running' }, { active: ['running'], lock: reviewLock(config, story) }) ? inProgress : null;
}

// `review resume --force`: forget a round that crashed too often so the next Stop runs it again.
export function resumeReview(config, story, { force = false } = {}) {
  const { review } = loadState(config, story.key);
  const interrupted = interruptedReview(config, story);
  if (force && (interrupted || review.lastVerdict === 'CRASHED')) {
    updateState(config, story.key, (s) => Object.assign(s.review, { inProgress: null, recoveries: 0, ...(s.review.lastVerdict === 'CRASHED' ? { lastHash: null, lastVerdict: null } : {}) }));
    clearEscalation(config, story, 'review');
    return `${story.key}: review reset; it runs again when the code agent finishes its turn.`;
  }
  if (interrupted) return `${story.key}: architecture review round ${interrupted.round} was interrupted; it runs again when the code agent finishes its turn.`;
  if (review.lastVerdict === 'CRASHED') return `${story.key}: the architecture review crashed ${review.recoveries} times; run \`node scripts/review/review.mjs resume ${story.key} --force\` to try again.`;
  return null;
}

// Stop hook: review the implementation once the agent has declared the work done. Changes requested
// block the stop and hand the findings back to the agent; approval records `review.approvedHash`,
// which later stages use as their gate.
export async function hookStop(config, story, payload = {}) {
  if (!isCodeAgentStop(config, payload)) return null;
  const state = loadState(config, story.key);
  if (!state.done) return null;
  const { hash } = implChanges(config);
  if (!hash) return null;
  const review = state.review;

  if (review.lastHash === hash) {
    if (review.lastVerdict === 'CHANGES_REQUESTED') {
      if (payload.stop_hook_active || review.unchangedBlocks >= 1) {
        return notice(`Review: ${story.key} still has unresolved architecture findings and the code has not changed. Run \`node scripts/review/review.mjs status ${story.key}\` for details.`);
      }
      updateState(config, story.key, (s) => (s.review.unchangedBlocks += 1));
      return block(`The architecture review findings for ${story.key} are still open and nothing has changed since the review. Address them:\n\n${review.lastReason}`);
    }
    return null;
  }

  if (review.rounds >= reviewMaxRounds(config)) {
    updateState(config, story.key, (s) => Object.assign(s.review, { lastHash: hash, lastVerdict: 'ESCALATED' }));
    escalate(config, story, 'review', `no approval after ${review.rounds} review rounds`, review.lastReason ?? '');
    return notice(`Review: ${story.key} was not approved after ${review.rounds} architecture review rounds. A human needs to decide; see .factory/state/escalations/${story.key}-review.md.`);
  }

  const lock = reviewLock(config, story);
  if (!acquireLock(lock)) return notice(`Review: an architecture review of ${story.key} is already running (pid ${lockHolder(lock)}).`);
  let result;
  const round = review.rounds + 1;
  try {
    // An earlier round of this code died mid-run: count it, and give up after recovery.maxAttempts.
    const died = review.inProgress && !isProcessAlive(review.inProgress.pid, review.inProgress.boot) && review.inProgress.hash === hash;
    const attempt = died ? nextAttempt(config, review, { backoff: false }) : { action: 'fresh', fields: { recoveries: 0 } };
    if (attempt.action === 'crashed') {
      updateState(config, story.key, (s) => Object.assign(s.review, { lastHash: hash, lastVerdict: 'CRASHED', inProgress: null }));
      escalate(config, story, 'review', `review round crashed ${attempt.attempts} times`, `Round ${round} of the architecture review died ${attempt.attempts} times without a verdict. Run \`node scripts/review/review.mjs resume ${story.key} --force\` to try again.`);
      return notice(`Review: the architecture review of ${story.key} crashed ${attempt.attempts} times; see .factory/state/escalations/${story.key}-review.md.`);
    }
    if (died) log(`${story.key}: rerunning interrupted review round ${round} (attempt ${attempt.attempt}/${attempt.maxAttempts})`);
    updateState(config, story.key, (s) => Object.assign(s.review, attempt.fields, { inProgress: { hash, round, ...selfProcess(), startedAt: nowIso() } }));
    result = await reviewRound(config, story, round);
    updateState(config, story.key, (s) => Object.assign(s.review, { inProgress: null, recoveries: 0 }));
  } finally {
    releaseLock(lock);
  }
  if (result.verdict === 'ERROR') {
    return notice(`Review: the architecture review for ${story.key} failed to produce a verdict; it will run again next time the agent stops.`);
  }
  // Council members who contradict each other on the same subject two rounds running: a question for the ticket's owner.
  const contested = (result.contradictions ?? []).map((c) => String(c.subject));
  // The council contradicting its own earlier ruling after an adjudication (council.mjs: `escalate`) goes to the owner at once.
  const repeated = [...new Set([...contested.filter((c) => (review.contested ?? []).includes(c)), ...(result.contradictions ?? []).filter((c) => c.escalate).map((c) => String(c.subject))])];
  updateState(config, story.key, (s) => (s.review.contested = contested));
  if (repeated.length && result.verdict === 'CHANGES_REQUESTED') {
    updateState(config, story.key, (s) => Object.assign(s.review, { rounds: round, lastHash: hash, lastVerdict: 'ESCALATED', lastReason: result.summary, unchangedBlocks: 0 }));
    // not-an-agent: an escalation to a person
    escalate(config, story, 'review', 'council members contradict each other', `The architecture review council disagrees on ${repeated.join('; ')} two rounds running, and the evidence has not settled it. The ticket's owner decides.\n\n${formatFindings(result.findings)}`);
    return notice(`Review: the architecture review council of ${story.key} contradicts itself on ${repeated.join('; ')}; the ticket's owner decides. See .factory/state/escalations/${story.key}-review.md.`);
  }
  if (result.verdict === 'ESCALATE') {
    updateState(config, story.key, (s) => Object.assign(s.review, { rounds: round, lastHash: hash, lastVerdict: 'ESCALATED', lastReason: result.summary, unchangedBlocks: 0 }));
    if (result.ownerQuestions?.length) {
      // not-an-agent: an escalation to a person (a council discussion's owner question)
      escalate(config, story, 'review', 'the council discussion needs an owner decision', ownerQuestionsText(result.ownerQuestions));
      return notice(`Review: ${story.key} needs an owner decision:\n${ownerQuestionsText(result.ownerQuestions)}\nSee .factory/state/escalations/${story.key}-review.md.`);
    }
    // not-an-agent: an escalation to a person
    escalate(config, story, 'review', 'a person must extend the architecture policy profile', `The architecture policy cannot classify a project this change adds, and only a person can extend the profile (.factory/policy). No code change by the agent can clear it.\n\n${formatFindings(result.findings)}`);
    // not-an-agent: a notice that a person decides
    return notice(`Review: ${story.key} needs a person: ${formatFindings(result.findings.filter((f) => f.needsPerson))}\nSee .factory/state/escalations/${story.key}-review.md.`);
  }
  if (result.verdict === 'CHANGES_REQUESTED') {
    const lessons = result.lessons ? `\n\nYou have been denied for these rules before. Lessons from your review history (follow them for the rest of this story):\n\n${result.lessons}` : '';
    const declare = councilFor(config, 'review') ? fixDeclarationText(fixesFile(config.root, config.stateDir, { stage: 'review', story: story.key }), result.findings) : '';
    const actions = councilFor(config, 'review') ? `\n\n${councilActionsText()}${declare ? `\n\n${declare}` : ''}` : '';
    // route: handOffTestGaps (in the review round: test-only findings went to feature verification)
    const reason = `Architecture review round ${round}/${reviewMaxRounds(config)} for ${story.key} requested changes. ${result.summary}\n\n${formatFindings(result.findings)}${lessons}${actions}\n\nMake these corrections, then finish your turn; the review runs again automatically.`;
    updateState(config, story.key, (s) => Object.assign(s.review, { rounds: round, lastHash: hash, lastVerdict: 'CHANGES_REQUESTED', lastReason: reason, unchangedBlocks: 0 }));
    return block(reason);
  }
  updateState(config, story.key, (s) => Object.assign(s.review, { rounds: 0, lastHash: hash, lastVerdict: 'APPROVED', lastReason: result.summary, approvedHash: hash, unchangedBlocks: 0, policyReviewId: null }));
  clearEscalation(config, story, 'review');
  // route: handOffTestGaps (notes; test gaps handed off already)
  const extra = result.findings.length ? `\nNon-blocking notes:\n${formatFindings(result.findings)}` : '';
  return notice(`Review: architecture review approved ${story.key} (round ${round}).${extra}`);
}

export function sessionContext(config, story) {
  if (!story) return '';
  const recovery = resumeReview(config, story);
  const status = `Architecture review for ${story.key}: ${loadState(config, story.key).review.lastVerdict ?? 'not run'}.${recovery ? `\n${recovery}` : ''}`;
  // The main session can be the code agent; give it the same lessons the implementer agent reads.
  const file = path.join(config.root, config.lessonsDir, 'implementer.md');
  const lessons = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim() : '';
  return lessons ? `${status}\n\nArchitecture lessons from earlier review denials (follow these when changing code; from ${config.lessonsDir}/implementer.md):\n\n${lessons}` : status;
}

export function reviewMetrics(config, { since } = {}) {
  const reviews = readMetricsLocal(config, REVIEWS_FILE).filter((r) => !since || r.ts >= since);
  const first = reviews.filter((r) => r.round === 1);
  const findings = {};
  for (const r of reviews) for (const f of r.findings ?? []) findings[f.category ?? 'other'] = (findings[f.category ?? 'other'] ?? 0) + 1;
  return {
    rounds: reviews.length,
    approvals: reviews.filter((r) => r.verdict === 'APPROVED').length,
    firstRoundApprovalRate: first.length ? Math.round((first.filter((r) => r.verdict === 'APPROVED').length / first.length) * 100) / 100 : 0,
    stories: new Set(reviews.map((r) => r.story)).size,
    findingsByCategory: findings,
  };
}
