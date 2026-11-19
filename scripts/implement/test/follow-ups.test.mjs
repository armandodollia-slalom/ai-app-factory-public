// Council C4: a C7 PR listed two issues as four follow-ups, and the PR check fixer's "could not fix" notes reached
// neither the PR body nor the board.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dedupeFollowUps } from '../lib/follow-ups.mjs';
import { followUpsSection, prCheckFollowUps } from '../lib/implement.mjs';
import { fixerNotesOf } from '../../pr-check/pr-check.mjs';

test('follow-ups naming the same problem in other words become one entry; different problems stay', () => {
  const titles = [
    'Catalog facet counts ignore onlyAvailable',
    'HybridApp catalog does not support onlyAvailable',
    'HybridApp catalog ignores the onlyAvailable filter',
    'Catalog facet counts ignore the In stock only filter',
    'Pre-existing whitespace and charset issues in CatalogApi.cs',
    'Parse catalog page query parameters (page, brand, type) leniently',
    'Make facet counts respect onlyAvailable',
    'Availability form hard-codes brand and type that the URI helpers already own',
  ];
  const out = dedupeFollowUps(titles.map((title) => ({ title })));
  assert.deepEqual(out.map((u) => u.title), [titles[0], titles[1], titles[4], titles[5], titles[7]]);
  assert.deepEqual(out[0].also, [titles[3], titles[6]]);
  assert.match(followUpsSection(titles.map((title) => ({ title }))), /also raised as: HybridApp catalog ignores the onlyAvailable filter/);
  assert.equal(dedupeFollowUps([{ title: 'Facet counts wrong', ticket: 'A-1' }, { title: 'Facet counts wrong', ticket: 'A-2' }]).length, 2);
});

test('the fixer\'s not-fixed notes become follow-ups unless a later round fixed them', () => {
  const history = [
    { upheld: [{ id: 'ACC-1', title: 'Writes need admin role' }, { id: 'FLO-2', title: 'Scope unused' }], fix: { notFixed: [{ id: 'ACC-1', reason: 'needs a policy decision' }, { id: 'FLO-2', reason: 'later' }] } },
    { upheld: [{ id: 'ACC-1', title: 'Writes need admin role' }], fix: { notFixed: [{ id: 'ACC-1', reason: 'again' }] } },
  ];
  const notes = fixerNotesOf(history);
  assert.deepEqual(notes, [{ id: 'ACC-1', title: 'Writes need admin role', reason: 'needs a policy decision' }, { id: 'FLO-2', title: 'Scope unused', reason: 'later' }]);
  const ups = prCheckFollowUps([{ fixerNotes: notes, resolvedFindings: [{ id: 'FLO-2' }] }]);
  assert.deepEqual(ups.map((u) => u.title), ['Writes need admin role']);
  assert.match(ups[0].reason, /the fixer did not fix it: needs a policy decision/);
});
