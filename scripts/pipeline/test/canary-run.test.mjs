// Proof of the redaction boundary (owner requirement, dogfood C23): a fixture run seeded with canary secrets (in the
// config, in an agent's output, in a tool finding, in an environment variable) writes and posts through the real
// writers, gates and adapters; no canary appears in anything committed, posted or exported. Then the factory's own secret
// scan (the pinned betterleaks, when this machine has it) and the generic `(api-key|secret|token|password)[:=]<value>`
// pattern run over a fixture of everything the run committed and posted: both find nothing.
//
// The canaries are made at run time from random bytes, so no credential-looking literal is in this file.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { appendJsonl, log, writeJson } from '../lib/util.mjs';
import { GENERIC_KEY_PATTERN, SecretGateError, installOutputRedaction, forgetSecretsForTest, gate, genericHits, redact, registerConfigSecrets, writeText } from '../lib/redact.mjs';
import { gatePushedRecords, gateStagedRecords } from '../lib/record-gate.mjs';
import { parseGitleaksJson } from '../lib/analysis/parsers.mjs';
import { canonicalFindingId, findingId, identify } from '../lib/analysis/baseline.mjs';
import { createAdapter } from '../lib/hosts/index.mjs';
import { trackerFor } from '../../board/lib/trackers/index.mjs';
import { sinkAdapter } from '../lib/sink.mjs';
import { buildPrompt } from '../lib/agents.mjs';
import { machineCache } from '../lib/analysis/runner.mjs';

const alnum = (n) => {
  const abc = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  return [...crypto.randomBytes(n)].map((b) => abc[b % abc.length]).join('');
};
const mixed = (n) => {
  let v = alnum(n);
  while (!/[0-9]/.test(v) || !/[A-Za-z]/.test(v)) v = alnum(n);
  return v;
};

test('canary run: nothing seeded as a secret reaches a record, a post, a log or the sink', async (t) => {
  forgetSecretsForTest();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canary-run-'));
  const g = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'pipe' }).toString().trim();
  g('init', '-q');
  g('config', 'user.email', 'test@example.invalid');
  g('config', 'user.name', 't');
  const env = { cfg: mixed(32), agent: mixed(40), tool: mixed(28), envVar: mixed(36), rule: `ghp_${alnum(36)}` };
  const canaries = Object.values(env);
  const prevEnv = process.env.FACTORY_CANARY_TOKEN;
  process.env.FACTORY_CANARY_TOKEN = env.envVar;
  process.env.FACTORY_REDACT_SEEN = path.join(dir, '.factory', 'state', 'redact-seen.jsonl');
  t.after(() => {
    if (prevEnv === undefined) delete process.env.FACTORY_CANARY_TOKEN;
    else process.env.FACTORY_CANARY_TOKEN = prevEnv;
    delete process.env.FACTORY_REDACT_SEEN;
    forgetSecretsForTest();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // 1. config: a token written into the config under a credential-named setting.
  registerConfigSecrets({ metrics: { sink: { type: 'http', apiKey: env.cfg } } });
  // 2. a tool finding: the scanner's report carries the matched value; the parser keeps rule, file, line, fingerprint.
  const parsed = parseGitleaksJson(JSON.stringify([{ RuleID: 'generic-api-key', Description: 'Generic API Key', File: 'src/a.env', StartLine: 3, Secret: env.tool }]));
  const findings = identify(dir, 'betterleaks', parsed);
  assert.ok(!JSON.stringify(findings).includes(env.tool), 'the parser drops the matched text');
  assert.match(findings[0].id, /^tool:fp-[0-9a-f]+:generic-api-key$/, 'the fingerprint comes first, prefixed');
  // 3. an agent's output, quoting the config value, the tool's value bare, a rule-shaped token and the env value.
  const agentOutput = `Done. I found apiKey=${env.agent} in appsettings; the old value ${env.tool} is gone; the config sets ${env.cfg}; CI used ${env.envVar}; a token ${env.rule} was in the log.`;

  // What a run commits: metrics shards, run records, decisions, reports, lessons, the PR body record.
  const metrics = path.join(dir, '.factory', 'metrics');
  appendJsonl(path.join(metrics, 'analysis-findings.jsonl.d', 'feat__x-1.jsonl'), findings.map((f) => ({ story: 'X-1', ...f, source: 'tool:betterleaks' })));
  appendJsonl(path.join(metrics, 'decisions.jsonl.d', 'feat__x-1.jsonl'), [{ story: 'X-1', stage: 'implement', reason: agentOutput }]);
  appendJsonl(path.join(metrics, 'token-usage.jsonl.d', 'feat__x-1.jsonl'), [{ story: 'X-1', stage: 'implement', tokens: 123456789, cost_usd: 1.25, session: 'f3a9c1d2-4b5e-4f60-8a71-92b3c4d5e6f7' }]);
  writeJson(path.join(dir, '.factory', 'state', 'implement', 'X-1.json'), { key: 'X-1', reason: agentOutput, findings: [agentOutput] });
  fs.mkdirSync(path.join(dir, '.factory', 'lessons'), { recursive: true });
  writeText(path.join(dir, '.factory', 'lessons', 'implementer.md'), `# Lessons\n\n- ${agentOutput}\n`);
  // A record written around the writers (raw fs) still meets the commit gate.
  fs.mkdirSync(path.join(metrics, 'pr-checks.jsonl.d'), { recursive: true });
  fs.writeFileSync(path.join(metrics, 'pr-checks.jsonl.d', 'feat__x-1.jsonl'), `${JSON.stringify({ story: 'X-1', upheld: [{ id: 'F-1', title: agentOutput }] })}\n`);
  g('add', '-A');
  gateStagedRecords(dir);
  g('commit', '-qm', 'X-1: records');

  // What a run logs.
  // log() redacts its line; any other console output of a harness process passes the wrapper util.mjs installs.
  const stderr = [];
  const write = process.stderr.write;
  process.stderr.write = (chunk) => (stderr.push(String(chunk)), true);
  try {
    log('implementer said:', agentOutput);
  } finally {
    process.stderr.write = write;
  }
  const proc = { stdout: { write: (c) => (stderr.push(String(c)), true) }, stderr: { write: (c) => (stderr.push(String(c)), true) } };
  installOutputRedaction(proc);
  proc.stderr.write(`raw console: ${agentOutput}\n`);
  proc.stdout.write(`implement run: ${agentOutput}\n`);

  // What a run posts: the PR body and a comment (host), the ticket and its comment (tracker), the sink export.
  const posted = [];
  const fakeGh = (args, opts = {}) => {
    posted.push(JSON.stringify(args), String(opts.input ?? ''));
    return { status: 0, stdout: args.includes('create') ? 'https://github.com/o/r/pull/7\n' : '{}', stderr: '' };
  };
  const host = createAdapter({ type: 'github', repo: 'o/r' }, { gh: fakeGh });
  try {
    host.pr.open({ head: 'feat/x-1', base: 'main', title: 'X-1: thing', body: `## Summary\n\n${agentOutput}` });
  } catch {
    // the fake returns little; what was sent is what counts
  }
  try {
    host.pr.comment(7, `Gate notice. ${agentOutput}`);
  } catch {
    // as above
  }
  const tracker = trackerFor({ root: dir, tracker: { type: 'github', repo: 'o/r' } }, { gh: fakeGh });
  for (const call of [() => tracker.tickets.create({ title: 'X-2: follow-up', body: agentOutput, addToBoard: false }), () => tracker.tickets.comment(5, `Evidence: ${agentOutput}`)]) {
    try {
      call();
    } catch {
      // as above
    }
  }
  const sinkDir = path.join(dir, 'sink');
  const sink = sinkAdapter({ root: dir, metricsDir: '.factory/metrics', stateDir: '.factory/state', metrics: { sink: { type: 'directory', path: sinkDir } } });
  await sink.push('decisions.jsonl', [{ story: 'X-1', reason: agentOutput }]);

  // Agents are told.
  assert.match(buildPrompt({ body: 'agent' }, 'task'), /Never write a key, token, password or connection string/);

  // Nothing seeded appears anywhere.
  const files = execFileSync('find', [dir, '-type', 'f', '-not', '-path', '*/.git/*', '-not', '-name', 'redact-seen.jsonl'], { stdio: 'pipe' }).toString().trim().split('\n');
  const committed = g('log', '-p', '--all');
  const everything = [...files.map((f) => fs.readFileSync(f, 'utf8')), committed, ...stderr, ...posted].join('\n');
  assert.ok(posted.length > 0 && stderr.length > 0, 'the run posted and logged');
  const parts = { ...Object.fromEntries(files.map((f) => [path.relative(dir, f), fs.readFileSync(f, 'utf8')])), committed, stderr: stderr.join(''), posted: posted.join('\n') };
  for (const [where, c] of Object.entries(env)) assert.ok(!everything.includes(c), `the ${where} canary leaked into ${Object.entries(parts).filter(([, v]) => v.includes(c)).map(([k]) => k).join(', ')}`);
  assert.match(everything, /\[redacted:/);
  assert.deepEqual(genericHits(everything), [], 'the generic key pattern finds nothing');
  assert.ok(!/\b(?:api[_-]?key|secret|token|password)[:=][0-9a-f]{8,}/i.test(everything), 'no credential word directly before a hex string');
  // The seen registry holds hashes only.
  assert.ok(!canaries.some((c) => fs.readFileSync(process.env.FACTORY_REDACT_SEEN, 'utf8').includes(c)));

  // The push gate blocks a record that would leave with a credential shape.
  fs.writeFileSync(path.join(metrics, 'late.jsonl'), `{"note":"token=${mixed(24)}"}\n`);
  g('add', '-A');
  g('-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'raw');
  assert.throws(() => gatePushedRecords(dir, 'HEAD~1'), SecretGateError);
  assert.match(gate(`api-key:${mixed(20)}`, 'test', { env: {} }), /^api-key:\[redacted:generic-api-key\]$/, 'the gate sends the redacted text');

  // The factory's own scan over everything committed and posted: the pinned betterleaks, when installed here.
  const bin = path.join(machineCache(), 'tools', `betterleaks-1.10.1-${process.platform}-${process.arch}`, process.platform === 'win32' ? 'betterleaks.exe' : 'betterleaks');
  if (fs.existsSync(bin)) {
    const fixture = path.join(dir, 'scan-fixture');
    fs.mkdirSync(fixture);
    fs.writeFileSync(path.join(fixture, 'committed-and-posted.txt'), [committed, ...posted, ...stderr].join('\n'));
    const report = path.join(dir, 'scan.json');
    const r = spawnSync(bin, ['dir', '--no-banner', '--redact', '-f', 'json', '-r', report, fixture], { encoding: 'utf8' });
    assert.ok([0, 1].includes(r.status), `betterleaks ran (${r.status})`);
    const leaks = JSON.parse(fs.readFileSync(report, 'utf8'));
    assert.deepEqual(leaks.map((f) => `${f.RuleID} line ${f.StartLine}: ${String(f.Match).slice(0, 80)}`), [], 'the pinned secret scanner finds nothing');
  } else t.diagnostic(`betterleaks not installed at ${bin}: the scanner part was not run`);
});

test('finding ids: no credential word before the fingerprint; ids from earlier runs still match', () => {
  const fp = '0123456789abcdef';
  assert.equal(findingId('generic-api-key', fp), `tool:fp-${fp}:generic-api-key`);
  assert.equal(canonicalFindingId(`tool:generic-api-key:${fp}`), `tool:fp-${fp}:generic-api-key`, 'a pre-0.2.85 id reads as the new one');
  assert.equal(canonicalFindingId(`tool:generic-api-key:${fp}~2`), `tool:fp-${fp}~2:generic-api-key`);
  assert.equal(canonicalFindingId(`tool:fp-${fp}:generic-api-key`), `tool:fp-${fp}:generic-api-key`);
  GENERIC_KEY_PATTERN.lastIndex = 0;
  assert.equal(GENERIC_KEY_PATTERN.test(findingId('generic-api-key', fp)), false);
  // The boundary leaves what the pipeline computes from records alone: fingerprints, SHAs, counts, ticket keys, paths.
  const rec = `{"fingerprint":"${fp}","sha":"9f1fa7b5f3c79f1fa7b5f3c79f1fa7b5f3c79f1f","tokens":12345678,"key":"SURP-1","keyframe":"/a/b1-x.png","id":"tool:fp-${fp}:generic-api-key"}`;
  assert.equal(redact(rec, { env: {} }), rec);
});
