// The review gate's fields on the story board, created by `board setup`: Impact, Complexity, Fix risk
// and Severity (single-select Low / Medium / High / Severe; Severity is derived by the harness),
// Confidence and Human reopens (numbers). Names are in `board.fields` (GitHub Projects) or
// `tracker.fields` (Jira custom field ids, Azure Boards reference names).
//
// Everything goes through the ticket tracker (scripts/board/lib/trackers/); `gh` is the injectable gh
// runner the GitHub tracker uses, so the tests keep their in-memory GitHub. The ticket helpers below
// (body, labels) are the gate's other ticket writes, on whichever tracker holds the tickets.
import { trackerFor } from '../../board/lib/trackers/index.mjs';
import { FIELD_DEFAULTS, fieldNames } from '../../board/lib/trackers/shared.mjs';
import { labelColor } from './github.mjs';

export { FIELD_DEFAULTS, fieldNames };

const tracker = (config, gh) => trackerFor(config, gh ? { gh } : {});

// GitHub only: { projectId, fields: { <name>: { id, dataType, options: { <option>: id } } } }.
export const projectFields = (config, gh) => tracker(config, gh).board.fields.project();

// Creates the fields that are missing (idempotent; on Jira and Azure Boards they are listed for a
// person to create). Returns the names created.
export const ensureFields = (config, gh, { log = () => {}, dryRun = false } = {}) => tracker(config, gh).board.fields.ensure({ log, dryRun });

// Writes the triage values of one ticket to its card: { impact, complexity, fixRisk, severity, confidence, reopens }
// (null clears a field). Fields the board does not have are skipped (run `board setup`). Returns the
// names written.
export const setTriageFields = (config, gh, issue, values) => tracker(config, gh).board.fields.set(issue, values);

// The ticket's body (Markdown), its replacement, a label (created first where the tracker needs it), and
// its assignees. On GitHub these are the same gh commands the gate ran before the tracker layer.
export const ticketBody = (config, gh, number) => tracker(config, gh).tickets.get(number)?.body ?? '';
export const setTicketBody = (config, gh, number, body) => tracker(config, gh).tickets.update(number, { body });
export function addTicketLabel(config, gh, number, label) {
  const t = tracker(config, gh);
  t.labels?.ensure?.(label, { color: labelColor(label), description: 'Set by the review gate' });
  t.tickets.update(number, { labels: { add: [label] } });
}
// GitHub reads only the assignees (`tickets.view`); other trackers return them with the ticket.
export function ticketAssignees(config, gh, number) {
  const t = tracker(config, gh);
  return (t.tickets.view ? t.tickets.view(number, 'assignees') : t.tickets.get(number))?.assignees ?? [];
}
