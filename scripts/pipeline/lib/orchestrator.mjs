// Every stage is led by an orchestrator (GEN-10): one agent run where judgement about who does the stage's producing
// work is exercised, with a written reason in the decision log. The implement stage's orchestrator is the implementer
// agent (it implements the ticket itself or plans subtasks: implement/lib/orchestrate.mjs); the test plan, test
// automation, architecture review and PR check stages ask the `stage-orchestrator` agent here. Whatever it decides, it
// never verifies its own work: the stage's council does. Its runs are agent runs like any other (usage, budgets).
import { agentDefinition } from './agents.mjs';
import { GUIDANCE_SHAPE, guidanceAsk, normalizeGuidance } from './clean-code.mjs';
import { searchCalls } from './search-calls.mjs';
import { logDecision } from './decisions.mjs';
import { entryFor, orchestratorSettings } from './pool.mjs';
import { extractResult } from './util.mjs';

export const ORCHESTRATOR_AGENT = 'stage-orchestrator';

// A stage's orchestrator: its pool entry (name, family) and effort.
export function orchestratorOf(config, section) {
  const s = orchestratorSettings(config, section);
  const e = entryFor(config, { name: ORCHESTRATOR_AGENT, entry: s.model });
  return { entry: e.name, family: e.family, effort: s.effort ?? e.effort ?? null };
}

// The run options of a stage's orchestrator (a decision, a ruling on a discussion split).
export function orchestratorRun(config, section) {
  const o = orchestratorOf(config, section);
  return { name: ORCHESTRATOR_AGENT, entry: o.entry, effort: o.effort };
}

// The task of the decision: what the stage produces, who it would delegate to, the choices it may make. `guidance`: the
// work goes to a writer (code or tests), so the orchestrator also searches the codebase and says where the change goes
// and what to reuse (clean-code.mjs); the writer's task carries it.
export function decisionTask({ stage, work, delegateTo, choices, context, guidance = false }) {
  const named = choices.map((c) => `\`${c}\``).join(', ');
  return [
    `# Decide who does the ${stage} work`,
    '',
    `Stage: ${stage}. The work: ${work}. Delegating hands it to ${delegateTo}.`,
    `Decide one of ${named}; do not change any file now.`,
    '',
    context,
    ...(guidance ? ['', '## Guidance for the writer', '', guidanceAsk()] : []),
    '',
    `End with: AGENT_RESULT: {"decision": ${choices.map((c) => `"${c}"`).join(' | ')}, "reason": "<one or two sentences>"${guidance ? `, ${GUIDANCE_SHAPE}` : ''}}`,
  ].join('\n');
}

// A guidance-only ask: who does the stage's work is decided (kept from an earlier handoff), and this handoff's work (other
// findings, other helpers) needs guidance of its own.
export function guidanceTask({ stage, work, context }) {
  return [
    `# Guide the writer of the ${stage} work`,
    '',
    `Stage: ${stage}. The work: ${work}. Who does it is decided; do not change any file now.`,
    '',
    context,
    '',
    '## Guidance for the writer',
    '',
    guidanceAsk(),
    '',
    `End with: AGENT_RESULT: {${GUIDANCE_SHAPE}}`,
  ].join('\n');
}

// One run of the stage's orchestrator on `task` (read-only, its own entry and effort), and what it answered. `run` is the
// stage's agent runner (runAgent or runAgentAsync semantics: it may return a promise); a run that throws answers nothing.
async function askOrchestrator(config, { section, story, task, run, usage, step }) {
  const o = orchestratorOf(config, section);
  const started = Date.now();
  let res;
  try {
    res = await run({ name: ORCHESTRATOR_AGENT, mode: 'read', entry: o.entry, effort: o.effort, task, usage: { stage: `${section}-orchestrator`, story, step, ...usage } });
  } catch (error) {
    res = { ok: false, output: '', error: error.message };
  }
  return { o, res, raw: extractResult(res?.output ?? '') ?? {}, started };
}

// An orchestrator's answer in the decision log, with its entry and the guidance and searches it gave.
const recordAnswer = (config, { section, story, o, res, decision, reason, given }) =>
  logDecision(config, { stage: `${section}-orchestrator`, story, round: null, agent: ORCHESTRATOR_AGENT, agentVer: res?.version ?? null, subject: section, decision, reason, entry: o.entry, family: o.family, effort: o.effort, ...given });

// The guidance an orchestrator wrote for the writer when asked, and the searches it made in `cwd` (the checkout) since
// `started` to find what the guidance names.
const guidanceGiven = (config, raw, { guidance, cwd, started }) => (guidance ? { guidance: normalizeGuidance(raw.guidance), searches: searchCalls(cwd ?? config.root, { agent: ORCHESTRATOR_AGENT, from: started }).length } : {});

// Asks the stage's orchestrator to decide. An unreadable answer delegates (the stage's usual path), and says so. Returns
// { decision, reason, entry, family, effort, version, guidance } (`guidance` only when asked for: a list, maybe empty).
// `cwd` is the checkout the orchestrator searches (its graphify and language-server calls are counted there).
export async function decide(config, { section, stage = section, story = null, work, delegateTo, choices = ['self', 'delegate'], context = '', run, usage = {}, guidance, cwd }) {
  const { o, res, raw, started } = await askOrchestrator(config, { section, story, task: decisionTask({ stage, work, delegateTo, choices, context, guidance }), run, usage, step: 'decide' });
  const fallback = choices.includes('delegate') ? 'delegate' : choices.at(-1);
  const decision = choices.includes(raw.decision) ? raw.decision : fallback;
  const reason = String(raw.reason ?? '').trim() || `the orchestrator gave no readable decision${res?.error ? ` (${res.error})` : ''}: the stage goes on as usual`;
  const given = guidanceGiven(config, raw, { guidance, cwd, started });
  recordAnswer(config, { section, story, o, res, decision, reason, given });
  return { decision, reason, ...o, version: res?.version ?? null, ...given };
}

// Asks the stage's orchestrator for the guidance of one handoff when its decision of who works is kept from an earlier
// one (a later fix targets other findings and other helpers). Logged as decision `guided`. Returns { guidance, searches }.
export async function guide(config, { section, stage = section, story = null, work, context = '', run, usage = {}, cwd }) {
  const { o, res, raw, started } = await askOrchestrator(config, { section, story, task: guidanceTask({ stage, work, context }), run, usage, step: 'guide' });
  const given = guidanceGiven(config, raw, { guidance: true, cwd, started });
  recordAnswer(config, { section, story, o, res, decision: 'guided', reason: `guidance for a later handoff: ${given.guidance.length} item(s)`, given });
  return given;
}

// The task the orchestrator does the work with when it keeps it: the stage agent's own instructions, then that agent's
// task. The orchestrator runs it as itself, on its own entry and effort; the stage's agent is not started.
export function selfWorkTask(config, agent, task) {
  const def = agentDefinition(config, agent);
  return [`# You are doing the ${agent} work yourself`, '', `Follow these instructions (the ${agent} agent's) exactly, with their output contract:`, '', def.body.trim(), '', '---', '', task].join('\n');
}

// The run options for the producing work: the stage's own agent, or the orchestrator doing it itself. `work` is the
// agent whose work it is (PIPELINE_AGENT_WORK): the guards and protections that hold for that agent hold for the
// orchestrator doing its work too (the PR check fixer's test guard, the protected files).
export function producerRun(config, { agent, task, selfDo = null }) {
  if (!selfDo) return { name: agent, task, work: agent };
  return { name: ORCHESTRATOR_AGENT, task: selfWorkTask(config, agent, task), entry: selfDo.entry, effort: selfDo.effort, work: agent };
}
