// PR-check finding severities, most severe first, shared by the PR check and the delivery fix mode.
export const SEVERITIES = ['blocking', 'major', 'minor'];
export const severityAtLeast = (severity, until) => SEVERITIES.indexOf(severity) !== -1 && SEVERITIES.indexOf(severity) <= SEVERITIES.indexOf(until);
