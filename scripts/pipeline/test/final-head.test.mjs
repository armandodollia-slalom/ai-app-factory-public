// The PR's records name the head it opens on (council C11, Sol 3): the Static analysis section reports that head, uses an
// earlier commit's scan as the head's only when the head changed nothing but the pipeline's records since, and otherwise
// shows that scan with its own commit; the promise of a demo video "added below" goes when the recordings are embedded;
// a changed gRPC contract is named in the API section, which reads HTTP endpoints only.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { analysedAncestor, prAnalysisSection } from '../lib/analysis/fixloop.mjs';
import { writeReport } from '../lib/analysis/report.mjs';
import { readMetricsLocal } from '../lib/state.mjs';
import { changedProtos, renderApiSection } from '../../pr-video/lib/api-summary.mjs';
import { withoutDemoPromise } from '../../implement/lib/implement.mjs';

const gitIn = (cwd) => (...args) => {
  const r = spawnSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', '-c', 'core.hooksPath=/dev/null', ...args], { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};
const write = (root, rel, text) => (fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }), fs.writeFileSync(path.join(root, rel), text));
const ANALYSIS = { tools: { t: { run: ['t'], parse: 'sarif', licence: 'MIT' } }, stages: { pair: ['t'], story: ['t'], prCheck: ['t'] } };

function story() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'final-head-')));
  const git = gitIn(root);
  git('init', '-q', '-b', 'main');
  write(root, '.gitignore', '.factory/state/\n');
  write(root, 'src/Api.cs', 'class Api {}\n');
  git('add', '-A');
  git('commit', '-qm', 'base');
  const commit = (rel, text, msg) => (write(root, rel, text), git('add', '-A'), git('commit', '-qm', msg), git('rev-parse', 'HEAD'));
  const config = { root, mainRoot: root, stateDir: '.factory/state', metricsDir: '.factory/metrics', project: { languages: [] }, precheck: {}, analysis: ANALYSIS };
  return { root, git, commit, config };
}
const report = (sha, findings = []) => ({ sha, slot: 'prCheck', ts: '2026-11-18T11:00:00Z', tools: [{ id: 't', status: findings.length ? 'findings' : 'ok' }], findings });

test('the section reports the delivered head, not the commit the body was first written on', () => {
  const s = story();
  const scanned = s.commit('src/Api.cs', 'class Api { int X; }\n', 'implementation');
  writeReport(s.config, report(scanned, [{ tool: 't', rule: 'r1', file: 'src/Api.cs', line: 1, severity: 'blocking' }]));
  // Records only since (the pipeline's metrics commit): the scan is the head's, with its open finding.
  const head = s.commit('.factory/metrics/council-rounds.jsonl', '{}\n', 'records');
  const same = prAnalysisSection(s.config, ['S-1'], { cwd: s.root, head });
  assert.match(same, new RegExp(`Report: the PR check's run on ${scanned.slice(0, 7)}; this head \\(${head.slice(0, 7)}\\) changed only the pipeline's records since`));
  assert.match(same, /- Still open on this head: 1 \(1 blocking\)/);
  assert.deepEqual(analysedAncestor(s.config, s.root, head), { sha: scanned, changed: [], kinds: { production: [], tests: [], fromBase: [] }, baseKnown: false });
  // Production code changed since (a CI fixing round): the scan is shown with its commit and never as the head's.
  const fixed = s.commit('src/Api.cs', 'class Api { int Y; }\n', 'ci fix');
  const other = prAnalysisSection(s.config, ['S-1'], { cwd: s.root, head: fixed });
  assert.match(other, new RegExp(`Report: none for this head \\(${fixed.slice(0, 7)}\\)\\. The latest is the PR check's run on ${scanned.slice(0, 7)}; changed since: 1 production file\\(s\\) \\(src/Api.cs\\)\\. It is shown as that commit's result`));
  assert.match(other, new RegExp(`- Still open on ${scanned.slice(0, 7)}: 1 \\(1 blocking\\); on this head: not known`));
  assert.doesNotMatch(other, /Still open on this head: 1/);
  // A report of the head itself wins.
  writeReport(s.config, report(fixed));
  assert.match(prAnalysisSection(s.config, ['S-1'], { cwd: s.root, head: fixed }), new RegExp(`Report: the PR check's run on this head \\(${fixed.slice(0, 7)}\\)[\\s\\S]*Still open on this head: 0`));
});

test('the promise of a demo video added later goes, wherever later sections put it', () => {
  const body = 'Implements S-1.\n\n- Architecture review: approved\n\nThe demo video of the changed e2e specs (and, for backend changes, an API summary of the endpoints) is added below by the PR demo video workflow once it has recorded them.\n\n<!-- council-review:start -->\n## Council\n<!-- council-review:end -->\n\n<!-- static-analysis:start -->\n## Static analysis\n<!-- static-analysis:end -->\n';
  const out = withoutDemoPromise(body);
  assert.doesNotMatch(out, /added below by the PR demo video workflow/);
  assert.match(out, /approved\n\n<!-- council-review:start -->[\s\S]*<!-- static-analysis:end -->\n$/);
  assert.equal(withoutDemoPromise('no promise here\n'), 'no promise here\n');
});

test('a changed gRPC contract is named in the API section, which reads HTTP endpoints only', () => {
  const s = story();
  s.git('checkout', '-qb', 'feat/s-1');
  s.commit('src/Basket.API/Proto/basket.proto', 'message BasketItem { string gift_message = 7; }\n', 'proto');
  assert.deepEqual(changedProtos(s.root, 'main'), ['src/Basket.API/Proto/basket.proto']);
  const only = renderApiSection({ endpoints: [], headSha: 'b81f73c000', origin: 'read by the `aspnet-minimal` route extractor', protos: changedProtos(s.root, 'main') });
  assert.match(only, /## API changes\n\nNo HTTP endpoint changes found \(read by the `aspnet-minimal` route extractor; commit b81f73c\)\. gRPC contract changes are not extracted: this PR changes `src\/Basket.API\/Proto\/basket.proto`/);
  assert.equal(renderApiSection({ endpoints: [] }), null, 'nothing changed: no section');
  const both = renderApiSection({ endpoints: [{ change: 'added', method: 'GET', route: '/api/x', service: 'api', calls: [], operation: null, examples: [] }], protos: ['a.proto'] });
  assert.match(both, /HTTP endpoints this PR adds[\s\S]*gRPC contract changes are not extracted: this PR changes `a.proto`[\s\S]*Added \| `GET` \| `\/api\/x`/);
});

// Held-out C18 (found after the freeze): BUG-52's section said "7 production file(s) changed since" and SHIP-1's 18, counting
// test plans, e2e specs and the files a merge of main brought in.
test('files changed since the scan are named by kind: this change\'s production files, tests and plans, the base merge', () => {
  const s = story();
  s.git('checkout', '-qb', 'feat/s-1');
  const scanned = s.commit('src/Api.cs', 'class Api { int X; }\n', 'implementation');
  writeReport(s.config, { ...report(scanned), slot: 'pair' });
  s.commit('.factory/plans/S-1/TC-S-1-01.md', '# case\n', 'plan');
  s.commit('e2e/s-1.spec.ts', 'test()\n', 'spec');
  s.commit('tests/Api.Tests/ApiTests.cs', 'class ApiTests {}\n', 'unit test');
  // A scenario of the story's test stack, with no scenariosDir in the worktree's config (held-out C19: BUG-53's
  // scenario.yaml was counted as a production file).
  s.commit('.factory/stack/scenarios/s-1/scenario.yaml', 'name: s-1\n', 'scenario');
  // main moves; the branch merges it (the PR's "keep mergeable" merge).
  s.git('checkout', '-q', 'main');
  s.commit('src/Other.cs', 'class Other {}\n', 'someone else');
  s.commit('docs/notes.md', 'notes\n', 'someone else, docs');
  s.git('checkout', '-q', 'feat/s-1');
  s.git('-c', 'core.editor=true', 'merge', '-q', '--no-edit', 'main');
  const head = s.git('rev-parse', 'HEAD');
  const anc = analysedAncestor(s.config, s.root, head, { base: 'main' });
  assert.deepEqual(anc.kinds, { production: [], tests: ['.factory/plans/S-1/TC-S-1-01.md', '.factory/stack/scenarios/s-1/scenario.yaml', 'e2e/s-1.spec.ts', 'tests/Api.Tests/ApiTests.cs'], fromBase: ['docs/notes.md', 'src/Other.cs'] });
  const text = prAnalysisSection(s.config, ['S-1'], { cwd: s.root, head, base: 'main' });
  assert.doesNotMatch(text, /production file/);
  assert.match(text, /changed since: 4 test or test plan file\(s\) \(\.factory\/plans\/S-1\/TC-S-1-01\.md, \.factory\/stack\/scenarios\/s-1\/scenario\.yaml, e2e\/s-1\.spec\.ts, tests\/Api\.Tests\/ApiTests\.cs\), 2 file\(s\) from the merge of the base branch \(docs\/notes\.md, src\/Other\.cs\)\. It is shown as that commit's result, not this head's/);
  assert.match(text, new RegExp(`Still open on ${scanned.slice(0, 7)}: 0; on this head: not known`));
  // A later production change of the story is counted as one, and only it.
  const fix = s.commit('src/Api.cs', 'class Api { int Y; }\n', 'ci fix');
  assert.match(prAnalysisSection(s.config, ['S-1'], { cwd: s.root, head: fix, base: 'main' }), /changed since: 1 production file\(s\) of this change \(src\/Api\.cs\), 4 test or test plan file\(s\)/);
});

// Held-out C18 (found after the freeze): no story or PR-check scan existed for either delivered head, so the section fell
// back to an early pair-round scan. The delivery scans the head it opens the PR on (deterministic tools, no agent).
test('the delivery scans the head it opens the PR on, and the body reports that scan as the head\'s', async () => {
  const { deliverFinished } = await import('../../implement/lib/implement.mjs');
  const s = story();
  // A tool of the PR check's slot: one finding per line holding TODO, in any tracked file.
  const tool = path.join(s.root, '..', `todo-${path.basename(s.root)}.mjs`);
  fs.writeFileSync(tool, "import { execSync } from 'node:child_process'; import fs from 'node:fs'; const out = []; for (const f of execSync('git ls-files', { encoding: 'utf8' }).split('\\n').filter(Boolean)) fs.readFileSync(f, 'utf8').split('\\n').forEach((l, i) => { if (l.includes('TODO')) out.push({ RuleID: 'todo', File: f, StartLine: i + 1, Secret: l }); }); console.log(JSON.stringify(out));");
  s.config.analysis = { tools: { todo: { licence: 'MIT', run: [process.execPath, tool], parse: 'gitleaks-json', scope: 'repo', baseline: 'native', block: { rules: ['*'] } } }, stages: { pair: ['todo'], story: ['todo'], prCheck: ['todo'] } };
  s.config.implement = {};
  s.git('checkout', '-qb', 'feat/s-1');
  const scanned = s.commit('src/Api.cs', 'class Api { int X; }\n', 'implementation');
  writeReport(s.config, { ...report(scanned), slot: 'pair', tools: [{ id: 'todo', status: 'ok' }] });
  // After the pair round: the tests, and a production change carrying a finding the pair scan never saw.
  s.commit('e2e/s-1.spec.ts', 'test()\n', 'spec');
  // The pipeline's records are tracked on the branch (a metrics shard committed with the work).
  s.commit('.factory/metrics/token-usage.jsonl.d/s-1.jsonl', '{"stage":"implement"}\n', 'records');
  const head = s.commit('src/Api.cs', 'class Api { int X; } // TODO\n', 'pr check fix');
  let opened = null;
  const io = {
    // As the live run does (held-out C19, BUG-53): the push and the CI wait write the pipeline's own records, so the
    // tracked shard is modified and run state is untracked when the delivery scans the head.
    push: () => {
      fs.appendFileSync(path.join(s.root, '.factory/metrics/token-usage.jsonl.d/s-1.jsonl'), '{"stage":"push"}\n');
      write(s.root, '.factory/metrics/run-conditions.jsonl.d/s-1.jsonl', '{"ok":true}\n');
      return { pushed: true };
    },
    repo: () => 'acme/shop',
    gate: async () => ({ state: 'success', names: ['CI'], failing: [], pending: [], rounds: 0 }),
    publishTicket: () => {},
    assess: () => null,
    publishGate: () => {},
    regate: () => {},
    media: () => ({ notes: [] }),
    updateBody: () => {},
    release: () => {},
    ownsPr: () => true,
    stateDecision: async () => {},
    usage: () => [],
  };
  const out = await deliverFinished(s.config, s.config, { id: 'S-1', keys: ['S-1'], label: 'S-1', branch: 'feat/s-1', worktree: s.root, base: 'main', title: 't', body: 'Implements S-1.\n\n- Test plan and automated tests: verified\n', isBug: false, io, save: () => {}, load: () => ({}), open: ({ body }) => ((opened = body), { pushed: true, url: 'https://github.com/acme/shop/pull/1' }) });
  assert.equal(out.finalSha, head);
  assert.match(opened, new RegExp(`- Report: the delivery's run on this head \\(${head.slice(0, 7)}\\)`));
  assert.match(opened, /- Still open on this head: 1 \(1 blocking\)\n {2}- todo `todo` src\/Api\.cs:1/);
  assert.doesNotMatch(opened, /a pair round's run|none for this head/);
  const runs = readMetricsLocal(s.config, 'analysis-runs.jsonl');
  assert.deepEqual(runs.map((r) => [r.stage, r.sha, r.tree, r.covers]), [['delivery', head, 'clean', head]]);
  // The scan is kept as the head's own report (not discarded because the records were uncommitted).
  assert.ok(fs.existsSync(path.join(s.root, '.factory/state/analysis/reports', head, 'prCheck.json')), 'the delivered head has its own kept scan');
});
