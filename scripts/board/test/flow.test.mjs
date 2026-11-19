// The board's state machine against a fake gh (test/fixtures/fake-gh.mjs): transitions, sequence numbers,
// claims, epic lanes and evidence, `board sync`, the interactive hooks and the removed `board pick`.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { listItems, resetMemo, setup } from '../lib/board.mjs';
import { mergeEpicEvidence, parseEpicEvidence, renderEpicEvidence, upsertEpicEvidence } from '../lib/epics.mjs';
import { TRANSITIONS, allocateSeq, applyEvent, encodeMarker, eventsForState, failStory, flowDir, latestMarker, nextLane, parseMarker, readFlow } from '../lib/flow.mjs';
import { videoFromPrBody } from '../lib/evidence.mjs';
import { syncBoard, syncVideos } from '../lib/sync.mjs';
import { failedResults, skipRefused } from '../../implement/lib/board-events.mjs';
import { seedTicket } from '../../pipeline/test/fixtures/tickets.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const BOARD_CLI = path.resolve(here, '..', 'board.mjs');
const COLUMNS = { backlog: 'Backlog', ready: 'Ready', inProgress: 'In Progress', testing: 'Testing', review: 'Pending Review', failed: 'Failed', done: 'Done' };
const OPTIONS = Object.fromEntries(Object.values(COLUMNS).map((name, i) => [name, `opt-${i}`]));

// A git repo, a fake gh first on PATH and its state: epic #10 with stories #12 (DEMO-1) and #13 (DEMO-2).
function fixture({ issues = {}, origin = null, prs = [] } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'board-flow-'));
  spawnSync('git', ['init', '-q', root]);
  if (origin) spawnSync('git', ['-C', root, 'remote', 'add', 'origin', origin]);
  const bin = path.join(root, '.bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'gh'), `#!/bin/sh\nexec "${process.execPath}" "${path.join(here, 'fixtures', 'fake-gh.mjs')}" "$@"\n`, { mode: 0o755 });
  const stateFile = path.join(root, '.gh.json');
  const base = {
    10: { title: 'Epic: Demo', labels: ['epic'], item: 'I10', column: 'Backlog', comments: [] },
    12: { title: 'DEMO-1: First', labels: ['story'], item: 'I12', column: 'Ready', parent: 10, comments: [] },
    13: { title: 'DEMO-2: Second', labels: ['story'], item: 'I13', column: 'Backlog', parent: 10, comments: [] },
  };
  fs.writeFileSync(stateFile, JSON.stringify({ repo: 'acme/shop', login: 'me', options: OPTIONS, issues: { ...base, ...issues }, prs }));
  const env = { PATH: `${bin}:/usr/bin:/bin`, FAKE_GH_STATE: stateFile, PIPELINE_BOARD_OWNER: 'me@box' };
  Object.assign(process.env, env);
  resetMemo();
  const config = {
    root,
    stateDir: '.factory/state',
    metricsDir: '.factory/metrics',
    tickets: { dir: '.factory/state/board', repo: 'acme/shop' },
    board: { repo: 'acme/shop', owner: 'acme', ownerType: 'user', projectNumber: 1, statusField: 'Status', columns: COLUMNS, storyLabel: 'story', blockedLabel: 'needs-human', epicLabel: 'epic' },
  };
  const gh = () => JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  const edit = (fn) => {
    const s = gh();
    fn(s);
    fs.writeFileSync(stateFile, JSON.stringify(s));
  };
  return { root, config, gh, edit, env, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('the transition table: Testing goes back to In Progress only on a product bug', () => {
  assert.equal(nextLane('ready', 'claim'), 'inProgress');
  assert.equal(nextLane('failed', 'claim'), 'inProgress');
  assert.equal(nextLane('inProgress', 'testing'), 'testing');
  assert.equal(nextLane('testing', 'product-bug'), 'inProgress');
  assert.equal(nextLane('testing', 'verified'), 'review');
  assert.equal(nextLane('inProgress', 'verified'), 'review', 'a missed Testing event does not strand the card');
  assert.equal(nextLane('testing', 'failed'), 'failed');
  assert.equal(nextLane('review', 'closed'), 'done');
  for (const [event, t] of Object.entries(TRANSITIONS)) if (event !== 'product-bug') assert.ok(!(t.from.includes('testing') && t.to === 'inProgress'), `${event} must not move Testing back`);
  assert.equal(nextLane('testing', 'claim'), null);
  assert.equal(nextLane('testing', 'claim', { force: true }), 'inProgress');
  assert.equal(nextLane('review', 'claim'), null);
  assert.equal(nextLane('review', 'claim', { force: true }), 'inProgress');
  assert.equal(nextLane('review', 'testing'), null);
  assert.equal(nextLane('failed', 'testing'), null);
  assert.equal(nextLane('done', 'failed'), null);
  assert.equal(nextLane('ready', 'nope'), null);
});

test('sequence numbers: markers round-trip, replays keep their number, the latest marker wins', () => {
  const m = { seq: 3, owner: 'a@b', event: 'claim', column: 'inProgress', note: 'x -- y' };
  assert.ok(!encodeMarker(m).slice(4, -3).includes('--'), 'no -- inside the HTML comment');
  assert.deepEqual(parseMarker(`text\n\n${encodeMarker(m)}`), m);
  assert.equal(latestMarker([{ body: encodeMarker({ seq: 1 }) }, { body: 'plain' }, { body: encodeMarker({ seq: 4 }) }]).seq, 4);
  const flow = { allocated: 2, ids: {} };
  assert.equal(allocateSeq(flow, 'testing:h1', 5), 6, 'next after the last applied anywhere');
  assert.equal(allocateSeq(flow, 'testing:h1', 9), 6, 'a replay keeps its number');
  assert.equal(allocateSeq(flow, null, 0), 7);
});

test('a story moves through the pipeline events, back on a product bug, and its epic follows', () => {
  const f = fixture();
  try {
    const col = (n) => f.gh().issues[n].column;
    const apply = (type, id, body = `${type} happened`) => applyEvent(f.config, 'DEMO-1', { type, id, body });
    assert.equal(apply('claim', 'claim:1').status, 'applied');
    assert.equal(col(12), 'In Progress');
    assert.equal(col(10), 'In Progress', 'the epic follows its stories');
    assert.equal(apply('testing', 'testing:h1').to, 'testing');
    assert.equal(col(10), 'Testing');
    const bug = apply('product-bug', 'bug:t1', 'Feature verification found 1 product bug(s)');
    assert.deepEqual([bug.from, bug.to], ['testing', 'inProgress']);
    assert.equal(apply('testing', 'testing:h2').to, 'testing');
    assert.equal(apply('verified', 'verified:h2').to, 'review');
    assert.equal(col(12), 'Pending Review');
    assert.equal(col(10), 'In Progress', 'DEMO-2 still waits in Backlog');

    const comments = f.gh().issues[12].comments;
    assert.equal(comments.length, 5);
    assert.deepEqual(comments.map((c) => parseMarker(c.body).seq), [1, 2, 3, 4, 5]);
    assert.deepEqual(comments.map((c) => parseMarker(c.body).owner), Array(5).fill('me@box'));
    assert.equal(readFlow(f.config, 'DEMO-1').applied, 5);
    assert.ok(flowDir(f.config).startsWith(fs.realpathSync(path.join(f.root, '.git'))) || flowDir(f.config).startsWith(path.join(f.root, '.git')), 'kept under the git common dir');
  } finally {
    f.cleanup();
  }
});

test('stale and replayed events are ignored', () => {
  const f = fixture();
  try {
    applyEvent(f.config, 'DEMO-1', { type: 'claim', id: 'claim:1', body: 'claimed' });
    applyEvent(f.config, 'DEMO-1', { type: 'testing', id: 'testing:h1', body: 'testing' });
    const replay = applyEvent(f.config, 'DEMO-1', { type: 'testing', id: 'testing:h1', body: 'testing' });
    assert.equal(replay.status, 'stale');
    assert.equal(f.gh().issues[12].comments.length, 2, 'a replay posts nothing');

    // An event numbered before another machine's later event (seen in the card's marker) is stale.
    const flow = readFlow(f.config, 'DEMO-1');
    fs.writeFileSync(path.join(flowDir(f.config), 'DEMO-1.json'), JSON.stringify({ ...flow, ids: { ...flow.ids, 'bug:old': 3 } }));
    f.edit((s) => s.issues[12].comments.push({ id: 7, body: encodeMarker({ seq: 6, owner: 'me@box', event: 'testing', column: 'testing' }) }));
    const old = applyEvent(f.config, 'DEMO-1', { type: 'product-bug', id: 'bug:old', body: 'bug' });
    assert.deepEqual([old.status, old.seq, old.last], ['stale', 3, 6]);
    assert.equal(f.gh().issues[12].column, 'Testing');
    // A new event is numbered after the remote marker.
    assert.equal(applyEvent(f.config, 'DEMO-1', { type: 'verified', id: 'verified:h1', body: 'ok' }).seq, 7);
    // An event the table does not allow from the current lane changes nothing.
    assert.equal(applyEvent(f.config, 'DEMO-1', { type: 'testing', id: 'testing:h9', body: 'x' }).status, 'not-allowed');
    assert.equal(f.gh().issues[12].column, 'Pending Review');
    // A story that failed in one run and is verified by a later one leaves Failed for Pending Review.
    // Review -> Failed is allowed: a PR check that ends with a question for the ticket's owner (council C6).
    assert.equal(applyEvent(f.config, 'DEMO-1', { type: 'failed', id: 'failed:run1', body: 'failed' }).status, 'applied');
    f.edit((st) => (st.issues[12].column = 'Failed'));
    const later = applyEvent(f.config, 'DEMO-1', { type: 'verified', id: 'verified:h2', body: 'ok' });
    assert.equal(later.status, 'applied');
    assert.equal(f.gh().issues[12].column, 'Pending Review');
  } finally {
    f.cleanup();
  }
});

test("a card another machine holds is not claimed without --force, and that machine's events then stop applying", () => {
  const held = { title: 'DEMO-1: First', labels: ['story'], item: 'I12', column: 'Testing', parent: 10, comments: [{ id: 1, body: `Claimed\n\n${encodeMarker({ seq: 4, owner: 'other@far', event: 'testing', column: 'testing' })}` }] };
  const f = fixture({ issues: { 12: held } });
  try {
    const refused = applyEvent(f.config, 'DEMO-1', { type: 'claim', id: 'claim:a', body: 'claim' });
    assert.deepEqual([refused.status, refused.owner], ['refused', 'other@far']);
    assert.equal(applyEvent(f.config, 'DEMO-1', { type: 'verified', id: 'verified:x', body: 'x' }).status, 'not-owner');
    assert.equal(f.gh().issues[12].column, 'Testing');

    const notTaken = applyEvent(f.config, 'DEMO-1', { type: 'claim', id: 'claim:f', force: true, body: 'claim' });
    assert.equal(notTaken.status, 'refused', '--force alone does not take a card another machine holds');
    const forced = applyEvent(f.config, 'DEMO-1', { type: 'claim', id: 'claim:b', takeover: true, body: 'claim' });
    assert.deepEqual([forced.status, forced.from, forced.to], ['applied', 'testing', 'inProgress']);
    assert.equal(parseMarker(f.gh().issues[12].comments.at(-1).body).owner, 'me@box');
    // The other machine (a later event of its own) is now the one locked out.
    process.env.PIPELINE_BOARD_OWNER = 'other@far';
    assert.equal(applyEvent(f.config, 'DEMO-1', { type: 'testing', id: 'testing:late', body: 'x' }).status, 'not-owner');
  } finally {
    process.env.PIPELINE_BOARD_OWNER = 'me@box';
    f.cleanup();
  }
});

test('a failed story goes to Failed with the comment and the needs-human label', () => {
  const f = fixture();
  try {
    applyEvent(f.config, 'DEMO-1', { type: 'claim', id: 'claim:1', body: 'claimed' });
    const r = failStory(f.config, 'DEMO-1', { id: 'failed:1', body: 'The pipeline stopped: **unresolved**.' });
    assert.equal(r.to, 'failed');
    const it = f.gh().issues[12];
    assert.equal(it.column, 'Failed');
    assert.ok(it.labels.includes('needs-human'));
    assert.match(it.comments.at(-1).body, /unresolved/);
    // DEMO-2 sits in Backlog, which cannot move on its own: the epic shows Failed.
    assert.equal(f.gh().issues[10].column, 'Failed');
  } finally {
    f.cleanup();
  }
});

test("an epic's lane follows its stories with the new lanes' precedence", async () => {
  const { epicColumn } = await import('../lib/board.mjs');
  assert.equal(epicColumn([]), 'backlog');
  assert.equal(epicColumn(['done', 'done']), 'done');
  assert.equal(epicColumn(['review', 'done']), 'review');
  assert.equal(epicColumn(['inProgress', 'testing', 'failed']), 'inProgress');
  assert.equal(epicColumn(['testing', 'failed', 'ready']), 'testing');
  assert.equal(epicColumn(['failed', 'backlog', 'done']), 'failed');
  assert.equal(epicColumn(['failed', 'ready']), 'ready', 'a ready story can still move');
  assert.equal(epicColumn(['ready', 'backlog']), 'ready');
  assert.equal(epicColumn(['review', 'backlog']), 'inProgress', 'partly delivered');
  assert.equal(epicColumn(['backlog', null]), 'backlog');
});

test('board sync moves closed stories to Done, records their late outcome and syncs the epic', () => {
  const f = fixture({ issues: { 13: { title: 'DEMO-2: Second', labels: ['story'], item: 'I13', column: 'Testing', state: 'CLOSED', parent: 10, comments: [] }, 12: { title: 'DEMO-1: First', labels: ['story'], item: 'I12', column: 'Done', state: 'CLOSED', parent: 10, comments: [] } } });
  try {
    fs.mkdirSync(path.join(f.root, '.factory/state/implement'), { recursive: true });
    fs.writeFileSync(path.join(f.root, '.factory/state/implement/DEMO-2.json'), JSON.stringify({ key: 'DEMO-2', branch: 'feat/demo-2', decisionId: 'd-1' }));
    const r = syncBoard(f.config, { listStories: () => [] });
    assert.deepEqual(r.done, ['DEMO-2']);
    assert.deepEqual(r.outcomes, ['DEMO-2']);
    assert.equal(f.gh().issues[13].column, 'Done');
    assert.equal(f.gh().issues[10].column, 'Done');
    const late = fs.readFileSync(path.join(f.root, '.factory/metrics/decision-outcomes.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(late[0].type, 'late');
    assert.equal(late[0].story ?? late[0].key, 'DEMO-2');
    const evidence = parseEpicEvidence(f.gh().issues[10].comments[0].body);
    assert.equal(evidence.stories['DEMO-2'].status, 'done');
    // A second sync finds nothing to do.
    assert.deepEqual(syncBoard(f.config, { listStories: () => [] }).done, []);
  } finally {
    f.cleanup();
  }
});

// Dogfood C2: BUG-16's group PR #49 was auto-merged, but its late outcome said "PR not merged": the lookup only
// searched PRs whose head is the story's own branch.
test('a ticket delivered in a group PR gets that PR\'s merge in its late outcome', () => {
  const f = fixture({
    issues: { 13: { title: 'DEMO-2: Second', labels: ['story'], item: 'I13', column: 'Pending Review', state: 'CLOSED', parent: 10, comments: [] } },
    prs: [{ head: 'bugfix/demo/group-a', number: 49, state: 'MERGED', url: 'https://github.com/acme/shop/pull/49', commits: [] }],
  });
  try {
    fs.mkdirSync(path.join(f.root, '.factory/state/implement'), { recursive: true });
    fs.writeFileSync(path.join(f.root, '.factory/state/implement/DEMO-2.json'), JSON.stringify({ key: 'DEMO-2', branch: 'feat/demo-2', base: 'bugfix/demo/group-a', decisionId: 'd-1' }));
    syncBoard(f.config, { listStories: () => [] });
    const late = fs.readFileSync(path.join(f.root, '.factory/metrics/decision-outcomes.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).find((r) => r.type === 'late');
    assert.equal(late.pr, 'https://github.com/acme/shop/pull/49');
    assert.equal(late.prMerged ?? late.pr_merged, true);
  } finally {
    f.cleanup();
  }
});

test('the epic keeps one evidence comment, edited in place, with a section per story and the epic PR', () => {
  const f = fixture();
  try {
    upsertEpicEvidence(f.config, { storyNumber: 12, key: 'DEMO-1', story: { status: 'review', pr: 'https://github.com/acme/shop/pull/5', video: 'https://v/1.webm', apiEvidence: 'https://github.com/acme/shop/issues/12#issuecomment-9' } });
    upsertEpicEvidence(f.config, { storyNumber: 13, key: 'DEMO-2', story: { status: 'failed', branch: 'feat/demo-2' } });
    upsertEpicEvidence(f.config, { epicNumber: 10, epic: { pr: 'https://github.com/acme/shop/pull/9', video: 'https://v/epic.webm' } });
    upsertEpicEvidence(f.config, { storyNumber: 12, key: 'DEMO-1', story: { status: 'done' } });
    const comments = f.gh().issues[10].comments;
    assert.equal(comments.length, 1, 'one rolling comment');
    const body = comments[0].body;
    assert.match(body, /\*\*Epic delivery:\*\* \[pull request\]\(https:\/\/github\.com\/acme\/shop\/pull\/9\) · \[video\]\(https:\/\/v\/epic\.webm\)/);
    assert.match(body, /### DEMO-1 \(#12\): Done\n\n- PR: https:\/\/github\.com\/acme\/shop\/pull\/5\n- Feature video: https:\/\/v\/1\.webm/, 'a status update keeps the links');
    assert.match(body, /- API evidence: \[requests and responses\]\(https:\/\/github\.com\/acme\/shop\/issues\/12#issuecomment-9\)/);
    assert.match(body, /### DEMO-2 \(#13\): Failed\n\n- Branch: `feat\/demo-2`/);
  } finally {
    f.cleanup();
  }
});

test('the epic evidence comment shrinks to one line per story over the size limit', () => {
  let data = { epic: {}, stories: {} };
  for (let i = 1; i <= 40; i++) data = mergeEpicEvidence(data, { key: `X-${i}`, story: { status: 'review', pr: `https://github.com/a/b/pull/${i}`, screenshots: Array.from({ length: 10 }, (_, j) => `https://img/${i}/${j}.png`) } });
  const config = { board: { columns: COLUMNS } };
  const full = renderEpicEvidence(config, data);
  const small = renderEpicEvidence(config, data, { maxChars: 8000 });
  assert.ok(full.includes('Screenshots:'));
  assert.ok(!small.includes('Screenshots:'));
  assert.match(small, /- \*\*X-40\*\*: Pending Review · \[PR\]\(https:\/\/github\.com\/a\/b\/pull\/40\)/);
  assert.equal(Object.keys(parseEpicEvidence(small).stories).length, 40, 'the data survives the compact form');
});

test('interactive sessions: story-start claims, the stop hook reports Testing, the bug, Testing again and Pending Review', () => {
  // The engine's board defaults name no repository: the checkout says which board is its own.
  const f = fixture({ origin: 'https://github.com/acme/shop.git' });
  try {
    fs.mkdirSync(path.join(f.root, '.factory'), { recursive: true });
    fs.writeFileSync(path.join(f.root, '.factory/config.json'), JSON.stringify({ tickets: { repo: 'acme/shop' }, board: { owner: 'acme', ownerType: 'user', repo: 'acme/shop', projectNumber: 1, projectTitle: 'Shop board' } }));
    seedTicket(f.root, { key: 'DEMO-1', slug: 'DEMO-1-first', text: '# DEMO-1: First\n\nText.\n' });
    const env = { ...process.env, ...f.env, PIPELINE_ROOT: f.root, PIPELINE_HEADLESS: '' };
    const cli = (args, extra = {}) => spawnSync(process.execPath, [BOARD_CLI, ...args], { cwd: f.root, env: { ...env, ...extra }, input: '{}', encoding: 'utf8' });
    const stateFile = path.join(f.root, '.factory/state/stories/DEMO-1.json');
    const setState = (patch) => {
      const s = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      fs.writeFileSync(stateFile, JSON.stringify({ ...s, ...patch, review: { ...s.review, ...patch.review }, automation: { ...s.automation, ...patch.automation } }));
    };
    const col = () => f.gh().issues[12].column;

    const start = cli(['hook', 'story-start', 'DEMO-1']);
    assert.equal(start.status, 0, start.stderr);
    assert.match(start.stdout, /DEMO-1 \(#12\) moved to In Progress/);
    fs.writeFileSync(path.join(f.root, '.factory/state/active-story'), 'DEMO-1\n');

    setState({ done: { hash: 'h1' }, review: { lastVerdict: 'APPROVED', approvedHash: 'h1' }, automation: { status: 'starting', workingHash: 'h1' } });
    cli(['hook', 'stop']);
    assert.equal(col(), 'Testing');
    cli(['hook', 'stop']);
    assert.equal(f.gh().issues[12].comments.length, 2, 'a repeated stop reports nothing new');

    setState({ automation: { status: 'product-bug', bugs: [{ case: 'TC-DEMO-1-01', actual: '500' }], finishedAt: 't1' } });
    cli(['hook', 'stop']);
    assert.equal(col(), 'In Progress');
    assert.match(f.gh().issues[12].comments.at(-1).body, /Feature verification found 1 product bug\(s\)[\s\S]*TC-DEMO-1-01: 500/);

    setState({ review: { approvedHash: 'h2' }, automation: { status: 'starting', workingHash: 'h2' } });
    cli(['hook', 'stop']);
    assert.equal(col(), 'Testing');

    // Headless runs report from the runner, so the hooks leave the card alone.
    setState({ automation: { status: 'verified', verifiedHash: 'h2', requestedHash: null } });
    cli(['hook', 'stop'], { PIPELINE_HEADLESS: '1' });
    assert.equal(col(), 'Testing');
    cli(['hook', 'stop']);
    assert.equal(col(), 'Pending Review');
    assert.match(f.gh().issues[12].comments.at(-1).body, /## Ready for review/);
    assert.equal(parseEpicEvidence(f.gh().issues[10].comments[0].body).stories['DEMO-1'].status, 'review');
    assert.deepEqual(f.gh().issues[12].comments.map((c) => parseMarker(c.body).event), ['claim', 'testing', 'product-bug', 'testing', 'verified']);
  } finally {
    f.cleanup();
  }
});

test('the stop hook derives the events from the pipeline state in order', () => {
  assert.deepEqual(eventsForState({ review: {}, automation: { status: 'idle' } }), []);
  assert.deepEqual(eventsForState({ review: { lastVerdict: 'APPROVED', approvedHash: 'h' }, automation: { status: 'running', workingHash: 'h' } }).map((e) => e.id), ['testing:h']);
  assert.deepEqual(eventsForState({ review: { lastVerdict: 'APPROVED', approvedHash: 'h2' }, automation: { status: 'starting', workingHash: 'h2', bugs: ['b'], finishedAt: 't' } }).map((e) => e.id), ['bug:t', 'testing:h2'], 'the bug, then the fix under test');
  assert.deepEqual(eventsForState({ done: { hash: 'h' }, review: {}, automation: { status: 'verified', verifiedHash: 'h' } }).map((e) => e.type), ['verified']);
  assert.deepEqual(eventsForState({ done: null, review: {}, automation: { status: 'verified', verifiedHash: 'h' } }), [], 'not before the line of work is done');
});

test('board pick is gone', () => {
  const r = spawnSync(process.execPath, [BOARD_CLI, 'pick', '--once'], { encoding: 'utf8', env: { ...process.env, PIPELINE_BOARD: '0' } });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /`board pick` was removed[\s\S]*implement run <KEY>/);
  assert.doesNotMatch(spawnSync(process.execPath, [BOARD_CLI, 'help'], { encoding: 'utf8' }).stdout, /^\s+pick /m);
});

test('implement run skips stories another machine holds (and stories stacked on them) and fails the unfinished ones', () => {
  const stories = [{ key: 'A-1', deps: [] }, { key: 'A-2', deps: ['A-1'] }, { key: 'A-3', deps: [] }, { key: 'A-4', deps: [], skip: 'already implemented' }];
  const claims = new Map([['A-1', { key: 'A-1', status: 'refused', owner: 'x@y', from: 'testing' }], ['A-3', { key: 'A-3', status: 'applied' }]]);
  assert.deepEqual(skipRefused(stories, claims), ['A-1', 'A-2']);
  assert.match(stories[0].skip, /claimed by x@y/);
  assert.match(stories[1].skip, /blocker A-1/);
  assert.equal(stories[2].skip, undefined);
  const results = [
    { key: 'A-1', outcome: 'skipped', reason: 'claimed by x@y on the board' },
    { key: 'A-2', outcome: 'skipped', reason: 'blocker A-5 ended unresolved' },
    { key: 'A-3', outcome: 'done', pr: 'u' },
    { key: 'A-4', outcome: 'done', pr: null },
    { key: 'A-5', outcome: 'unresolved' },
  ];
  assert.deepEqual(failedResults(results, { pr: true }).map((r) => r.key), ['A-2', 'A-4', 'A-5']);
  assert.deepEqual(failedResults(results, { pr: false }).map((r) => r.key), ['A-2', 'A-5']);
});

test('the feature video comes from the PR demo video section; notes without a recording are not videos', () => {
  const section = (inner) => `Intro\n\n<!-- pr-demo-video:start -->\n## Demo video\n\n${inner}\n\n<sub>Updated by \`.github/workflows/pr-demo-video.yml\` on every push; edits inside this section are overwritten.</sub>\n<!-- pr-demo-video:end -->\n\nCloses #12`;
  const url = 'https://github.com/acme/shop/blob/pr-videos/pr-7/cart.webm';
  const v = videoFromPrBody(section(`Recorded on the test stack.\n\n### ✅ Cart\n\n[![Cart](https://github.com/acme/shop/blob/pr-videos/pr-7/cart.gif?raw=true)](${url})\n\n[Full video (WebM)](${url}) · \`cart.webm\``));
  assert.equal(v.url, url);
  assert.match(v.markdown, /### ✅ Cart/);
  assert.doesNotMatch(v.markdown, /## Demo video|Updated by/);
  assert.equal(videoFromPrBody(section('No frontend changes; no video recorded (commit abc1234).')), null);
  assert.equal(videoFromPrBody('no section here'), null);
  assert.equal(videoFromPrBody(null), null);
});

test('board sync posts feature videos published after Pending Review, on the story and the epic, once', () => {
  const f = fixture();
  try {
    upsertEpicEvidence(f.config, { epicNumber: 10, storyNumber: 12, key: 'DEMO-1', story: { status: 'review', pr: 'https://github.com/acme/shop/pull/7' } });
    upsertEpicEvidence(f.config, { epicNumber: 10, storyNumber: 13, key: 'DEMO-2', story: { status: 'inProgress' } });
    upsertEpicEvidence(f.config, { epicNumber: 10, epic: { pr: 'https://github.com/acme/shop/pull/9' } });
    const items = [{ number: 10, labels: ['epic'] }];
    assert.deepEqual(syncVideos(f.config, items, { findVideo: () => null }), [], 'nothing published yet');
    const calls = [];
    const findVideo = (pr, key) => (calls.push(key), { url: `${pr}/video.webm`, markdown: `[Full video (WebM)](${pr}/video.webm)` });
    assert.deepEqual(syncVideos(f.config, items, { findVideo }), ['DEMO-1', 'epic#10']);
    assert.deepEqual(calls, ['DEMO-1', 'epic #10'], 'stories without a PR are skipped');
    assert.match(f.gh().issues[12].comments.at(-1).body, /### Feature video[\s\S]*pull\/7\/video\.webm/);
    const data = parseEpicEvidence(f.gh().issues[10].comments[0].body);
    assert.equal(data.stories['DEMO-1'].video, 'https://github.com/acme/shop/pull/7/video.webm');
    assert.equal(data.epic.video, 'https://github.com/acme/shop/pull/9/video.webm');
    assert.deepEqual(syncVideos(f.config, items, { findVideo }), [], 'a second sync finds nothing to do');
  } finally {
    f.cleanup();
  }
});

test('board setup on a project other repositories share: only this repository\'s cards change; columns and views stay', () => {
  const f = fixture({
    issues: {
      20: { title: 'BUG-1: theirs, no lane', labels: ['story'], item: 'I20', column: null, repo: 'acme/other', comments: [] },
      21: { title: 'Epic: theirs', labels: ['epic'], item: 'I21', column: 'Done', repo: 'acme/other', comments: [] },
      22: { title: 'BUG-2: theirs, open', labels: ['story'], item: 'I22', column: 'Backlog', parent: 21, repo: 'acme/other', comments: [] },
      30: { title: 'DEMO-3: ours, no lane', labels: ['story'], item: 'I30', column: null, comments: [] },
    },
  });
  try {
    f.edit((s) => {
      delete s.options.Failed;
      s.views = [{ id: 'V1', name: 'Their view', filter: '' }];
    });
    const logs = [];
    setup(f.config, { log: (m) => logs.push(m), writeProjectNumber: () => {} });
    const after = f.gh();
    assert.deepEqual(after.mutations ?? [], [], 'no field, option or view mutation on a shared project');
    assert.equal(after.issues['20'].column, null, "another repository's column-less card is not placed");
    assert.equal(after.issues['21'].column, 'Done', "another repository's epic is not moved");
    assert.equal(after.issues['30'].column, 'Backlog', "this repository's column-less card gets a lane");
    assert.ok(logs.some((l) => /shared/.test(l)) && logs.some((l) => /missing columns: Failed/.test(l)), logs.join('\n'));
  } finally {
    f.cleanup();
  }
});

test('board setup --dry-run on a shared project: prints the changes it would make and makes none', () => {
  const f = fixture({
    issues: {
      21: { title: 'Epic: theirs', labels: ['epic'], item: 'I21', column: 'Done', repo: 'acme/other', comments: [] },
      22: { title: 'BUG-2: theirs, open', labels: ['story'], item: 'I22', column: null, parent: 21, repo: 'acme/other', comments: [] },
      30: { title: 'DEMO-3: ours, no lane', labels: ['story'], item: 'I30', column: null, comments: [] },
    },
  });
  try {
    const before = f.gh();
    const logs = [];
    setup(f.config, { log: (m) => logs.push(m), writeProjectNumber: () => {}, dryRun: true });
    const after = f.gh();
    assert.deepEqual(after.mutations ?? [], [], 'no field, option or view mutation');
    assert.deepEqual(after.writes ?? [], [], 'no repository change');
    assert.equal((after.linked ?? []).length, (before.linked ?? []).length, 'not linked');
    for (const n of ['21', '22', '30']) assert.equal(after.issues[n].column, before.issues[n].column, `#${n} untouched`);
    assert.ok(!after.calls.some((c) => /^(label create|project item-edit|project link|repo edit)/.test(c)), after.calls.join('\n'));
    const text = logs.join('\n');
    assert.match(text, /would enable issues/);
    assert.match(text, /would link project #1/);
    assert.match(text, /would put .*#30 .* in Backlog/);
    assert.doesNotMatch(text, /#22/, "another repository's card is not even proposed");
    assert.match(text, /dry run: \d+ change\(s\) above; none made/);
  } finally {
    f.cleanup();
  }
});


test('board sync on a shared project touches only this repository\'s cards: another repository\'s closed story stays where it is (dogfood step 5)', () => {
  const f = fixture({
    issues: {
      38: { title: 'BUG-16: theirs, closed', labels: ['story'], item: 'I38', column: 'Pending Review', state: 'CLOSED', parent: 64, repo: 'acme/other', comments: [] },
      64: { title: 'Epic: theirs', labels: ['epic'], item: 'I64', column: 'Pending Review', repo: 'acme/other', comments: [] },
      30: { title: 'DEMO-3: ours, closed', labels: ['story'], item: 'I30', column: 'Pending Review', state: 'CLOSED', comments: [] },
    },
  });
  try {
    const r = syncBoard(f.config, { listStories: () => [], findVideo: () => null, gate: () => ({ reopens: [], regated: [], reopenedLabel: 'reopened' }) });
    const after = f.gh();
    assert.equal(after.issues['38'].column, 'Pending Review', "another repository's closed card is not moved");
    assert.equal(after.issues['64'].column, 'Pending Review', "another repository's epic is not moved");
    assert.equal(after.issues['30'].column, 'Done', "this repository's closed card moves to Done");
    assert.deepEqual(r.done, ['DEMO-3']);
    assert.ok(listItems(f.config).every((i) => i.repo === 'acme/shop'), 'listItems returns this repository only');
    assert.equal(listItems(f.config, { all: true }).filter((i) => i.repo === 'acme/other').length, 2, 'unless all is asked for');
  } finally {
    f.cleanup();
  }
});

test('a card claimed again out of Failed loses the needs-human label of the earlier failure (dogfood step 5)', () => {
  const f = fixture({ issues: { 12: { title: 'DEMO-1: First', labels: ['story', 'needs-human'], item: 'I12', column: 'Failed', parent: 10, comments: [] } } });
  try {
    const r = applyEvent(f.config, 'DEMO-1', { type: 'claim', id: 'claim:again', force: true, body: 'claimed' });
    assert.equal(r.status, 'applied');
    assert.equal(f.gh().issues['12'].column, 'In Progress');
    assert.deepEqual(f.gh().issues['12'].labels, ['story']);
  } finally {
    f.cleanup();
  }
});

// Council C3 (Sol 6): the gate's own merge closed the ticket, but the card stayed in Pending Review until another sync.
test('board sync moves a card to Done in the same sync when the gate\'s merge closed its issue', () => {
  const f = fixture({ issues: { 14: { title: 'DEMO-3: Third', labels: ['story'], item: 'I14', column: 'Pending Review', state: 'OPEN', parent: 10, comments: [] } } });
  try {
    const gate = () => {
      f.edit((st) => { st.issues[14].state = 'CLOSED'; });
      return { reopens: [], regated: ['https://github.com/acme/shop/pull/9'], reopenedLabel: 'reopened' };
    };
    const r = syncBoard(f.config, { listStories: () => [], gate });
    assert.deepEqual(r.done, ['DEMO-3']);
    assert.equal(f.gh().issues[14].column, 'Done');
  } finally {
    f.cleanup();
  }
});

// Council C6: a PR check that ends with a question for the ticket's owner moves a card in review to Failed.
test('an owner decision moves a card in review to Failed', async () => {
  const { nextLane } = await import('../lib/flow.mjs');
  assert.equal(nextLane('review', 'failed'), 'failed');
  assert.equal(nextLane('done', 'failed'), null);
});
