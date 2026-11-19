// Agent prompts never contradict the factory guard (council A3): no assembled prompt tells an agent to edit a
// path the guard denies it, and topology is never placed in .factory/config.json.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { agentDefinition, buildPrompt } from '../lib/agents.mjs';
import { loadConfig } from '../lib/config.mjs';
import { agentTextProblems, promptProblems, textProblems } from '../lib/instruction-check.mjs';
import { parse } from 'yaml';

const INSTALL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const FACTORY = path.join(INSTALL, 'bin/factory.mjs');

function onboarded() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'prompts-')));
  spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  fs.mkdirSync(path.join(root, 'src/Api'), { recursive: true });
  fs.writeFileSync(path.join(root, 'App.sln'), '');
  fs.writeFileSync(path.join(root, 'src/Api/Api.csproj'), '<Project Sdk="Microsoft.NET.Sdk.Web" />\n');
  const r = spawnSync(process.execPath, [FACTORY, 'init', '--tools', 'claude'], { cwd: root, encoding: 'utf8', env: { ...process.env, PIPELINE_ROOT: '' } });
  assert.equal(r.status, 0, r.stderr);
  return root;
}

test('textProblems: topology in config.json and edits of guarded paths are flagged; negations and app.json are not', () => {
  assert.equal(textProblems('Register its `stack.services` and `teststack.services` in `.factory/config.json`.').length, 1);
  assert.equal(textProblems('Add the rule to `.factory/policy/rules/api.yaml`.').length, 1);
  assert.deepEqual(textProblems('Register its `stack.services` and `teststack.services` in `.factory/app.json`.'), []);
  assert.deepEqual(textProblems('Never edit `.factory/config.json`; report what should change.'), []);
  assert.deepEqual(textProblems('Models are configured in `.factory/config.json`.'), [], 'naming the file is not an instruction');
});

test("no assembled prompt of any agent tells it to edit a path the factory guard denies it", () => {
  const root = onboarded();
  const config = loadConfig('implement', root);
  assert.deepEqual(promptProblems(config), [], 'the base definitions, rendered for a fresh repository');
  // The final prompt (definition + lessons + task) of the agents that change or review application code.
  for (const name of ['implementer', 'pair-implementer', 'architecture-reviewer', 'test-automation']) {
    const prompt = buildPrompt(agentDefinition(config, name), 'Implement SHOP-1: add a reviews service.');
    assert.deepEqual(textProblems(prompt), [], name);
  }
  // The instructions every tool reads (AGENTS.md, CLAUDE.md) name app.json for topology.
  assert.match(fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8'), /\.factory\/app\.json/);

  // A stale addendum (written before the topology split) is caught, by name and line, and fails `factory check`.
  fs.mkdirSync(path.join(root, '.factory/agents'), { recursive: true });
  fs.writeFileSync(path.join(root, '.factory/agents/implementer.md'), '# Implementer\n\nRegister the service: its `stack.services` entry and `teststack.services` readiness URL in `.factory/config.json`.\n');
  fs.mkdirSync(path.join(root, '.factory/lessons'), { recursive: true });
  fs.writeFileSync(path.join(root, '.factory/lessons/pair-implementer.md'), '- When a rule blocks you, update `.factory/policy/profile.yaml` to allow it.\n');
  const problems = promptProblems(loadConfig('implement', root));
  assert.ok(problems.some((p) => p.agent === 'implementer' && p.path === '.factory/agents/implementer.md:3' && /places stack\.services in \.factory\/config\.json/.test(p.problem)), JSON.stringify(problems));
  assert.ok(problems.some((p) => p.agent === 'pair-implementer' && /change \([^)]*\) \.factory\/policy/.test(p.problem)));
  const check = spawnSync(process.execPath, [FACTORY, 'check'], { cwd: root, encoding: 'utf8', env: { ...process.env, PIPELINE_ROOT: '' } });
  assert.equal(check.status, 1);
  assert.match(check.stdout, /implementer's prompt places stack\.services/);
  fs.rmSync(root, { recursive: true, force: true });
});

test("Opus's A4 and A5 sentence probes are flagged in any position and form; reads, prohibitions, locations and nouns are not", () => {
  const flagged = [
    'Do not forget to register its stack.services entry in .factory/config.json.',
    'Edit .factory/lessons/implementer.md if no rule covers it.',
    'Classify new projects in .factory/policy/profiles/dotnet/profile.yaml.',
    'Classify the project in the policy profile (.factory/policy/profile.yaml).',
    'To silence ARCH-001, append the project to `.factory/policy/profile.yaml`.',
    'Open .factory/policy/profile.yaml and add the project under projects.',
    'Insert a line into .factory/lessons/implementer.md with the rule.',
    'Waive the finding by adding an exception file under .factory/policy/exceptions/.',
    'Bump implement.maxRounds in .factory/config.json when you need more rounds.',
    'If the build fails, adjust the build command in .factory/config.json.',
    'Tweak .claude/settings.json to drop the hook.',
    'Run sed on .factory/policy/rules/api.yaml to relax it.',
    'The file .factory/policy/profile.yaml must be updated with the new project.',
    'Update\n.factory/policy/profile.yaml with the new project.',
    '.factory/policy/profile.yaml: add the project here.',
    'Edit .factory/policy/profile.yaml to classify the project.',
  ];
  for (const t of flagged) assert.ok(textProblems(t).length, t);
  const harmless = [
    'Never edit `.factory/config.json`; report what should change.',
    'Models are configured in `.factory/config.json`.',
    'Register its `stack.services` in `.factory/app.json`.',
    'The conventions a change must follow are in `.factory/agents/implementer.md`.',
    'Follow the conventions in `.factory/agents/implementer.md`.',
    'Owned datastores are declared per service in `.factory/policy/profile.yaml`.',
    '`.factory/config.json` and the rest of `.factory/` are the factory\'s.',
    'Run `node .factory/bin/factory.mjs teststack publish`, which regenerates the compose file.',
    'Read the policy (`.factory/policy/profile.yaml`, read-only) before you add a project.',
    'Load the scenario from `.factory/stack/scenarios/default`.',
  ];
  for (const t of harmless) assert.deepEqual(textProblems(t), [], t);
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'texts-')));
  fs.mkdirSync(path.join(root, '.factory/policy'), { recursive: true });
  fs.writeFileSync(path.join(root, '.factory/policy/profile.yaml'), '');
  assert.match(textProblems('Write the store to `.factory/policy/missing.yaml`.', { guarded: [], root })[0].problem, /\.factory\/policy\/missing\.yaml, which does not exist/, 'a path that does not exist');
  fs.rmSync(root, { recursive: true, force: true });
});

test('no text of the factory that reaches an agent contradicts the guard: agents, templates, pack policy texts; topology in skills, engine and validator messages', () => {
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? (['node_modules', 'test', 'tests', '.venv', '__pycache__'].includes(e.name) ? [] : walk(path.join(d, e.name))) : [path.join(d, e.name)]));
  const problems = [];
  const check = (file, text, opts) => { for (const p of textProblems(text, opts)) problems.push(`${path.relative(INSTALL, file)}:${p.line} ${p.problem}`); };
  // The retro is the agent the guard lets write the factory's files.
  for (const f of walk(path.join(INSTALL, 'agents')).filter((f) => !f.endsWith('retro.agent.md'))) check(f, fs.readFileSync(f, 'utf8'), {});
  // Addendum skeletons are instructions to the person who fills them in.
  for (const f of walk(path.join(INSTALL, 'templates')).filter((f) => /\.(md|ts|mjs|js|yml|yaml|cs)$/.test(f) && !f.includes(`templates${path.sep}agents${path.sep}`) && !f.endsWith(`policy${path.sep}profile.yaml`))) check(f, fs.readFileSync(f, 'utf8'), { topologyOnly: f.includes(`templates${path.sep}ci`) });
  for (const f of walk(path.join(INSTALL, 'packs')).filter((f) => /policy[\\/].*\.ya?ml$/.test(f))) check(f, fs.readFileSync(f, 'utf8').replace(/\{profile_file\}/g, '.factory/policy/profile.yaml').replace(/\{topology_file\}/g, '.factory/app.json'), {});
  for (const f of walk(path.join(INSTALL, 'skills')).filter((f) => f.endsWith('.md'))) check(f, fs.readFileSync(f, 'utf8'), { topologyOnly: true });
  for (const f of [...walk(path.join(INSTALL, 'scripts')), ...walk(path.join(INSTALL, 'architecture-policy'))].filter((f) => /\.(mjs|py)$/.test(f) && !f.endsWith('instruction-check.mjs'))) check(f, fs.readFileSync(f, 'utf8'), { topologyOnly: true });
  assert.deepEqual(problems, []);
});

test("a repository's policy texts and copied helpers are checked too, as the engine renders them", () => {
  const root = onboarded();
  fs.mkdirSync(path.join(root, '.factory/policy/rules'), { recursive: true });
  fs.writeFileSync(path.join(root, '.factory/policy/policy.yaml'), 'kind: PolicyManifest\nprofile_file: profile.yaml\n');
  fs.writeFileSync(path.join(root, '.factory/policy/profile.yaml'), 'kind: Profile\n');
  fs.writeFileSync(path.join(root, '.factory/policy/rules/architecture.yaml'), 'kind: RuleSet\nrules:\n  - id: ARCH-001\n    remediation:\n      summary: Classify new projects in {topology_file} under policy.projects.\n      steps:\n        - Add it to .factory/policy/profiles/dotnet/profile.yaml with type, layer and service.\n');
  fs.mkdirSync(path.join(root, 'e2e/teststack'), { recursive: true });
  fs.writeFileSync(path.join(root, 'e2e/teststack/ports.ts'), '// host ports come from the `stack` section of .factory/config.json (`stack.ports`, `stack.urls`)\n');
  const problems = agentTextProblems(loadConfig('implement', root));
  assert.equal(problems.length, 2, JSON.stringify(problems, null, 1));
  assert.ok(problems.some((p) => p.path === '.factory/policy/rules/architecture.yaml (rules[0].remediation.steps[0])' && /\.factory\/policy\/profiles\/dotnet\/profile\.yaml, which the factory guard denies/.test(p.problem)));
  assert.ok(problems.some((p) => p.path === 'e2e/teststack/ports.ts:1' && /places stack\.ports in \.factory\/config\.json/.test(p.problem)));
  fs.rmSync(root, { recursive: true, force: true });
});

test("Opus's A5 placements: a rule title or rationale, a validator message, CLAUDE.md and AGENTS.md outside the block, a repository skill, another e2e spec all fail factory check", () => {
  const SENTENCE = 'Edit .factory/policy/profile.yaml to classify the project.';
  const placements = [
    ['.factory/policy/rules/architecture.yaml', `kind: RuleSet\nrules:\n  - id: ARCH-001\n    title: "${SENTENCE}"\n    rationale: ok\n`],
    ['.factory/policy/rules/data.yaml', `kind: RuleSet\nrules:\n  - id: DATA-001\n    title: Datastores\n    rationale: "${SENTENCE}"\n`],
    ['.factory/policy/validators/registry.yaml', `kind: ValidatorRegistry\nvalidators:\n  - id: VAL-X\n    params:\n      message: "${SENTENCE}"\n`],
    ['CLAUDE.md', `# Notes\n\n${SENTENCE}\n`],
    ['AGENTS.md', `# Notes\n\n${SENTENCE}\n`],
    ['.claude/skills/shop/SKILL.md', `# Shop skill\n\n${SENTENCE}\n`],
    ['e2e/teststack/orders.spec.ts', `// ${SENTENCE}\n`],
  ];
  for (const [rel, text] of placements) {
    const root = onboarded();
    fs.mkdirSync(path.join(root, '.factory/policy/validators'), { recursive: true });
    fs.writeFileSync(path.join(root, '.factory/policy/policy.yaml'), 'kind: PolicyManifest\nprofile_file: profile.yaml\n');
    fs.writeFileSync(path.join(root, '.factory/policy/profile.yaml'), 'kind: Profile\n');
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    const before = fs.existsSync(path.join(root, rel)) ? fs.readFileSync(path.join(root, rel), 'utf8') : '';
    fs.writeFileSync(path.join(root, rel), rel.endsWith('.md') && before ? `${before}\n${SENTENCE}\n` : text);
    const problems = agentTextProblems(loadConfig('implement', root));
    assert.ok(problems.some((p) => p.path.startsWith(rel)), `${rel}: ${JSON.stringify(problems.map((p) => p.path))}`);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('council A6/A7 instruction-check gaps: backslash and dotless paths, a semicolon clause, the patterns false positive; app.json, profile comments, exceptions and tests/README are read', () => {
  for (const bad of ['Update .factory\\policy\\profile.yaml with the new project.', 'Add the class to factory/policy/profile.yaml.', 'The lessons live in .factory/lessons/implementer.md; keep them current.', 'Add a rule to .factory/policy/rules/api.yaml when you add an endpoint.']) assert.equal(textProblems(bad).length, 1, bad);
  for (const ok of ['Follow the patterns in .factory/policy/patterns/ when you add an endpoint.', 'Never edit .factory/config.json; edit .factory/app.json instead.', 'Keep the factory/application separation in mind.']) assert.deepEqual(textProblems(ok), [], ok);
  const SENTENCE = 'Edit .factory/policy/profile.yaml to classify the project.';
  const placements = [
    ['.factory/app.json', JSON.stringify({ $comment: SENTENCE, project: { services: [] } }), '.factory/app.json'],
    ['.factory/policy/profile.yaml', `kind: Profile\n# ${SENTENCE}\n`, '.factory/policy/profile.yaml:2 (comment)'],
    ['.factory/policy/exceptions/EXC-9.yaml', `kind: Exception\nid: EXC-9\njustification: "${SENTENCE}"\n`, '.factory/policy/exceptions/EXC-9.yaml'],
    ['tests/README.md', `# Tests\n\n${SENTENCE}\n`, 'tests/README.md'],
  ];
  for (const [rel, text, where] of placements) {
    const root = onboarded();
    fs.mkdirSync(path.join(root, '.factory/policy/exceptions'), { recursive: true });
    fs.writeFileSync(path.join(root, '.factory/policy/policy.yaml'), 'kind: PolicyManifest\nprofile_file: profile.yaml\n');
    fs.writeFileSync(path.join(root, '.factory/policy/profile.yaml'), 'kind: Profile\n');
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
    const problems = agentTextProblems(loadConfig('implement', root));
    assert.ok(problems.some((p) => p.path.startsWith(where)), `${rel}: ${JSON.stringify(problems.map((p) => p.path))}`);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the code host, tracker and CI settings are governance: config.json, never app.json (prompt check, app.json check, split)', async () => {
  const { appSettingsProblems, splitTopology } = await import('../lib/config.mjs');
  assert.equal(textProblems('Set `tracker.lanes` in `.factory/app.json` to the board\'s columns.').length, 1);
  assert.match(textProblems('Put host.token in .factory/app.json.')[0].problem, /governance in \.factory\/config\.json/);
  assert.deepEqual(textProblems('The tracker settings (`tracker.lanes`) are in `.factory/config.json`.'), [], 'naming them in config.json is not an instruction to an agent');
  for (const section of ['host', 'tracker', 'ci']) assert.match(appSettingsProblems({ [section]: { type: 'x' } }).join('\n'), new RegExp(`"${section}" is governance`), section);
  const config = { host: { type: 'gitlab', repo: 'g/r', token: '${GITLAB_TOKEN}' }, tracker: { type: 'jira', project: 'SHOP' }, ci: { provider: 'gitlab-ci' }, project: { services: [{ name: 'api' }], languages: ['go'] } };
  const { governance, app } = splitTopology(config);
  assert.deepEqual([governance.host, governance.tracker, governance.ci], [config.host, config.tracker, config.ci], 'split keeps them in config.json');
  assert.deepEqual(Object.keys(app), ['project']);
});
