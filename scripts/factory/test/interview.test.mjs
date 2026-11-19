// The setup interview (scripts/factory/lib/interview.mjs and `factory init`): every stage asked, detected values shown as
// defaults, the same result typed or from an answers file, a re-run that edits instead of overwriting, and no secret ever
// taken as an answer.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { changes, interview, QUESTIONS, readAnswers, variableName } from '../lib/interview.mjs';

const INSTALL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const FACTORY = path.join(INSTALL, 'bin/factory.mjs');

// A scripted person: answers by question id, Enter (the default) for the rest; records what was asked and shown.
function person(answers = {}) {
  const seen = [];
  return {
    seen,
    ask: async (q, def) => {
      seen.push({ id: q.id, section: q.section, def, ask: q.ask });
      return Object.hasOwn(answers, q.id) ? answers[q.id] : '';
    },
  };
}

test('every stage is asked: code host, ticket board, CI, merging and reviews, agents, UI verification, metrics, static analysis, the client\'s scanner', async () => {
  const p = person({ 'tracker.type': 'jira', 'scanner.id': 'sonarqube', 'metrics.sink': 'http', 'analysis.enabled': 'yes', 'agents.local': 'claude, codex', 'council.seat': 'yes' });
  await interview({ detected: { host: { type: 'bitbucket', url: 'https://bitbucket.org', repo: 'acme/shop' } }, ask: p.ask });
  const sections = new Set(p.seen.map((s) => s.section));
  for (const s of ['Code host', 'Ticket board', 'CI system', 'Merging and reviews', 'Agents', 'UI verification', 'Observability', 'Static analysis', 'Commercial scanner']) assert.ok(sections.has(s), s);
  // Detected values are shown to confirm, never assumed silently.
  assert.equal(p.seen.find((s) => s.id === 'host.type').def, 'bitbucket');
  assert.equal(p.seen.find((s) => s.id === 'host.repo').def, 'acme/shop');
  assert.equal(p.seen.find((s) => s.id === 'ci.provider').def, 'bitbucket-pipelines', 'the host\'s own CI is the default');
  for (const lane of ['backlog', 'ready', 'inProgress', 'testing', 'review', 'failed', 'done']) assert.ok(p.seen.some((s) => s.id === `tracker.lanes.${lane}`), lane);
});

test('Jira + Bitbucket + Jenkins: the answers become .factory/config.json with ${NAME} references only', async () => {
  const p = person({
    'host.type': 'bitbucket', 'host.repo': 'acme/shop', 'host.token': 'BITBUCKET_TOKEN',
    'tracker.type': 'jira', 'tracker.url': 'https://acme.atlassian.net', 'tracker.project': 'SHOP', 'tracker.board': '12', 'tracker.lanes.review': 'In Review', 'tracker.user': 'JIRA_EMAIL', 'tracker.token': 'JIRA_API_TOKEN',
    'ci.provider': 'jenkins', 'ci.url': 'https://ci.acme.io', 'ci.job': 'team/shop', 'ci.user': 'JENKINS_USER', 'ci.token': 'JENKINS_API_TOKEN',
    'review.owners': '@acme/platform', 'agents.local': 'claude, codex', 'agents.models.claude': 'opus', 'agents.models.codex': 'sol', 'council.seat': 'yes',
    'scanner.id': 'snyk-code', 'scanner.mode': 'server', 'scanner.token': 'SNYK_TOKEN', 'scanner.acceptedBy': 'Dana Lee (client CISO), 2026-11-17',
  });
  const r = await interview({ ask: p.ask, pin: { tools: ['claude'] } });
  const c = r.config;
  assert.deepEqual([c.host.type, c.host.repo, c.host.token], ['bitbucket', 'acme/shop', '${BITBUCKET_TOKEN}']);
  assert.deepEqual([c.tracker.type, c.tracker.url, c.tracker.project, c.tracker.board.id, c.tracker.lanes.review], ['jira', 'https://acme.atlassian.net', 'SHOP', '12', 'In Review']);
  assert.deepEqual(c.tracker.auth, { user: '${JIRA_EMAIL}', token: '${JIRA_API_TOKEN}' });
  assert.deepEqual(c.ci, { provider: 'jenkins', url: 'https://ci.acme.io', job: 'team/shop', user: '${JENKINS_USER}', token: '${JENKINS_API_TOKEN}' });
  assert.deepEqual(c.council.members.map((m) => [m.cli, m.model]), [['claude', 'opus'], ['codex', 'sol']], 'the council is seated from what is really available');
  assert.deepEqual(c.analysis.commercial, { scanner: 'snyk-code', mode: 'server', replaces: [], token: '${SNYK_TOKEN}', check: 'code/snyk' }, 'server mode: the check that binds the result to a head, proposed from the definition');
  assert.equal(c.analysis.acceptLicence[0].by, 'Dana Lee (client CISO), 2026-11-17');
  assert.deepEqual(r.pin.owners, ['@acme/platform']);
  assert.deepEqual(r.pin.tools, ['claude', 'codex']);
  // Nothing secret anywhere: every credential is a reference.
  const text = JSON.stringify(c);
  for (const m of text.matchAll(/"(token|user)":"([^"]*)"/g)) assert.match(m[2], /^\$\{[A-Z_]+\}$/, m[0]);
});

test('a token value is refused where a variable name is asked; the person is asked again', async () => {
  assert.throws(() => variableName('ghp_abcdefghijklmnopqrstuvwxyz0123456789'), /not an environment variable name/);
  assert.equal(variableName('${GITLAB_TOKEN}'), 'GITLAB_TOKEN');
  let n = 0;
  const ask = async (q) => (q.id === 'host.token' ? (n++ === 0 ? 'glpat-xxxxxxxxxxxxxxxxxxxx' : 'GITLAB_TOKEN') : q.id === 'host.type' ? 'gitlab' : '');
  const r = await interview({ ask });
  assert.equal(r.config.host.token, '${GITLAB_TOKEN}');
  assert.equal(n, 2, 'asked again after the refusal');
  await assert.rejects(interview({ answers: { 'host.type': 'gitlab', 'host.token': 'glpat-secretvalue123' } }), /not an environment variable name/, 'an answers file with a value fails');
});

test('headless: an answers file gives the same config as the same answers typed', async () => {
  const answers = { 'host.type': 'gitlab', 'host.repo': 'grp/shop', 'tracker.type': 'gitlab', 'ci.provider': 'gitlab-ci', 'agents.local': 'claude', 'analysis.enabled': true };
  const typed = await interview({ ask: person(answers).ask });
  const file = await interview({ answers: readAnswers(JSON.stringify({ answers }), []) });
  assert.deepEqual(file.config, typed.config);
  assert.equal(file.asked.find((a) => a.id === 'host.type').source, 'given');
  assert.ok(file.asked.some((a) => a.source === 'default'), 'what was not given is the default shown, recorded as such');
  assert.deepEqual(readAnswers('{"host.type":"gitlab"}', ['tracker.type=linear']), { 'host.type': 'gitlab', 'tracker.type': 'linear' });
  await assert.rejects(interview({ answers: { 'tracker.kind': 'jira' } }), /unknown answer id/);
  await assert.rejects(interview({ answers: { 'tracker.type': 'trello' } }), /not one of/);
});

test('a re-run edits the existing config: unrelated settings stay, defaults are what is set now', async () => {
  const existing = { project: { languages: ['go'] }, implement: { checks: [{ name: 'build', cmd: 'go build ./...' }] }, host: { type: 'github', repo: 'acme/shop' }, board: { owner: 'acme', repo: 'acme/shop', projectNumber: 7 }, tickets: { repo: 'acme/shop' } };
  const p = person({ 'metrics.sink': 'directory', 'metrics.target': '~/factory-metrics' });
  const r = await interview({ config: existing, ask: p.ask });
  assert.equal(p.seen.find((s) => s.id === 'tracker.type').def, 'github', 'the legacy GitHub board is the default');
  assert.equal(p.seen.find((s) => s.id === 'tracker.board').def, '7');
  assert.deepEqual(r.config.implement.checks, existing.implement.checks);
  assert.deepEqual(r.config.project, existing.project);
  assert.equal(r.config.metrics.sink.path, '~/factory-metrics');
  const diff = changes(existing, r.config).map((d) => d.path);
  assert.ok(diff.includes('metrics.sink.type') && diff.includes('metrics.sink.path') && !diff.some((d) => d.startsWith('implement.checks') || d.startsWith('project')), diff.join(', '));
  assert.equal(QUESTIONS.length, new Set(QUESTIONS.map((x) => x.id)).size, 'question ids are unique');
});

test('factory init --answers --dry-run prints what it would write and writes nothing; without it the config is written and edited on a re-run', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'interview-')));
  spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  spawnSync('git', ['remote', 'add', 'origin', 'https://gitlab.com/grp/shop.git'], { cwd: root });
  fs.writeFileSync(path.join(root, 'go.mod'), 'module shop\n');
  const answers = path.join(root, 'answers.json');
  fs.writeFileSync(answers, JSON.stringify({ 'tracker.type': 'linear', 'tracker.project': 'SHOP', 'tracker.token': 'LINEAR_API_KEY', 'agents.local': 'claude' }));
  const init = (...args) => spawnSync(process.execPath, [FACTORY, 'init', ...args], { cwd: root, encoding: 'utf8', env: { ...process.env, PIPELINE_DISABLE: '1' } });
  const dry = init('--answers', answers, '--dry-run');
  assert.equal(dry.status, 0, dry.stderr);
  const plan = JSON.parse(dry.stdout);
  assert.ok(plan.config.some((d) => d.path === 'tracker.type' && d.after === 'linear'));
  assert.ok(plan.config.some((d) => d.path === 'host.type' && d.after === 'gitlab'), 'detected from the origin remote');
  assert.equal(fs.existsSync(path.join(root, '.factory/config.json')), false, 'a dry run writes nothing');
  const real = init('--answers', answers);
  assert.equal(real.status, 0, real.stderr);
  const config = JSON.parse(fs.readFileSync(path.join(root, '.factory/config.json'), 'utf8'));
  assert.deepEqual([config.host.type, config.tracker.type, config.tracker.auth.token, config.ci.provider], ['gitlab', 'linear', '${LINEAR_API_KEY}', 'gitlab-ci']);
  // A person adds a setting by hand; a re-run that changes the CI keeps it.
  config.implement = { ...(config.implement ?? {}), maxRounds: 4 };
  fs.writeFileSync(path.join(root, '.factory/config.json'), JSON.stringify(config));
  const again = init('--set', 'metrics.sink=directory', '--set', 'metrics.target=/tmp/m');
  assert.equal(again.status, 0, again.stderr);
  const after = JSON.parse(fs.readFileSync(path.join(root, '.factory/config.json'), 'utf8'));
  assert.equal(after.implement.maxRounds, 4);
  assert.equal(after.tracker.type, 'linear', 'the earlier answer is now the default');
  assert.equal(after.metrics.sink.path, '/tmp/m');
  const recorded = JSON.parse(fs.readFileSync(path.join(root, '.factory/interview.json'), 'utf8'));
  assert.ok(recorded.answers.some((a) => a.id === 'metrics.sink' && a.source === 'given'));
  assert.doesNotMatch(JSON.stringify(recorded), /lin_api_|glpat-|ghp_/);
  const listed = init('--questions');
  assert.match(listed.stdout, /^tracker\.type\s+\[github\|jira\|azure-boards\|gitlab\|linear\|custom\]/m);
  fs.rmSync(root, { recursive: true, force: true });
});
