// Shared pieces of the ticket tracker adapters (scripts/board/lib/trackers/): errors, `${ENV}` expansion,
// the factory's vocabulary (lanes, ticket types, triage fields) and how a repository maps it onto its
// tracker (`tracker.lanes`, `tracker.types`, `tracker.fields` in .factory/config.json).
//
// UnsupportedError and `${ENV}` expansion are the ones the code host layer uses
// (scripts/pipeline/lib/hosts/errors.mjs, scripts/pipeline/lib/env.mjs).
import { expandEnv as expandEnvShared } from '../../../pipeline/lib/env.mjs';
import { UnsupportedError } from '../../../pipeline/lib/hosts/errors.mjs';
import { defaultSettings } from '../../../pipeline/lib/settings.mjs';

// A method this tracker cannot support. The message says what to do instead; callers that can degrade
// catch it (`error instanceof UnsupportedError`, `error.name === 'UnsupportedError'` or `error.unsupported`).
export { UnsupportedError };

// A tracker request that failed. `code`: auth | not-found | rate-limit | refused (a content filter on the text) | http | network | config.
export class TrackerError extends Error {
  constructor(code, message, { status = null } = {}) {
    super(message);
    this.name = 'TrackerError';
    this.code = code;
    this.status = status;
  }
}

// "${NAME}" -> process.env.NAME (env.mjs, as in the metrics sink and the host token). A missing or empty
// variable is a TrackerError('config') that names it.
export function expandEnv(text, env = process.env, what = 'the tracker') {
  if (text == null) return text;
  try {
    return expandEnvShared(text, env, what, { emptyIsMissing: true });
  } catch (error) {
    throw new TrackerError('config', error.message);
  }
}

// The factory's lanes in board order, and the default names (board.columns).
export const LANES = ['backlog', 'ready', 'inProgress', 'testing', 'review', 'failed', 'done'];
export const TICKET_TYPES = ['epic', 'story', 'bug', 'spike'];
// Triage fields of the review gate: single-select levels and numbers.
export const SELECT_FIELDS = ['impact', 'complexity', 'fixRisk', 'severity'];
export const NUMBER_FIELDS = ['confidence', 'reopens'];
export const FIELD_DEFAULTS = defaultSettings().board.fields;
export const LEVELS = ['Low', 'Medium', 'High', 'Severe'];

// The tracker's names for the factory's lanes: `tracker.lanes` over `board.columns`.
export function laneNames(config) {
  const columns = config.board?.columns ?? {};
  const names = { ...columns, ...(config.tracker?.lanes ?? {}) };
  for (const lane of LANES) if (!names[lane]) names[lane] = defaultSettings().board.columns[lane];
  return names;
}

// The factory lane a tracker status/column name stands for (case-insensitive), or null.
export function laneOf(config, name) {
  if (name == null) return null;
  const names = laneNames(config);
  const lower = String(name).toLowerCase();
  return LANES.find((l) => String(names[l]).toLowerCase() === lower) ?? null;
}

// The tracker's names for the factory's ticket types.
export function typeNames(config, defaults) {
  return { ...defaults, ...(config.tracker?.types ?? {}) };
}

// The factory type of a tracker type name.
export function typeOf(config, defaults, name) {
  const names = typeNames(config, defaults);
  const lower = String(name ?? '').toLowerCase();
  return TICKET_TYPES.find((t) => String(names[t]).toLowerCase() === lower) ?? null;
}

// The tracker's ids or names for the triage fields: `tracker.fields` over `board.fields`.
export const fieldNames = (config) => ({ ...FIELD_DEFAULTS, ...(config.board?.fields ?? {}), ...(config.tracker?.fields ?? {}) });

// Labels/tags carry the factory's own key on trackers whose native key differs (`factory-key-SHOP-3`).
export const KEY_LABEL_PREFIX = 'factory-key-';
export const keyLabel = (key) => `${KEY_LABEL_PREFIX}${key}`;
export const keyFromLabels = (labels) => (labels ?? []).find((l) => String(l).startsWith(KEY_LABEL_PREFIX))?.slice(KEY_LABEL_PREFIX.length) ?? null;

// A filesystem- and branch-safe key: letters, digits and dashes (`AB#4521` -> `AB-4521`).
export const safeKey = (key) => String(key).replace(/[^A-Za-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');

// Factory story keys look like `SHOP-3`; epics and spikes `epic-<slug>` / `spike-<slug>`.
export const STORY_KEY = /^([A-Z][A-Z0-9]*-\d+):/;

// A label change: an array replaces the labels, { add, remove } edits them.
export function applyLabelChange(current, change) {
  if (change == null) return current;
  if (Array.isArray(change)) return [...new Set(change)];
  const remove = new Set(change.remove ?? []);
  return [...new Set([...(current ?? []).filter((l) => !remove.has(l)), ...(change.add ?? [])])];
}

// Hidden markers (`<!-- name:... -->`) the factory puts in comments and bodies. Trackers that cannot
// store HTML comments keep them elsewhere (an entity property, a delimited block) and put them back.
export const MARKER_LINE = /<!--[\s\S]*?-->/g;
export function splitMarkers(text) {
  const markers = String(text ?? '').match(MARKER_LINE) ?? [];
  const rest = String(text ?? '').replace(MARKER_LINE, '').replace(/\n{3,}/g, '\n\n').trimEnd();
  return { markers, text: rest };
}
export const joinMarkers = (text, markers) => (markers?.length ? `${String(text ?? '').trimEnd()}\n\n${markers.join('\n')}` : String(text ?? ''));

// The normalised ticket (contract): fills defaults so adapters stay small.
export function ticket(t) {
  return {
    id: t.id,
    number: t.id,
    key: t.key ?? null,
    type: t.type ?? null,
    title: t.title ?? '',
    body: t.body ?? null,
    state: t.state ?? 'open',
    stateReason: t.stateReason ?? null,
    labels: t.labels ?? [],
    assignees: t.assignees ?? [],
    parent: t.parent ?? null,
    blockedBy: t.blockedBy ?? [],
    url: t.url ?? null,
    updatedAt: t.updatedAt ?? null,
    meta: t.meta ?? null,
    raw: t.raw ?? null,
  };
}

// The flat board item shape the board stage uses (board.mjs listItems), from a normalised ticket.
export function boardItem(config, t, { itemId = t.id, lane = null, status = null, repo = null, fields = {} } = {}) {
  return {
    itemId,
    column: lane,
    lane,
    status,
    number: t.id,
    id: t.id,
    title: t.title,
    url: t.url,
    state: t.state === 'closed' ? 'CLOSED' : 'OPEN',
    repo,
    key: t.key,
    assignees: t.assignees,
    labels: t.labels,
    parent: t.parent,
    stateReason: t.stateReason,
    severity: fields.severity ?? null,
    fields,
    ticket: t,
  };
}

// A ticket id from the command line, for any tracker: a GitHub issue or Azure Boards work item number
// (`12`, `#12`, `AB#12`) becomes a number; a Jira key (`SHOP-7`) stays a string. null when empty.
export function ticketId(arg) {
  const text = String(arg ?? '').trim();
  if (!text) return null;
  const n = /^(?:#|AB#)?(\d+)$/i.exec(text);
  if (n) return Number(n[1]) || null;
  return /^[A-Za-z][A-Za-z0-9_]*-\d+$/.test(text) ? text.toUpperCase() : null;
}
