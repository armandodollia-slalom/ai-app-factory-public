// Static analysis settings (`analysis` in .factory/config.json): which tools exist, how each one runs, is parsed,
// scoped, baselined and blocks, and which run in which slot of the pipeline. Opt-in: without an `analysis` section
// nothing here runs and nothing else in the engine changes.
//
// A tool is data, never code in the engine:
//   run        argv (["{bin}", "detect", "--report-format", "sarif", "--report-path", "{out}"]) or a command line
//   fix        argv or command line of its auto-fix (optional), run on the files the change touches
//   parse      "sarif" | "msbuild" | "eslint-json" | "eslint" | "lines" | "gitleaks-json" | "module:<path>" (a pack's parser)
//   output     "stdout" (default) or a path template with {out} (the file the tool writes)
//   scope      "changed-lines" | "changed-files" | "repo": what the tool is given and which findings are kept
//   baseline   "lines" (a finding counts when it is on a line the change added or changed) |
//              "merge-base" (it counts when the merge-base does not have it, by fingerprint)
//   block      { levels: ["error"], rules: ["CA2100", "generic-*"] }: what blocks; everything else is reported only
//   lens       the council lens its findings belong to (correctness, security, test-value, rewrite, ...)
//   timeoutSec, extensions (the files it reads), env, protect (its configuration and suppression files),
//   version { cmd, match } (doctor), install { version, platforms: { "linux-x64": { url, sha256, bin } } } (a pinned
//   binary), sample (a file its parser must understand; doctor)
// The language packs supply tools (packs/<id>/analysis.json); the repository's own `analysis.tools` entries override
// them by id. `precheck` is the repository's own linters and formatters (precheck.lint / precheck.fix) as one tool.
import fs from 'node:fs';
import path from 'node:path';
import { INSTALL_ROOT } from '../config.mjs';
import { licenceRows } from './licences.mjs';
import { SEVERITIES, VENDOR_SEVERITIES } from './commercial.mjs';

export const SLOTS = ['pair', 'story', 'prCheck', 'featureVerification', 'ci'];
export const SCOPES = ['changed-lines', 'changed-files', 'repo'];
// native: the tool itself reports only what the change introduced (a commit range, a baseline-commit flag);
// fingerprint: merge-base vs HEAD by fingerprint (merge-base is the same mode under its older name).
export const BASELINES = ['lines', 'merge-base', 'fingerprint', 'native'];
export const BUILTIN_PARSERS = ['sarif', 'msbuild', 'eslint-json', 'eslint', 'lines', 'gcc', 'gitleaks-json', 'actionlint-json', 'osv-json'];
export const LEVELS = ['error', 'warning', 'note'];
export const LENSES = ['correctness', 'acceptance', 'security', 'test-value', 'rewrite', 'ui'];
export const PRECHECK_TOOL = 'precheck';
export const FIX_BOUNCES_DEFAULT = 2;
export const PLATFORMS = ['linux-x64', 'linux-arm64', 'darwin-x64', 'darwin-arm64', 'win32-x64', 'win32-arm64'];

const TOOL_KEYS = ['run', 'worktreeRun', 'exclude', 'fix', 'parse', 'output', 'scope', 'baseline', 'block', 'lens', 'timeoutSec', 'extensions', 'env', 'protect', 'version', 'install', 'sample', 'description', 'okExit', 'enabled', 'when', 'onChange', 'rules', 'prepare', 'freshness', 'offline', 'needsRules', 'licence', 'data', 'rulesArg', 'validateRule', 'ruleFilter', 'licenceReview', 'errorPattern', 'missingPattern', 'forbid', 'severity', 'commercial', 'submitOnly', '$comment'];
const SECTION_KEYS = ['$comment', 'tools', 'stages', 'fixLoop', 'suppressions', 'protect', 'coverage', 'ci', 'maxConcurrent', 'reports', 'acceptLicence', 'licenceReview', 'vars', 'secrets', 'commercial'];
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isCmd = (v) => (typeof v === 'string' && v.trim()) || (Array.isArray(v) && v.length && v.every((a) => typeof a === 'string'));

export const analysisOn = (config) => isObject(config?.analysis);

// The analysis defaults of the repository's language packs: { tools, stages, suppressions, protect, ci }.
// The `security` pack (language-neutral scanners) comes first whenever analysis is on; the `commercial` pack's
// definitions (every one off) follow, for analysis.commercial to turn on.
export function packAnalysis(languages = [], installRoot = INSTALL_ROOT) {
  const out = { tools: {}, stages: {}, suppressions: [], protect: [], ci: [], coverage: null, vars: {}, groups: {} };
  for (const id of ['security', 'commercial', ...languages.filter((l) => l !== 'security' && l !== 'commercial')]) {
    const file = path.join(installRoot, 'packs', id, 'analysis.json');
    if (!fs.existsSync(file)) continue;
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const [tid, tool] of Object.entries(doc.tools ?? {})) out.tools[tid] ??= { ...tool, pack: id };
    for (const [slot, ids] of Object.entries(doc.stages ?? {})) out.stages[slot] = [...new Set([...(out.stages[slot] ?? []), ...ids])];
    out.suppressions.push(...(doc.suppressions ?? []));
    out.protect.push(...(doc.protect ?? []));
    // A job another pack already declared gets this pack's tools too (the dependency audit of every ecosystem in one job).
    for (const job of doc.ci ?? []) {
      const had = out.ci.find((j) => j.id === job.id);
      if (had) Object.assign(had, { tools: [...new Set([...had.tools, ...job.tools])], toolchain: had.toolchain || job.toolchain });
      else out.ci.push({ ...job, tools: [...job.tools] });
    }
    Object.assign(out.vars, doc.vars ?? {});
    for (const [g, ids] of Object.entries(doc.groups ?? {})) if (Array.isArray(ids)) out.groups[g] = [...new Set([...(out.groups[g] ?? []), ...ids])];
    out.coverage ??= doc.coverage ?? null;
  }
  return out;
}

// Inline suppressions every repository is checked for (the packs add their languages' own). Regular expressions,
// matched against the lines a change adds.
export const SUPPRESSIONS_DEFAULT = [
  { id: 'secret-allow', pattern: 'gitleaks:allow|nosecret|pragma:\\s*allowlist\\s+secret' },
  { id: 'nosonar', pattern: 'NOSONAR' },
  { id: 'nosec', pattern: '#\\s*nosec\\b|//\\s*#?nosec\\b' },
];

// The analysis section with pack defaults filled in, every tool normalised. Returns null when analysis is off.
export function resolveAnalysis(config, { installRoot = INSTALL_ROOT } = {}) {
  if (!analysisOn(config)) return null;
  const a = config.analysis;
  const packs = packAnalysis(config.project?.languages ?? [], installRoot);
  const tools = new Map();
  // A repository's entry for a pack's tool changes only the keys it names ({ "enabled": true } turns an optional one on).
  const declared = { ...packs.tools };
  for (const [id, t] of Object.entries(a.tools ?? {})) declared[id] = t === null ? null : { ...(packs.tools[id] ?? {}), ...t };
  // The client's commercial scanner(s): the pack's definition, turned on, with the client's token reference, severity
  // overrides, mode and project (docs/providers/commercial-scanners.md).
  const scanners = commercialEntries(a).filter((e) => packs.tools[e.scanner]?.commercial || a.tools?.[e.scanner]?.commercial);
  for (const e of scanners) declared[e.scanner] = commercialTool(declared[e.scanner] ?? packs.tools[e.scanner], e);
  const hasPrecheck = Object.keys(config.precheck?.lint ?? {}).length > 0;
  if (hasPrecheck && !declared[PRECHECK_TOOL]) declared[PRECHECK_TOOL] = { builtin: PRECHECK_TOOL };
  for (const [id, raw] of Object.entries(declared)) {
    if (raw === null || raw?.enabled === false) continue;
    const t = id === PRECHECK_TOOL ? precheckTool(config, raw) : normalizeTool(id, raw, installRoot);
    if (t) tools.set(id, t);
  }
  // The repository's own linters run in every slot but CI (whose lint job already runs them); the packs add theirs.
  const defaultStages = { ci: packs.stages.ci ?? [] };
  for (const slot of ['pair', 'story', 'prCheck', 'featureVerification']) defaultStages[slot] = [...new Set([...(hasPrecheck ? [PRECHECK_TOOL] : []), ...(packs.stages[slot] ?? packs.stages.pair ?? [])])];
  const stages = Object.fromEntries(SLOTS.map((s) => [s, [...(a.stages?.[s] ?? defaultStages[s] ?? [])].filter((id) => tools.has(id))]));
  let jobs = Array.isArray(a.ci?.jobs) ? a.ci.jobs : packs.ci;
  // A scanner that replaces open-source jobs takes their place in CI and their tools leave the fix-loop stages; one
  // beside them adds its own job (findings at the same place and CWE are reported once: commercial.mjs dedupe).
  const replaced = new Set(scanners.flatMap((e) => e.replaces));
  if (replaced.size) {
    const gone = new Set([...jobs.filter((j) => replaced.has(j.id)).flatMap((j) => j.tools), ...[...replaced].flatMap((g) => packs.groups[g] ?? [])]);
    const kept = new Set(jobs.filter((j) => !replaced.has(j.id)).flatMap((j) => j.tools));
    jobs = jobs.filter((j) => !replaced.has(j.id));
    for (const s of SLOTS) stages[s] = stages[s].filter((id) => !gone.has(id) || kept.has(id) || scanners.some((e) => e.scanner === id));
  }
  for (const e of scanners) {
    if (!tools.has(e.scanner)) continue;
    const t = tools.get(e.scanner);
    if (e.mode === 'local') for (const s of e.stages) if (!stages[s].includes(e.scanner)) stages[s].push(e.scanner);
    if (e.mode === 'server' && !t.run) continue; // the client's own CI integration scans; the gate waits for its check
    jobs = [...jobs, { id: `commercial-${e.scanner}`, name: e.jobName ?? `${t.commercial?.vendor ?? e.scanner} scan (${e.scanner})`, tools: [e.scanner], required: true, timeoutMin: e.timeoutMin, secrets: refNames([e.token, ...Object.values(e.env)]), description: e.mode === 'server' ? `uploads to ${t.commercial?.vendor ?? e.scanner}; the result of the head is read from the server` : null }];
  }
  // Licences: a tool, rule source or data source under a licence that is neither allowlisted nor accepted is not run or
  // loaded (factory doctor and `factory analysis check` fail on it and say why).
  const allTools = new Map(tools);
  const licences = licenceRows({ tools: allTools }, { acceptLicence: a.acceptLicence ?? [], review: a.licenceReview ?? 'default' });
  const gone = (r) => !r.ok || r.off;
  const bad = new Set(licences.filter((r) => gone(r) && r.kind === 'tool').map((r) => r.what));
  const dropped = (id, kind, sid) => licences.some((r) => gone(r) && r.kind === kind && (r.what === `${id} ${kind === 'rules' ? 'rules' : 'data'} ${sid}` || r.what.startsWith(`${id} rules ${sid} (`)));
  for (const [id, t] of [...tools]) {
    if (bad.has(id)) tools.delete(id);
    else tools.set(id, { ...t, rules: t.rules.filter((src) => !dropped(id, 'rules', src.id)), data: t.data.map((d) => (dropped(id, 'data', d.id) ? { ...d, excluded: true } : d)) });
  }
  // Known non-secrets a person declared (analysis.secrets.allow: the seeded demo users' password in every e2e spec, for
  // example): the secret scanner keeps its default rules and ignores exactly these values. Governance, never an agent's.
  // The factory's own placeholder marker is always on the list: a test value that contains it (FAKE_SECRET_MARKER) is never
  // flagged, here or in CI, so the test-writing agents have a fake token, key or password the scanner accepts.
  const declaredAllow = secretsAllow(a.secrets);
  const allow = { stopwords: [...new Set([FAKE_SECRET_MARKER, ...(declaredAllow?.stopwords ?? [])])], regexes: declaredAllow?.regexes ?? [] };
  if (tools.has('betterleaks')) {
    const t = tools.get('betterleaks');
    tools.set('betterleaks', { ...t, env: { ...(t.env ?? {}), BETTERLEAKS_CONFIG_TOML: betterleaksAllowToml(allow) } });
  }
  const blocked = Object.fromEntries(licences.filter((r) => !r.ok && r.kind === 'tool').map((r) => [r.what, r.problem]));
  for (const s of SLOTS) stages[s] = stages[s].filter((id) => tools.has(id) || blocked[id]);
  return {
    allTools,
    licences,
    blocked,
    tools,
    stages,
    fixLoop: { bounces: Number.isInteger(a.fixLoop?.bounces) ? a.fixLoop.bounces : FIX_BOUNCES_DEFAULT },
    // One pattern per id: a repository's own pattern replaces a pack's or the default of the same id.
    suppressions: [...new Map([...SUPPRESSIONS_DEFAULT, ...packs.suppressions, ...scanners.flatMap((e) => tools.get(e.scanner)?.commercial?.suppressions ?? []), ...(a.suppressions?.inline ?? [])].map((x) => [x.id, x])).values()],
    protect: [...new Set([...packs.protect, ...(a.protect ?? []), ...[...tools.values()].flatMap((t) => t.protect)])],
    coverage: a.coverage === undefined ? packs.coverage : a.coverage,
    ci: { jobs: a.ci?.enabled === false ? [] : jobs.map(normalizeJob).map((j) => ({ ...j, tools: j.tools.filter((id) => tools.has(id)) })).filter((j) => j.tools.length) },
    vars: { ...resolveVars(config, { ...packs.vars, ...(a.vars ?? {}) }), ...Object.assign({}, ...scanners.map((e) => e.vars)) },
    commercial: scanners.filter((e) => tools.has(e.scanner) || blocked[e.scanner]).map((e) => ({ ...e, tool: tools.get(e.scanner) ?? null, blocked: blocked[e.scanner] ?? null })),
    varSpecs: { ...packs.vars, ...(a.vars ?? {}) },
    maxConcurrent: Number.isInteger(a.maxConcurrent) ? a.maxConcurrent : 2,
    reports: { keep: a.reports?.keep ?? 200 },
  };
}

// The marker of a fake secret in test data: a value containing it is on the secret scanner's allow-list in every
// repository (the agents' instructions name it, beside analysis.secrets.allow).
export const FAKE_SECRET_MARKER = 'factoryfake';

const secretsAllow = (secrets) => {
  const allow = secrets?.allow;
  if (!allow) return null;
  const stopwords = (allow.stopwords ?? []).filter((x) => typeof x === 'string' && x);
  const regexes = (allow.regexes ?? []).filter((x) => typeof x === 'string' && x);
  return stopwords.length || regexes.length ? { stopwords, regexes } : null;
};

// The secret scanner's configuration: its default rules plus one allowlist of the declared values (TOML basic strings,
// escaped as JSON strings are).
export function betterleaksAllowToml({ stopwords = [], regexes = [] }) {
  const list = (xs) => `[${xs.map((x) => JSON.stringify(x)).join(', ')}]`;
  return ['[extend]', 'useDefault = true', '', '[[allowlists]]', 'description = "analysis.secrets.allow in .factory/config.json and the factory placeholder marker"', ...(stopwords.length ? [`stopwords = ${list(stopwords)}`] : []), ...(regexes.length ? [`regexes = ${list(regexes)}`] : []), ''].join('\n');
}

// Placeholders of the tools in use that no built-in and no analysis.vars value fills ({solution} with two solution files
// at the root): [{ tool, name, candidates }]. Such a tool is skipped at run time; check and doctor say so up front.
const BUILTIN_VARS = new Set(['files', 'rules', 'out', 'base', 'mergeBase', 'range', 'root', 'bin', 'cache', 'packs', 'factoryBin']);
export function unresolvedVars(resolved, root = null) {
  if (!resolved) return [];
  const used = new Set([...SLOTS.flatMap((s) => resolved.stages[s] ?? []), ...(resolved.ci?.jobs ?? []).flatMap((j) => j.tools)]);
  const out = [];
  for (const id of used) {
    const t = resolved.tools.get(id);
    if (!t) continue;
    const text = JSON.stringify([t.run, t.prepare ?? null]);
    for (const m of text.matchAll(/\{([a-z][A-Za-z0-9]*)\}/g)) {
      const name = m[1];
      if (BUILTIN_VARS.has(name) || Object.hasOwn(resolved.vars ?? {}, name) || out.some((u) => u.tool === id && u.name === name)) continue;
      const spec = resolved.varSpecs?.[name];
      let candidates = [];
      if (spec?.candidates && root) {
        try {
          candidates = fs.readdirSync(root).filter((n) => spec.candidates.some((c) => new RegExp(`^${c.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`).test(n)));
        } catch {
          /* no checkout */
        }
      }
      out.push({ tool: id, name, candidates });
    }
  }
  return out;
}

// Placeholders a pack's commands use beside the built-in ones ({solution}): a value from analysis.vars, else the one
// file at the repository root matching the pack's candidates.
function resolveVars(config, vars) {
  const out = {};
  for (const [k, v] of Object.entries(vars)) {
    if (typeof v === 'string') out[k] = v;
    else if (v?.candidates && config.root) {
      let names = [];
      try {
        names = fs.readdirSync(config.root);
      } catch {
        /* no checkout */
      }
      const hits = names.filter((n) => v.candidates.some((c) => new RegExp(`^${c.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`).test(n)));
      if (hits.length === 1) out[k] = hits[0];
    }
  }
  return out;
}

const expandPacks = (s, installRoot) => String(s).replace(/\{packs\}/g, path.join(installRoot, 'packs'));

export function normalizeTool(id, raw, installRoot = INSTALL_ROOT) {
  const parse = raw.parse ?? 'lines';
  return {
    id,
    pack: raw.pack ?? null,
    description: raw.description ?? null,
    run: raw.run,
    worktreeRun: raw.worktreeRun ?? null,
    fix: raw.fix ?? null,
    parse: parse.startsWith('module:') ? `module:${expandPacks(parse.slice(7), installRoot)}` : parse,
    output: raw.output ?? 'stdout',
    scope: raw.scope ?? 'changed-lines',
    baseline: raw.baseline === 'fingerprint' ? 'merge-base' : raw.baseline ?? (raw.scope === 'repo' ? 'merge-base' : 'lines'),
    when: raw.when ?? null,
    onChange: raw.onChange ?? null,
    rules: normalizeRules(raw.rules),
    rulesArg: raw.rulesArg ?? '--config',
    validateRule: raw.validateRule ?? null,
    ruleFilter: raw.ruleFilter ?? null,
    licence: raw.licence ?? null,
    licenceReview: raw.licenceReview ?? null,
    errorPattern: raw.errorPattern ?? null,
    missingPattern: raw.missingPattern ?? null,
    forbid: raw.forbid ?? [],
    data: raw.data ?? [],
    prepare: raw.prepare ?? null,
    freshness: raw.freshness ?? null,
    offline: raw.offline ?? [],
    needsRules: Boolean(raw.needsRules),
    block: { levels: raw.block?.levels ?? [], rules: raw.block?.rules ?? [] },
    lens: raw.lens ?? 'correctness',
    timeoutSec: raw.timeoutSec ?? 600,
    extensions: raw.extensions ?? null,
    exclude: raw.exclude ?? [],
    env: raw.env ?? {},
    protect: raw.protect ?? [],
    version: raw.version ?? null,
    install: raw.install ?? null,
    sample: raw.sample ? expandPacks(raw.sample, installRoot) : null,
    okExit: raw.okExit ?? null,
    severity: raw.severity ?? null,
    commercial: raw.commercial ?? null,
    submitOnly: Boolean(raw.submitOnly),
  };
}

// analysis.commercial: one scanner ({ scanner, mode, ... }) or a list of them, normalised:
//   { scanner, mode: local | server, replaces: [job ids], token: "${NAME}", env: { VENDOR_VAR: "${NAME}" },
//     severity: { critical|high|medium|low|info: blocking|major|minor }, check, url, project, timeoutMin, stages, vars }
const refNames = (values) => [...new Set(values.flatMap((v) => [...String(v ?? '').matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g)].map((m) => m[1])))];
const JOB_ALIASES = { sca: 'dependencies', dependency: 'dependencies', secret: 'secrets' };
export function commercialEntries(section) {
  const c = section?.commercial;
  if (!c) return [];
  return (Array.isArray(c) ? c : [c]).filter((e) => isObject(e) && typeof e.scanner === 'string' && e.enabled !== false).map((e) => ({
    scanner: e.scanner,
    mode: e.mode === 'server' ? 'server' : 'local',
    replaces: [...new Set((e.replaces ?? []).map((j) => JOB_ALIASES[j] ?? j))],
    token: e.token ?? null,
    env: isObject(e.env) ? e.env : {},
    severity: isObject(e.severity) ? e.severity : {},
    check: e.check ?? null,
    url: e.url ?? null,
    project: e.project ?? null,
    timeoutMin: Number.isInteger(e.timeoutMin) && e.timeoutMin > 0 ? e.timeoutMin : 60,
    stages: Array.isArray(e.stages) ? e.stages.filter((s) => SLOTS.includes(s) && s !== 'ci') : ['story', 'prCheck'],
    jobName: e.jobName ?? null,
    vars: { ...(isObject(e.vars) ? e.vars : {}), ...(e.project ? { project: e.project } : {}), ...(e.url ? { url: e.url } : {}) },
  }));
}

// A commercial definition turned on for one client: its token reaches the vendor's own variable from the client's
// (never a value: a `${NAME}` reference expanded when the tool runs), the client's severity overrides win, and in
// server mode the CI job only uploads (the result of the head is read from the vendor, scanners/index.mjs).
function commercialTool(def, e) {
  const c = def.commercial ?? {};
  const env = { ...(def.env ?? {}), ...(c.tokenEnv && e.token ? { [c.tokenEnv]: e.token } : {}), ...e.env };
  const server = e.mode === 'server';
  return {
    ...def,
    enabled: true,
    env,
    severity: { ...(def.severity ?? {}), ...e.severity },
    commercial: { ...c, mode: e.mode, check: e.check ?? c.check ?? null, url: e.url ?? c.server?.url ?? null, project: e.project, timeoutMin: e.timeoutMin },
    ...(server ? { run: c.server?.submit ?? null, submitOnly: true, parse: 'lines', output: 'stdout' } : {}),
  };
}

// A tool's rule sources, as a list of { id, repo, commit, include, exclude, licence, requireHeader } (a pinned git
// source), { id, dir, licence } (a folder of the repository) or { id, builtin, include, licence } (the factory's own
// rules, packs/security/rules/<builtin>/<folder>). The older single object { git, commit, path } | { dir } is read too.
export function normalizeRules(rules) {
  if (rules === undefined || rules === null) return [];
  const list = Array.isArray(rules) ? rules : [rules.git ? { id: 'rules', repo: rules.git, commit: rules.commit, include: rules.path ? [rules.path] : [], licence: rules.licence } : { id: 'local', ...rules }];
  return list.filter((s) => s && s.enabled !== false).map((s) => ({ id: s.id, repo: s.repo ?? null, commit: s.commit ?? null, dir: s.dir ?? null, builtin: s.builtin ?? null, include: s.include ?? [], exclude: s.exclude ?? [], licence: s.licence ?? (s.builtin ? 'MIT' : null), licenceReview: s.licenceReview ?? null, requireHeader: s.requireHeader ?? null, note: s.note ?? null }));
}

// The repository's linters (precheck.lint, by extension) and fixers (precheck.fix) as one analysis tool. Its output
// is read with the lint parser the pre-commit hook and CI already use; every finding on a changed line blocks, as CI's
// lint does.
function precheckTool(config, raw = {}) {
  return {
    ...normalizeTool(PRECHECK_TOOL, { parse: 'lines', scope: 'changed-lines', baseline: 'lines', lens: 'correctness', block: { levels: ['error', 'warning'] }, ...raw, run: null }),
    builtin: PRECHECK_TOOL,
    lint: config.precheck?.lint ?? {},
    fixers: config.precheck?.fix ?? {},
  };
}

// A CI job, provider-neutral: { id, name, tools, required, when, fetchDepth, toolchain, timeoutMin }.
export function normalizeJob(job) {
  return {
    id: job.id,
    name: job.name ?? job.id,
    tools: job.tools ?? [],
    required: job.required !== false,
    when: job.when ?? ['pull_request'],
    fetchDepth: job.fetchDepth ?? 0,
    toolchain: Boolean(job.toolchain),
    timeoutMin: job.timeoutMin ?? 30,
    description: job.description ?? null,
    // The CI secrets the job's tools read (a commercial scanner's token): each CI system's renderer exposes exactly
    // these names from its own secret store; a job without any renders as before.
    ...(Array.isArray(job.secrets) && job.secrets.length ? { secrets: job.secrets } : {}),
  };
}

// Problems in an `analysis` section (with the packs' tools it may refer to). Every message names the key.
export function analysisProblems(section, { packTools = {}, precheck = false } = {}) {
  if (section === undefined) return [];
  if (!isObject(section)) return ['analysis must be an object'];
  const p = [];
  // analysis.secrets.allow: { stopwords: [string], regexes: [string] } (known non-secrets, set by a person).
  if (section?.secrets !== undefined) {
    const al = section.secrets?.allow;
    if (typeof section.secrets !== 'object' || section.secrets === null || (al !== undefined && (typeof al !== 'object' || al === null))) p.push('analysis.secrets must be { "allow": { "stopwords": [...], "regexes": [...] } }');
    for (const k of Object.keys(al ?? {})) if (!['stopwords', 'regexes'].includes(k) || !Array.isArray(al[k]) || al[k].some((x) => typeof x !== 'string' || !x)) p.push(`analysis.secrets.allow.${k} must be a list of non-empty strings (stopwords, regexes)`);
    for (const r of al?.regexes ?? []) {
      try {
        new RegExp(r);
      } catch {
        p.push(`analysis.secrets.allow.regexes: ${JSON.stringify(r)} is not a regular expression`);
      }
    }
  }
  for (const k of Object.keys(section)) if (!SECTION_KEYS.includes(k)) p.push(`analysis.${k} is not a setting (${SECTION_KEYS.filter((x) => x !== '$comment').join(', ')})`);
  if (section.tools !== undefined && !isObject(section.tools)) p.push('analysis.tools must map tool ids to tools');
  const known = new Set([...Object.keys(packTools), ...Object.keys(section.tools ?? {}), ...(precheck ? [PRECHECK_TOOL] : [])]);
  for (const [id, t] of Object.entries(isObject(section.tools) ? section.tools : {})) {
    const at = `analysis.tools.${id}`;
    if (!/^[a-z0-9][a-z0-9._-]*$/.test(id)) p.push(`${at}: a tool id is lower-case letters, digits, ".", "_" and "-"`);
    if (t === null) continue;
    if (!isObject(t)) {
      p.push(`${at} must be an object (or null to turn a pack's tool off)`);
      continue;
    }
    const merged = { ...(packTools[id] ?? {}), ...t };
    for (const k of Object.keys(t)) if (!TOOL_KEYS.includes(k)) p.push(`${at}.${k} is not a tool setting (${TOOL_KEYS.join(', ')})`);
    // A server-only scanner definition has no local command (its CI integration or its custom adapter scans).
    const serverOnly = isObject(merged.commercial) && Array.isArray(merged.commercial.modes) && merged.commercial.modes.length === 1 && merged.commercial.modes[0] === 'server';
    if (id !== PRECHECK_TOOL && merged.enabled !== false && !serverOnly) {
      if (!isCmd(merged.run)) p.push(`${at}.run must be a command: an argv array or a command line`);
      if (merged.fix !== undefined && merged.fix !== null && !isCmd(merged.fix)) p.push(`${at}.fix must be a command: an argv array or a command line`);
    }
    const parse = merged.parse ?? 'lines';
    if (typeof parse !== 'string' || !(BUILTIN_PARSERS.includes(parse) || parse.startsWith('module:'))) p.push(`${at}.parse "${parse}" is not a parser (${BUILTIN_PARSERS.join(', ')}, or module:<path> for a pack's own)`);
    if (merged.scope !== undefined && !SCOPES.includes(merged.scope)) p.push(`${at}.scope "${merged.scope}" is not a scope (${SCOPES.join(', ')})`);
    if (merged.baseline !== undefined && !BASELINES.includes(merged.baseline)) p.push(`${at}.baseline "${merged.baseline}" is not a baseline (${BASELINES.join(', ')})`);
    if (merged.output !== undefined && (typeof merged.output !== 'string' || (!['stdout', 'stderr'].includes(merged.output) && !merged.output.includes('{out}')))) p.push(`${at}.output must be "stdout", "stderr" or a path with {out}`);
    if (merged.lens !== undefined && !LENSES.includes(merged.lens)) p.push(`${at}.lens "${merged.lens}" is not a lens (${LENSES.join(', ')})`);
    if (merged.timeoutSec !== undefined && !(Number.isInteger(merged.timeoutSec) && merged.timeoutSec > 0)) p.push(`${at}.timeoutSec must be a positive whole number of seconds`);
    if (merged.block !== undefined) {
      if (!isObject(merged.block)) p.push(`${at}.block must be { levels: [...], rules: [...] }`);
      else {
        for (const l of merged.block.levels ?? []) if (!LEVELS.includes(l)) p.push(`${at}.block.levels: "${l}" is not a level (${LEVELS.join(', ')})`);
        if (merged.block.rules !== undefined && !(Array.isArray(merged.block.rules) && merged.block.rules.every((r) => typeof r === 'string'))) p.push(`${at}.block.rules must be a list of rule ids (a trailing * matches a prefix)`);
      }
    }
    if (merged.install !== undefined && merged.install !== null) p.push(...installProblems(merged.install, `${at}.install`));
    for (const k of ['when', 'onChange']) if (merged[k] !== undefined && merged[k] !== null && !(Array.isArray(merged[k]) && merged[k].every((g) => typeof g === 'string'))) p.push(`${at}.${k} must be a list of globs`);
    if (merged.rules !== undefined && merged.rules !== null) {
      const list = Array.isArray(merged.rules) ? merged.rules : [merged.rules];
      list.forEach((r, i) => {
        const ra = `${at}.rules[${i}]`;
        if (!isObject(r)) return p.push(`${ra} must be { id, repo, commit, include, exclude, licence } or { id, dir, licence }`);
        if (Array.isArray(merged.rules) && (typeof r.id !== 'string' || !/^[a-z0-9][a-z0-9._-]*$/.test(r.id))) p.push(`${ra}.id must be lower-case letters, digits, ".", "_" and "-"`);
        const repo = r.repo ?? r.git;
        if (!(typeof r.dir === 'string' || typeof r.builtin === 'string' || (typeof repo === 'string' && /^[0-9a-f]{40}$/.test(r.commit ?? '')))) p.push(`${ra} needs repo and a pinned commit (40 hex characters), dir or builtin`);
        for (const k of ['include', 'exclude']) if (r[k] !== undefined && !(Array.isArray(r[k]) && r[k].every((x) => typeof x === 'string'))) p.push(`${ra}.${k} must be a list of folders`);
        if (Array.isArray(merged.rules) && !r.builtin && (typeof r.licence !== 'string' || !r.licence)) p.push(`${ra}.licence must name the rule set's licence (an SPDX id or the licence's name)`);
      });
    }
    if ((merged.licence !== undefined || (id !== PRECHECK_TOOL && !packTools[id] && merged.enabled !== false)) && (typeof merged.licence !== 'string' || !merged.licence)) p.push(`${at}.licence must name the tool's licence (an SPDX id or the licence's name): a tool runs only under a licence the factory allows or a person accepted (analysis.acceptLicence)`);
    if (merged.prepare !== undefined && merged.prepare !== null && !isCmd(merged.prepare)) p.push(`${at}.prepare must be a command`);
    if (merged.offline !== undefined && !(Array.isArray(merged.offline) && merged.offline.every((a) => typeof a === 'string'))) p.push(`${at}.offline must list the flags that keep the tool offline (doctor checks its run command has them)`);
  }
  if (section.stages !== undefined) {
    if (!isObject(section.stages)) p.push('analysis.stages must map slots to tool ids');
    else
      for (const [slot, ids] of Object.entries(section.stages)) {
        if (!SLOTS.includes(slot)) p.push(`analysis.stages.${slot} is not a slot (${SLOTS.join(', ')})`);
        if (!Array.isArray(ids)) p.push(`analysis.stages.${slot} must be a list of tool ids`);
        else for (const id of ids) if (!known.has(id)) p.push(`analysis.stages.${slot} names "${id}", which is not a tool (${[...known].join(', ') || 'none declared'})`);
      }
  }
  if (section.fixLoop !== undefined) {
    const b = section.fixLoop?.bounces;
    if (!isObject(section.fixLoop) || (b !== undefined && !(Number.isInteger(b) && b >= 0 && b <= 10))) p.push('analysis.fixLoop.bounces must be a whole number from 0 to 10');
  }
  if (section.suppressions !== undefined) {
    const inline = section.suppressions?.inline;
    if (!isObject(section.suppressions) || (inline !== undefined && !Array.isArray(inline))) p.push('analysis.suppressions.inline must be a list of { id, pattern }');
    for (const [i, s] of (Array.isArray(inline) ? inline : []).entries()) {
      if (!isObject(s) || typeof s.id !== 'string' || typeof s.pattern !== 'string') p.push(`analysis.suppressions.inline[${i}] must be { id, pattern }`);
      else
        try {
          new RegExp(s.pattern);
        } catch (error) {
          p.push(`analysis.suppressions.inline[${i}].pattern is not a regular expression: ${error.message}`);
        }
    }
  }
  if (section.protect !== undefined && !(Array.isArray(section.protect) && section.protect.every((x) => typeof x === 'string'))) p.push('analysis.protect must be a list of repository paths');
  if (section.ci !== undefined) {
    if (!isObject(section.ci)) p.push('analysis.ci must be { jobs: [...] }');
    else if (section.ci.jobs !== undefined) {
      if (!Array.isArray(section.ci.jobs)) p.push('analysis.ci.jobs must be a list');
      else
        for (const [i, j] of section.ci.jobs.entries()) {
          const at = `analysis.ci.jobs[${i}]`;
          if (!isObject(j) || typeof j.id !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(j.id)) p.push(`${at}.id must be lower-case letters, digits and "-"`);
          if (!Array.isArray(j?.tools) || !j.tools.length) p.push(`${at}.tools must name at least one tool`);
          else for (const id of j.tools) if (!known.has(id)) p.push(`${at}.tools names "${id}", which is not a tool`);
        }
    }
  }
  if (section.coverage !== undefined && section.coverage !== null) {
    const c = section.coverage;
    if (!isObject(c) || !isCmd(c.run) || !['lcov', 'cobertura'].includes(c.format ?? 'lcov')) p.push('analysis.coverage must be { run: <command>, format: "lcov" | "cobertura", output: <path with {out}> }');
  }
  if (section.acceptLicence !== undefined) {
    if (!Array.isArray(section.acceptLicence)) p.push('analysis.acceptLicence must be a list of { tool | source, licence, by }');
    else
      section.acceptLicence.forEach((a, i) => {
        if (!isObject(a) || typeof a.licence !== 'string' || (typeof a.tool !== 'string' && typeof a.source !== 'string') || typeof a.by !== 'string' || !a.by.trim()) p.push(`analysis.acceptLicence[${i}] must name the tool (or "<tool>:<rule source>" as source), the licence and who accepted it ("by")`);
      });
  }
  p.push(...commercialProblems(section, packTools));
  if (section.licenceReview !== undefined && !['default', 'strict'].includes(section.licenceReview)) p.push('analysis.licenceReview must be "default" (items pending legal review run, with a warning) or "strict" (they are off)');
  if (section.maxConcurrent !== undefined && !(Number.isInteger(section.maxConcurrent) && section.maxConcurrent >= 1)) p.push('analysis.maxConcurrent must be a whole number of at least 1');
  return p;
}

// analysis.commercial: a known definition, a mode it supports, the token as a `${NAME}` reference only (a value in the
// config would be a secret in the repository), severities from the factory's three, replaced jobs by id.
const REF = /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/;
function commercialProblems(section, packTools) {
  const c = section.commercial;
  if (c === undefined || c === null) return [];
  const list = Array.isArray(c) ? c : [c];
  const p = [];
  list.forEach((e, i) => {
    const at = Array.isArray(c) ? `analysis.commercial[${i}]` : 'analysis.commercial';
    if (!isObject(e)) return p.push(`${at} must be { scanner, mode, token, ... }`);
    const def = section.tools?.[e.scanner]?.commercial ? { ...packTools[e.scanner], ...section.tools[e.scanner] } : packTools[e.scanner];
    if (!def?.commercial) return p.push(`${at}.scanner "${e.scanner}" is not a commercial scanner definition (${Object.keys(packTools).filter((k) => packTools[k].commercial).join(', ')}, or one of analysis.tools with a "commercial" block)`);
    const modes = def.commercial.modes ?? ['local'];
    if (e.mode !== undefined && !['local', 'server'].includes(e.mode)) p.push(`${at}.mode must be "local" or "server"`);
    else if (!modes.includes(e.mode ?? 'local')) p.push(`${at}.mode: ${e.scanner} runs ${modes.join(' or ')} only`);
    if (e.token === undefined || e.token === null) p.push(`${at}.token must name the variable that holds the ${def.commercial.vendor ?? e.scanner} token, as "\${NAME}" (set it in the environment and the CI system's secret store)`);
    else if (typeof e.token !== 'string' || !REF.test(e.token)) p.push(`${at}.token must be a "\${NAME}" reference, never the token itself`);
    for (const [k, v] of Object.entries(isObject(e.env) ? e.env : {})) if (typeof v !== 'string' || !REF.test(v)) p.push(`${at}.env.${k} must be a "\${NAME}" reference`);
    for (const [k, v] of Object.entries(isObject(e.severity) ? e.severity : {})) {
      if (![...VENDOR_SEVERITIES, 'default'].includes(k)) p.push(`${at}.severity.${k}: the vendor severities are ${VENDOR_SEVERITIES.join(', ')}`);
      if (!SEVERITIES.includes(v)) p.push(`${at}.severity.${k} must be ${SEVERITIES.join(', ')}`);
    }
    if (e.replaces !== undefined && (!Array.isArray(e.replaces) || e.replaces.some((j) => typeof j !== 'string'))) p.push(`${at}.replaces must list CI job ids (sast, dependencies, secrets, ...)`);
    if (e.timeoutMin !== undefined && !(Number.isInteger(e.timeoutMin) && e.timeoutMin > 0)) p.push(`${at}.timeoutMin must be a whole number of minutes`);
  });
  return p;
}

function installProblems(install, at) {
  const p = [];
  if (!isObject(install)) return [`${at} must be { version, platforms: { <os-arch>: { url, sha256, bin } } }`];
  if (typeof install.version !== 'string' || !install.version.trim() || /latest/i.test(install.version)) p.push(`${at}.version must pin a version (never "latest")`);
  if (!isObject(install.platforms) || !Object.keys(install.platforms).length) p.push(`${at}.platforms must map ${PLATFORMS.join(', ')} to { url, sha256, bin }`);
  for (const [plat, d] of Object.entries(isObject(install.platforms) ? install.platforms : {})) {
    if (!PLATFORMS.includes(plat)) p.push(`${at}.platforms.${plat} is not a platform (${PLATFORMS.join(', ')})`);
    if (!isObject(d) || typeof d.url !== 'string' || !/^https:\/\//.test(d.url)) p.push(`${at}.platforms.${plat}.url must be an https URL`);
    else if (/\/latest\//.test(d.url)) p.push(`${at}.platforms.${plat}.url must name a release, not "latest"`);
    if (!isObject(d) || !/^[0-9a-f]{64}$/.test(d.sha256 ?? '')) p.push(`${at}.platforms.${plat}.sha256 must be the archive's SHA-256 (64 hex characters)`);
    if (!isObject(d) || typeof d.bin !== 'string' || !d.bin) p.push(`${at}.platforms.${plat}.bin must name the executable inside the archive`);
  }
  return p;
}

// Validation against the loaded config (the packs of its languages).
export function configAnalysisProblems(config, installRoot = INSTALL_ROOT) {
  if (config?.analysis === undefined) return [];
  return analysisProblems(config.analysis, { packTools: packAnalysis(config.project?.languages ?? [], installRoot).tools, precheck: Object.keys(config.precheck?.lint ?? {}).length > 0 });
}

// Whether a finding of `rule` at `level` blocks under a tool's block list (a rule ending in * matches a prefix).
export function blocks(tool, { rule, level }) {
  if ((tool.block?.levels ?? []).includes(level)) return true;
  return (tool.block?.rules ?? []).some((r) => (r.endsWith('*') ? String(rule ?? '').startsWith(r.slice(0, -1)) : r === rule));
}
