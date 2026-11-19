// Story lookup for every stage. Stories live on the GitHub board; scripts/pipeline/lib/tickets.mjs is
// the one loader (cache in .factory/state/board/, fetched on demand). This module keeps the names the
// stages already import and adds the active-story and case-id helpers.
import fs from 'node:fs';
import path from 'node:path';
import { currentBranch } from './git.mjs';
import { sha } from './util.mjs';
import { epicOf, listEpics, listStories, resolveStory, storiesFromPaths } from './tickets.mjs';

export { epicOf, listEpics, listStories, resolveStory, storiesFromPaths };

export const CASE_ID = /TC-([A-Z][A-Z0-9]*-\d+)-(\d{2,})(?!\d)/g;

export const storySha = (text) => sha(text.replace(/\r\n/g, '\n'));

// The ticket without its `## Implementation Notes` section: the implementer's (and the PR check's) account is not the
// ticket, so the plan does not go stale when the harness updates it (council C5: the fixer may not edit the notes, the
// re-check re-planned from notes that no longer matched the code). Plans are stamped with this hash; a plan stamped
// with the whole text (storySha, before) still counts.
export const withoutNotes = (text) => {
  const lines = String(text).replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let skip = false;
  for (const l of lines) {
    if (/^##\s+/.test(l)) skip = /^##\s+Implementation Notes\b/i.test(l);
    if (!skip) out.push(l);
  }
  return out.join('\n').replace(/\n+$/, '\n');
};
export const ticketSha = (text) => sha(withoutNotes(text));
export const storyMatches = (stamp, text) => stamp === ticketSha(text) || stamp === storySha(text);

export const casePrefix = (key) => `TC-${key}-`;

export function caseIdsIn(text, key) {
  const ids = new Set();
  for (const match of text.matchAll(CASE_ID)) {
    if (!key || match[1] === key) ids.add(match[0]);
  }
  return ids;
}

const activeFile = (config) => path.join(config.root, config.stateDir, 'active-story');

// The story registered with `pipeline start` (not inferred from the branch name), from the cache only.
export function activeStoryFile(config) {
  if (!fs.existsSync(activeFile(config))) return null;
  return resolveStory(config, fs.readFileSync(activeFile(config), 'utf8').trim(), { fetch: false })?.file ?? null;
}

export function activeStory(config) {
  if (fs.existsSync(activeFile(config))) {
    const story = resolveStory(config, fs.readFileSync(activeFile(config), 'utf8').trim());
    if (story) return story;
  }
  // Hooks call this on every turn: a branch name only matches tickets already in the cache (`pipeline
  // start`, `implement run` and `board fetch` put them there), so no hook waits on GitHub.
  const branch = currentBranch(config.root).toUpperCase();
  for (const match of branch.matchAll(/([A-Z][A-Z0-9]*-\d+)/g)) {
    const story = resolveStory(config, match[1], { fetch: false });
    if (story) return story;
  }
  return null;
}
