import { resetTrackers, trackerFor } from './trackers/index.mjs';

// Columns in board order. Pipeline events move a story through the transition table in flow.mjs;
// `board move` moves it forward in this order, or anywhere with --force. Testing is where feature verification writes and
// verifies the tests after the review approved the code. Failed holds stories the pipeline could not
// finish: it sits after Pending Review, and a human moves it back to Ready.
export const COLUMNS = ['backlog', 'ready', 'inProgress', 'testing', 'review', 'failed', 'done'];
const KEY_TITLE = /^([A-Z][A-Z0-9]*-\d+):/;

export const storyKeyOf = (title) => KEY_TITLE.exec(title ?? '')?.[1] ?? null;
export const isForward = (from, to) => COLUMNS.indexOf(to) > COLUMNS.indexOf(from ?? 'backlog') || (from == null && to === 'backlog');

// "[FE - ...]" stories change visible UI (they get a video); "[BE - ...]" stories are APIs (they get
// the requests and responses of their verified tests).
export function storyKind(text) {
  const title = /^#\s+(.+)$/m.exec(text ?? '')?.[1] ?? '';
  if (/\[FE\b/.test(title)) return 'ui';
  if (/\[BE\b/.test(title)) return 'api';
  return 'other';
}

// The epic a story belongs to: the `epic-<slug>.md` file its text links to ("Part of: [...](../epic-x.md)").
export const epicSlugOf = (text) => /\]\((?:[^)\s]*\/)?(epic-[\w-]+)\.md\)/.exec(text ?? '')?.[1] ?? null;

const t = (config) => trackerFor(config);

// The board is live only when configured and not opted out. On GitHub also only when the checkout's
// origin is the configured repo, so throwaway test repos and forks never touch the real board.
export const isActive = (config) => t(config).active();

// GitHub only: the Projects v2 project (id, url, Status options). Other trackers have no project.
export const project = (config) => (t(config).board.project ? t(config).board.project() : { url: t(config).webUrl });
export const resetMemo = () => resetTrackers();

// The ticket of a story key: { number (the tracker's id), url }, or null.
export function findIssue(config, key) {
  const tr = t(config);
  // A tracker whose keys live in titles remembers the key's ticket (find); the others look the key up.
  if (tr.traits?.keyFromTitle) return tr.tickets.find(key);
  const found = tr.tickets.get(key);
  return found ? { number: found.id, url: found.url } : null;
}

// The ticket's card and its current lane: { id (item id), column }.
export const issueItem = (config, issue) => t(config).board.item(issue);

// Takes a card off the board view (archived items stay in the tracker's archive). Used for abandoned tickets. A
// tracker without an archive leaves the card where it is (its ticket is closed).
export const archiveItem = (config, itemId) => t(config).board.archiveItem?.(itemId);

export const setColumn = (config, itemId, column) => t(config).board.moveItem(itemId, column);

// Moves a story's card by hand (`board move`). Without `force` it only moves forward in board order.
// Pipeline events go through applyEvent in flow.mjs instead. Returns null when the story has no issue.
export function moveStory(config, key, column, { force = false } = {}) {
  const issue = findIssue(config, key);
  if (!issue) return null;
  const item = issueItem(config, issue);
  if (item.column === column || (!force && !isForward(item.column, column))) return { issue, from: item.column, to: item.column, moved: false };
  setColumn(config, item.id, column);
  try {
    syncEpicColumns(config);
  } catch {
    // The epic's lane is cosmetic; the next poll or setup catches up.
  }
  return { issue, from: item.column, to: column, moved: true };
}

// The lane an epic sits in, from its stories' lanes, first match wins: Done when all are done; Pending
// Review when all are in review or done; In Progress when any is in progress; Testing when any is in
// testing; Failed when any failed and none can still move on its own (none in progress, testing or
// ready); Ready when any is ready; In Progress when some finished but the rest wait in Backlog; else
// Backlog.
export function epicColumn(columns) {
  const any = (...lanes) => columns.some((c) => lanes.includes(c));
  if (columns.length && columns.every((c) => c === 'done')) return 'done';
  if (columns.length && columns.every((c) => c === 'review' || c === 'done')) return 'review';
  if (any('inProgress')) return 'inProgress';
  if (any('testing')) return 'testing';
  if (any('failed') && !any('ready')) return 'failed';
  if (any('ready')) return 'ready';
  if (any('review', 'done')) return 'inProgress';
  return 'backlog';
}

// Moves every epic card to the lane its stories call for. Returns the epics moved.
export function syncEpicColumns(config, items = listItems(config), { log = () => {}, dryRun = false } = {}) {
  const moved = [];
  for (const epic of items.filter((i) => i.labels.includes(config.board.epicLabel))) {
    const stories = items.filter((i) => i.parent === epic.number);
    const target = epicColumn(stories.map((s) => (s.state === 'CLOSED' ? 'done' : s.column)));
    if (epic.column === target) continue;
    if (dryRun) {
      log(`would move epic #${epic.number} to ${config.board.columns[target]}`);
      continue;
    }
    setColumn(config, epic.itemId, target);
    epic.column = target;
    moved.push(epic.number);
    log(`epic #${epic.number} moved to ${config.board.columns[target]}`);
  }
  return moved;
}

// Gives an epic's open stories the epic's assignees (adding and removing as needed), so assigning an
// epic assigns all of its stories. Tickets only: no board access needed (runs in CI).
export const syncEpicAssignees = (config, number) => t(config).board.syncAssignees(number);

export const comment = (config, number, body) => t(config).tickets.comment(number, body);
export const addLabel = (config, number, label) => t(config).tickets.update(number, { labels: { add: [label] } });
export const removeLabel = (config, number, label) => t(config).tickets.update(number, { labels: { remove: [label] } });

// The ticket cards of THIS repository on the board, with their column, assignees and the review gate's Severity
// field (set on triaged bug tickets): { itemId, column, status, number, title, url, state: OPEN|CLOSED, repo, key,
// assignees, labels, parent, stateReason, severity, ticket, fields }. A board can be shared with other repositories:
// their cards are never returned unless `all` is set (setup's check for a shared board), so nothing that acts on the
// result (sync, epic lanes, the review gate, requeue) can touch them.
export const listItems = (config, { all = false } = {}) => t(config).board.items({ repoScoped: !all });

// One-time setup (`board setup`): creates what the factory needs on the tracker and reports what a
// person must create by hand. Returns { url, done, manual }.
export function setup(config, { log = () => {}, writeProjectNumber = () => {}, dryRun = false } = {}) {
  return t(config).board.setup({ log, writeProjectNumber, dryRun, syncEpics: (items, o = {}) => syncEpicColumns(config, items, { log, dryRun: Boolean(o.dryRun ?? dryRun) }) });
}
