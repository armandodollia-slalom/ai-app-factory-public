import { writeText } from '../../pipeline/lib/redact.mjs';
import fs from 'node:fs';
import { remoteHost } from '../../pipeline/lib/hosts/index.mjs';
import path from 'node:path';
import { agentDefinition, runAgent } from '../../pipeline/lib/agents.mjs';
import { INSTALL_ROOT, loadConfig } from '../../pipeline/lib/config.mjs';
import { pull as sinkPull, push as sinkPush, sinkSettings } from '../../pipeline/lib/sink.mjs';
import { MANIFEST, render } from '../../factory/lib/render.mjs';
import { openPullRequest, prPublisher } from '../../pipeline/lib/bot.mjs';
import { deliverFinished } from '../../implement/lib/implement.mjs';
import { ciGate } from '../../implement/lib/ci-wait.mjs';
import { hostFor } from '../../pipeline/lib/hosts/index.mjs';

import { git, revExists } from '../../pipeline/lib/git.mjs';
import { AGENT_STAGE, categoryStats, loadMetrics } from '../../feature-verification/lib/metrics.mjs';
import { automationStatus, planStatus } from '../../feature-verification/lib/plans.mjs';
import { automationVerifierTaskFor, planVerifierTaskFor } from '../../feature-verification/lib/workflows.mjs';
import { spawnBackground } from '../../pipeline/lib/background.mjs';
import { RECOVERY_DONE, nextAttempt, runDied } from '../../pipeline/lib/recovery.mjs';
import { clearEscalation, escalate, logFile, stateDir } from '../../pipeline/lib/state.mjs';
import { listStories } from '../../pipeline/lib/stories.mjs';
import { lessonsDisabled } from '../../pipeline/lib/run-tags.mjs';
import { acquireLock, appendJsonl, extractResult, lockHolder, log, nowIso, readJson, releaseLock, run, selfProcess, sha, writeJson } from '../../pipeline/lib/util.mjs';
import { digestIsEmpty, retroDigest, retroSince } from './digest.mjs';
import { applyProposals } from '../../review-gate/lib/review-retro.mjs';
import { VERIFIER, metricsFile, runVerifier } from '../../feature-verification/lib/verify.mjs';
import { LENSES } from '../../pr-check/lib/loop.mjs';

const RULE = /^##\s+(L\d+)[:.]?\s*(.*)$/;
const MARKER = /<!--\s*category:\s*([^;>]+?)\s*(?:;\s*subtype:\s*([^;>]*?)\s*)?;\s*added:\s*([0-9T:.\-Z]+)\s*(?:;[^>]*)?-->/;

export function parseRules(text) {
  const rules = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const heading = RULE.exec(lines[i]);
    if (!heading) continue;
    const marker = lines.slice(i + 1, i + 4).map((l) => MARKER.exec(l)).find(Boolean);
    rules.push({
      id: heading[1],
      title: heading[2],
      category: marker?.[1]?.trim() ?? null,
      subtype: marker?.[2]?.trim() || null,
      added: marker?.[3] ?? null,
    });
  }
  return rules;
}

const lessonsPath = (config, agent, root = config.root) => path.join(root, config.lessonsDir, `${agent}.md`);

// The lessons files as they are, so a run knows whether they changed since the last lessons check.
export function lessonsHash(config, root = config.root) {
  const texts = LESSON_AGENTS.map((agent) => lessonsPath(config, agent, root)).filter((f) => fs.existsSync(f)).map((f) => `${path.basename(f)}\n${fs.readFileSync(f, 'utf8')}`);
  // The check's own definition is part of it: a better check looks at the lessons it passed again.
  return texts.length ? sha(`${agentDefinition(loadConfig('feature-verification', root), 'lessons-check').version}\n${texts.join('\n')}`, 12) : null;
}

// Removes rules (`## L<n>` sections, up to the next `## ` heading) from a lessons file's text.
export function removeRules(text, ids) {
  const drop = new Set(ids);
  const out = [];
  let skipping = false;
  for (const line of text.split('\n')) {
    const heading = RULE.exec(line);
    if (heading || /^##\s/.test(line)) skipping = Boolean(heading && drop.has(heading[1]));
    if (!skipping) out.push(line);
  }
  return `${out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`;
}

// Council C4: two lessons taught the PR check critics to skip "deviations the Implementation Notes accept" and "a
// deviation the story already records"; the critics then left an authorization rule weaker than the ticket's unraised.
// Only a person on the ticket can waive a criterion. A rule that tells an agent to accept the implementer's notes
// instead of the ticket, or to skip findings because of them, is removed whatever the lessons check says.
const NOTES = String.raw`(?:implementation\s+notes|deviations?|recorded\s+decisions?|the\s+story(?:'s)?\s+(?:already\s+)?(?:records?|notes?|decisions?))`;
const ACCEPTS = String.raw`(?:accepts?|accepted|records?|recorded|documents?|documented|justif\w*|allows?|explains?)`;
const WAIVER = [
  new RegExp(String.raw`\b${NOTES}\b[^.]{0,80}\b${ACCEPTS}\b`, 'i'),
  new RegExp(String.raw`\b${ACCEPTS}\b[^.]{0,40}\b(?:in|by|under)\s+(?:the\s+|its\s+)?${NOTES}\b`, 'i'),
  new RegExp(String.raw`\b(?:record|note|list|write)\b[^.]{0,40}\b${NOTES}\b[^.]{0,60}\binstead\b`, 'i'),
];
// Report verbs broadly (council C5: "do not file it as a finding" got through the first list). This word list is the
// backstop; the lessons check judges each rule's meaning (waivers in its result).
const REPORT = String.raw`(?:report|raise|flag|uphold|block|file|log|record|list|count|treat|mark|score|escalate|mention)`;
const SKIP = new RegExp(String.raw`\b(?:skip|ignore|dismiss|waive|overlook|omit|leave\s+out|let\s+(?:it|them)\s+pass|stay\s+silent|downgrade|lower\s+(?:its|the)\s+severity|as\s+(?:a\s+)?minor|(?:do\s+not|don't|never|no\s+need\s+to)\s+${REPORT}|not\s+a\s+finding|is\s+(?:met|acceptable|fine|allowed|ok))\b|\binstead\b`, 'i');

// The text of each rule (heading and body), by id.
export function ruleTexts(text) {
  const out = new Map();
  let id = null;
  for (const line of text.split('\n')) {
    const heading = RULE.exec(line);
    if (heading) id = heading[1];
    else if (/^##\s/.test(line)) id = null;
    if (id) out.set(id, `${out.get(id) ?? ''}${line}\n`);
  }
  return out;
}

export const waivesCriteria = (ruleText) => WAIVER.some((re) => re.test(ruleText)) && SKIP.test(ruleText);

// Removes the waiver rules from every lessons file. Returns [{ agent, rule, definition, why }] like checkLessons.
export function dropWaiverLessons(config, root) {
  const found = [];
  for (const agent of LESSON_AGENTS) {
    const file = lessonsPath(config, agent, root);
    if (!fs.existsSync(file)) continue;
    const text = fs.readFileSync(file, 'utf8');
    const ids = [...ruleTexts(text)].filter(([, t]) => waivesCriteria(t)).map(([id]) => id);
    if (!ids.length) continue;
    writeText(file, removeRules(text, ids));
    for (const rule of ids) found.push({ agent, rule, definition: 'The ticket\'s Expected behaviour and acceptance criteria are the contract; the Implementation Notes never waive a criterion.', why: 'it tells the agent to accept the implementer\'s notes instead of the ticket, or to skip findings because of them' });
  }
  for (const c of found) log(`lessons: removed ${c.agent} ${c.rule}: ${c.why}`);
  return found;
}

// A lesson must never contradict the definition of the agent it goes to (council C2: a pr-check-style lesson told the
// critic not to report formatter-only hunks, which its definition and the implementers' hygiene rule forbid). The
// lessons-check agent compares every rule with the agent's definition; the rules it finds contradicting are removed.
// Returns [{ agent, rule, definition, why }] for the rules removed.
export function checkLessons(config, root, { runAgentImpl = runAgent } = {}) {
  const waivers = dropWaiverLessons(config, root);
  const files = LESSON_AGENTS.map((agent) => ({ agent, file: lessonsPath(config, agent, root) }))
    .filter((x) => fs.existsSync(x.file))
    .map((x) => ({ ...x, text: fs.readFileSync(x.file, 'utf8') }))
    .filter((x) => parseRules(x.text).length);
  if (!files.length) return waivers;
  // One agent per call: its definition and its lessons file only. With every agent in one prompt the check missed a
  // contradiction it finds when it reads the two alone (dogfood C4).
  const definitions = loadConfig('feature-verification', root);
  const found = [];
  for (const x of files) {
    const task = [`## ${x.agent}`, '', '### Definition', '', '````markdown', agentDefinition(definitions, x.agent).body, '````', '', '### Lessons file', '', '````markdown', x.text.trimEnd(), '````', ''].join('\n');
    const res = runAgentImpl(config, { name: 'lessons-check', mode: 'read', cwd: root, usage: { stage: 'lessons', story: null }, timeoutSec: config.timeoutsSec.lessons, task });
    if (!res?.ok) {
      log(`lessons: the lessons check of ${x.agent} did not run; none of its rules was removed.`);
      continue;
    }
    const out = extractResult(res.output) ?? {};
    // The check also judges each rule's meaning: does it tell any reviewer to skip, downgrade or not report a deviation
    // from the ticket? Those are removed like contradictions (council C5: the word list is only a backstop).
    const waived = (Array.isArray(out.waivers) ? out.waivers : []).map((w) => ({ ...w, agent: w?.agent ?? x.agent, definition: 'The ticket is the contract; only a person on the ticket can waive a criterion.', why: `waiver: ${w?.why ?? ''}` }));
    const mine = [...(out.contradictions ?? []), ...waived].filter((c) => c?.agent === x.agent && parseRules(x.text).some((r) => r.id === c.rule));
    if (mine.length) writeText(x.file, removeRules(x.text, mine.map((c) => c.rule)));
    found.push(...mine);
  }
  for (const c of found) log(`lessons: removed ${c.agent} ${c.rule}: it contradicts the agent's definition (${c.why})`);
  return [...waivers, ...found.map((c) => ({ agent: c.agent, rule: c.rule, definition: String(c.definition ?? ''), why: String(c.why ?? '') }))];
}

// The implementer learns from architecture review denials (.factory/metrics/arch-reviews.jsonl): every
// blocking finding, from the Architecture Policy Pack (subtype = rule id) or the LLM reviewer.
export const IMPLEMENTER = 'implementer';

function reviewDenials(reviews = []) {
  return reviews
    .filter((r) => r.verdict === 'CHANGES_REQUESTED')
    .flatMap((r) =>
      (r.findings ?? [])
        .filter((f) => (f.severity ?? 'blocking') === 'blocking')
        .map((f) => ({
          ts: r.ts,
          story: r.story,
          attributed_agent: IMPLEMENTER,
          category: f.category ?? 'other',
          subtype: f.rule ?? null,
          case: `review round ${r.round} (${r.reviewer ?? 'architecture-reviewer'})`,
          detail: f.issue ?? null,
          location: f.file ? `${f.file}${f.line ? `:${f.line}` : ''}` : null,
        })),
    );
}

// Implementation bugs the integration tests found (decision log, stage automation): the implementer
// shipped code that contradicts a verified test case. Category product-bug; no subtype.
function productBugs(decisions = []) {
  return decisions
    .filter((d) => d.stage === 'automation' && d.decision === 'product-bug')
    .flatMap((d) =>
      (d.items ?? []).map((b) => ({
        ts: d.ts,
        story: d.story,
        attributed_agent: IMPLEMENTER,
        category: 'product-bug',
        subtype: null,
        case: b.case ?? `automation round ${d.round}`,
        detail: [b.expected && `expected ${b.expected}`, b.actual && `got ${b.actual}`, b.reason].filter(Boolean).join('; ') || null,
        location: b.location ?? null,
      })),
    );
}

// The PR check (.factory/metrics/pr-checks.jsonl) teaches three kinds of agent:
// - implementer: findings upheld in round 1, i.e. against the code as the implementer wrote it;
// - pr-check-fixer: findings upheld again after the fixer had a round to fix them;
// - each critic (pr-check-<lens>): its findings the judge dismissed (false positives).
export const PR_CHECK_FIXER = 'pr-check-fixer';
// The agent that produced what a PR-check finding is about: the video lens and findings located in the e2e
// specs, test projects or scenarios are the test automation's work, everything else the implementer's
// (council C1: a feature's video findings became implementer lessons, none reached test-automation).
const TEST_PATH = /(^|[\s/`(])(e2e|tests?|\.factory\/stack\/scenarios)\//;
export const producerOf = (f) => (f.lens === 'video' || TEST_PATH.test(String(f.evidence ?? '')) ? 'test-automation' : IMPLEMENTER);
export const PR_CHECK_CRITICS = Object.fromEntries(Object.entries(LENSES).map(([lens, l]) => [l.agent, lens]));
const PR_CHECK_AGENTS = [PR_CHECK_FIXER, ...Object.keys(PR_CHECK_CRITICS)];

function prCheckEntries(checks = [], agent) {
  const entry = (r, f, extra) => ({
    ts: r.ts,
    story: r.story,
    attributed_agent: agent,
    case: `PR check ${r.target} round ${r.round} (${f.id})`,
    detail: [f.title, f.detail ?? f.reason].filter(Boolean).join(': ') || null,
    location: f.evidence || null,
    ...extra,
  });
  // A seeded fix round (council C7) records findings another stage raised (CI, a report round): no critic's or
  // implementer's lesson.
  return checks.filter((r) => !r.seeded).flatMap((r) => {
    if (agent === IMPLEMENTER) {
      return r.round === 1 ? (r.upheld ?? []).filter((f) => f.title && producerOf(f) === IMPLEMENTER).map((f) => entry(r, f, { category: `pr-check-${f.lens}`, subtype: null })) : [];
    }
    if (agent === 'test-automation' || agent === VERIFIER.automation) {
      // Findings about the tests and their videos teach the agent that wrote them, and the verifier that passed them.
      return r.round === 1 ? (r.upheld ?? []).filter((f) => f.title && producerOf(f) === 'test-automation').map((f) => entry(r, f, { category: agent === 'test-automation' ? `pr-check-${f.lens}` : 'passed-but-upheld', subtype: agent === 'test-automation' ? null : f.lens })) : [];
    }
    if (agent === PR_CHECK_FIXER) {
      return (r.upheld ?? []).filter((f) => f.repeat).map((f) => entry(r, f, { category: 'not-fixed', subtype: f.lens }));
    }
    const lens = PR_CHECK_CRITICS[agent];
    return (r.dismissed ?? []).filter((f) => f.lens === lens).map((f) => entry(r, f, { category: 'dismissed-finding', subtype: null, location: null }));
  });
}

function entriesFor(data, agent) {
  if (agent === IMPLEMENTER) return [...reviewDenials(data.reviews), ...prCheckEntries(data.prChecks, agent), ...productBugs(data.decisions)];
  if (agent === 'test-automation') return [...data.denials.filter((d) => d.attributed_agent === agent), ...prCheckEntries(data.prChecks, agent)];
  if (agent === VERIFIER.automation) return [...data.calibration.filter((d) => d.attributed_agent === agent), ...prCheckEntries(data.prChecks, agent)];
  if (PR_CHECK_AGENTS.includes(agent)) return prCheckEntries(data.prChecks, agent);
  if (agent.endsWith('-verifier')) return data.calibration.filter((d) => d.attributed_agent === agent);
  return data.denials.filter((d) => d.attributed_agent === agent);
}

function runsFor(data, agent) {
  const checks = data.prChecks ?? [];
  if (agent === IMPLEMENTER) return [...(data.reviews ?? []), ...checks.filter((r) => r.round === 1)];
  if (agent === PR_CHECK_FIXER) return checks.filter((r) => r.round > 1);
  const lens = PR_CHECK_CRITICS[agent];
  if (lens) return checks.filter((r) => r.lensScores && lens in r.lensScores);
  const stage = AGENT_STAGE[agent];
  return data.runs.filter((r) => r.stage === stage);
}

// Decides, from the denial log alone, what each agent's lessons file should gain or lose.
export function lessonCandidates(config, data, agent, lessonsText) {
  const settings = config.lessons;
  const entries = entriesFor(data, agent);
  const runs = runsFor(data, agent);
  const rules = parseRules(lessonsText);
  const matches = (rule, d) => d.category === rule.category && (!rule.subtype || rule.subtype === d.subtype);

  const ruleReport = rules.map((rule) => {
    if (!rule.added || !rule.category) return { ...rule, action: 'keep', note: 'no tracking marker' };
    const after = runs.filter((r) => r.ts > rule.added);
    const before = runs.filter((r) => r.ts <= rule.added);
    const hitsAfter = entries.filter((d) => d.ts > rule.added && matches(rule, d));
    const hitsBefore = entries.filter((d) => d.ts <= rule.added && matches(rule, d));
    const storiesAfter = new Set(after.map((r) => r.story)).size;
    const rateAfter = after.length ? hitsAfter.length / after.length : 0;
    const rateBefore = before.length ? hitsBefore.length / before.length : 0;
    let action = 'keep';
    if (storiesAfter >= settings.retireAfterStories && hitsAfter.length === 0) action = 'retire';
    else if (after.length >= settings.revertMinRounds && rateBefore > 0 && rateAfter >= rateBefore) action = 'revert';
    return { ...rule, action, storiesAfter, hitsAfter: hitsAfter.length, rateBefore: +rateBefore.toFixed(3), rateAfter: +rateAfter.toFixed(3) };
  });

  const recurring = categoryStats(entries).filter((c) => c.stories >= settings.storyThreshold);
  const newOrStrengthen = recurring
    .map((c) => {
      const rule = rules.find((r) => r.category === c.category && (!r.subtype || r.subtype === c.subtype));
      const relevant = entries.filter((d) => d.category === c.category && (d.subtype ?? null) === c.subtype && (!rule?.added || d.ts > rule.added));
      const stories = new Set(relevant.map((d) => d.story)).size;
      if (stories < settings.storyThreshold) return null;
      const examples = relevant
        .slice(-settings.examplesPerCategory)
        .map((d) => ({ story: d.story, case: d.case, detail: d.detail, location: d.location }));
      return { action: rule ? 'strengthen' : 'add', rule: rule?.id ?? null, category: c.category, subtype: c.subtype, count: relevant.length, stories, examples };
    })
    .filter(Boolean);

  const actionable = [...newOrStrengthen, ...ruleReport.filter((r) => r.action !== 'keep')];
  return { agent, rules: ruleReport, changes: newOrStrengthen, actionable: actionable.length > 0 };
}

export const LESSON_AGENTS = ['test-planner', 'test-automation', VERIFIER.plan, VERIFIER.automation, IMPLEMENTER, ...PR_CHECK_AGENTS];

function lessonsTask(config, reports, root, digest = null, factoryDir = null) {
  const lines = [
    `Maximum rules per file: ${config.lessons.maxRules}. Today: ${nowIso()}.`,
    reports.length
      ? 'Edit the lessons files listed below as requested. Every rule you add or rewrite must carry the tracking marker on the line after its heading, with added set to today.'
      : 'No lessons file needs a change this time.',
    '',
  ];
  for (const report of reports) {
    const file = path.relative(root, lessonsPath(config, report.agent, root));
    lines.push(`## ${report.agent} (${file})`, '', 'Current file:', '', '````markdown', fs.existsSync(path.join(root, file)) ? fs.readFileSync(path.join(root, file), 'utf8').trimEnd() : '(missing)', '````', '');
    lines.push('Requested changes (JSON):', '', '```json', JSON.stringify({ changes: report.changes, rules: report.rules.filter((r) => r.action !== 'keep') }, null, 2), '```', '');
  }
  if (digest) {
    lines.push(
      '## Factory retro',
      '',
      `The decision log since ${digest.since}: why each agent decided what it did. Look for root causes that a lessons rule cannot fix (an unclear agent definition, a gap in the docs or the story template, a policy rule that keeps misfiring, a verifier that is too strict or too lax) and fix them by editing files under: ${allowedPaths(config).join(', ')}.`,
      'Only propose changes the evidence supports across stories; list every file you change in `proposals` with the evidence. Leave everything else alone.',
      '`factoryChanges` lists the factory\'s own commits since then. Before you propose a change or call something open, check it: when a commit made after a finding addresses it, the finding is already fixed in a later release; say so in its observation (`alreadyFixed`: the commit) and propose nothing for it. Lessons go to the agent that produced what a finding is about (the tests, scenarios and their videos are the test automation\'s work, and the verifier that passed them is also taught; the production code is the implementer\'s).',
      'Whether or not you change anything, account for what did not go through on its own: every entry of `escalations`, `runOutcomes` and `prChecks`, and every `firstVerifierScores` entry below 9. For each, write one `observations` item in your result: what happened, the likely root cause (an agent definition, the docs, a template, the factory engine itself, this codebase, or the ticket), and whether it is a one-off or a pattern so far. These are recorded with the run even when you propose nothing.',
      'End with `AGENT_RESULT: {"proposals": [{"file": "...", "why": "..."}], "observations": [{"about": "<escalation, PR check, first score, outcome>", "story": "<key>", "what": "...", "rootCause": "...", "where": "agent|docs|template|engine|codebase|ticket", "pattern": "one-off|pattern"}]}`.',
      'The `reviews` section is how people reviewed the bug-fix PRs the review gate sent them, by PR class. Its `proposals` for the approvals policy are computed and applied by the harness (never edit `implement.reviewGate` yourself); use the section to explain them and to find causes elsewhere (for example a triage rating that keeps sending trivial PRs to people).',
      '',
      '```json',
      JSON.stringify(digest, null, 2),
      '```',
      '',
    );
    if (factoryDir) {
      lines.push(
        '## Where a fix belongs',
        '',
        `- **This repository** (a rule that holds for this codebase): lessons files, and under ${allowedPaths(config).join(', ') || '(nothing else)'}.`,
        `- **The factory** (a root cause every codebase would hit: a base agent definition, the factory's docs, a template, a skill): a checkout of the factory is at \`${path.relative(root, factoryDir)}/\`. Edit there only under ${factorySettings(config).allowedPaths.join(', ')}; it becomes a separate pull request against the factory. A root cause in the factory's engine (its scripts) or templates cannot be edited here: say so in an observation with \`where\` \"engine\" or \"template\" and \`pattern\` \"pattern\" when it recurs, and it is filed as an issue against the factory. List those files in \`proposals\` with the prefix \`factory:\` (for example \`factory:agents/implementer.agent.md\`) and a one-line reason that names no story, file or person of this repository.`,
        'When unsure, keep the fix here: a lesson or an addendum can be promoted later.',
        '',
      );
    }
  }
  return lines.join('\n');
}

const allowedPaths = (config) => config.lessons.retro?.allowedPaths ?? [];

// The review gate's approvals policy (`implement.reviewGate` of the effective config of `root`): the
// table and the retro's proposal settings.
const OVERLAY = '.factory/config.json';
function reviewPolicy(root) {
  let gate = null;
  try {
    gate = loadConfig('implement', root).implement?.reviewGate ?? null;
  } catch {
    gate = null;
  }
  return gate ? { table: gate.approvals ?? {}, retro: gate.retro ?? {} } : null;
}

// Applies the retro's approvals proposals to the table in `root` (the lessons branch), so they reach
// a person as a reviewed PR. The proposals were computed in code with the guards (minimum sample, never
// below 1 approval); the agent never edits the table. They are written to the repository's own
// .factory/config.json, which overrides the engine's default table. Returns the proposals applied.
function applyApprovalProposals(root, proposals) {
  const wanted = (proposals ?? []).filter((p) => p.kind === 'approvals');
  const policy = reviewPolicy(root);
  if (!wanted.length || !policy) return [];
  const file = path.join(root, OVERLAY);
  const overlay = readJson(file, {}) ?? {};
  overlay.implement = { ...(overlay.implement ?? {}), reviewGate: { ...(overlay.implement?.reviewGate ?? {}), approvals: applyProposals(policy.table, wanted) } };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeText(file, `${JSON.stringify(overlay, null, 2)}\n`);
  return wanted;
}

// ---- the factory checkout ------------------------------------------------------------------------
// A retro finds two kinds of fix. One belongs to this repository (lessons, agent addenda, policy rules):
// it goes into the lessons branch. The other belongs to the factory itself (a base agent definition, the
// docs, a template, a skill): the agent gets a checkout of the factory, inside the worktree's ignored
// state folder, and its edits there become a separate branch and pull request against the factory.
const FACTORY_ALLOWED = ['agents/', 'docs/', 'templates/', 'skills/'];
const factorySettings = (config) => ({ enabled: true, allowedPaths: FACTORY_ALLOWED, evidence: 'summary', ...(config.retro?.factory ?? {}) });

export function factorySource(config) {
  const settings = factorySettings(config);
  // The factory working on itself has one root: its fixes are ordinary edits of the lessons branch.
  if (!settings.enabled || path.resolve(INSTALL_ROOT) === path.resolve(config.mainRoot ?? config.root)) return null;
  if (!fs.existsSync(path.join(INSTALL_ROOT, '.git'))) return null;
  const pin = readJson(path.join(config.root, '.factory/factory.json'), {}) ?? {};
  const origin = git(INSTALL_ROOT, ['remote', 'get-url', 'origin']);
  return { from: INSTALL_ROOT, source: settings.source ?? pin.source ?? ((origin.status === 0 && origin.stdout.trim()) || null) };
}

function prepareFactoryCheckout(config, root, src, branch) {
  const dir = path.join(root, config.stateDir, 'factory-src');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  const cloned = run('git', ['clone', '-q', src.from, dir]);
  if (cloned.status !== 0) throw new Error(`could not clone the factory from ${src.from}: ${cloned.stderr.trim()}`);
  if (src.source) git(dir, ['remote', 'set-url', 'origin', src.source]);
  git(dir, ['checkout', '-q', '-b', branch], { allowFail: false });
  return dir;
}

// Commits the agent's edits in the factory checkout (only under the allowed paths) and opens the pull
// request against the factory with the developer's own git and gh credentials (the PR bot's token is
// limited to the app repository). Without push access the commit is saved as a patch for a person to send.
async function publishFactoryChanges(config, dir, { branch, push, proposals }) {
  const settings = factorySettings(config);
  const changes = changedFiles(dir);
  const outside = changes.filter((c) => !inside(c.file, settings.allowedPaths));
  if (outside.length) {
    log(`retro: discarding factory edits outside ${settings.allowedPaths.join(', ')}: ${outside.map((c) => c.file).join(', ')}`);
    const tracked = outside.filter((c) => !c.untracked).map((c) => c.file);
    if (tracked.length) git(dir, ['checkout', '--', ...tracked]);
    for (const c of outside.filter((x) => x.untracked)) fs.rmSync(path.join(dir, c.file), { force: true });
  }
  const files = changedFiles(dir).map((c) => c.file);
  if (!files.length) return null;
  const project = config.project?.name ?? path.basename(config.root);
  // What leaves the app repository: by default the agent's own one-line reasons, never excerpts of the
  // decision log (stories, code locations). "none" lists only the files.
  const reasons = files.map((f) => {
    const why = settings.evidence === 'none' ? '' : proposals.find((p) => p.file === `factory:${f}` || p.file === f)?.why ?? '';
    return `- \`${f}\`${why ? `: ${why}` : ''}`;
  });
  const title = `Retro (${project}): ${files.length} proposed factory change${files.length === 1 ? '' : 's'}`;
  const body = `Proposed by the factory retro of \`${project}\` from its agents' decision log.\n\n${reasons.join('\n')}\n\nReview each change: it should hold for every codebase the factory serves, not only the one that proposed it.`;
  git(dir, ['add', '--', ...files]);
  git(dir, ['commit', '-q', '-m', `${title}\n\n${reasons.join('\n')}`], { allowFail: false });
  const patch = () => {
    const out = path.join(stateDir(config), 'retro', `${branch.replace(/\//g, '-')}.patch`);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, git(dir, ['format-patch', '-1', '--stdout']).stdout);
    return { status: 'patch', patch: path.relative(config.root, out), files };
  };
  const origin = git(dir, ['remote', 'get-url', 'origin']).stdout.trim();
  if (!push || !origin || path.resolve(origin) === path.resolve(INSTALL_ROOT)) return patch();
  const pushed = run('git', ['push', '-q', '-u', 'origin', branch], { cwd: dir });
  if (pushed.status !== 0) {
    log(`retro: could not push ${branch} to the factory (${pushed.stderr.trim().split('\n').pop()}); saved the change as a patch.`);
    return patch();
  }
  // No PR is opened against the factory (owner requirement C18: the pipeline opens a PR only once its CI is proven on the
  // branch head, and this repository's settings cannot prove the factory's CI). The branch is pushed and a person opens
  // the PR from its compare link.
  const compare = compareUrl(hostFor({ root: dir }, { cwd: dir }), branch);
  log(`retro: pushed ${branch} to the factory; a person opens its PR${compare ? ` (${compare})` : ''}`);
  return { status: 'pushed', url: null, compare, branch, files, title, body };
}

// Ticket keys are not sent to the factory: a list of them becomes a count, a lone one "a ticket".
export const redactTickets = (text) => String(text ?? '')
  .replace(/\(\s*[A-Z][A-Z0-9]*-\d+(?:\s*,\s*[A-Z][A-Z0-9]*-\d+)*\s*\)/g, (m) => `(${m.split(',').length} ticket${m.split(',').length === 1 ? '' : 's'})`)
  .replace(/\b[A-Z][A-Z0-9]*-\d+\b/g, 'a ticket');

// A recurring root cause the retro agent placed in the factory's engine or templates, which it cannot edit (its
// factory checkout is writable only under agents/, docs/, templates/, skills/), is filed as an issue against the
// factory instead of staying in this repository's observations log (council C3: the retro named "the check fires for
// new members with no callers, which adds rounds without catching real defects" as an engine pattern, and nothing
// reached the factory). One open issue per title; nothing is filed in a dry run or without push.
export function fileFactoryIssues(config, observations, { origin, push, gh = null }) {
  const host = origin ? remoteHost(String(origin), gh ? { gh } : {}) : null;
  const repo = host ? String(host.repo ?? '') || null : null;
  const due = observations.filter((o) => ['engine', 'template'].includes(o.where) && o.pattern === 'pattern' && !o.alreadyFixed && o.rootCause);
  if (!repo || !push || !due.length) return [];
  const project = config.project?.name ?? path.basename(config.root);
  const filed = [];
  for (const o of due) {
    const title = `Retro (${project}): ${redactTickets(o.about || o.rootCause).slice(0, 110)}`;
    const existing = (() => {
      try {
        return host.issues.search({ text: title, state: 'open' }).find((i) => i.title === title);
      } catch {
        return null;
      }
    })();
    if (existing) {
      filed.push({ title, url: existing.url, existing: true });
      continue;
    }
    const body = [
      `Raised by the factory retro of \`${project}\` from its agents' decision log: a recurring root cause in the factory's ${o.where}, which the retro cannot change itself.`,
      '',
      `**What the decision log shows:** ${redactTickets(o.what)}`,
      '',
      `**Root cause, as the retro agent reads it:** ${redactTickets(o.rootCause)}`,
      '',
      'A person decides whether and how the factory changes. The retro sends no code, story or file of the application.',
    ].join('\n');
    try {
      filed.push({ title, url: host.issues.create({ title, body }).url });
    } catch (error) {
      log(`retro: could not file the factory issue "${title}" (${String(error.message).split('\n').pop()})`);
    }
  }
  for (const f of filed) log(`retro: ${f.existing ? 'already filed' : 'filed'} against the factory: ${f.url}`);
  return filed;
}

const inside = (file, dirs) => dirs.some((d) => file === d.replace(/\/$/, '') || file.startsWith(d.endsWith('/') ? d : `${d}/`));

// Files changed in a checkout, including untracked files.
const changedFiles = (root) =>
  git(root, ['status', '--porcelain', '--untracked-files=all']).stdout.split('\n').filter(Boolean).map((l) => ({ file: l.slice(3).replace(/^.* -> /, ''), untracked: l.startsWith('??') }));

function observationsFrom(output) {
  const items = extractResult(output)?.observations;
  return (Array.isArray(items) ? items : []).filter((o) => o && typeof o === 'object').map((o) => ({ about: String(o.about ?? ''), story: o.story ? String(o.story) : null, what: String(o.what ?? ''), rootCause: String(o.rootCause ?? ''), where: String(o.where ?? ''), pattern: String(o.pattern ?? '') }));
}

function proposalsFrom(output) {
  const proposals = extractResult(output)?.proposals;
  return (Array.isArray(proposals) ? proposals : []).filter((p) => p?.file).map((p) => ({ file: String(p.file), why: String(p.why ?? '') }));
}

// A lessons run records itself in lessons-run.json and holds a lock while it works, so a run that dies
// (crash, kill, reboot) is found and resumed: from the push if it had already committed, else from the
// start with its leftover worktree and branch removed. lessons-last.json is written only when a run ends,
// so a crashed run is still due.
const RETRO_CLI = path.join(INSTALL_ROOT, 'scripts/retro/retro.mjs');
const LESSONS_KEY = 'lessons';
const LESSONS_STORY = { key: LESSONS_KEY };
// Removes a retro worktree completely. `git worktree remove` leaves the folders git ignores (build output, the
// knowledge graph, the factory checkout under .factory/state/factory-src) behind, and an agent could later read
// that factory checkout (dogfood C4: six retro worktree folders were left, one with the factory's run notes).
export function dropWorktree(config, dir) {
  if (fs.existsSync(dir)) git(config.root, ['worktree', 'remove', '--force', dir]);
  // Read-only folders (a graphify cache) made the removal throw after the PR was opened (council C3, C7 retro run).
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    run('chmod', ['-R', 'u+w', dir]);
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch (error) {
      log(`retro: could not remove ${dir} (${error.message}); the next run removes it`);
    }
  }
  git(config.root, ['worktree', 'prune']);
}

// Retro worktree folders no run uses any more (left by a crash, or by older versions): removed at the start of a run.
export function sweepRetroWorktrees(config, keep = null) {
  const dir = path.join(stateDir(config), 'worktrees');
  if (!fs.existsSync(dir)) return [];
  const real = (p) => (fs.existsSync(p) ? fs.realpathSync(p) : path.resolve(p));
  const live = new Set(git(config.root, ['worktree', 'list', '--porcelain']).stdout.split('\n').filter((l) => l.startsWith('worktree ')).map((l) => real(l.slice(9))));
  const removed = [];
  for (const name of fs.readdirSync(dir).filter((n) => n.startsWith('retro-lessons-'))) {
    const abs = path.resolve(dir, name);
    if ((keep && real(abs) === real(keep)) || live.has(real(abs))) continue;
    fs.rmSync(abs, { recursive: true, force: true });
    removed.push(name);
  }
  return removed;
}

export const lessonsRunFile = (config) => path.join(stateDir(config), 'lessons-run.json');
const lessonsLock = (config) => path.join(stateDir(config), 'locks', 'lessons.lock');
const readRun = (config) => readJson(lessonsRunFile(config), null);
const saveRun = (config, fields) => writeJson(lessonsRunFile(config), { ...readRun(config), ...fields });

function discardRun(config, prior) {
  if (prior.worktree && fs.existsSync(prior.worktree)) dropWorktree(config, prior.worktree);
  git(config.root, ['worktree', 'prune']);
  if (prior.branch && revExists(config.root, `refs/heads/${prior.branch}`)) git(config.root, ['branch', '-D', prior.branch]);
}

// Delivers the lessons branch through the same delivery as every pipeline PR (implement.mjs deliverFinished; owner
// requirement C18): pushed, its CI proven on the head (no fixing agent: a red lessons branch opens no PR), then the PR
// opens once, as the pipeline's PR bot (dev-bot-<login>, lib/bot.mjs) or the developer's gh login. Where the branch push
// runs no pipeline, the PR opens as a draft and is marked ready only when its checks are green.
export async function publish(config, { branch, push, title, body }, deps = {}) {
  if (!push) return { status: 'committed', branch };
  const publisher = deps.open ? null : deps.publisher ?? (await prPublisher(config));
  const worktree = path.join(stateDir(config), 'retro', `deliver-${Date.now()}`);
  fs.mkdirSync(path.dirname(worktree), { recursive: true });
  git(config.root, ['worktree', 'add', '-q', worktree, branch], { allowFail: false });
  try {
    const out = await deliverFinished(config, config, {
      id: 'lessons',
      keys: [],
      auditKeys: [],
      label: 'lessons',
      branch,
      worktree,
      base: config.baseRef ?? 'origin/main',
      title,
      body,
      result: {},
      isBug: false,
      targetArgs: [],
      save: (s) => saveRun(config, { phase: s.phase === 'ci-wait' || s.phase === null ? 'pushed' : 'committed', delivery: s }),
      load: () => readRun(config)?.delivery ?? null,
      open: deps.open ?? (async ({ title: t, body: b, draft }) => {
        const opened = await openPullRequest(publisher, { cwd: worktree, branch, base: String(config.baseRef ?? 'origin/main').replace(/^origin\//, ''), title: t, body: b, draft }, { mergeBase: () => null });
        return { ...opened, draft };
      }),
      io: { publishTicket: () => {}, ...(deps.io ?? {}), gate: (opts) => (deps.io?.gate ?? ciGate)({ ...opts, fixRounds: 0 }) },
    });
    if (out.outcome) log(`lessons: ${out.pr ? `${out.pr}: ` : 'no PR: '}${out.reason}`);
    else log(`lessons: opened ${out.pr}`);
    return { status: out.pr ? 'pr' : 'not-delivered', branch, url: out.pr ?? '', ...(out.outcome ? { reason: out.reason } : {}) };
  } finally {
    git(config.root, ['worktree', 'remove', '--force', worktree]);
  }
}

// Where a person finds the pushed proposal: the factory repository and branch (the host's own UI offers the PR from it).
function compareUrl(host, branch) {
  const repo = String(host.repo ?? '');
  return repo ? `${repo}, branch ${branch}` : null;
}

export async function lessonsCommand(config, { dryRun = false, local = false, ifDue = false, push = true, resume = false, since = null } = {}) {
  // `since`: an ISO date, or 'all' for the whole history in the store; by default the window starts at the last lessons commit.
  const windowStart = since === 'all' ? '1970-01-01T00:00:00.000Z' : since ? new Date(since).toISOString() : null;
  // Experiments must not teach the agents mid-run: no lessons files, no retro, no lessons branch.
  if (lessonsDisabled()) {
    log('lessons: disabled (PIPELINE_LESSONS=off); nothing written.');
    return { status: 'disabled' };
  }
  const lock = lessonsLock(config);
  if (!acquireLock(lock)) {
    log(`lessons: another lessons run (pid ${lockHolder(lock)}) is in progress.`);
    return { status: 'already-running' };
  }
  const lastFile = path.join(stateDir(config), 'lessons-last.json');
  const swept = sweepRetroWorktrees(config);
  if (swept.length) log(`lessons: removed ${swept.length} retro worktree folder(s) no run uses: ${swept.join(', ')}`);
  let last = null;
  try {
    // We hold the lock, so a run still recorded as working died.
    const prior = readRun(config);
    const interrupted = ['starting', 'running'].includes(prior?.status) ? prior : null;
    const kept = interrupted ? { recoveries: interrupted.recoveries ?? 0, retryAt: interrupted.retryAt ?? null } : RECOVERY_DONE;
    if (interrupted) {
      local = interrupted.local ?? local;
      push = interrupted.push ?? push;
      if (!local && ['committed', 'pushed'].includes(interrupted.phase) && revExists(config.root, `refs/heads/${interrupted.branch}`)) {
        log(`lessons: resuming the interrupted run after its commit on ${interrupted.branch}.`);
        if (interrupted.worktree && fs.existsSync(interrupted.worktree)) dropWorktree(config, interrupted.worktree);
        saveRun(config, { status: 'running', ...selfProcess() });
        const result = await publish(config, { branch: interrupted.branch, push, title: interrupted.title, body: interrupted.body });
        last = { ts: nowIso(), ...interrupted.last };
        return { ...result, resumed: true };
      }
      log('lessons: an earlier run was interrupted; starting it over.');
      if (!local) discardRun(config, interrupted);
    }
    if (resume && !interrupted) {
      log('lessons: no interrupted run to resume.');
      return { status: 'nothing-to-resume' };
    }
    const lastRun = readJson(lastFile, {});
    if (ifDue && !interrupted && lastRun.ts && Date.now() - Date.parse(lastRun.ts) < config.lessons.intervalDays * 86_400_000) {
      log(`lessons: last run ${lastRun.ts}; not due yet.`);
      return { status: 'not-due' };
    }
    // The remote store, when it can be read back, adds the records of other machines and CI runs (and,
    // with sink scope "all", other repositories) to this checkout's own.
    try {
      if (sinkSettings(config).canPull) {
        await sinkPush(config);
        const pulled = await sinkPull(config, { since: windowStart ?? retroSince(config) });
        if (!pulled.failed) process.env.FACTORY_METRICS_MERGED = '1';
        log(`retro: ${pulled.pulled} record(s) from the ${sinkSettings(config).type} metrics store${pulled.failed ? ' (some streams failed; using local records)' : ''}.`);
      }
    } catch (error) {
      log(`retro: metrics store unavailable (${error.message}); using this checkout's records.`);
    }
    const data = loadMetrics(config);
    const reports = LESSON_AGENTS.map((agent) => {
      const file = lessonsPath(config, agent);
      return lessonCandidates(config, data, agent, fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '');
    });
    const actionable = reports.filter((r) => r.actionable);
    const retro = config.lessons.retro?.enabled === false ? null : retroDigest(config, data.decisions ?? [], windowStart ?? retroSince(config), { outcomes: data.outcomes ?? [], policy: reviewPolicy(config.root), prChecks: data.prChecks ?? [], verifierRuns: data.runs ?? [], implementRuns: data.implementRuns ?? [], escalations: data.escalations ?? [] });
    const digest = retro && !digestIsEmpty(retro) ? retro : null;
    // Lessons files changed since the last lessons check (a merged lessons PR, an edit by hand) are checked even
    // when nothing else is due.
    const lessonsNow = lessonsHash(config);
    const checkDue = Boolean(lessonsNow) && lessonsNow !== lastRun.lessonsChecked;
    const summaryOfRun = { actionable: actionable.map((r) => r.agent), retro: digest ? digest.counts : null, lessonsChecked: lastRun.lessonsChecked ?? null };
    last = { ts: nowIso(), ...summaryOfRun };
    if (dryRun || (actionable.length === 0 && !digest && !checkDue)) {
      log(dryRun ? 'lessons: dry run' : 'lessons: no recurring denials past the threshold, no rules to retire or revert and no new decisions to review.');
      return { status: dryRun ? 'dry-run' : 'nothing-to-do', reports, digest };
    }

    let root = config.root;
    let branch = null;
    if (!local) {
      // A run started over keeps the interrupted run's branch (discardRun removed it): the name is stamped to
      // the minute, and the rerun must land on the same branch whatever the minute it starts in.
      branch = (!interrupted?.local && interrupted?.branch) || `retro/lessons-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}`;
      root = path.join(stateDir(config), 'worktrees', branch.replace('/', '-'));
    }
    writeJson(lessonsRunFile(config), { status: 'running', ...selfProcess(), startedAt: nowIso(), requestedAt: nowIso(), phase: 'agent', local, push, branch, worktree: local ? null : root, last: summaryOfRun, ...kept });
    if (!local) {
      const base = revExists(config.root, config.baseRef) ? config.baseRef : 'HEAD';
      const added = git(config.root, ['worktree', 'add', '-b', branch, root, base]);
      if (added.status !== 0) throw new Error(`git worktree add failed: ${added.stderr}`);
    }
    let factoryDir = null;
    try {
      const src = digest && !local ? factorySource(config) : null;
      if (src) {
        try {
          factoryDir = prepareFactoryCheckout(config, root, src, `retro/${config.project?.name ?? 'app'}-${branch.split('lessons-')[1]}`);
        } catch (error) {
          log(`retro: no factory checkout (${error.message}); factory-level fixes are listed as proposals only.`);
        }
      }
      // Only the lessons check is due: no retro agent run.
      const result = actionable.length || digest ? runAgent(config, { name: 'retro', mode: 'write', cwd: root, usage: { stage: 'lessons', story: null }, timeoutSec: config.timeoutsSec.lessons, task: lessonsTask(config, actionable, root, digest, factoryDir) }) : { ok: true, output: '' };
      if (!result.ok) throw new Error('lessons agent failed');
      const writable = [config.lessonsDir, ...(digest ? allowedPaths(config) : [])];
      const outside = changedFiles(root).filter((c) => !inside(c.file, writable));
      if (outside.length) {
        log(`lessons: discarding edits outside ${writable.join(', ')}: ${outside.map((c) => c.file).join(', ')}`);
        if (!local) {
          const tracked = outside.filter((c) => !c.untracked).map((c) => c.file);
          if (tracked.length) git(root, ['checkout', '--', ...tracked]);
          for (const c of outside.filter((x) => x.untracked)) fs.rmSync(path.join(root, c.file), { force: true });
        }
      }
      // Agent addenda have generated copies for the agent tools; keep them in step with any retro edit.
      if (fs.existsSync(path.join(root, MANIFEST)) && changedFiles(root).some((c) => c.file.startsWith('.factory/agents/'))) render(root, INSTALL_ROOT);
      const proposals = digest ? proposalsFrom(result.output) : [];
      const observations = digest ? observationsFrom(result.output) : [];
      if (observations.length) appendJsonl(metricsFile(config, 'retro-observations.jsonl'), observations.map((o) => ({ ts: nowIso(), ...o })));
      last.observations = observations.length;
      let upstream = null;
      if (factoryDir) {
        try {
          upstream = await publishFactoryChanges(config, factoryDir, { branch: git(factoryDir, ['rev-parse', '--abbrev-ref', 'HEAD']).stdout.trim(), push, proposals });
        } catch (error) {
          log(`retro: the factory change was not published (${error.message}).`);
        }
      }
      if (factoryDir && observations.length) {
        try {
          last.factoryIssues = fileFactoryIssues(config, observations, { origin: git(factoryDir, ['remote', 'get-url', 'origin']).stdout.trim(), push }).map((f) => f.url);
        } catch (error) {
          log(`retro: factory issues not filed (${error.message})`);
        }
      }
      const contradicting = checkLessons(config, root);
      last.lessonsChecked = lessonsHash(config, root);
      // The approvals policy proposals (computed in code, guarded) go into this PR for a person to approve.
      const policy = digest ? applyApprovalProposals(root, digest.reviews?.proposals) : [];
      const written = (digest?.reviews?.proposals ?? []).filter((p) => p.kind !== 'approvals');
      for (const agent of LESSON_AGENTS) {
        const file = lessonsPath(config, agent, root);
        if (!fs.existsSync(file)) continue;
        ensureLessonsHeading(file, agent);
        const count = parseRules(fs.readFileSync(file, 'utf8')).length;
        if (count > config.lessons.maxRules) throw new Error(`${agent} lessons file has ${count} rules (max ${config.lessons.maxRules}).`);
      }
      if (local) return { status: 'applied-locally', reports: actionable, proposals, policy, observations, contradicting };
      const toCommit = changedFiles(root).map((c) => c.file);
      if (!toCommit.length) {
        // Nothing to commit: the branch made for it is removed with its worktree (it would only hold the base).
        dropWorktree(config, root);
        git(config.root, ['branch', '-D', branch]);
        return { status: 'no-edits', reports: actionable, proposals, upstream, observations, contradicting };
      }
      git(root, ['add', '--', ...toCommit]);
      // Carry calibration audits run in this checkout (e.g. by CI) into the PR so they are not lost.
      const calibration = path.join(config.metricsDir, 'calibration.jsonl');
      if (fs.existsSync(path.join(config.root, calibration))) {
        fs.mkdirSync(path.join(root, config.metricsDir), { recursive: true });
        fs.copyFileSync(path.join(config.root, calibration), path.join(root, calibration));
        git(root, ['add', '--', calibration]);
      }
      const summary =
        actionable
          .map((r) => `- **${r.agent}**: ${[...r.changes.map((c) => `${c.action} ${c.category}${c.subtype ? `/${c.subtype}` : ''} (${c.stories} stories)`), ...r.rules.filter((x) => x.action !== 'keep').map((x) => `${x.action} ${x.id} ${x.category}`)].join('; ')}`)
          .join('\n') || '- No lessons file changes.';
      const removedNote = contradicting.length ? `\n\n### Lessons removed: they contradicted their agent's definition\n\n${contradicting.map((c) => `- **${c.agent}** ${c.rule}: ${c.why} (definition: "${c.definition}")`).join('\n')}` : '';
      const factory =
        removedNote + (proposals.length ? `\n\n### Proposed factory changes (needs human review)\n\nFrom the decision log since ${digest.since}:\n\n${proposals.map((p) => `- \`${p.file}\`: ${p.why}`).join('\n')}` : '') +
        (policy.length || written.length
          ? `\n\n### Proposed approvals policy changes (needs human review)\n\nFrom the review gate's pr-review records (\`implement.reviewGate.approvals\` in \`${OVERLAY}\`; never fewer than 1 approval for a PR that is not auto-merged, and only for a class with at least ${reviewPolicy(root)?.retro?.minSample ?? 5} PRs reviewed by people):\n\n${[...policy.map((p) => `- \`${p.class}\`: ${p.from} → ${p.to} approval(s): ${p.why}`), ...written.map((p) => `- \`${p.class}\`: not applied, for a person to decide: ${p.why}`)].join('\n')}`
          : '');
      const upstreamNote = upstream ? `\n\n### Proposed upstream to the factory\n\n${upstream.url ? `Pull request: ${upstream.url}` : upstream.patch ? `Saved as a patch for a person to send: \`${upstream.patch}\`` : `Branch \`${upstream.branch}\` pushed to the factory; a person opens its PR${upstream.compare ? ` (${upstream.compare})` : ''}`} (${upstream.files.map((f) => `\`${f}\``).join(', ')}).` : '';
      const title = 'Update agent lessons from verifier, architecture review and PR check findings';
      const trailer = agentTrailer(config.agent?.cli);
      const message = `${title}\n\n${summary}${factory}${trailer ? `\n\n${trailer}` : ''}`;
      const body = `Generated by \`factory retro run\` from \`.factory/metrics/\`.\n\n${summary}${factory}${upstreamNote}\n\nReview each rule: it should be concrete, generalize beyond the examples, and not contradict the agent definition.`;
      git(root, ['commit', '-m', message], { allowFail: false });
      saveRun(config, { phase: 'committed', title, body });
      return { ...(await publish(config, { branch, push, title, body })), worktree: push ? undefined : root, proposals, upstream, observations, contradicting };
    } finally {
      if (!local) dropWorktree(config, root);
    }
  } catch (err) {
    if (readRun(config)?.pid === process.pid) saveRun(config, { status: 'failed', error: String(err.message ?? err) });
    throw err;
  } finally {
    // Reached unless the process died: the run ended (or failed) and is not resumed.
    if (last) writeJson(lastFile, last);
    const current = readRun(config);
    if (current && ['starting', 'running'].includes(current.status) && current.pid === process.pid) saveRun(config, { status: 'done', finishedAt: nowIso(), ...RECOVERY_DONE });
    // Ship this run's own records (observations, lessons-run outcome) to the store, as a story does when it ends
    // (council C1: a retro's observations stayed untracked in the main checkout).
    if (!dryRun) await shipRetroRecords(config);
    releaseLock(lock);
  }
}

// A lessons file starts with its top-level heading, as markdownlint (MD041) and the reference's files have it; the
// retro agent writes new files from `## L1` (dogfood C2: CI's lint failed on the retro's lessons PR #47).
export function ensureLessonsHeading(file, agent) {
  const text = fs.readFileSync(file, 'utf8');
  if (/^\s*# /.test(text)) return false;
  writeText(file, `# Lessons: ${agent}\n\nRules learned from this repository's reviews, verifier findings and PR checks; they are appended to the ${agent} agent's instructions on every run.\n\n${text.replace(/^\s+/, '')}`);
  return true;
}

export async function shipRetroRecords(config, pushImpl = sinkPush) {
  try {
    if (!sinkSettings(config).canPush) return null;
    const r = await pushImpl(config);
    if (r?.shipped) log(`retro: ${r.shipped} record(s) shipped to the ${sinkSettings(config).type} metrics store.`);
    return r;
  } catch (error) {
    log(`retro: records not shipped to the metrics store (${error.message}); \`factory sink push\` retries.`);
    return null;
  }
}

// The commit trailer naming the agent that wrote the retro's edits, from the configured agent CLI.
export const agentTrailer = (cli) => ({ copilot: 'Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>', claude: 'Co-authored-by: Claude <noreply@anthropic.com>' })[cli] ?? null;

// Resumes a lessons run that died, in the background, with the shared backoff; escalates after
// recovery.maxAttempts. `force` restarts one escalated as crashed.
export function recoverLessons(config, { force = false } = {}) {
  if (lessonsDisabled()) return null;
  let runRec = readRun(config);
  if (!runRec) return null;
  if (runRec.status === 'crashed') {
    if (!force) return null;
    clearEscalation(config, LESSONS_STORY, 'retro');
    runRec = { ...runRec, status: 'running', pid: null, requestedAt: null, recoveries: 0, retryAt: null };
  }
  if (!runDied(config, runRec, { active: ['starting', 'running'], lock: lessonsLock(config) })) return null;
  const next = nextAttempt(config, runRec, { force });
  if (next.action === 'waiting') return { kind: 'lessons', action: 'waiting', retryAt: next.retryAt };
  if (next.action === 'crashed') {
    writeJson(lessonsRunFile(config), { ...runRec, status: 'crashed' });
    escalate(config, LESSONS_STORY, 'retro', `lessons run crashed ${next.attempts} times`, `The lessons and factory retro run (\`factory retro run\`) died ${next.attempts} times. Last log: ${runRec.log ?? 'none'}.\nRetry with \`factory fv resume --force\`.`);
    return { kind: 'lessons', action: 'crashed' };
  }
  const file = logFile(config, LESSONS_KEY, 'lessons');
  const logPath = path.relative(config.root, file);
  writeJson(lessonsRunFile(config), { ...runRec, status: 'starting', pid: null, boot: null, requestedAt: nowIso(), log: logPath, ...next.fields });
  spawnBackground(config, { script: RETRO_CLI, key: LESSONS_KEY, stage: 'lessons', args: ['run', '--resume'], file });
  return { kind: 'lessons', action: 'resumed', attempt: next.attempt, log: logPath };
}

export function formatLessonsRecovery(r) {
  if (r.action === 'resumed') return `Retro: resumed the interrupted lessons and factory retro run (attempt ${r.attempt}, log: ${r.log}).`;
  if (r.action === 'waiting') return `Retro: the lessons and factory retro run crashed; it is retried after ${r.retryAt}.`;
  return 'Retro: the lessons and factory retro run kept crashing and was escalated (.factory/state/escalations/lessons-retro.md).';
}

// Re-checks recent passing results (at or above loops.requiredScore) with a stricter auditor so the verifiers themselves can improve.
export function calibrateCommand(config, { stage = null, sample = 3 } = {}) {
  const data = loadMetrics(config);
  const stories = listStories(config);
  const stages = stage ? [stage] : ['plan', 'automation'];
  const results = [];
  for (const s of stages) {
    const latest = new Map();
    for (const r of data.runs.filter((x) => x.stage === s && x.passed)) latest.set(r.story, r);
    const candidates = [...latest.values()]
      .sort((a, b) => (a.ts < b.ts ? 1 : -1))
      .map((r) => ({ run: r, story: stories.find((x) => x.key === r.story) }))
      .filter(({ story }) => story && (s === 'plan' ? planStatus(config, story).state === 'verified' : automationStatus(config, story).state === 'verified'))
      .slice(0, sample);
    for (const { run: original, story } of candidates) {
      const task = `${s === 'plan' ? planVerifierTaskFor(config, story) : automationVerifierTaskFor(config, story)}\n\nAUDIT MODE: another verifier already scored this ${original.score}/10. Re-check it independently and strictly; report every gap you find.`;
      const verdict = runVerifier(config, { stage: s, story, round: 0, producerVersion: original.agent_prompt_ver, task, model: config.agent.models.audit, metrics: false });
      if (verdict.error) continue;
      const misses = verdict.gaps.map((g) => ({ ts: nowIso(), stage: s, story: story.key, verifier_ver: original.verifier_ver, audit_score: verdict.score, ...g, attributed_agent: VERIFIER[s] }));
      appendJsonl(metricsFile(config, 'calibration.jsonl'), misses.length ? misses : [{ ts: nowIso(), stage: s, story: story.key, verifier_ver: original.verifier_ver, audit_score: verdict.score, category: 'agreed', attributed_agent: 'none' }]);
      results.push({ stage: s, story: story.key, auditScore: verdict.score, misses: misses.length });
    }
  }
  return results;
}
