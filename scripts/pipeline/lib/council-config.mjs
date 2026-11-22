// The `council` section of a repository's .factory/config.json: which verification stages seat a council of
// verifiers instead of their single verifier, with which members (CLI, model, reasoning effort, lens), for how
// many rounds, and how their results combine. Pure functions (node:net only, for IP parsing), so config.mjs can
// validate the section at load time. The runtime (seating, merging, the PR body table) is council.mjs. See
// docs/ai-pipeline/council.md.
import net from 'node:net';

// The stages a council can sit for, named after the code that runs them, and the setting each one's round
// limit comes from when it has no council.
export const COUNCIL_STAGES = {
  pairVerify: { agent: 'pair-verifier', rounds: 'implement.maxPairRounds', mode: 'read', title: 'Pair verifier' },
  pairUiVerify: { agent: 'pair-ui-verifier', rounds: 'implement.maxPairRounds', mode: 'verify', ui: true, title: 'Pair UI verifier' },
  review: { agent: 'architecture-reviewer', rounds: 'review.maxRounds', mode: 'read', title: 'Architecture review' },
  testPlan: { agent: 'test-plan-verifier', rounds: 'loops.planMaxRounds', mode: 'read', title: 'Test plan verifier' },
  testAutomation: { agent: 'test-automation-verifier', rounds: 'loops.automationMaxRounds', mode: 'read', title: 'Test automation verifier' },
  prCheck: { agent: 'pr-check critics', rounds: 'prCheck.maxRounds', mode: 'read', title: 'PR check critics' },
};

export const COUNCIL_LENSES = {
  correctness: 'Wrong results, edge cases, error paths, concurrency, numeric bounds, defects the change itself introduces.',
  acceptance: 'Each Expected and acceptance line: met, partly met, unmet or unverifiable. Anything not fully met blocks.',
  security: 'Authorization weaker than the ticket states, secrets, injection, data exposure.',
  'test-value': 'Tests that add bloat. See "Useless tests".',
  rewrite: 'A simpler design. See "Rewrite".',
  ui: 'The running app against the mockup, with screenshots.',
};

// `custom` runs the member's own `cmd` (a shell command that reads the prompt on stdin), like PIPELINE_AGENT_CMD.
export const COUNCIL_CLIS = ['claude', 'codex', 'copilot', 'custom'];
export const COUNCIL_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
export const BLOCK_ON = ['any', 'majority', 'all'];
export const ON_UNAVAILABLE = ['fail', 'report'];
export const COUNCIL_DEFAULTS = { rounds: 3, passScore: 9, blockOn: 'any', onUnavailable: 'fail' };

export const INTERCOM_ON_SPLIT = ['orchestrator', 'owner'];
export const INTERCOM_MAX_TURNS = 20;
export const INTERCOM_MAX_ESCALATIONS = 20;
export const INTERCOM_DEFAULTS = {
  enabled: false,
  host: '127.0.0.1',
  port: 0,
  advertiseHost: null,
  allowInsecureRemote: false,
  maxTurnsPerMember: 2,
  maxEscalations: 3,
  onSplit: 'orchestrator',
};

const MEMBER_KEYS = ['name', 'cli', 'model', 'effort', 'lens', 'blocking', 'cmd', 'timeoutSec', 'env'];
const COUNCIL_KEYS = ['rounds', 'passScore', 'blockOn', 'onUnavailable', 'members', 'stages', 'lateGraceSec', 'intercom'];
const STAGE_KEYS = ['members', 'rounds', 'lenses', 'intercom'];
const INTERCOM_KEYS = ['enabled', 'host', 'port', 'advertiseHost', 'allowInsecureRemote', 'maxTurnsPerMember', 'maxEscalations', 'onSplit'];
const isObject = (v) => v && typeof v === 'object' && !Array.isArray(v);
const posInt = (v) => Number.isInteger(v) && v >= 1;
const NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/;

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

export function resolveIntercom(council, stage = null) {
  const base = isObject(council?.intercom) ? council.intercom : {};
  const override = stage && isObject(council?.stages?.[stage]?.intercom) ? council.stages[stage].intercom : {};
  return { ...INTERCOM_DEFAULTS, ...base, ...override };
}

// Every problem with the section, as sentences naming the key. `agent` is the merged `agent` settings (allowedModels,
// modelIds): a member's model must be allowed and have an id for the member's CLI, the same rule agent.strictModels
// applies to every other agent, checked here so a typo fails at load and never halfway through a round.
export function councilProblems(council, agent = {}) {
  if (council === undefined || council === null) return [];
  if (!isObject(council)) return ['council must be an object'];
  const problems = [];
  for (const key of Object.keys(council)) if (!key.startsWith('$') && !COUNCIL_KEYS.includes(key)) problems.push(`council.${key} is not a council setting (${COUNCIL_KEYS.join(', ')})`);
  if (council.lateGraceSec !== undefined && !(Number.isFinite(council.lateGraceSec) && council.lateGraceSec >= 0)) problems.push('council.lateGraceSec must be a number of seconds, 0 or more');
  if (council.rounds !== undefined && !posInt(council.rounds)) problems.push('council.rounds must be a whole number of 1 or more');
  if (council.passScore !== undefined && !(Number.isFinite(council.passScore) && council.passScore >= 0 && council.passScore <= 10)) problems.push('council.passScore must be a number from 0 to 10');
  if (council.blockOn !== undefined && !BLOCK_ON.includes(council.blockOn)) problems.push(`council.blockOn must be one of ${BLOCK_ON.join(', ')}`);
  if (council.onUnavailable !== undefined && !ON_UNAVAILABLE.includes(council.onUnavailable)) problems.push(`council.onUnavailable must be one of ${ON_UNAVAILABLE.join(', ')}`);
  if (council.intercom !== undefined) problems.push(...intercomProblems(council.intercom, 'council.intercom'));
  const members = council.members;
  if (!Array.isArray(members) || !members.length) problems.push('council.members must list at least one member');
  const allowed = agent.allowedModels ?? [];
  const names = new Map();
  for (const [i, m] of (Array.isArray(members) ? members : []).entries()) {
    const at = `council.members[${i}]${isObject(m) && typeof m.name === 'string' ? ` ("${m.name}")` : ''}`;
    if (!isObject(m)) {
      problems.push(`${at} must be an object`);
      continue;
    }
    for (const key of Object.keys(m)) if (!key.startsWith('$') && !MEMBER_KEYS.includes(key)) problems.push(`${at}.${key} is not a member setting (${MEMBER_KEYS.join(', ')})`);
    if (typeof m.name !== 'string' || !NAME.test(m.name)) problems.push(`${at}.name must be a short name of letters, digits, - or _`);
    else if (names.has(m.name)) problems.push(`council.members has two members named "${m.name}"`);
    else names.set(m.name, m);
    if (!COUNCIL_CLIS.includes(m.cli)) problems.push(`${at}.cli must be one of ${COUNCIL_CLIS.join(', ')}`);
    if (!Object.hasOwn(COUNCIL_LENSES, m.lens)) problems.push(`${at}.lens "${m.lens}" is not a lens (${Object.keys(COUNCIL_LENSES).join(', ')})`);
    else if (m.lens === 'ui' && m.cli === 'codex') problems.push(`${at}.lens is ui, but a Codex member's sandbox cannot start a browser; give the ui lens to a claude or copilot member`);
    if (m.effort !== undefined && !COUNCIL_EFFORTS.includes(m.effort)) problems.push(`${at}.effort must be one of ${COUNCIL_EFFORTS.join(', ')}`);
    if (m.blocking !== undefined && typeof m.blocking !== 'boolean') problems.push(`${at}.blocking must be true or false`);
    if (m.env !== undefined) problems.push(...envProblems(m.env, `${at}.env`));
    if (m.timeoutSec !== undefined && !posInt(m.timeoutSec)) problems.push(`${at}.timeoutSec must be a whole number of seconds`);
    if (m.cli === 'custom') {
      if (typeof m.cmd !== 'string' || !m.cmd.trim()) problems.push(`${at}.cmd must be the command a custom member runs (it reads the prompt on stdin)`);
    } else if (m.cmd !== undefined) problems.push(`${at}.cmd is only for cli "custom"`);
    if (m.cli !== 'custom' || m.model !== undefined) {
      if (typeof m.model !== 'string' || !m.model) problems.push(`${at}.model must name a model alias from agent.allowedModels`);
      else if (!allowed.includes(m.model)) problems.push(`${at}.model "${m.model}" is not in agent.allowedModels (${allowed.join(', ') || 'none'})`);
      else if (COUNCIL_CLIS.includes(m.cli) && m.cli !== 'custom' && !agent.modelIds?.[m.cli]?.[m.model]) problems.push(`${at}.model "${m.model}" has no id for agent CLI "${m.cli}" (agent.modelIds.${m.cli}.${m.model}); add the id or seat the member on another CLI`);
    }
  }
  if (council.stages !== undefined && !isObject(council.stages)) problems.push('council.stages must be an object keyed by stage');
  for (const [stage, s] of Object.entries(isObject(council.stages) ? council.stages : {})) {
    if (stage.startsWith('$')) continue;
    const at = `council.stages.${stage}`;
    if (!Object.hasOwn(COUNCIL_STAGES, stage)) {
      problems.push(`${at} is not a stage a council can sit for (${Object.keys(COUNCIL_STAGES).join(', ')})`);
      continue;
    }
    if (!isObject(s)) {
      problems.push(`${at} must be an object ({} seats the whole council)`);
      continue;
    }
    for (const key of Object.keys(s)) if (!key.startsWith('$') && !STAGE_KEYS.includes(key)) problems.push(`${at}.${key} is not a stage setting (${STAGE_KEYS.join(', ')})`);
    if (s.rounds !== undefined && !posInt(s.rounds)) problems.push(`${at}.rounds must be a whole number of 1 or more`);
    if (s.intercom !== undefined) problems.push(...intercomProblems(s.intercom, `${at}.intercom`, council.intercom));
    // A member's lens for this stage only (the same two members can judge code through correctness in one stage and
    // test value in another).
    if (s.lenses !== undefined) {
      if (!isObject(s.lenses)) problems.push(`${at}.lenses must map member names to lenses`);
      else {
        const seatedHere = names.size ? new Set(seatedNames(council, stage)) : new Set();
        for (const [n, lens] of Object.entries(s.lenses)) {
          if (!names.has(n)) problems.push(`${at}.lenses names "${n}", which is not in council.members`);
          else if (!seatedHere.has(n)) problems.push(`${at}.lenses names "${n}", who does not sit for this stage`);
          if (!Object.hasOwn(COUNCIL_LENSES, lens)) problems.push(`${at}.lenses.${n} "${lens}" is not a lens (${Object.keys(COUNCIL_LENSES).join(', ')})`);
          else if (lens === 'ui' && !COUNCIL_STAGES[stage].ui) problems.push(`${at}.lenses.${n} is ui, which needs a leased app stack slot; only pairUiVerify has one`);
          else if (lens === 'ui' && names.get(n)?.cli === 'codex') problems.push(`${at}.lenses.${n} is ui, but ${n} runs on Codex, whose sandbox cannot start a browser; give the ui lens to a claude or copilot member`);
        }
      }
    }
    if (s.members !== undefined) {
      if (!Array.isArray(s.members) || !s.members.length) problems.push(`${at}.members must list at least one member name (leave it out to seat the whole council)`);
      else {
        const seen = new Set();
        for (const n of s.members) {
          if (seen.has(n)) problems.push(`${at}.members names "${n}" twice`);
          seen.add(n);
          if (!names.has(n)) problems.push(`${at}.members names "${n}", which is not in council.members`);
          else if (names.get(n).lens === 'ui' && !COUNCIL_STAGES[stage].ui) problems.push(`${at}.members seats "${n}" (lens ui), which needs a leased app stack slot; only pairUiVerify has one`);
        }
      }
    }
    if (names.size && !problems.some((p) => p.startsWith(`${at}.members`))) {
      const seated = seatedNames(council, stage);
      if (!seated.length) problems.push(`${at} seats nobody (the whole council has only ui members, which need a stack slot)`);
      else if (!seated.some((n) => names.get(n)?.blocking !== false)) problems.push(`${at} seats no blocking member; at least one must have blocking true`);
    }
  }
  return problems;
}

// The member names a stage seats: its own list, or the whole council without the ui members a stage with no stack
// slot cannot run.
export function seatedNames(council, stage) {
  const s = council?.stages?.[stage];
  if (!s) return [];
  if (Array.isArray(s.members)) return [...s.members];
  return (council.members ?? []).filter((m) => m && (m.lens !== 'ui' || COUNCIL_STAGES[stage]?.ui)).map((m) => m.name);
}

// A member's (or an implement role's) `env`: settings for its CLI process, such as a CLI's home folder
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
