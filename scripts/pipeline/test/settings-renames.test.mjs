// GEN-7: the non-council settings combined and renamed to one naming pattern. Every old name is refused naming the new
// one, every reader of a combined setting follows the new one, the rows that change behaviour behave as the row says,
// every duration is in seconds, and no file outside the old-to-new table and the upgrade note names an old setting.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { descriptions, renamedProblems, renamedSettings, renamedTarget, segments, settingsProblems, stripComments } from '../lib/settings.mjs';
import { loadConfig } from '../lib/config.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const tmp = (t, prefix) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};
const repoWith = (t, settings) => {
  const dir = tmp(t, 'renames-');
  spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  fs.mkdirSync(path.join(dir, '.factory'));
  fs.writeFileSync(path.join(dir, '.factory/config.json'), JSON.stringify(settings));
  return dir;
};
// { a: { b: value } } from 'a.b'.
const docAt = (name, value) => segments(name).reduceRight((v, k) => (k === '[]' ? [v] : { [k]: v }), value);

test('every old name of the table fails the load and names its new setting (or why it was removed)', () => {
  const rows = renamedSettings().filter((r) => !r.from.startsWith('env:'));
  assert.ok(rows.length > 90, 'the GEN-7 rows are in the table');
  for (const r of rows) {
    const problems = settingsProblems(docAt(r.from, 1));
    const want = r.removed ? 'was removed' : `was renamed: use ${r.to}`;
    assert.ok(problems.some((p) => p.includes(want)), `${r.from}: ${problems.join('; ')}`);
  }
  assert.ok(settingsProblems({}, { env: { FACTORY_EXTERNAL_RETRIES: '3' } }).includes('the environment variable FACTORY_EXTERNAL_RETRIES was renamed: use FACTORY_EXTERNAL_MAX_RETRIES'));
});

test('a combined row: each reader of the new setting follows it', async (t) => {
  const settings = {
    project: { frontendPaths: ['ui/'], testRoots: ['checks'] },
    teststack: { scenariosDir: 'data/scenarios' },
    hooks: { codeAgents: ['builder'] },
    prCheck: { mode: 'report', fixMinSeverity: 'blocking', returnToImplementation: { maxReturns: 4 }, video: { maxFrames: 7, maxTotalFrames: 100, minFramesPerVideo: 1 } },
    implement: { waitSec: { prCheck: 99 }, epic: { maxTicketsPerGroup: 3 } },
  };
  const config = loadConfig('implement', repoWith(t, settings));
  // project.frontendPaths: the PR check, the UI-ticket rule and the demo video's classification.
  const { frontendPathsOf } = await import('../../pr-check/lib/context.mjs');
  const { uiRules } = await import('../../implement/lib/plan.mjs');
  const { classifyFiles } = await import('../../pr-video/lib/api-summary.mjs');
  assert.deepEqual(frontendPathsOf(config), ['ui/']);
  assert.deepEqual(uiRules(config).filePatterns, ['ui/']);
  assert.equal(classifyFiles(['ui/cart.tsx'], config).frontend, true);
  // project.testRoots: the test stages, the review gate and the board's evidence.
  const { testRoots } = await import('../../feature-verification/lib/runners.mjs');
  const { testRootIgnores } = await import('../../review-gate/lib/systems.mjs');
  assert.deepEqual(testRoots(config), ['checks']);
  assert.deepEqual(testRootIgnores(config), ['checks/**']);
  // teststack.scenariosDir: the ticket of a changed file, and what counts as test code.
  const { isTestFile } = await import('../../feature-verification/lib/runners.mjs');
  assert.equal(isTestFile(config, 'data/scenarios/x-1/seed.sql', []), true);
  // hooks.codeAgents: the architecture review and the automatic PR check.
  const hooks = await import('../../pr-check/lib/hooks.mjs');
  const { isCodeAgentStop } = await import('../lib/cli.mjs');
  assert.equal(isCodeAgentStop(config, { hook_event_name: 'SubagentStop', agent_type: 'builder' }), true);
  assert.equal(isCodeAgentStop(config, { hook_event_name: 'SubagentStop', agent_type: 'implementer' }), false);
  // prCheck.returnToImplementation.maxReturns: the pipeline's returns and the hook's checks (one more than the returns).
  const { returnSettings } = await import('../../implement/lib/pr-check-return.mjs');
  assert.equal(returnSettings(config).maxReturns, 4);
  assert.equal(hooks.hookMaxChecks(config), 5);
  // prCheck.mode and implement.waitSec.prCheck: one mode and one wait for a single ticket and an epic's units.
  const { prCheckFixSettings } = await import('../../implement/lib/implement.mjs');
  assert.deepEqual([prCheckFixSettings(config).mode, prCheckFixSettings(config).fixUntil, prCheckFixSettings(config).fixTimeoutSec], ['report', 'blocking', 99]);
  // An epic unit's PR check runs on the same settings: its severity to fix to (the epic delivery test checks the unit
  // follows prCheck.mode; the callers test that it passes no round limit of its own).
  const { prCheckUnitArgs } = await import('../../implement/lib/epic.mjs');
  const unit = (kind) => prCheckUnitArgs({ wtConfig: config, base: 'main', unit: { kind } }, ['A-1'], { fix: true });
  assert.deepEqual([unit('feature').slice(-2), unit('group').slice(-2)], [['--until', 'blocking'], ['--until', prCheckFixSettings(config).bugFixUntil]]);
  assert.deepEqual(prCheckUnitArgs({ wtConfig: config, base: 'main' }, ['A-1']).slice(-1), ['--no-fix']);
  // prCheck.video.maxFrames: the only frame cap (video.critic.* is gone).
  const { framesPerVideo } = await import('../../pr-check/lib/video.mjs');
  assert.equal(framesPerVideo(config.prCheck.video, 1), 7);
  // implement.epic.maxTicketsPerGroup: one cap for bug groups and feature groups.
  const { validateGroups } = await import('../../implement/lib/epic-plan.mjs');
  const stories = ['A-1', 'A-2', 'A-3', 'A-4'].map((key) => ({ key, blockedBy: [] }));
  const over = validateGroups([{ id: 'all', title: 'All', tickets: stories.map((s) => s.key) }], { stories, maxPerGroup: config.implement.epic.maxTicketsPerGroup });
  assert.match(over.errors.join(), /more than implement\.epic\.maxTicketsPerGroup \(3\)/);
});

test('implement.maxParallel and lsp.maxLanguageServers are upper limits on the numbers worked out from free memory', async (t) => {
  const { autoSize, maxLanguageServers, parallelFor } = await import('../../implement/lib/resources.mjs');
  const mem = { totalGb: 256, freeGb: 200, dockerGb: null };
  const free = autoSize(mem, { cpus: 64 });
  assert.ok(free.parallel > 3 && free.lspMaxServers > 2, 'plenty of memory: a large number');
  const capped = autoSize(mem, { cpus: 64, maxParallel: 3, maxLanguageServers: 2 });
  assert.deepEqual([capped.parallel, capped.lspMaxServers], [3, 2]);
  const small = autoSize({ totalGb: 8, freeGb: 7, dockerGb: null }, { cpus: 64, maxParallel: 3, maxLanguageServers: 50 });
  assert.equal(small.parallel, 1, 'an upper limit, never a number forced above what memory allows');
  const config = loadConfig('implement', repoWith(t, { implement: { maxParallel: 2 }, lsp: { maxLanguageServers: 1 } }));
  assert.equal(parallelFor(config, undefined, { dryRun: true, mem, cpus: 64, print: () => {} }), 2);
  assert.equal(parallelFor(config, '5', { dryRun: true, mem, cpus: 64, print: () => {} }), 5, '--parallel N forces N');
  assert.equal(maxLanguageServers(config, {}), 1);
  assert.equal(maxLanguageServers(config, { LSP_MAX_SERVERS: '4' }), 4, 'the variable overrides the setting');
  // The daemon caps the run's memory-based number (LSP_SIZED_SERVERS) with the setting.
  const { loadConfig: lspConfig } = await import('../../lsp/lib/common.mjs');
  const root = repoWith(t, { lsp: { maxLanguageServers: 3 } });
  const saved = { sized: process.env.LSP_SIZED_SERVERS, max: process.env.LSP_MAX_SERVERS };
  t.after(() => {
    for (const [k, v] of [['LSP_SIZED_SERVERS', saved.sized], ['LSP_MAX_SERVERS', saved.max]]) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  });
  delete process.env.LSP_MAX_SERVERS;
  process.env.LSP_SIZED_SERVERS = '9';
  assert.equal(lspConfig(root).maxLanguageServers, 3);
  process.env.LSP_SIZED_SERVERS = '1';
  assert.equal(lspConfig(root).maxLanguageServers, 1);
});

test('implement.worker.retryDelaySec doubles each retry, like recovery.retryDelaySec', async (t) => {
  // The batch itself: a ticket that fails twice is started again after 10 s, then 20 s, then ends done.
  const { runBatch } = await import('../../implement/lib/implement.mjs');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'worker-retry-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = { root, stateDir: '.factory/state', metricsDir: '.factory/metrics', implement: { worker: { maxRetries: 3, retryDelaySec: 10 } } };
  const waits = [];
  const results = [{ outcome: 'error', reason: 'crashed' }, { outcome: 'error', reason: 'crashed' }, { outcome: 'done' }];
  const out = await runBatch(config, [{ key: 'A-1', deps: [], branch: 'feat/a-1', worktree: root, base: 'main' }], { deps: { startWorker: async () => results.shift(), sleep: async (ms) => waits.push(ms) } });
  assert.deepEqual([waits, out[0].outcome], [[10_000, 20_000], 'done']);
  const { nextAttempt } = await import('../lib/recovery.mjs');
  const base = { recovery: { maxRetries: 3, retryDelaySec: 10 } };
  const at = (n) => Date.parse(nextAttempt(base, { recoveries: n }).fields.retryAt) - Date.now();
  assert.ok(at(1) > 15_000 && at(1) <= 20_000, 'the second restart waits twice the first');
  assert.equal(nextAttempt(base, { recoveries: 3 }).action, 'crashed');
});

test('the external-call retries: FACTORY_EXTERNAL_MAX_RETRIES and FACTORY_EXTERNAL_RETRY_DELAY_SEC, in seconds, doubling', async () => {
  const { externalRetries, externalRetryPauseMs } = await import('../lib/external.mjs');
  assert.equal(externalRetries({}), 2);
  assert.equal(externalRetries({ FACTORY_EXTERNAL_MAX_RETRIES: '5' }), 5);
  assert.deepEqual([1, 2, 3].map((a) => externalRetryPauseMs(a, {})), [2000, 4000, 8000]);
  assert.equal(externalRetryPauseMs(2, { FACTORY_EXTERNAL_RETRY_DELAY_SEC: '0.5' }), 1000);
});

test('every duration setting is in seconds with its name ending in Sec (retention in Days)', () => {
  for (const d of descriptions()) {
    const leaf = segments(d.name).at(-1);
    const parent = segments(d.name).at(-2) ?? '';
    if (/(Min|Minutes|Ms|Hours|Seconds)$/.test(leaf)) assert.fail(`${d.name}: a unit other than seconds in the name`);
    if (!d.unit || !/^(seconds|minutes|hours|milliseconds|days)$/.test(d.unit)) continue;
    assert.ok(['seconds', 'days'].includes(d.unit), `${d.name}: ${d.unit}`);
    if (d.unit === 'days') assert.match(leaf, /Days$/, d.name);
    else assert.ok(/Sec$/.test(leaf) || /Sec$/.test(parent), `${d.name} is in seconds and says so`);
  }
});

test('no code, sample, doc, skill, template or explorer data names an old setting (outside the table and the upgrade note)', () => {
  const names = renamedSettings().map((r) => r.from.replace(/^env:/, '')).filter((n) => n.includes('.') || /^[A-Z][A-Z0-9_]+$/.test(n)).map((n) => n.replace(/\[\]/g, ''));
  const files = spawnSync('git', ['ls-files', '-co', '--exclude-standard'], { cwd: ROOT, encoding: 'utf8' }).stdout.split('\n').filter((f) => f && /\.(mjs|js|ts|json|md|ya?ml|sh|html)$/.test(f) && !/(^|\/)(test|tests|node_modules|graphify-out)\//.test(f) && !f.endsWith('renamed-settings.json') && fs.existsSync(path.join(ROOT, f)));
  const liveParts = new Set(descriptions().flatMap((d) => segments(d.name)));
  const code = files.filter((f) => /\.(mjs|js)$/.test(f)).map((f) => stripComments(fs.readFileSync(path.join(ROOT, f), 'utf8'))).join('\n');
  const oldLeaves = [...new Set(renamedSettings().filter((r) => !r.from.startsWith('env:')).map((r) => segments(r.from).at(-1)))].filter((l) => /[a-z][A-Z]/.test(l) && l.length >= 6 && !liveParts.has(l) && !new RegExp(`\\b${l}\\b`).test(code));
  const hits = [];
  for (const f of files) {
    let text = fs.readFileSync(path.join(ROOT, f), 'utf8');
    if (f === 'docs/configuration.md') text = text.replace(/<!-- generated:renamed-settings -->[\s\S]*?<!-- \/generated:renamed-settings -->/, '').replace(/### Upgrading from 0\.2\.99[\s\S]*?### Upgrading from 0\.2\.96/, '');
    for (const n of names) {
      const re = new RegExp(`(?<![\\w.$])${n.replace(/[.]/g, '\\.')}(?![\\w])`);
      if (re.test(text)) hits.push(`${f}: ${n}`);
    }
    // Council r1 (A9): an old name's last part alone (`highMin`), when it is unambiguous: no live setting has it and no
    // code uses it as a name. Searched in Markdown code spans, in code comments and anywhere in a page (council r3, A16:
    // the explorer mockup named maxBugFixCycles and ciFixRounds as bare keys).
    for (const leaf of oldLeaves) {
      const re = /\.md$/.test(f) ? new RegExp(`\`[^\`\\n]*\\b${leaf}\\b[^\`\\n]*\``) : /\.(mjs|js|ts)$/.test(f) ? new RegExp(`//[^\\n]*\\b${leaf}\\b`) : /\.html$/.test(f) ? new RegExp(`\\b${leaf}\\b`) : null;
      if (re?.test(text)) hits.push(`${f}: ${leaf}`);
    }
  }
  assert.deepEqual(hits, []);
});

// Council r1 (A8): a refusal must name the key that is live now, never another refused one.
test('every rename leads to a live described setting, following later renames; the message names the end of the chain', () => {
  const renamed = renamedSettings();
  const described = descriptions().map((d) => segments(d.name));
  const wild = (seg) => /^<[^>]+>$/.test(seg);
  // A setting, or a section that holds described settings (a whole section may move).
  const live = (name) => described.some((d) => d.length >= segments(name).length && segments(name).every((seg, i) => wild(seg) || wild(d[i]) || seg === d[i]));
  for (const r of renamed.filter((x) => x.to && !x.from.startsWith('env:'))) {
    const t = renamedTarget(r, segments(r.from), renamed);
    if (t.removed) continue;
    assert.ok(live(t.to), `${r.from} leads to ${t.to}, which is not a described setting`);
    assert.ok(!renamed.some((o) => !o.from.startsWith('env:') && o.from === t.to), `${r.from} leads to ${t.to}, which is itself refused`);
  }
  // A chain is followed to its end, the old name's value at a wildcard carried along.
  const chain = [{ from: 'a.old', to: 'b.mid' }, { from: 'b.mid', to: 'c.new', note: 'say why' }, { from: 'x.<k>', to: 'y.<k>' }, { from: 'y.gone', removed: 'it went' }];
  assert.deepEqual(renamedProblems({ a: { old: 1 }, x: { kept: 1, gone: 2 } }, { renamed: chain, env: {} }), ['a.old was renamed: use c.new (say why)', 'x.kept was renamed: use y.kept', 'x.gone was removed: it went']);
  assert.match(settingsProblems({ agent: { models: { implementer: 'opus' } } }).join('\n'), /agent\.models\.implementer was renamed: use implement\.orchestrator\.model \(the implementer is the implement stage's orchestrator; the value names a models\.pool entry/);
});

// Council r5 (A18): every documented sample block in examples/ (a `$...` key holding settings) loads once enabled the
// way its comment says: renamed to the section it names ("rename to \"analysis\""), or with the sections inside it
// renamed into place. The eShop analysis sample still used analysis.fixLoop.bounces.
test('every sample block in examples/, enabled as its comment says, loads with no old or unknown setting', async () => {
  const { analysisProblems } = await import('../lib/analysis/config.mjs');
  const files = spawnSync('git', ['ls-files', 'examples'], { cwd: ROOT, encoding: 'utf8' }).stdout.split('\n').filter((f) => /(^|\/)\.factory\/config\.json$/.test(f));
  const sections = new Set(descriptions().map((d) => segments(d.name)[0]));
  let samples = 0;
  for (const f of files) {
    const doc = JSON.parse(fs.readFileSync(path.join(ROOT, f), 'utf8'));
    for (const [key, block] of Object.entries(doc)) {
      if (!key.startsWith('$') || !block || typeof block !== 'object') continue;
      const { $comment: comment = '', ...inner } = block;
      const named = /rename (?:it )?to \\?"([A-Za-z]+)\\?"/.exec(comment)?.[1];
      const overlay = named ? { [named]: inner } : Object.keys(inner).every((k) => sections.has(k)) ? inner : null;
      assert.ok(overlay, `${f} ${key}: its comment names no section to rename it to, and its keys are not sections`);
      samples += 1;
      assert.deepEqual(settingsProblems(overlay), [], `${f} ${key}`);
      if (overlay.analysis) assert.deepEqual(analysisProblems(overlay.analysis).filter((p) => /is not a setting|renamed/.test(p)), [], `${f} ${key}`);
    }
  }
  assert.ok(samples >= 2, `${samples} samples`);
});
