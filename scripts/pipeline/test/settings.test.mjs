// GEN-6: every setting is described once beside its defaults, the loader refuses old, unknown and out-of-range names and
// values with the right name or the allowed values, and the configuration reference is generated from the descriptions
// and checked against the code (scripts/pipeline/lib/settings.mjs).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { allowedText, descriptions, referenceMarkdown, settingsCheck, settingsProblems, staleReference, REFERENCE_FILE } from '../lib/settings.mjs';
import { ConfigError, loadConfig } from '../lib/config.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const tmp = (t, prefix) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};
const repoWith = (t, settings) => {
  const dir = tmp(t, 'settings-repo-');
  spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  fs.mkdirSync(path.join(dir, '.factory'));
  fs.writeFileSync(path.join(dir, '.factory/config.json'), JSON.stringify(settings));
  return dir;
};
const write = (root, rel, text) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), typeof text === 'string' ? text : JSON.stringify(text, null, 2));
};

test('the factory passes its own settings check: reference current, every read setting described, every described one read, defaults allowed and written once', () => {
  assert.deepEqual(settingsCheck().map((p) => `${p.kind}: ${p.name}: ${p.problem}`), []);
});

test('a renamed or removed setting fails the load naming the new setting or why, and no agent starts', (t) => {
  const renamed = [{ from: 'implement.oldThing', to: 'implement.newThing' }, { from: 'council.members[].oldKey', to: 'council.members[].newKey' }, { from: 'env:OLD_SWITCH', to: 'implement.newThing' }];
  const problems = settingsProblems({ implement: { oldThing: 1 }, council: { members: [{ name: 'a', oldKey: 1 }] } }, { renamed, env: { OLD_SWITCH: '1' } });
  assert.ok(problems.includes('implement.oldThing was renamed: use implement.newThing'), problems.join('\n'));
  assert.ok(problems.includes('council.members.0.oldKey was renamed: use council.members[].newKey'), problems.join('\n'));
  assert.ok(problems.includes('the environment variable OLD_SWITCH was renamed: use implement.newThing'), problems.join('\n'));
  // The real table, through the loader every command uses, and a command that would start an agent.
  const dir = repoWith(t, { implement: { preOpen: { failedStory: 'escalate' } } });
  assert.throws(() => loadConfig('implement', dir), (e) => e instanceof ConfigError && /implement\.preOpen\.failedStory was removed: a story whose PR check or CI never passes/.test(e.message));
  const marker = path.join(dir, 'agent-started');
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts/review/review.mjs'), 'run'], { cwd: dir, encoding: 'utf8', timeout: 60_000, env: { ...process.env, PIPELINE_ROOT: dir, PIPELINE_AGENT_CMD: `touch ${JSON.stringify(marker)}` } });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /implement\.preOpen\.failedStory was removed/);
  assert.equal(fs.existsSync(marker), false, 'no agent ran');
});

test('a misspelt name fails the load and names the closest setting', () => {
  assert.deepEqual(settingsProblems({ implement: { maxCouncilRonds: 3 } }), ['implement.maxCouncilRonds is not a setting; did you mean implement.maxCouncilRounds?']);
  assert.deepEqual(settingsProblems({ implemnt: {} }), ['implemnt is not a setting; did you mean implement?']);
});

test('a value outside a setting\'s allowed ones fails the load listing them, in the words the reference shows', (t) => {
  const cases = [
    [{ implement: { delivery: 'sometimes' } }, 'implement.delivery'],
    [{ implement: { maxCouncilRounds: 0 } }, 'implement.maxCouncilRounds'],
    [{ prCheck: { councilPassScore: 11 } }, 'prCheck.councilPassScore'],
    // Council r1 (sol-03): more decimals than allowed in any notation, and a member count no council can seat.
    [{ implement: { councilPassScore: 1e-7 } }, 'implement.councilPassScore'],
    [{ council: { members: 4294967296 } }, 'council.members'],
    [{ video: { apiEvidence: { paymentBodies: 'show' } } }, 'video.apiEvidence.paymentBodies'],
  ];
  const reference = referenceMarkdown();
  for (const [settings, name] of cases) {
    const d = descriptions().find((x) => x.name === name);
    const dir = repoWith(t, settings);
    assert.throws(() => loadConfig(null, dir), (e) => e instanceof ConfigError && e.message.includes(`${name} is `) && e.message.includes(`allowed: ${allowedText(d)}`), name);
    const row = reference.split('\n').find((l) => l.startsWith(`| \`${name}\` |`));
    assert.ok(row.includes(`| ${allowedText(d).replace(/\|/g, '\\|')} |`), `${name}: the reference shows the same allowed values`);
  }
});

test('the check names a setting the code reads with no description, a described one read nowhere, a bad or undescribed default and a second default in code', (t) => {
  const root = tmp(t, 'settings-check-');
  write(root, 'scripts/pipeline/config.json', { implement: { rounds: 3, delivery: 'epic', orphanDefault: 1 } });
  write(root, 'scripts/pipeline/settings.json', {
    'implement.rounds': { does: 'How many rounds a pair gets.', type: 'integer', min: 1 },
    'implement.delivery': { does: 'How a run delivers its work.', type: 'enum', values: ['story'] },
    'implement.neverRead': { does: 'Described, but no code reads it.', type: 'boolean' },
  });
  write(root, 'scripts/pipeline/lib/code.mjs', "export const a = (config) => [config.implement.rounds ?? 3, config.implement.delivery, config.implement.brandNewSetting];\n");
  const found = settingsCheck({ root, scriptsDir: path.join(root, 'scripts'), reference: null }).map((p) => `${p.kind}: ${p.name}`);
  for (const expected of ['undescribed: implement.brandNewSetting', 'unread: implement.neverRead', 'default: implement.delivery', 'default: implement.orphanDefault', 'fallback: implement.rounds']) assert.ok(found.includes(expected), `${expected} in ${found.join(', ')}`);
  assert.ok(!found.some((f) => f.endsWith(': implement.rounds') && !f.startsWith('fallback')), 'a described, read, allowed default is fine');
});

// Council r1 (sol-04): a section set to null would replace every default under it.
test('a section set to null or a plain value is refused, naming the section; a nullable object setting may be null', (t) => {
  assert.deepEqual(settingsProblems({ agent: null, prCheck: 3 }), [
    'agent is null; it holds settings, so it must be an object (leave it out to keep its defaults)',
    'prCheck is 3; it holds settings, so it must be an object (leave it out to keep its defaults)',
  ]);
  assert.throws(() => loadConfig(null, repoWith(t, { implement: null })), (e) => e instanceof ConfigError && /implement is null; it holds settings/.test(e.message));
  assert.deepEqual(settingsProblems({ analysis: null }), []);
});

// Council r1 (sol-05): reads through the settings accessor count, and a name in a comment is not a read.
test('the check sees setting(config, name) reads, and a setting named only in a comment is read nowhere; readBy names the file that reads it', (t) => {
  const root = tmp(t, 'settings-accessor-');
  write(root, 'scripts/pipeline/config.json', { implement: { rounds: 3, commentOnly: true, computed: 2 } });
  write(root, 'scripts/pipeline/settings.json', {
    'implement.rounds': { does: 'How many rounds a pair gets.', type: 'integer', min: 1 },
    'implement.commentOnly': { does: 'Named in a comment only.', type: 'boolean' },
    'implement.computed': { does: 'Read under a computed name.', type: 'integer', readBy: 'scripts/pipeline/lib/code.mjs' },
  });
  write(root, 'scripts/pipeline/lib/code.mjs', "// implement.commentOnly: the implement section's commentOnly switch\nexport const a = (config, s) => [setting(config, 'implement.rounds'), setting(config, 'implement.example'), setting(config, `${s}.computed`)];\n");
  // Council r1 (A3, A4): a local name for a part of the settings, and a second default through the accessor or that name.
  write(root, 'scripts/pipeline/lib/alias.mjs', "export function b(config) {\n  const impl = config.implement ?? {};\n  return [impl.aliasOnly, impl.rounds ?? 4, setting(config, 'implement.rounds') ?? 3];\n}\n");
  // Council r2 (sol-05): words in a file are not reads; bracket access and joined literals are; a computed name is
  // declared with readBy (implement.computed names code.mjs, so its computed call there is accounted for).
  write(root, 'scripts/pipeline/config.json', { implement: { rounds: 3, commentOnly: true, computed: 2 }, feature: { enabled: true } });
  write(root, 'scripts/pipeline/settings.json', {
    'implement.rounds': { does: 'How many rounds a pair gets.', type: 'integer', min: 1 },
    'implement.commentOnly': { does: 'Named in a comment only.', type: 'boolean' },
    'implement.computed': { does: 'Read under a computed name.', type: 'integer', readBy: 'scripts/pipeline/lib/code.mjs' },
    'feature.enabled': { does: 'A switch only unrelated code mentions.', type: 'boolean' },
  });
  write(root, 'scripts/pipeline/lib/words.mjs', "export const feature = 'x';\nexport const example = { enabled: true };\nexport const c = (config) => [config['implement'].alsoUndocumented, setting(config, 'implement.' + 'undocumented')];\n");
  write(root, 'scripts/pipeline/lib/other.mjs', 'export const d = (config, name) => setting(config, name);\n');
  // Council r2 (A3): a destructured read of the settings.
  write(root, 'scripts/pipeline/lib/destructure.mjs', 'export function e(config) {\n  const { brandNewFour, rounds } = config.implement;\n  return [brandNewFour, rounds];\n}\n');
  // Council r3 (sol-05): a part of the settings handed on and a property of something else are no read of feature.enabled;
  // a second computed name in a file that declares one must stand for settings declared there too.
  write(root, 'scripts/pipeline/lib/consume.mjs', 'export const f = (config, input) => [consume(config.feature), input.enabled];\n');
  write(root, 'scripts/pipeline/lib/code2.mjs', 'export const g = (config, s) => setting(config, `${s}.computed`);\n');
  // Council r4 (sol-05): an accessor read is one whatever its first argument (an object literal, a nested call).
  write(root, 'scripts/pipeline/lib/anyfirst.mjs', "export const h = (f, k) => [setting({}, 'feature.undocumented'), setting(readJson(path.join(f, 'x.json'), {}) ?? {}, 'feature.alsoUndocumented').deep, setting({ a: 1 }, k), setting(pick('a, b)'), 'feature.inString'), setting ({}, 'feature.spaced'), setting\n  ({}, 'feature.newline')];\n");
  fs.appendFileSync(path.join(root, 'scripts/pipeline/lib/code.mjs'), 'export const h = (config, s) => setting(config, `${s}.other`);\n');
  const found = settingsCheck({ root, scriptsDir: path.join(root, 'scripts'), reference: null }).map((p) => `${p.kind}: ${p.name}`);
  assert.deepEqual(found.filter((f) => /^(undescribed|unread|computed):/.test(f)).sort(), [
    'computed: scripts/pipeline/lib/anyfirst.mjs:1',
    'computed: scripts/pipeline/lib/code.mjs:3',
    'computed: scripts/pipeline/lib/code2.mjs:1',
    'computed: scripts/pipeline/lib/other.mjs:1',
    'undescribed: feature.alsoUndocumented',
    'undescribed: feature.alsoUndocumented.deep',
    'undescribed: feature.inString',
    'undescribed: feature.newline',
    'undescribed: feature.spaced',
    'undescribed: feature.undocumented',
    'undescribed: implement.aliasOnly',
    'undescribed: implement.alsoUndocumented',
    'undescribed: implement.brandNewFour',
    'undescribed: implement.example',
    'undescribed: implement.undocumented',
    'unread: feature.enabled',
    'unread: implement.commentOnly',
  ]);
  assert.equal(found.filter((f) => f === 'fallback: implement.rounds').length, 2, 'impl.rounds ?? 4 and setting(...) ?? 3');
});

// Council r2 (A4): a default written again as a parameter's default, as a module constant, or through a local name the
// file declares in more than one function.
test('the check finds a default written again in a parameter default, a module constant, or a twice-declared local name', (t) => {
  const root = tmp(t, 'settings-twins-');
  write(root, 'scripts/pipeline/config.json', { implement: { maxSubtasks: 4, waitRounds: 7, lessonsCap: 5 }, timeoutSec: 900, board: { resolvedLabel: 'escalation-resolved' }, review: { policyDir: '.factory/policy' }, prune: { analysisReports: 200 }, video: { width: 1280, pauseSec: 0.6 }, fields: { severity: 'Severity', impact: 'Impact' } });
  write(root, 'scripts/pipeline/settings.json', {
    'implement.maxSubtasks': { does: 'At most this many subtasks.', type: 'integer', min: 1 },
    'implement.waitRounds': { does: 'Rounds to wait.', type: 'integer', min: 1 },
    'implement.lessonsCap': { does: 'Lessons per prompt.', type: 'integer', min: 1 },
    timeoutSec: { does: 'A generic timeout.', type: 'integer', min: 1 },
    'board.resolvedLabel': { does: 'The label of a resolved escalation.', type: 'string' },
    'review.policyDir': { does: 'The folder of the rules.', type: 'string' },
    'prune.analysisReports': { does: 'Reports kept.', type: 'integer', min: 1, env: 'PRUNE_REPORTS' },
    'video.width': { does: 'The recording width.', type: 'integer', min: 1 },
    'video.pauseSec': { does: 'The pause after a line.', type: 'number', min: 0 },
    'fields.<field>': { does: 'A project field\'s name.', type: 'string' },
  });
  // Council r3 (A4): `|| <literal>`, `?? <a module constant of one>`, and any `<x>.<key> ?? <the default>`, in a message
  // too; a key any object has (a timeout) counts only on the settings themselves.
  write(root, 'scripts/pipeline/lib/more.mjs', [
    "const RESOLVED = 'escalation-resolved';",
    'export const label = (config) => config.board?.resolvedLabel ?? RESOLVED;',
    "export const dir = (config) => config.review.policyDir || '.factory/policy';",
    'export const message = (s) => `older than the newest ${s.analysisReports ?? 200}`;',
    'export const timeout = (tool, config) => [tool.timeoutSec ?? 900, config.timeoutSec ?? 900];',
    "export const bare = (policyDir) => policyDir ?? '.factory/policy';",
    'export const fromEnv = () => Number(process.env.PRUNE_REPORTS || 200);',
    'export const part = (settings) => settings?.timeoutSec ?? 900;',
    'export const reads = (config) => [config.prune.analysisReports, process.env.PRUNE_REPORTS];',
    "export const distinct = (flag, run) => [flag('dir') ?? '.factory/policy', run.base || '.factory/policy'];",
    'export const size = (p, config) => [p.width ?? 1280, config.video.width];',
    "export const viaAccessor = () => setting(readJson('x.json', {}) ?? {}, 'prune.analysisReports') ?? 201;",
    // Council r4 (A4): one key of a module constant equal to a setting's default; a map setting's default by its key.
    'export const PACE = { pauseSec: 0.6, minStepSec: 1.2 };',
    "export const field = (b, config) => [b.fields?.severity ?? 'Severity', config.video.pauseSec, config.fields];",
    "export const names = (k) => ({ severity: 'Severity', impact: 'Impact' })[k];",
    '',
  ].join('\n'));
  write(root, 'scripts/pipeline/lib/twins.mjs', [
    'export const limits = (plan, { maxSubtasks = 4, timeoutSec = 900 } = {}) => [plan, maxSubtasks, timeoutSec];',
    'export const DEFAULTS = { maxSubtasks: 4, waitRounds: 7 };',
    'export function a(config) {\n  const p = config.implement;\n  return p.lessonsCap;\n}',
    'export function b(config) {\n  const p = config.implement;\n  return p.lessonsCap ?? 5;\n}',
    '',
  ].join('\n'));
  const found = settingsCheck({ root, scriptsDir: path.join(root, 'scripts'), reference: null }).filter((p) => p.kind === 'fallback').map((p) => `${p.name}: ${p.problem.split(' falls back')[0]}`);
  assert.deepEqual(found.sort(), [
    'board.resolvedLabel: scripts/pipeline/lib/more.mjs:2',
    'fields.impact: scripts/pipeline/lib/more.mjs:15',
    'fields.severity: scripts/pipeline/lib/more.mjs:14',
    'fields.severity: scripts/pipeline/lib/more.mjs:15',
    'implement.lessonsCap: scripts/pipeline/lib/twins.mjs:9',
    'implement.maxSubtasks: scripts/pipeline/lib/twins.mjs:1',
    'implement.maxSubtasks: scripts/pipeline/lib/twins.mjs:2',
    'implement.waitRounds: scripts/pipeline/lib/twins.mjs:2',
    'prune.analysisReports: scripts/pipeline/lib/more.mjs:12',
    'prune.analysisReports: scripts/pipeline/lib/more.mjs:4',
    'prune.analysisReports: scripts/pipeline/lib/more.mjs:7',
    'review.policyDir: scripts/pipeline/lib/more.mjs:10',
    'review.policyDir: scripts/pipeline/lib/more.mjs:3',
    'review.policyDir: scripts/pipeline/lib/more.mjs:6',
    'timeoutSec: scripts/pipeline/lib/more.mjs:5',
    'timeoutSec: scripts/pipeline/lib/more.mjs:8',
    'video.pauseSec: scripts/pipeline/lib/more.mjs:13',
    'video.width: scripts/pipeline/lib/more.mjs:11',
  ], 'timeoutSec, a generic helper parameter or another object\'s key, is left alone');
});

test('the generated reference is the descriptions: a hand edit of the generated part fails the check', (t) => {
  assert.deepEqual(staleReference(), []);
  const copy = path.join(tmp(t, 'settings-ref-'), 'configuration.md');
  fs.writeFileSync(copy, fs.readFileSync(REFERENCE_FILE, 'utf8').replace('| `implement.maxCouncilRounds` | How many', '| `implement.maxCouncilRounds` | Hand-edited: how many'));
  assert.deepEqual(staleReference(copy).map((s) => s.id), ['settings']);
});

test('every setting has its row with all six facts, and an overriding environment variable only on its row', () => {
  const doc = fs.readFileSync(REFERENCE_FILE, 'utf8');
  const rows = new Map(doc.split('\n').filter((l) => l.startsWith('| `')).map((l) => [l.split(' | ')[0].slice(3, -1), l]));
  for (const d of descriptions()) {
    const row = rows.get(d.name);
    assert.ok(row, `${d.name} has a row`);
    const cells = row.slice(1, -1).split(/(?<!\\)\|/).map((c) => c.trim());
    assert.equal(cells.length, 6, `${d.name}: ${row}`);
    assert.ok(cells.every(Boolean), `${d.name}: an empty fact`);
    assert.equal(cells[5], d.env ? `\`${d.env}\`` : 'none');
  }
  const switches = doc.slice(doc.indexOf('## Environment and git switches'), doc.indexOf('## Settings reference'));
  for (const d of descriptions().filter((x) => x.env)) assert.ok(!switches.includes(d.env), `${d.env} is listed as a separate switch`);
});

// Council r4 (T12): an environment variable on a setting's row counts as read only through an actual read, never through
// its name in a comment, inside a longer name, or in a message.
test('the check reads a setting\'s environment variable only where code actually reads it', (t) => {
  const root = tmp(t, 'settings-env-');
  write(root, 'scripts/pipeline/config.json', { sink: { a: 'x', b: 'x', c: 'x', d: 'x', e: 'x' } });
  write(root, 'scripts/pipeline/settings.json', {
    'sink.a': { does: 'Read for real.', type: 'string', env: 'SINK_A' },
    'sink.b': { does: 'Named in a comment only.', type: 'string', env: 'SINK_B' },
    'sink.c': { does: 'Only inside a longer name.', type: 'string', env: 'SINK_C' },
    'sink.d': { does: 'Only in a message.', type: 'string', env: 'SINK_D' },
    'sink.e': { does: 'Read by a script.', type: 'string', env: 'SINK_E' },
  });
  write(root, 'scripts/pipeline/lib/env.mjs', [
    '// SINK_B overrides sink.b',
    "export const f = (config) => [process.env.SINK_A ?? config.sink.a, config.sink.b, process.env.SINK_C_TIMEOUT, config.sink.c, config.sink.d, config.sink.e];",
    "export const g = () => console.log('set SINK_D to override it');",
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(root, 'scripts/pipeline/run.sh'), '#!/bin/sh\necho "${SINK_E:-x}"\n');
  const found = settingsCheck({ root, scriptsDir: path.join(root, 'scripts'), reference: null }).filter((p) => p.kind === 'env').map((p) => p.name).sort();
  assert.deepEqual(found, ['sink.b', 'sink.c', 'sink.d']);
});

// Council r4 (A4): a custom adapter's call time limit is the adapter's own, shown as the default on its three rows.
test('the custom adapters\' call time limit is the one their reference rows show', async () => {
  const { CUSTOM_CALL_TIMEOUT_SEC } = await import('../lib/providers/custom.mjs');
  for (const name of ['host.timeoutSec', 'tracker.timeoutSec', 'ci.timeoutSec']) assert.equal(descriptions().find((d) => d.name === name).defaultText, `\`${CUSTOM_CALL_TIMEOUT_SEC}\``, name);
});

// Council r4 (A17): a readBy file must read the key, not merely name it; a key it only copies into another object must be
// read on from there (analysis.reports.keep was copied and never used).
test('readBy holds a declaration to a read of the key: a word, a quoted name or an object key is not one; a copy must be read on', (t) => {
  const root = tmp(t, 'settings-readby-');
  const keys = ['named', 'quoted', 'objectKey', 'copied', 'copiedUsed', 'computed', 'param', 'bracket'];
  write(root, 'scripts/pipeline/config.json', { s: Object.fromEntries(keys.map((k) => [k, 1])) });
  write(root, 'scripts/pipeline/settings.json', Object.fromEntries(keys.map((k) => [`s.${k}`, { does: `The ${k} case.`, type: 'integer', readBy: 'scripts/pipeline/lib/a.mjs' }])));
  write(root, 'scripts/pipeline/lib/a.mjs', [
    '// named: only in a comment',
    "export const msg = 'set s.quoted to change it';",
    'export const obj = { objectKey: 1 };',
    'export const opts = (o) => ({ copied: o.copied, copiedUsed: o.copiedUsed });',
    'export const c = (config, x) => setting(config, `${x}.computed`);',
    'export const p = (project, { param = {}, other }) => [project, param, other];',
    "export const b = (o) => o['bracket'];",
    '',
  ].join('\n'));
  write(root, 'scripts/pipeline/lib/b.mjs', 'export const use = ({ copiedUsed }) => copiedUsed + 1;\n');
  const found = settingsCheck({ root, scriptsDir: path.join(root, 'scripts'), reference: null }).filter((p) => p.kind === 'unread').map((p) => p.name).sort();
  assert.deepEqual(found, ['s.copied', 's.named', 's.objectKey', 's.quoted']);
  // The setting it found (analysis.reports.keep, never used) is gone: a repository that sets it is told what replaces it.
  assert.deepEqual(settingsProblems({ analysis: { reports: { keep: 5 } } }), ['analysis.reports.keep was renamed: use prune.analysisReports (factory prune keeps the newest analysis reports; the pipeline never pruned them itself)']);
});
