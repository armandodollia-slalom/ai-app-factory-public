#!/usr/bin/env node
// `factory council`: seat the configured council on the current branch by hand, or validate its configuration.
// The pipeline's stages seat it themselves (docs/ai-pipeline/council.md); this is the same seating and merging with a
// generic task: the branch's diff against its base and the active story, if there is one.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runAgentAsync } from '../pipeline/lib/agents.mjs';
import { parseArgs, runMain } from '../pipeline/lib/cli.mjs';
import { loadConfig } from '../pipeline/lib/config.mjs';
import { COUNCIL_STAGES, councilDoctorRows, councilFor, memberRunEnv, councilReviewSection, memberScore, memberTask, mergeCouncil, planCases, recordCouncilRound, runCouncil, testProtection } from '../pipeline/lib/council.mjs';
import { resolveIntercom, seatedNames } from '../pipeline/lib/council-config.mjs';
import { applyRulings, checkoutState, intercomStateDir, runIntercomDiscussion } from '../pipeline/lib/intercom.mjs';
import { intercomDoctor } from '../pipeline/lib/intercom-server.mjs';
import { git } from '../pipeline/lib/git.mjs';
import { resolveStory, activeStory } from '../pipeline/lib/stories.mjs';
import { extractResult, setLogTag, sha } from '../pipeline/lib/util.mjs';

setLogTag('council');

// `--rulings` is listed only where a council discussion is enabled: with it off, the usage is what it always was.
const usage = (rulings = false) => `Usage: factory council <command> [options]

  review [--stage <stage>] [--base <ref>] [--story <KEY>]${rulings ? ' [--rulings <file>]' : ''} [--json]
                     seat the council configured for <stage> on the current branch (its diff against <ref>,
                     default baseRef) and print the merged result; exits 0 when the council passes, 1 when not${rulings ? `
                     (--rulings <file> answers the splits a discussion left awaiting a ruling, without running anyone)` : ''}
  check [--json]     validate the council section of .factory/config.json and list who sits for each stage

Stages: ${Object.keys(COUNCIL_STAGES).join(', ')} (pairUiVerify needs a leased app stack and runs only in the pipeline).`;

// The stage folder whose config.json the stage's settings come from.
export const STAGE_CONFIG = { pairVerify: 'implement', pairUiVerify: 'implement', review: 'review', testPlan: 'feature-verification', testAutomation: 'feature-verification', prCheck: 'pr-check' };
// For a PR check council, the critic agent each lens runs (scripts/pr-check/lib/loop.mjs COUNCIL_CRITIC).
const PR_CRITIC = { acceptance: 'pr-check-acceptance', correctness: 'pr-check-flow', security: 'pr-check-flow', 'test-value': 'pr-check-style', rewrite: 'pr-check-style', ui: 'pr-check-design' };
const ORDER = ['review', 'pairVerify', 'prCheck', 'testAutomation', 'testPlan'];

const fence = (text, lang = '') => `\`\`\`\`${lang}\n${String(text).trimEnd()}\n\`\`\`\``;

export function reviewTask({ branch, base, story, storyText, diff, stage }) {
  return [
    `Review the change on branch ${branch} against ${base} as a member of the ${COUNCIL_STAGES[stage].title} council, by hand (\`factory council review\`).`,
    story ? `Story: ${story.key} (${story.file})` : 'No story is active: judge the change against what its commits and diff say it does, and say so in `summary`.',
    '',
    ...(storyText ? ['### Story', '', fence(storyText, 'markdown'), ''] : []),
    '### Diff',
    '',
    fence(diff || '(empty)', 'diff'),
    '',
    'Whatever output format the instructions above give, end with one line: `AGENT_RESULT: {"score": <0-10>, "verdict": "APPROVED" | "CHANGES_REQUESTED", "summary": "...", "findings": [...], "followUps": [...]}`, each finding with `severity`, `file`, `line`, `issue` and the council fields below.',
  ].join('\n');
}

// A member's answer in any of the stage contracts: findings (verifiers, critics) or gaps (test verifiers).
export function parseAny(output) {
  const raw = extractResult(output ?? '');
  if (!raw || typeof raw !== 'object') return null;
  const list = Array.isArray(raw.findings) ? raw.findings : Array.isArray(raw.gaps) ? raw.gaps : null;
  if (!list) return null;
  const score = memberScore(raw);
  const verdict = ['APPROVED', 'CHANGES_REQUESTED'].includes(raw.verdict) ? raw.verdict : null;
  return { score, verdict, summary: String(raw.summary ?? ''), findings: list.filter((f) => f && typeof f === 'object').map((f) => ({ ...f, issue: f.issue ?? f.title ?? f.detail })), disputes: raw.disputes, followUps: raw.followUps };
}

function pickStage(config, wanted) {
  if (wanted) {
    if (!COUNCIL_STAGES[wanted]) throw new Error(`unknown stage "${wanted}" (${Object.keys(COUNCIL_STAGES).join(', ')})`);
    return wanted;
  }
  const configured = Object.keys(config.council?.stages ?? {});
  const stage = ORDER.find((s) => configured.includes(s));
  if (!stage) throw new Error('no council is configured: add a `council` section with at least one stage under council.stages to .factory/config.json (docs/ai-pipeline/council.md)');
  return stage;
}

const intercomOn = (c) => Boolean(c && (resolveIntercom(c).enabled || Object.keys(c.stages ?? {}).some((s) => resolveIntercom(c, s).enabled)));

async function review(flags) {
  const probe = loadConfig(null);
  const stage = pickStage(probe, flags.stage);
  if (COUNCIL_STAGES[stage].ui) throw new Error('the pairUiVerify council drives the app on a leased test stack slot; it runs only inside `factory implement run`');
  const config = loadConfig(STAGE_CONFIG[stage]);
  const council = councilFor(config, stage);
  if (!council) throw new Error(`no council sits for ${stage}: add council.stages.${stage} to .factory/config.json`);
  const readOnly = { cwd: config.root, exclude: [config.metricsDir, config.stateDir, ...(config.implExclude ?? [])] };
  if (flags.rulings) return reviewRulings(config, council, stage, readOnly, flags);
  const base = flags.base || config.baseRef;
  const mergeBase = git(config.root, ['merge-base', base, 'HEAD']).stdout.trim();
  if (!mergeBase) throw new Error(`no merge base between ${base} and HEAD; pass --base <ref>`);
  const diff = git(config.root, ['diff', mergeBase, '--', '.', ...(config.implExclude ?? []).map((e) => `:(exclude)${e}`)]).stdout.slice(0, 150_000);
  const branch = git(config.root, ['rev-parse', '--abbrev-ref', 'HEAD']).stdout.trim();
  const story = flags.story ? resolveStory(config, String(flags.story).toUpperCase(), { fetch: false }) : activeStory(config);
  const storyText = story?.file && fs.existsSync(path.join(config.root, story.file)) ? fs.readFileSync(path.join(config.root, story.file), 'utf8') : null;
  const task = reviewTask({ branch, base, story, storyText, diff, stage });
  const subject = story?.key ?? `branch:${branch}`;
  const agentOf = (m) => (stage === 'prCheck' ? PR_CRITIC[m.lens] : COUNCIL_STAGES[stage].agent);
  const runMember = (m, t, o) => runAgentAsync(config, { name: agentOf(m), task: t, mode: 'read', model: m.model, cli: m.cli === 'custom' ? null : m.cli, effort: m.effort, cmd: m.cli === 'custom' ? m.cmd : null, timeoutSec: m.timeoutSec ?? 1800, noSubagents: true, extraEnv: memberRunEnv(m), intercom: o?.intercom ?? null, usage: { stage: `council-${stage}`, story: subject, round: 1, step: o?.purpose === 'intercom' ? `intercom-${m.name}` : m.name } });
  const out = await runCouncil({
    council,
    round: 1,
    retries: config.agent.resultParseRetries,
    taskFor: (m) => memberTask(task, { council, member: m, round: 1 }),
    run: runMember,
    parse: parseAny,
    readOnly,
  });
  // A discussion, when enabled: a split waits for `--rulings` (the person or model running this rules on it).
  const intercom = await runIntercomDiscussion({ config, council, results: out.results, subject, stage, violation: out.violation, readOnly, reviewed: sha(`${mergeBase}\n${task}`, 16), run: runMember, deferRulings: true });
  const cases = story ? planCases(config.root, config.plansDir, story.key) : [];
  const merged = mergeCouncil(council, out.results, { protect: (f) => testProtection(f, { keys: story ? [story.key] : [], cases }), violation: out.violation, ...(intercom ? { intercom } : {}) });
  return report(config, { stage, subject, council, merged, flags, base, step: 'by-hand' });
}

// The second call: rulings for the saved room's splits, merged with the saved round-1 results. Nobody runs again, and
// nothing is written unless the room, this stage, the checkout and every entry check out (applyRulings).
function reviewRulings(config, council, stage, readOnly, flags) {
  if (!council.intercom?.enabled) throw new Error('--rulings answers a council discussion, and council.intercom.enabled is not true for this stage');
  const saved = applyRulings(intercomStateDir(config), path.resolve(flags.rulings), { stage, ...checkoutState(readOnly), members: council.members.map((m) => m.name) });
  const results = saved.results.map((r) => ({ ...r, member: council.members.find((m) => m.name === r.member) }));
  const keys = String(saved.meta.subject).startsWith('branch:') ? [] : [saved.meta.subject];
  const cases = keys.flatMap((k) => planCases(config.root, config.plansDir, k));
  const merged = mergeCouncil(council, results, { protect: (f) => testProtection(f, { keys, cases }), intercom: saved.result });
  return report(config, { stage, subject: saved.meta.subject, council, merged, flags, base: null, step: 'by-hand-rulings' });
}

function report(config, { stage, subject, council, merged, flags, base, step }) {
  const rec = recordCouncilRound(config, { stage, story: subject, step, round: 1, council, merged });
  if (flags.json) console.log(JSON.stringify({ stage, base, ...merged }, null, 2));
  else console.log(formatResult(stage, merged, councilReviewSection([rec])));
  return merged.error ? 2 : merged.pass ? 0 : 1;
}

export function formatResult(stage, merged, table) {
  const where = (f) => (f.file ? `${f.file}${f.line ? `:${f.line}` : ''} ` : '');
  const line = (f) => `- [${f.severity}${f.action !== 'fix' ? `, ${f.action}` : ''}] ${where(f)}${f.text}${f.members?.length ? ` (${f.members.join(', ')})` : ''}${f.notUpheld ? ` — not upheld: ${f.notUpheld}` : ''}${f.protected ? ` — not acted on: ${f.protected}` : ''}${f.supersededBy ? ` — superseded by rewrite ${f.supersededBy}` : ''}`;
  return [
    merged.summary,
    ...(merged.unavailable?.length ? ['', 'Unavailable (never substituted):', ...merged.unavailable.map((u) => `- ${u.name} (${u.cli}): ${u.reason}`)] : []),
    ...(merged.findings?.length ? ['', 'Findings that stand:', ...merged.findings.map(line)] : []),
    ...(merged.contradictions?.length ? ['', 'Members contradict each other (decide with evidence, or ask the ticket\'s owner):', ...merged.contradictions.map((c) => `- ${c.subject}: ${c.positions.map((p) => `${p.member} ${p.action}`).join(' vs ')}`)] : []),
    ...(merged.awaitingRuling?.length ? ['', `Splits awaiting a ruling (room ${merged.intercom.roomId}; answer with --rulings <file>, {"roomId", "rulings": [{"disputeId", "findingId", "ruling", "reason"}]}):`, ...merged.awaitingRuling.map((e) => `- ${e.disputeId} on ${e.findingId} (${e.kind}): ${e.question} | ${e.positions.map((p) => `${p.seat} ${p.effect}: ${p.position.replace(/\n/g, ' / ')}${p.evidence ? ` [${p.evidence}]` : ''}`).join(' | ')}`)] : []),
    ...(merged.ownerQuestions?.length ? ['', 'Owner questions from the council discussion:', ...merged.ownerQuestions.map((q) => `- ${q.findingId} (${q.kind}): ${q.question} (${q.reason})`)] : []),
    ...(merged.notes?.length ? ['', 'Notes (do not block):', ...merged.notes.map(line)] : []),
    ...(merged.followUps?.length ? ['', 'Follow-ups (outside the ticket):', ...merged.followUps.map((u) => `- ${u.title} (${u.member})`)] : []),
    ...(table ? ['', table] : []),
  ].join('\n');
}

async function check(flags) {
  let config;
  try {
    config = loadConfig(null);
  } catch (error) {
    console.error(error.message);
    return 1;
  }
  const c = config.council;
  if (!c) {
    console.log('No council configured: every stage runs its single verifier.');
    return 0;
  }
  const stages = Object.keys(c.stages ?? {}).map((stage) => {
    const s = councilFor(loadConfig(STAGE_CONFIG[stage]), stage);
    return { stage, rounds: s.rounds, passScore: s.passScore, blockOn: s.blockOn, onUnavailable: s.onUnavailable, ...(s.intercom.enabled ? { intercom: s.intercom } : {}), members: seatedNames(c, stage) };
  });
  if (flags.json) console.log(JSON.stringify({ ok: true, stages }, null, 2));
  else {
    console.log('Council configuration: OK');
    for (const s of stages) console.log(`- ${s.stage}: ${s.members.join(', ')} (${s.rounds} round(s), pass ${s.passScore}/10, blockOn ${s.blockOn}, onUnavailable ${s.onUnavailable}${s.intercom?.enabled ? `, intercom ${s.intercom.host}:${s.intercom.port}` : ''})`);
    // Whether every seated member can run here: its CLI, its login (with the member's own env) and its model.
    const rows = councilDoctorRows(config, { probe: (cmd, args, env) => spawnSync(cmd, args, { encoding: 'utf8', env, shell: process.platform === 'win32', timeout: 60_000 }).status === 0 });
    const ic = intercomOn(c) ? await intercomDoctor(config) : { rows: [], warnings: [] };
    rows.push(...ic.rows);
    for (const [what, ok, note] of rows) console.log(`${ok ? 'ok     ' : 'MISSING'}  ${what}${note ? `  (${note})` : ''}`);
    for (const [what, note] of ic.warnings) console.log(`WARN     ${what}  (${note})`);
    const idle = Object.values(COUNCIL_STAGES).length - stages.length;
    if (idle) console.log(`Other stages (${Object.keys(COUNCIL_STAGES).filter((k) => !stages.some((s) => s.stage === k)).join(', ')}) run their single verifier.`);
  }
  return 0;
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const { flags } = parseArgs(rest, new Set(['stage', 'base', 'story', 'rulings']));
  let rulings = false;
  try {
    rulings = intercomOn(loadConfig(null).council);
  } catch {
    // no readable configuration: the plain usage
  }
  if (!command || command === 'help' || flags.help) {
    console.log(usage(rulings));
    return 0;
  }
  if (command === 'review') return review(flags);
  if (command === 'check') return check(flags);
  console.error(`Unknown command "${command}".\n\n${usage(rulings)}`);
  return 2;
}

// Run as a command (directly or through bin/factory.mjs); imported, it only exports its helpers.
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) runMain(main, 'council');
