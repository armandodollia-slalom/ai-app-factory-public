// Every stage is led by an orchestrator (GEN-10): one agent run where judgement about who does the stage's producing
// work is exercised, with a written reason in the decision log. The implement stage's orchestrator is the implementer
// agent (it implements the ticket itself or plans subtasks: implement/lib/orchestrate.mjs); the test plan, test
// automation, architecture review and PR check stages ask the `stage-orchestrator` agent here. Whatever it decides, it
// never verifies its own work: the stage's council does. Its runs are agent runs like any other (usage, budgets).
import { agentDefinition } from './agents.mjs';
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

// The task of the decision: what the stage produces, who it would delegate to, the choices it may make.
export function decisionTask({ stage, work, delegateTo, choices, context }) {
  const named = choices.map((c) => `\`${c}\``).join(', ');
  return [
    `# Decide who does the ${stage} work`,
    '',
    `Stage: ${stage}. The work: ${work}. Delegating hands it to ${delegateTo}.`,
    `Decide one of ${named}; do not change any file now.`,
    '',
    context,
    '',
    `End with: AGENT_RESULT: {"decision": ${choices.map((c) => `"${c}"`).join(' | ')}, "reason": "<one or two sentences>"}`,
  ].join('\n');
}

// Asks the stage's orchestrator to decide. `run` is the stage's agent runner (runAgent or runAgentAsync semantics: it
// may return a promise). An unreadable answer delegates (the stage's usual path), and says so. Returns
// { decision, reason, entry, family, effort, version }.
export async function decide(config, { section, stage = section, story = null, work, delegateTo, choices = ['self', 'delegate'], context = '', run, usage = {} }) {
  const o = orchestratorOf(config, section);
  const task = decisionTask({ stage, work, delegateTo, choices, context });
  let res;
  try {
    res = await run({ name: ORCHESTRATOR_AGENT, mode: 'read', entry: o.entry, effort: o.effort, task, usage: { stage: `${section}-orchestrator`, story, step: 'decide', ...usage } });
  } catch (error) {
    res = { ok: false, output: '', error: error.message };
  }
  const raw = extractResult(res?.output ?? '') ?? {};
  const fallback = choices.includes('delegate') ? 'delegate' : choices.at(-1);
  const decision = choices.includes(raw.decision) ? raw.decision : fallback;
  const reason = String(raw.reason ?? '').trim() || `the orchestrator gave no readable decision${res?.error ? ` (${res.error})` : ''}: the stage goes on as usual`;
  logDecision(config, {
    stage: `${section}-orchestrator`,
    story,
    round: null,
    agent: ORCHESTRATOR_AGENT,
    agentVer: res?.version ?? null,
    subject: section,
    decision,
    reason,
    entry: o.entry,
    family: o.family,
    effort: o.effort,
  });
  return { decision, reason, ...o, version: res?.version ?? null };
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
