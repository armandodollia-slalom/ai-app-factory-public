// Test fakes: a council member's scripted steps are its review rounds. The harness's follow-up question for a missing
// `resolves` (council.mjs fillResolves) is answered here, outside the script, so a fixture that predates the question
// keeps its step order; the answer names nothing, so the harness infers and marks every value.
export const isResolvesQuestion = (task) => /Your result was rejected: \d+ finding\(s\) have no `resolves` field/.test(String(task ?? ''));
export const RESOLVES_ANSWER = 'AGENT_RESULT: {"resolves": {}}';
export const withResolvesAnswer = (fn) => async (m, task, o) => (isResolvesQuestion(task) ? { status: 0, output: RESOLVES_ANSWER } : fn(m, task, o));
