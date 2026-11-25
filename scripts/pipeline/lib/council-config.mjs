// The `council` section of a repository's .factory/config.json: every verification stage is a council (of one member
// unless `council.members` or the stage's `councilMembers` seats more, from `models.pool`) and how their results combine.
// Each stage's round limit and pass score are its own section's (`<section>.maxCouncilRounds`,
// `<section>.councilPassScore`). Pure functions (node:net only, for IP parsing), so config.mjs can
// validate the section at load time. The runtime (seating, merging, the PR body table) is council.mjs. See
// docs/ai-pipeline/council.md.
import net from 'node:net';
import { defaultSettings } from './settings.mjs';
import { CLEAN_CODE_LENS } from './clean-code.mjs';

// The verifier stages, named after the code that runs them, and the settings section each one's round limit
// (`<section>.maxCouncilRounds`), pass score (`<section>.councilPassScore`) and discussion override
// (`<section>.councilIntercom`) come from. Both pair verifiers are the implement stage's.
export const COUNCIL_STAGES = {
  pairVerify: { agent: 'pair-verifier', section: 'implement', mode: 'read', title: 'Pair verifier' },
  pairUiVerify: { agent: 'pair-ui-verifier', section: 'implement', mode: 'verify', ui: true, title: 'Pair UI verifier' },
  architectureReview: { agent: 'architecture-reviewer', section: 'architectureReview', mode: 'read', title: 'Architecture review' },
  testPlan: { agent: 'test-plan-verifier', section: 'testPlan', mode: 'read', title: 'Test plan verifier' },
  testAutomation: { agent: 'test-automation-verifier', section: 'testAutomation', mode: 'read', title: 'Test automation verifier' },
  prCheck: { agent: 'pr-check critics', section: 'prCheck', mode: 'read', title: 'PR check critics' },
};
// The lens of a council's sole member: it reviews everything.
export const SOLE_LENS = 'all';

export const COUNCIL_LENSES = {
  correctness: 'Wrong results, edge cases, error paths, concurrency, numeric bounds, defects the change itself introduces.',
  acceptance: 'Each Expected and acceptance line: met, partly met, unmet or unverifiable. Anything not fully met blocks.',
  security: 'Authorization weaker than the ticket states, secrets, injection, data exposure.',
  'test-value': 'Tests that add bloat. See "Useless tests".',
  rewrite: 'A simpler design. See "Rewrite".',
  ui: 'The running app against the mockup, with screenshots.',
  // The fixed seat's lens (GEN-16): never a counted seat's, never in STAGE_LENSES.
  [CLEAN_CODE_LENS]: 'The clean-code rules (CC-<n>): one source of truth, no copied logic, names, functions, comments, dead code, tests. A strict arbiter: every upheld breach blocks.',
};

// The clean-code seat (GEN-16): one member on the clean-code lens sits on every council, in addition to the seats
// `council.members` and `<stage>.councilMembers` count. No setting removes it.
export const CLEAN_CODE_SEAT = 'clean-code';
const COUNT_SETTINGS = ['council.members', ...Object.values(COUNCIL_STAGES).map((s) => `${s.section}.councilMembers`)];
const FIXED = 'the clean-code seat is fixed: it sits on every council in addition to the seats `council.members` and `<stage>.councilMembers` count, and no setting removes it or turns it off';
// The settings a repository wrote to remove or turn off the clean-code seat: a key that names it, a list that names its
// lens (an exclusion), or a count of 0. Each problem says the seat is fixed.
export function fixedSeatProblems(overlay) {
  const problems = [];
  const sections = ['council', ...new Set(Object.values(COUNCIL_STAGES).map((s) => s.section))];
  const walk = (node, at) => {
    if (Array.isArray(node)) {
      if (node.some((v) => typeof v === 'string' && /^clean[-_ ]?code$/i.test(v))) problems.push(`${at}: ${FIXED}`);
      return;
    }
    if (!isObject(node)) return;
    for (const [k, v] of Object.entries(node)) {
      if (/clean[-_ ]?code/i.test(k)) problems.push(`${at}.${k}: ${FIXED}`);
      else walk(v, `${at}.${k}`);
    }
  };
  for (const s of sections) walk(overlay?.[s], s);
  for (const name of COUNT_SETTINGS) {
    const [section, key] = name.split('.');
    if (overlay?.[section]?.[key] === 0) problems.push(`${name} is 0: ${FIXED}; a count of 1 seats the stage's own verifier beside it`);
  }
  return problems;
}

export const BLOCK_QUORUM = ['any', 'majority', 'all'];
export const ON_UNAVAILABLE = ['fail', 'report'];

export const INTERCOM_ON_SPLIT = ['orchestrator', 'owner'];
export const INTERCOM_MAX_TURNS = 20;
export const INTERCOM_MAX_ESCALATIONS = 20;
export const INTERCOM_DEFAULTS = defaultSettings().council.intercom;

const INTERCOM_KEYS = ['enabled', 'host', 'port', 'advertiseHost', 'allowInsecureRemote', 'maxTurnsPerMember', 'maxEscalations', 'onSplit'];
const isObject = (v) => v && typeof v === 'object' && !Array.isArray(v);
const posInt = (v) => Number.isInteger(v) && v >= 1;

const HOSTNAME_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;

// An IP address in its canonical spelling (net.isIP parses; the WHATWG URL parser canonicalizes IPv6), or null.
function canonicalIp(host) {
  const h = String(host ?? '').trim().toLowerCase();
  if (net.isIPv4(h)) return h;
  return net.isIPv6(h) ? new URL(`http://[${h}]`).hostname.slice(1, -1) : null;
}

export const canonicalHost = (host) => canonicalIp(host) ?? String(host ?? '').trim().toLowerCase();

// A hostname or an IP address, never a URL; all-numeric names that are not a valid IPv4 address (`0`, `127.1`) are refused.
export function isValidHost(value) {
  if (typeof value !== 'string' || value !== value.trim() || !value || value.length > 253) return false;
  if (net.isIP(value)) return true;
  return !value.includes(':') && !/^[\d.]+$/.test(value) && HOSTNAME_RE.test(value);
}

export function isWildcardHost(host) {
  return ['0.0.0.0', '::', '::ffff:0:0'].includes(canonicalIp(host));
}

export function isLoopbackHost(host) {
  const ip = canonicalIp(host);
  if (!ip) return String(host ?? '').trim().toLowerCase() === 'localhost';
  return ip === '::1' || ip.startsWith('127.') || /^::ffff:7f[0-9a-f]{2}:/.test(ip);
}

export function intercomProblems(intercom, at = 'council.intercom', inherited = null) {
  if (intercom === undefined) return [];
  if (!isObject(intercom)) return [`${at} must be an object`];
  const problems = [];
  for (const key of Object.keys(intercom)) {
    if (!key.startsWith('$') && !INTERCOM_KEYS.includes(key)) {
      problems.push(`${at}.${key} is not an intercom setting (${INTERCOM_KEYS.join(', ')})`);
    }
  }
  if (intercom.enabled !== undefined && typeof intercom.enabled !== 'boolean') problems.push(`${at}.enabled must be true or false`);
  if (intercom.host !== undefined && !isValidHost(intercom.host)) problems.push(`${at}.host must be a valid hostname or IP address (not a URL)`);
  if (intercom.port !== undefined && !(Number.isInteger(intercom.port) && intercom.port >= 0 && intercom.port <= 65535)) problems.push(`${at}.port must be a whole number from 0 to 65535`);
  if (intercom.advertiseHost !== undefined && intercom.advertiseHost !== null) {
    if (!isValidHost(intercom.advertiseHost)) problems.push(`${at}.advertiseHost must be a valid hostname or IP address (not a URL)`);
    else if (isWildcardHost(intercom.advertiseHost)) problems.push(`${at}.advertiseHost cannot be a wildcard address (${intercom.advertiseHost})`);
  }
  if (intercom.allowInsecureRemote !== undefined && typeof intercom.allowInsecureRemote !== 'boolean') problems.push(`${at}.allowInsecureRemote must be true or false`);
  if (intercom.maxTurnsPerMember !== undefined && !(Number.isInteger(intercom.maxTurnsPerMember) && intercom.maxTurnsPerMember >= 1 && intercom.maxTurnsPerMember <= INTERCOM_MAX_TURNS)) {
    problems.push(`${at}.maxTurnsPerMember must be a whole number from 1 to ${INTERCOM_MAX_TURNS}`);
  }
  if (intercom.maxEscalations !== undefined && !(Number.isInteger(intercom.maxEscalations) && intercom.maxEscalations >= 0 && intercom.maxEscalations <= INTERCOM_MAX_ESCALATIONS)) {
    problems.push(`${at}.maxEscalations must be a whole number from 0 to ${INTERCOM_MAX_ESCALATIONS}`);
  }
  if (intercom.onSplit !== undefined && !INTERCOM_ON_SPLIT.includes(intercom.onSplit)) problems.push(`${at}.onSplit must be one of ${INTERCOM_ON_SPLIT.join(', ')}`);
  const eff = { ...INTERCOM_DEFAULTS, ...(isObject(inherited) ? inherited : {}), ...intercom };
  if (isValidHost(eff.host) && !isLoopbackHost(eff.host)) {
    if (eff.allowInsecureRemote !== true) {
      problems.push(`${at}.host "${eff.host}" is not loopback; set ${at}.allowInsecureRemote to true to allow plain-HTTP bearer tokens on the network (or bind 127.0.0.1 and tunnel with ssh -R)`);
    }
    if (!eff.advertiseHost || !isValidHost(eff.advertiseHost) || isWildcardHost(eff.advertiseHost)) {
      problems.push(`${at}.advertiseHost must be a reachable hostname or IP when ${at}.host is not loopback (cannot advertise ${eff.host})`);
    }
  }
  return problems;
}

// The discussion settings of a stage: council.intercom with the stage section's `councilIntercom` on top.
export function resolveIntercom(council, override = null) {
  const base = isObject(council?.intercom) ? council.intercom : {};
  return { ...INTERCOM_DEFAULTS, ...base, ...(isObject(override) ? override : {}) };
}

// Every problem with the section, as sentences naming the key. Types and allowed values come from the settings
// descriptions (settings.mjs); these are the rules they cannot say. Members are no longer listed here: they come from
// `models.pool`, and `council.members` is how many sit.
export function councilProblems(council) {
  if (council === undefined || council === null) return [];
  if (!isObject(council)) return ['council must be an object'];
  const problems = [];
  if (Array.isArray(council.members)) {
    problems.push('council.members is now how many members a council seats (a whole number); the models they run on are models.pool entries, and lenses are no longer settings');
  } else if (council.members !== undefined && !posInt(council.members)) problems.push('council.members must be a whole number, 1 or more');
  if (council.lateGraceSec !== undefined && !(Number.isFinite(council.lateGraceSec) && council.lateGraceSec >= 0)) problems.push('council.lateGraceSec must be a number of seconds, 0 or more');
  if (council.blockQuorum !== undefined && !BLOCK_QUORUM.includes(council.blockQuorum)) problems.push(`council.blockQuorum must be one of ${BLOCK_QUORUM.join(', ')}`);
  if (council.onUnavailable !== undefined && !ON_UNAVAILABLE.includes(council.onUnavailable)) problems.push(`council.onUnavailable must be one of ${ON_UNAVAILABLE.join(', ')}`);
  if (council.intercom !== undefined) problems.push(...intercomProblems(council.intercom, 'council.intercom'));
  return problems;
}

// The lenses a stage's council seats, its core lens first: the order the harness gives them to the seats (the pair UI
// verifier's `ui`, the test stages' `test-value`, the PR check's `acceptance`).
export const STAGE_LENSES = {
  pairVerify: ['correctness', 'acceptance', 'security', 'rewrite', 'test-value'],
  pairUiVerify: ['ui', 'correctness', 'acceptance', 'security', 'rewrite'],
  architectureReview: ['correctness', 'security', 'rewrite', 'acceptance', 'test-value'],
  testPlan: ['test-value', 'acceptance', 'correctness'],
  testAutomation: ['test-value', 'correctness', 'acceptance', 'rewrite'],
  prCheck: ['acceptance', 'correctness', 'security', 'rewrite', 'test-value'],
};

// Whether an entry's CLI can drive a browser (the `ui` lens): Codex's sandbox cannot start one.
export const canDriveBrowser = (entry) => entry?.cli !== 'codex';

// A pool entry's `env`: settings for its CLI process, such as a CLI's home folder
// (CODEX_HOME, CLAUDE_CONFIG_DIR), with `~` and `${NAME}` expanded when the agent starts (council.mjs agentEnv). Never a
// secret: a variable whose name looks like a token, key or password must be a `${NAME}` reference to the caller's own
// environment, and a value that looks like a credential is refused. The harness's own variables cannot be set.
const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SECRET_NAME = /(TOKEN|SECRET|PASSWORD|PASSWD|PASSPHRASE|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|CREDENTIAL|AUTH|COOKIE|SESSION)|(^|_)KEY$/i;
const SECRET_VALUE = /^(sk-|sk_|ghp_|gho_|ghs_|github_pat_|xox[abpr]-|AKIA|eyJ)[A-Za-z0-9_\-.]{8,}/;
const RESERVED = /^(PIPELINE_|FACTORY_|NODE_OPTIONS$)/;
export const ENV_REFERENCE = /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/;
export function envProblems(env, at) {
  if (!isObject(env)) return [`${at} must be an object of variable names and values`];
  const problems = [];
  for (const [k, v] of Object.entries(env)) {
    if (!NAME_RE.test(k)) problems.push(`${at}.${k} is not a variable name`);
    else if (RESERVED.test(k)) problems.push(`${at}.${k} is the harness's own variable and cannot be set`);
    if (typeof v !== 'string') {
      problems.push(`${at}.${k} must be a string`);
      continue;
    }
    if (SECRET_NAME.test(k) && !ENV_REFERENCE.test(v)) problems.push(`${at}.${k} looks like a secret: put the value in the environment and write "\${${k}}" here, never the secret itself`);
    else if (SECRET_VALUE.test(v)) problems.push(`${at}.${k} holds what looks like a credential; settings files never hold secrets (use a \${NAME} reference)`);
  }
  return problems;
}
