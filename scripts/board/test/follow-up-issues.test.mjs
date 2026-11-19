// Council C6: a follow-up the PR leaves out is filed as an issue (one per title), not only listed.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileFollowUps } from '../lib/epics.mjs';

test('each follow-up becomes one issue; an open one with the same title is reused', () => {
  const calls = [];
  const issues = [{ number: 5, title: 'Follow-up: Log levels', url: 'https://github.com/a/b/issues/5' }];
  const gh = (args, o = {}) => {
    calls.push([...args, o.input ?? '']);
    if (args[1] === 'list') return { status: 0, stdout: JSON.stringify(issues) };
    if (args[1] === 'create') return { status: 0, stdout: 'https://github.com/a/b/issues/9\n' };
    return { status: 0, stdout: '' };
  };
  const filed = fileFollowUps({ root: '/tmp', board: { repo: 'a/b' }, tickets: { repo: 'a/b' } }, '- BUG-1: Log levels (PR check before this PR FLOW-1-1)\n- Quantity overflow on merge (the sum can wrap)', { pr: 'https://github.com/a/b/pull/3', key: 'BUG-1', gh });
  assert.deepEqual(filed.map((f) => [f.title, f.existing]), [['Follow-up: Log levels', true], ['Follow-up: Quantity overflow on merge', false]]);
  assert.equal(calls.filter((c) => c[1] === 'create').length, 1);
  assert.match(calls.find((c) => c[1] === 'create').join(' '), /Left out of https:\/\/github.com\/a\/b\/pull\/3 for BUG-1/);
});
