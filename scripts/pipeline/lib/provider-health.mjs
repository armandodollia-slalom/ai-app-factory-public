// How the agent provider behaved during one agent run, read from the agent CLI's own session transcript (Claude Code
// writes an `api-request` row per API call and an `assistant` row whose `requestRef` names the request it answers).
// Council C12: a held-out bug's agents were 5-10x slower than usual because 7 API requests got no answer until the CLI gave up
// and sent them again (73 minutes lost) and 5 agents waited 5 minutes before their first request; the usage records
// only had seconds, so it looked like slow agents. Now each run records it, the run log says it and the PR body lists it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Claude Code keeps a session's transcript at <config dir>/projects/<cwd with every non-alphanumeric character as ->/<id>.jsonl.
export function claudeTranscriptPath(sessionId, cwd, env = process.env) {
  const dir = env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  const slug = path.resolve(cwd).replace(/[^A-Za-z0-9]/g, '-');
  return path.join(dir, 'projects', slug, `${sessionId}.jsonl`);
}

export function claudeTranscript(sessionId, cwd, env = process.env) {
  if (!sessionId || !cwd) return null;
  const file = claudeTranscriptPath(sessionId, cwd, env);
  return fs.existsSync(file) ? file : null;
}

const RATE = /\b(429|rate[_ -]?limit|too many requests|usage limit|quota)\b/i;
const OVERLOAD = /\b(529|overloaded|503|502|504|timeout|timed out|ECONNRESET|socket hang up)\b/i;

// { requests, resent, stalledSec, errors, rateLimited, overloaded, startupSec } from a transcript's rows.
export function apiHealth(rows) {
  const ms = (r) => Date.parse(r.timestamp ?? '') || null;
  const answered = new Set(rows.filter((r) => r.type === 'assistant' && r.requestRef).map((r) => r.requestRef));
  const requests = rows.filter((r) => r.type === 'api-request' && r.id);
  let resent = 0;
  let stalledSec = 0;
  requests.forEach((r, i) => {
    const next = requests[i + 1];
    if (answered.has(r.id) || !next) return;
    resent += 1;
    stalledSec += Math.max(0, (ms(next) - ms(r)) / 1000);
  });
  const errorRows = rows.filter((r) => r.isApiErrorMessage || (r.type === 'system' && /api[_ ]?error|retry/i.test(String(r.subtype ?? r.content ?? ''))));
  const text = (r) => JSON.stringify(r.message?.content ?? r.content ?? r.error ?? '');
  const dequeue = rows.find((r) => r.type === 'queue-operation' && r.operation === 'dequeue');
  const startupSec = dequeue && requests[0] ? Math.max(0, Math.round((ms(requests[0]) - ms(dequeue)) / 1000)) : null;
  return {
    requests: requests.length,
    resent,
    stalledSec: Math.round(stalledSec),
    errors: errorRows.length,
    rateLimited: errorRows.some((r) => RATE.test(text(r))),
    overloaded: errorRows.some((r) => OVERLOAD.test(text(r))),
    startupSec,
  };
}

export function readTranscript(file) {
  const rows = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      // a partly written last line
    }
  }
  return rows;
}

// The health of one claude run from its JSON result (stdout), or null when it cannot be read.
export function claudeRunHealth(stdout, cwd, env = process.env) {
  let sessionId = null;
  try {
    sessionId = JSON.parse(String(stdout).trim())?.session_id ?? null;
  } catch {
    return null;
  }
  const file = claudeTranscript(sessionId, cwd, env);
  if (!file) return null;
  try {
    return { sessionId, ...apiHealth(readTranscript(file)) };
  } catch {
    return null;
  }
}

// Whether a run's provider behaviour is worth a line in the run log and a run-conditions record.
export const degraded = (h) => Boolean(h && (h.resent > 0 || h.errors > 0 || (h.startupSec ?? 0) > 60));

export const describeHealth = (h) =>
  [
    h.resent ? `${h.resent} API request(s) got no answer and were sent again (${Math.round(h.stalledSec / 60)} min lost)` : null,
    h.errors ? `${h.errors} API error(s)${h.rateLimited ? ', rate limited' : h.overloaded ? ', provider overloaded' : ''}` : null,
    (h.startupSec ?? 0) > 60 ? `${h.startupSec} s before its first API request` : null,
  ]
    .filter(Boolean)
    .join('; ');
