#!/usr/bin/env node
// Stand-in for the real agent CLIs (claude, codex, copilot) in the council tests: `fake-cli.mjs <cli> <args...>`,
// started through a wrapper named after the CLI on PATH, so the factory builds each CLI's real invocation and parses
// each CLI's real output format. Answers come from FAKE_CLI_SCRIPT (JSON: { "<member>": [result, result, ...] }, the
// member from PIPELINE_COUNCIL_MEMBER, the last answer repeating); a result `{ "exit": n, "text": "..." }` fails the
// run instead. Every call is logged to FAKE_CLI_SCRIPT.calls.jsonl (cli, member, argv, prompt).
import fs from 'node:fs';
import path from 'node:path';

const [cli, ...argv] = process.argv.slice(2);
const scriptFile = process.env.FAKE_CLI_SCRIPT;
if (!scriptFile) process.exit(0);
const member = process.env.PIPELINE_COUNCIL_MEMBER ?? process.env.PIPELINE_AGENT_NAME ?? '';
const arg = (flag) => {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : null;
};
let prompt;
if (cli === 'copilot') {
  const p = arg('-p') ?? '';
  const file = /Read the file (\S+) and follow/.exec(p)?.[1];
  prompt = file ? fs.readFileSync(path.resolve(process.cwd(), file), 'utf8') : p;
} else {
  prompt = fs.readFileSync(0, 'utf8');
}
// The harness's follow-up question for a missing `resolves` is answered outside the member's scripted steps (see
// resolves-question.mjs) and not logged as a call.
if (/Your result was rejected: \d+ finding\(s\) have no `resolves` field/.test(prompt)) {
  const text = 'AGENT_RESULT: {"resolves": {}}\n';
  if (cli === 'claude') process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', result: text, modelUsage: {} }));
  else if (cli === 'codex') {
    fs.writeFileSync(arg('--output-last-message'), text);
    process.stdout.write(`${JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } })}\n`);
  } else process.stdout.write(text);
  process.exit(0);
}
const log = `${scriptFile}.calls.jsonl`;
const counts = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
const n = counts.filter((c) => c.member === member && c.agent === process.env.PIPELINE_AGENT_NAME).length;
fs.appendFileSync(log, `${JSON.stringify({ cli, member, agent: process.env.PIPELINE_AGENT_NAME, argv, prompt, env: { effort: process.env.PIPELINE_AGENT_EFFORT ?? null, CODEX_HOME: process.env.CODEX_HOME ?? null } })}\n`);
const script = JSON.parse(fs.readFileSync(scriptFile, 'utf8'));
const steps = script[member] ?? script['*'] ?? [];
const step = steps[Math.min(n, steps.length - 1)] ?? {};
if (step.delayMs) await new Promise((r) => setTimeout(r, step.delayMs));
if (step.exit) {
  process.stdout.write(step.text ?? '');
  process.stderr.write(step.stderr ?? '');
  process.exit(step.exit);
}
const text = `Reviewed.\nAGENT_RESULT: ${JSON.stringify(step.result ?? step)}\n`;
if (cli === 'claude') {
  process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', result: text, modelUsage: {} }));
} else if (cli === 'codex') {
  fs.writeFileSync(arg('--output-last-message'), text);
  process.stdout.write(`${JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5 } })}\n`);
} else {
  process.stdout.write(text);
}
