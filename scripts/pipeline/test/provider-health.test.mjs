// Council C12: BUG-41's PR check agents were 5-10x slower than usual. Their transcripts showed API requests that got
// no answer until the CLI sent them again (one 14.7 minutes later) and agents that waited 5 minutes before their first
// request; nothing in the usage records said so. Each run's provider behaviour is now measured and recorded.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { apiHealth, claudeRunHealth, claudeTranscript, degraded, describeHealth } from '../lib/provider-health.mjs';
import { runConditionsSection } from '../../implement/lib/implement.mjs';
import { usageRecords } from '../lib/usage.mjs';

// The shape of BUG-41's video critic session a25d0a43 (council C12), reduced to the rows that matter.
const BUG41 = [
  { type: 'queue-operation', operation: 'enqueue', timestamp: '2026-11-16T01:33:45.148Z' },
  { type: 'queue-operation', operation: 'dequeue', timestamp: '2026-11-16T01:33:45.150Z' },
  { type: 'api-request', id: 'r1', timestamp: '2026-11-16T01:33:45.284Z' },
  { type: 'assistant', requestRef: 'r1', timestamp: '2026-11-16T01:33:59.000Z' },
  { type: 'api-request', id: 'r2', timestamp: '2026-11-16T01:34:01.236Z' },
  { type: 'assistant', requestRef: 'r2', timestamp: '2026-11-16T01:34:04.000Z' },
  { type: 'api-request', id: 'r3', timestamp: '2026-11-16T01:34:04.943Z' }, // never answered
  { type: 'api-request', id: 'r4', timestamp: '2026-11-16T01:48:45.200Z' }, // the CLI's retry
  { type: 'assistant', requestRef: 'r4', timestamp: '2026-11-16T01:49:03.046Z' },
];

test('a request that got no answer and was sent again is counted with the time it lost (BUG-41)', () => {
  const h = apiHealth(BUG41);
  assert.deepEqual({ ...h }, { requests: 4, resent: 1, stalledSec: 880, errors: 0, rateLimited: false, overloaded: false, startupSec: 0 });
  assert.equal(degraded(h), true);
  assert.equal(describeHealth(h), '1 API request(s) got no answer and were sent again (15 min lost)');
});

test('a slow start and rate-limit errors are reported; a healthy run is not', () => {
  const slow = apiHealth([
    { type: 'queue-operation', operation: 'dequeue', timestamp: '2026-11-16T00:36:57.745Z' },
    { type: 'api-request', id: 'a', timestamp: '2026-11-16T00:42:21.837Z' },
    { type: 'assistant', requestRef: 'a', timestamp: '2026-11-16T00:42:25.000Z' },
    { type: 'system', isApiErrorMessage: true, content: 'API Error: 429 rate_limit_error, retrying in 30s', timestamp: '2026-11-16T00:43:00.000Z' },
  ]);
  assert.equal(slow.startupSec, 324);
  assert.equal(slow.rateLimited, true);
  assert.match(describeHealth(slow), /1 API error\(s\), rate limited; 324 s before its first API request/);
  assert.equal(degraded(apiHealth(BUG41.slice(0, 6))), false);
});

test('the transcript is found from the run\'s session id and working directory', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-'));
  const cwd = '/Users/x/code/shop-worktrees/bug-41';
  const dir = path.join(home, 'projects', '-Users-x-code-shop-worktrees-bug-41');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 's-1.jsonl'), `${BUG41.map((r) => JSON.stringify(r)).join('\n')}\n{"partial`);
  const env = { CLAUDE_CONFIG_DIR: home };
  assert.equal(claudeTranscript('s-1', cwd, env), path.join(dir, 's-1.jsonl'));
  const h = claudeRunHealth(JSON.stringify({ type: 'result', session_id: 's-1', result: 'x' }), cwd, env);
  assert.equal(h.resent, 1);
  assert.equal(claudeRunHealth('not json', cwd, env), null);
  fs.rmSync(home, { recursive: true, force: true });
});

test('the usage record carries the provider behaviour, and the PR body lists a slow provider', () => {
  const [r] = usageRecords({ root: os.tmpdir(), stateDir: '.factory/state' }, { ctx: { story: 'BUG-41' }, agent: 'pr-check-video', mode: 'read', cli: 'claude', alias: 'opus', runId: 'x', api: { ...apiHealth(BUG41) } });
  assert.deepEqual(r.api, { requests: 4, resent: 1, stalled_sec: 880, errors: 0, rate_limited: false, overloaded: false, startup_sec: 0 });
  const section = runConditionsSection([
    { kind: 'provider-slow', story: 'BUG-41', agent: 'pr-check-video', resent: 4, stalledSec: 3600, errors: 0, startupSec: 0 },
    { kind: 'provider-slow', story: 'BUG-41', agent: 'pr-check-design', resent: 0, stalledSec: 0, errors: 0, startupSec: 324 },
    { kind: 'external-call', story: 'BUG-41', call: 'gh pr checks 7 -R', event: 'attempt 1 of 3 timed out, retrying', detail: 'timed out after 120 s' },
  ]);
  assert.match(section, /- External calls: 1 retried after a timeout or a network error/);
  assert.match(section, /- Agent provider: 4 API request\(s\) got no answer and were sent again \(60 min lost\), 0 API error\(s\), 1 slow agent start\(s\); the run took longer, its outcome is unchanged/);
});
