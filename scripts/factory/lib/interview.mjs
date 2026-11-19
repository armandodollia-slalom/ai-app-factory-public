// The setup interview of `factory init`: every stage the factory sets up, asked once, with what detection found shown
// as the default to confirm (never silently assumed). The same questions run three ways:
//   - interactive: `factory init` in a terminal (ask() reads a line; Enter keeps the default shown);
//   - headless: `factory init --answers <file.json>` and `--set id=value` flags (CI, scripted setups) give the same
//     result as the same answers typed;
//   - again on an existing setup: the defaults are what .factory/config.json and .factory/factory.json hold now, and
//     only what an answer changes is written (edit, never overwrite).
// Nothing secret is asked: a credential question takes the NAME of the environment variable (or CI secret) that will
// hold it, and the config gets a `${NAME}` reference. A value that looks like a token is refused.
//
// interview({ detected, config, pin, ask?, answers?, probe? }) -> { config, pin, asked: [{ id, question, answer, source }] }
import { CI_FOR_HOST, DEFAULT_URLS, TRACKER_FOR_HOST } from '../../pipeline/lib/products.mjs';
import { packAnalysis } from '../../pipeline/lib/analysis/config.mjs';

export const HOSTS = ['github', 'gitlab', 'azure-devops', 'bitbucket', 'custom'];
export const TRACKERS = ['github', 'jira', 'azure-boards', 'gitlab', 'linear', 'custom'];
export const CI_SYSTEMS = ['github-actions', 'gitlab-ci', 'azure-pipelines', 'jenkins', 'circleci', 'bitbucket-pipelines', 'custom'];
export const AGENT_CLIS = ['claude', 'codex', 'copilot', 'gemini', 'cursor'];
export const LANES = ['backlog', 'ready', 'inProgress', 'testing', 'review', 'failed', 'done'];
const LANE_DEFAULTS = { backlog: 'Backlog', ready: 'Ready', inProgress: 'In Progress', testing: 'Testing', review: 'Pending Review', failed: 'Failed', done: 'Done' };
export const SCANNERS = ['none', 'semgrep', 'codeql', 'snyk-code', 'snyk-open-source', 'sonarqube', 'checkmarx', 'veracode'];
const TOKEN_DEFAULTS = { gitlab: 'GITLAB_TOKEN', 'azure-devops': 'AZURE_DEVOPS_TOKEN', bitbucket: 'BITBUCKET_TOKEN', jira: 'JIRA_API_TOKEN', 'azure-boards': 'AZURE_DEVOPS_TOKEN', linear: 'LINEAR_API_KEY', jenkins: 'JENKINS_API_TOKEN', circleci: 'CIRCLECI_TOKEN', 'bitbucket-pipelines': 'BITBUCKET_TOKEN' };
// The commercial definitions (packs/commercial/analysis.json): the variable each vendor's CLI reads, its modes, licence.
const COMMERCIAL = Object.fromEntries(Object.entries(packAnalysis([]).tools).filter(([, t]) => t.commercial).map(([id, t]) => [id, t]));
const SCANNER_TOKENS = Object.fromEntries(Object.entries(COMMERCIAL).map(([id, t]) => [id, t.commercial.tokenEnv]));

// ---- small helpers ----------------------------------------------------------------------------------------
const get = (obj, p) => p.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
function set(obj, p, value) {
  const keys = p.split('.');
  let o = obj;
  for (const k of keys.slice(0, -1)) o = o[k] && typeof o[k] === 'object' ? o[k] : (o[k] = {});
  if (value === undefined) delete o[keys.at(-1)];
  else o[keys.at(-1)] = value;
}
const yes = (v) => /^(y|yes|true|1|on)$/i.test(String(v).trim());
const list = (v) => (Array.isArray(v) ? v : String(v ?? '').split(/[\s,]+/)).map((x) => String(x).trim()).filter(Boolean);
const ref = (name) => `\${${name}}`;
const refName = (value) => /^\$\{(\w+)\}$/.exec(String(value ?? ''))?.[1] ?? null;

// An environment variable NAME, never a value: upper case, digits, underscores.
export function variableName(answer) {
  const v = String(answer ?? '').trim().replace(/^\$\{?|\}$/g, '');
  if (!/^[A-Z][A-Z0-9_]{1,63}$/.test(v)) throw new Error(`"${String(answer).slice(0, 12)}..." is not an environment variable name (A-Z, 0-9, _): give the NAME of the variable that holds the credential, never the credential itself`);
  return v;
}

// ---- the questions --------------------------------------------------------------------------------------
// Each: { id, section, ask: text, kind: choice|text|bool|list|variable, choices?, when?(ctx), def(ctx), apply(ctx, value) }.
// ctx: { config, pin, detected, answers (id -> value so far), probe }.
const Q = [];
const q = (id, section, ask, kind, def, apply, extra = {}) => Q.push({ id, section, ask, kind, def, apply, ...extra });

const hostType = (ctx) => ctx.answers['host.type'] ?? ctx.config.host?.type ?? ctx.detected?.host?.type ?? 'github';
const trackerType = (ctx) => ctx.answers['tracker.type'] ?? ctx.config.tracker?.type ?? (ctx.config.tickets?.repo || ctx.config.board?.repo ? 'github' : TRACKER_FOR_HOST[hostType(ctx)] ?? (hostType(ctx) === 'gitlab' ? 'gitlab' : null));
const ciType = (ctx) => ctx.answers['ci.provider'] ?? ctx.config.ci?.provider ?? CI_FOR_HOST[hostType(ctx)] ?? (hostType(ctx) === 'bitbucket' ? 'bitbucket-pipelines' : 'github-actions');

// Code host
q('host.type', 'Code host', 'Which code host holds this repository?', 'choice', hostType, (c, v) => set(c.config, 'host.type', v), { choices: HOSTS });
q('host.url', 'Code host', 'Its base URL (a self-managed server, GitHub Enterprise, Azure DevOps Server)?', 'text', (c) => c.config.host?.url ?? (c.detected?.host?.type === hostType(c) ? c.detected.host.url : null) ?? DEFAULT_URLS[hostType(c)] ?? '', (c, v) => (v && v !== DEFAULT_URLS[hostType(c)] ? set(c.config, 'host.url', v) : null), { when: (c) => hostType(c) !== 'custom' });
q('host.repo', 'Code host', 'The repository (owner/name; group/project; organization/project/repository; workspace/repository)?', 'text', (c) => c.config.host?.repo ?? (c.detected?.host?.type === hostType(c) ? c.detected.host.repo : null) ?? '', (c, v) => (v ? set(c.config, 'host.repo', v) : null));
q('host.token', 'Code host', 'The environment variable (or CI secret) that will hold the code host token?', 'variable', (c) => refName(c.config.host?.token) ?? TOKEN_DEFAULTS[hostType(c)] ?? '', (c, v) => set(c.config, 'host.token', ref(v)), { when: (c) => !['github', 'custom'].includes(hostType(c)), note: 'GitHub uses the signed-in gh CLI; a token is optional there.' });
q('host.command', 'Code host', 'The command that implements the code host contract (docs/providers/custom.md)?', 'text', (c) => c.config.host?.command ?? 'node scripts/factory-host.mjs', (c, v) => set(c.config, 'host.command', v), { when: (c) => hostType(c) === 'custom' });

// Tracker
q('tracker.type', 'Ticket board', 'Which ticket board holds the stories?', 'choice', (c) => trackerType(c) ?? 'jira', (c, v) => set(c.config, 'tracker.type', v), { choices: TRACKERS });
q('tracker.url', 'Ticket board', 'Its URL (Jira site or Data Center base URL; Azure DevOps organization URL; GitLab server)?', 'text', (c) => c.config.tracker?.url ?? { 'azure-boards': c.config.host?.url && c.config.host?.repo ? `${c.config.host.url}/${c.config.host.repo.split('/')[0]}` : 'https://dev.azure.com/<organization>', gitlab: c.config.host?.url ?? 'https://gitlab.com', linear: 'https://api.linear.app' }[trackerType(c)] ?? '', (c, v) => (v ? set(c.config, 'tracker.url', v) : null), { when: (c) => ['jira', 'azure-boards', 'gitlab', 'linear'].includes(trackerType(c)) });
q('tracker.project', 'Ticket board', 'The project (Jira project key; Azure DevOps project; GitLab project path; Linear team key)?', 'text', (c) => c.config.tracker?.project ?? (trackerType(c) === 'azure-boards' ? c.config.host?.repo?.split('/')[1] : trackerType(c) === 'gitlab' ? c.config.host?.repo : '') ?? '', (c, v) => (v ? set(c.config, 'tracker.project', v) : null), { when: (c) => ['jira', 'azure-boards', 'gitlab', 'linear'].includes(trackerType(c)) });
q('tracker.board', 'Ticket board', 'The board (Jira board id; Azure DevOps team; GitHub project number; blank: find or create it)?', 'text', (c) => (trackerType(c) === 'github' ? c.config.board?.projectNumber : c.config.tracker?.board?.id ?? c.config.tracker?.board?.team) ?? '', (c, v) => {
  if (!v) return;
  if (trackerType(c) === 'github') set(c.config, 'board.projectNumber', Number(v) || null);
  else set(c.config, trackerType(c) === 'azure-boards' ? 'tracker.board.team' : 'tracker.board.id', v);
});
q('tracker.existing', 'Ticket board', 'Use an existing board as it is (yes), or let `board setup` create the missing lanes, labels and fields (no)? Existing statuses are never renamed or removed either way.', 'bool', (c) => c.config.tracker?.board?.existing ?? Boolean(c.config.board?.projectNumber ?? c.config.tracker?.board?.id), (c, v) => set(c.config, trackerType(c) === 'github' ? 'board.existing' : 'tracker.board.existing', yes(v)));
q('tracker.shared', 'Ticket board', 'Is the board shared with other teams or repositories? (setup then changes nothing that is not this repository\'s)', 'bool', (c) => c.config.tracker?.board?.shared ?? c.config.board?.shared ?? false, (c, v) => set(c.config, trackerType(c) === 'github' ? 'board.shared' : 'tracker.board.shared', yes(v)));
for (const lane of LANES) {
  q(`tracker.lanes.${lane}`, 'Ticket board', `The board's status or column for the pipeline's "${lane}" lane?`, 'text', (c) => (trackerType(c) === 'github' ? c.config.board?.columns?.[lane] : c.config.tracker?.lanes?.[lane]) ?? LANE_DEFAULTS[lane], (c, v) => {
    const at = trackerType(c) === 'github' ? `board.columns.${lane}` : `tracker.lanes.${lane}`;
    // The factory's own name needs no setting (it stays out of the config unless it was set).
    if (v && (v !== LANE_DEFAULTS[lane] || get(c.config, at) !== undefined)) set(c.config, at, v);
  });
}
q('tracker.user', 'Ticket board', 'The environment variable that will hold the Jira user (Cloud: the account e-mail; Data Center with a personal access token: leave blank)?', 'text', (c) => refName(c.config.tracker?.auth?.user) ?? 'JIRA_EMAIL', (c, v) => (v ? set(c.config, 'tracker.auth.user', ref(variableName(v))) : set(c.config, 'tracker.auth.user', undefined)), { when: (c) => trackerType(c) === 'jira' });
q('tracker.token', 'Ticket board', 'The environment variable that will hold the board token?', 'variable', (c) => refName(c.config.tracker?.auth?.token) ?? (trackerType(c) === 'gitlab' && hostType(c) === 'gitlab' ? refName(c.config.host?.token) : null) ?? TOKEN_DEFAULTS[trackerType(c)] ?? '', (c, v) => set(c.config, 'tracker.auth.token', ref(v)), { when: (c) => !['github', 'custom'].includes(trackerType(c)) });
q('tracker.command', 'Ticket board', 'The command that implements the tracker contract (docs/providers/custom.md)?', 'text', (c) => c.config.tracker?.command ?? 'node scripts/factory-tracker.mjs', (c, v) => set(c.config, 'tracker.command', v), { when: (c) => trackerType(c) === 'custom' });

// CI
q('ci.provider', 'CI system', 'Which CI system runs the pipelines?', 'choice', ciType, (c, v) => set(c.config, 'ci.provider', v), { choices: CI_SYSTEMS });
q('ci.url', 'CI system', 'The CI server URL (Jenkins)?', 'text', (c) => c.config.ci?.url ?? '', (c, v) => (v ? set(c.config, 'ci.url', v) : null), { when: (c) => ciType(c) === 'jenkins' });
q('ci.job', 'CI system', 'The Jenkins job that builds this repository\'s pull requests (a Multibranch Pipeline job path, e.g. team/shop)?', 'text', (c) => c.config.ci?.job ?? '', (c, v) => (v ? set(c.config, 'ci.job', v) : null), { when: (c) => ciType(c) === 'jenkins' });
q('ci.project', 'CI system', 'The CircleCI project slug (gh/org/repo, bb/workspace/repo, or circleci/<org id>/<project id>)?', 'text', (c) => c.config.ci?.project ?? (c.answers['host.repo'] ? `${{ github: 'gh', bitbucket: 'bb' }[hostType(c)] ?? 'gh'}/${c.answers['host.repo']}` : ''), (c, v) => (v ? set(c.config, 'ci.project', v) : null), { when: (c) => ciType(c) === 'circleci' });
q('ci.user', 'CI system', 'The environment variable that will hold the Jenkins user name?', 'variable', (c) => refName(c.config.ci?.user) ?? 'JENKINS_USER', (c, v) => set(c.config, 'ci.user', ref(v)), { when: (c) => ciType(c) === 'jenkins' });
q('ci.token', 'CI system', 'The environment variable that will hold the CI API token (to read runs and logs)?', 'variable', (c) => refName(c.config.ci?.token) ?? TOKEN_DEFAULTS[ciType(c)] ?? '', (c, v) => set(c.config, 'ci.token', ref(v)), { when: (c) => ['jenkins', 'circleci'].includes(ciType(c)) || (ciType(c) === 'bitbucket-pipelines' && hostType(c) !== 'bitbucket') });
q('ci.command', 'CI system', 'The command that implements the CI contract (docs/providers/custom.md)?', 'text', (c) => c.config.ci?.command ?? 'node scripts/factory-ci.mjs', (c, v) => set(c.config, 'ci.command', v), { when: (c) => ciType(c) === 'custom' });

// Merging and reviews
q('review.autoMerge', 'Merging and reviews', 'May the review gate merge a Low-risk, high-confidence bug fix by itself once its CI is green on that head?', 'bool', (c) => c.config.implement?.autoMerge?.enabled ?? true, (c, v) => set(c.config, 'implement.autoMerge.enabled', yes(v)));
q('review.mergeIdentity', 'Merging and reviews', 'Who merges: the developer\'s own login (gh-user), the pipeline\'s PR bot (bot), or an app/token with a rule bypass (app)?', 'choice', (c) => c.config.implement?.autoMerge?.identity ?? 'gh-user', (c, v) => set(c.config, 'implement.autoMerge.identity', v), { choices: ['gh-user', 'bot', 'app'], when: (c) => yes(c.answers['review.autoMerge'] ?? c.config.implement?.autoMerge?.enabled ?? true) });
q('review.owners', 'Merging and reviews', 'Who owns the factory\'s files (code owners: handles or teams, comma-separated)?', 'list', (c) => (c.pin.owners ?? []).join(', '), (c, v) => {
  const owners = list(v).map((o) => (o.startsWith('@') || o.includes('@') ? o : `@${o}`));
  if (owners.length) c.pin.owners = owners;
});
q('review.enforce', 'Merging and reviews', 'Will a repository admin let `factory review-gate enforce` require review-quorum and the CI checks on the default branch? (yes: doctor warns until it is done; no: reviews are advisory and doctor says so)', 'bool', (c) => c.config.implement?.reviewGate?.enforced ?? true, (c, v) => set(c.config, 'implement.reviewGate.enforced', yes(v)));

// Agents and models
q('agents.local', 'Agents', 'Which agent CLIs are installed and signed in on this machine?', 'list', (c) => (c.config.agent?.available?.local ?? AGENT_CLIS.filter((x) => c.probe?.(x))).join(', '), (c, v) => {
  const clis = list(v).filter((x) => AGENT_CLIS.includes(x));
  set(c.config, 'agent.available.local', clis);
  const files = clis.filter((x) => ['claude', 'codex', 'gemini', 'cursor', 'copilot'].includes(x));
  if (files.length) c.pin.tools = [...new Set(files)];
});
q('agents.ci', 'Agents', 'Which agent CLIs may run in CI (the PR check, the retro)?', 'list', (c) => (c.config.agent?.available?.ci ?? [c.config.agent?.cli ?? 'claude']).join(', '), (c, v) => set(c.config, 'agent.available.ci', list(v).filter((x) => AGENT_CLIS.includes(x))));
q('agents.default', 'Agents', 'The default agent CLI for the pipeline\'s agents?', 'choice', (c) => c.config.agent?.cli ?? list(c.answers['agents.local'])[0] ?? 'claude', (c, v) => set(c.config, 'agent.cli', v), { choices: ['claude', 'codex', 'copilot'] });
for (const cli of ['claude', 'codex', 'copilot']) {
  q(`agents.models.${cli}`, 'Agents', `Which models may ${cli} use (aliases: opus, sonnet, sol, ...; your subscription decides)?`, 'list', (c) => (c.config.agent?.available?.models?.[cli] ?? { claude: ['opus', 'sonnet'], codex: ['sol'], copilot: ['sonnet'] }[cli]).join(', '), (c, v) => set(c.config, `agent.available.models.${cli}`, list(v)), { when: (c) => list(c.answers['agents.local'] ?? '').includes(cli) || list(c.answers['agents.ci'] ?? '').includes(cli) });
}
q('council.seat', 'Agents', 'Seat a council of verifiers from those CLIs and models (review and PR check)?', 'bool', (c) => Boolean(c.config.council), (c, v) => {
  if (!yes(v)) return;
  if (c.config.council?.members?.length) return; // an existing council is kept as it is
  const clis = list(c.answers['agents.local'] ?? '').filter((x) => ['claude', 'codex', 'copilot'].includes(x));
  const members = clis.flatMap((cli) => list(c.answers[`agents.models.${cli}`] ?? '').slice(0, 1).map((model) => ({ name: `${cli}-${model}`.replace(/[^\w-]/g, '-'), cli, model, effort: 'high', lens: 'correctness' })));
  if (members.length) set(c.config, 'council', { onUnavailable: 'fail', members, stages: { review: {}, prCheck: {} } });
});

// UI verification and videos
q('browser.available', 'UI verification', 'Is a browser (Playwright) and the test stack (Docker) available for UI verification and feature videos?', 'bool', (c) => Boolean(c.pin.features?.demoVideo ?? c.config.implement?.ui?.teststackCmd), (c, v) => {
  c.pin.features = { ...(c.pin.features ?? {}), demoVideo: yes(v) };
  if (yes(v)) set(c.config, 'implement.ui.teststackCmd', c.config.implement?.ui?.teststackCmd ?? ['node', '.factory/bin/factory.mjs', 'teststack']);
});

// Observability
q('metrics.sink', 'Observability', 'Where do agent metrics go: none, directory, http, otlp or command?', 'choice', (c) => c.config.metrics?.sink?.type ?? 'none', (c, v) => set(c.config, 'metrics.sink.type', v), { choices: ['none', 'directory', 'http', 'otlp', 'command'] });
q('metrics.target', 'Observability', 'The store\'s path, URL or command?', 'text', (c) => c.config.metrics?.sink?.path ?? c.config.metrics?.sink?.url ?? c.config.metrics?.sink?.command ?? '', (c, v) => {
  const type = c.answers['metrics.sink'];
  if (v) set(c.config, `metrics.sink.${type === 'directory' ? 'path' : type === 'command' ? 'command' : 'url'}`, v);
}, { when: (c) => !['none', undefined].includes(c.answers['metrics.sink']) });
q('metrics.token', 'Observability', 'The environment variable that holds the store\'s token (blank: none)?', 'text', (c) => refName(String(c.config.metrics?.sink?.headers?.Authorization ?? '').replace(/^Bearer /, '')) ?? '', (c, v) => (v ? set(c.config, 'metrics.sink.headers', { Authorization: `Bearer ${ref(variableName(v))}` }) : null), { when: (c) => ['http', 'otlp'].includes(c.answers['metrics.sink']) });

// Static analysis and the client's scanner
q('analysis.enabled', 'Static analysis', 'Run the open-source static analysis (secrets, dependencies, security patterns) in the fix loop and CI?', 'bool', (c) => Boolean(c.config.analysis), (c, v) => (yes(v) ? set(c.config, 'analysis', c.config.analysis ?? {}) : set(c.config, 'analysis', undefined)));
q('analysis.licenceReview', 'Static analysis', 'Licence review mode: default (items pending legal review stay on) or strict (they are off)?', 'choice', (c) => c.config.analysis?.licenceReview ?? 'default', (c, v) => set(c.config, 'analysis.licenceReview', v === 'default' ? undefined : v), { choices: ['default', 'strict'], when: (c) => yes(c.answers['analysis.enabled']) });
q('scanner.id', 'Commercial scanner', 'Does the client have a commercial scanner to integrate?', 'choice', (c) => c.config.analysis?.commercial?.scanner ?? 'none', (c, v) => (v !== 'none' ? set(c.config, 'analysis.commercial.scanner', v) : null), { choices: SCANNERS });
const scannerOn = (c) => (c.answers['scanner.id'] ?? 'none') !== 'none';
q('scanner.mode', 'Commercial scanner', 'How does it run: local (its CLI in the fix loop and CI) or server (it scans in the client\'s CI or SaaS; the harness waits for the result of each head)?', 'choice', (c) => c.config.analysis?.commercial?.mode ?? COMMERCIAL[c.answers['scanner.id']]?.commercial.modes[0] ?? 'local', (c, v) => set(c.config, 'analysis.commercial.mode', v), { choices: ['local', 'server'], when: scannerOn });
q('scanner.replaces', 'Commercial scanner', 'Which open-source jobs does it replace (sast, sca, secrets; blank: it runs beside them, findings deduplicated)?', 'list', (c) => (c.config.analysis?.commercial?.replaces ?? []).join(', '), (c, v) => set(c.config, 'analysis.commercial.replaces', list(v).filter((x) => ['sast', 'sca', 'secrets'].includes(x))), { when: scannerOn });
q('scanner.token', 'Commercial scanner', 'The environment variable (and CI secret) that holds the scanner\'s token?', 'variable', (c) => refName(c.config.analysis?.commercial?.token) ?? SCANNER_TOKENS[c.answers['scanner.id']] ?? '', (c, v) => set(c.config, 'analysis.commercial.token', ref(v)), { when: scannerOn });
q('scanner.server', 'Commercial scanner', 'The scanner\'s server or tenant URL (SonarQube, Checkmarx; blank for the vendor\'s default)?', 'text', (c) => c.config.analysis?.commercial?.url ?? '', (c, v) => (v ? set(c.config, 'analysis.commercial.url', v) : null), { when: (c) => scannerOn(c) && ['sonarqube', 'checkmarx', 'semgrep'].includes(c.answers['scanner.id']) });
q('scanner.project', 'Commercial scanner', 'The scanner\'s project or application name for this repository?', 'text', (c) => c.config.analysis?.commercial?.project ?? '', (c, v) => (v ? set(c.config, 'analysis.commercial.project', v) : null), { when: (c) => scannerOn(c) && ['sonarqube', 'checkmarx', 'veracode', 'snyk-code', 'snyk-open-source'].includes(c.answers['scanner.id']) });
q('scanner.deployment', 'Commercial scanner', 'The Semgrep deployment slug (the organisation in Semgrep AppSec Platform)?', 'text', (c) => c.config.analysis?.commercial?.deployment ?? '', (c, v) => (v ? set(c.config, 'analysis.commercial.deployment', v) : null), { when: (c) => scannerOn(c) && c.answers['scanner.id'] === 'semgrep' && c.answers['scanner.mode'] === 'server' });
q('scanner.check', 'Commercial scanner', 'The exact name of the check the scanner reports on a pull request (it joins the checks a head needs before a merge)?', 'text', (c) => c.config.analysis?.commercial?.check ?? COMMERCIAL[c.answers['scanner.id']]?.commercial.check ?? '', (c, v) => (v ? set(c.config, 'analysis.commercial.check', v) : null), { when: (c) => scannerOn(c) && c.answers['scanner.mode'] === 'server' });
q('scanner.acceptedBy', 'Commercial scanner', 'Who accepts the scanner\'s licence for this engagement (a named person and the date)? The tool stays off until a person is named.', 'text', (c) => c.config.analysis?.acceptLicence?.find((a) => a.tool === c.answers['scanner.id'])?.by ?? '', (c, v) => {
  if (!v) return;
  const id = c.answers['scanner.id'];
  const others = (c.config.analysis?.acceptLicence ?? []).filter((a) => a.tool !== id);
  set(c.config, 'analysis.acceptLicence', [...others, { tool: id, licence: COMMERCIAL[id]?.licence ?? `${id} commercial licence (the client's)`, by: v, ...(id === 'codeql' ? { rejected: true } : {}) }]);
}, { when: scannerOn });

export const QUESTIONS = Q;

// ---- running it ----------------------------------------------------------------------------------------------
function normalise(question, raw) {
  const v = typeof raw === 'string' ? raw.trim() : raw;
  if (question.kind === 'choice') {
    const s = String(v);
    if (!question.choices.includes(s)) throw new Error(`${question.id}: "${s}" is not one of ${question.choices.join(', ')}`);
    return s;
  }
  if (question.kind === 'bool') {
    if (typeof v === 'boolean') return v;
    if (!/^(y|yes|n|no|true|false|1|0|on|off)$/i.test(String(v))) throw new Error(`${question.id}: answer yes or no`);
    return yes(v);
  }
  if (question.kind === 'variable') return variableName(v);
  if (question.kind === 'list') return list(v).join(', ');
  return v == null ? '' : String(v);
}

const show = (v) => (typeof v === 'boolean' ? (v ? 'yes' : 'no') : Array.isArray(v) ? v.join(', ') : String(v ?? ''));

// Runs the interview. `ask(question, defaultShown)` returns the line typed ('' keeps the default); `answers` are given
// answers by id (an answers file and --set flags), which are used without asking.
export async function interview({ detected = {}, config = {}, pin = {}, ask = null, answers = {}, probe = null } = {}) {
  const ctx = { detected, config: structuredClone(config ?? {}), pin: structuredClone(pin ?? {}), answers: {}, probe };
  const asked = [];
  const unknown = Object.keys(answers).filter((id) => !Q.some((x) => x.id === id));
  if (unknown.length) throw new Error(`unknown answer id(s): ${unknown.join(', ')} (factory init --questions lists them)`);
  for (const question of Q) {
    if (question.when && !question.when(ctx)) continue;
    const def = question.def(ctx);
    let value;
    let source;
    if (Object.hasOwn(answers, question.id)) {
      value = normalise(question, answers[question.id]);
      source = 'given';
    } else if (ask) {
      let prompt = question;
      for (;;) {
        const typed = await ask(prompt, show(def));
        try {
          value = normalise(question, typed === '' || typed == null ? def : typed);
          break;
        } catch (error) {
          if (typed === '' || typed == null) throw error; // a default that is not valid: say so
          prompt = { ...question, ask: `${error.message}. ${question.ask}` };
        }
      }
      source = 'asked';
    } else {
      // Headless without an answer: the default shown, recorded as such.
      if (def === '' || def == null) continue;
      value = normalise(question, def);
      source = 'default';
    }
    ctx.answers[question.id] = value;
    question.apply(ctx, value);
    asked.push({ id: question.id, section: question.section, question: question.ask, answer: show(value), source });
  }
  return { config: ctx.config, pin: ctx.pin, asked };
}

// A readline asker for a terminal: prints the section once, the question and its default.
export function terminalAsk({ input = process.stdin, output = process.stdout } = {}) {
  let section = null;
  let rl = null;
  const lines = [];
  let waiting = null;
  return async (question, def) => {
    if (!rl) {
      const readline = await import('node:readline');
      rl = readline.createInterface({ input, terminal: false });
      rl.on('line', (l) => (waiting ? (waiting(l), (waiting = null)) : lines.push(l)));
      rl.on('close', () => waiting?.(''));
    }
    if (question.section !== section) {
      section = question.section;
      output.write(`\n== ${section}\n`);
    }
    if (question.note) output.write(`   (${question.note})\n`);
    output.write(`${question.ask}${question.choices ? ` [${question.choices.join(' | ')}]` : ''}${def !== '' ? ` (${def})` : ''}: `);
    return lines.length ? lines.shift() : new Promise((resolve) => (waiting = resolve));
  };
}

// The answers file: JSON { "<id>": value } (or { "answers": { ... } }); --set id=value flags on top.
export function readAnswers(text, sets = []) {
  const parsed = text ? JSON.parse(text) : {};
  const answers = { ...(parsed.answers ?? parsed) };
  delete answers.$comment;
  for (const s of sets) {
    const at = String(s).indexOf('=');
    if (at < 1) throw new Error(`--set ${s}: use --set <id>=<value>`);
    answers[s.slice(0, at)] = s.slice(at + 1);
  }
  return answers;
}

// What the interview changes, path by path, for --dry-run: [{ path, before, after }].
export function changes(before, after, prefix = '') {
  const out = [];
  const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);
  for (const k of keys) {
    const p = prefix ? `${prefix}.${k}` : k;
    const a = before?.[k];
    const b = after?.[k];
    const obj = (x) => x && typeof x === 'object' && !Array.isArray(x);
    if ((obj(a) || a === undefined) && (obj(b) || b === undefined) && (obj(a) || obj(b))) out.push(...changes(a ?? {}, b ?? {}, p));
    else if (JSON.stringify(a) !== JSON.stringify(b)) out.push({ path: p, before: a, after: b });
  }
  return out;
}

export { get as getPath };
