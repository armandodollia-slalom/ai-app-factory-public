#!/usr/bin/env node
// The generator: points the factory at a codebase and keeps what it generated there in step.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { APP_FILE, INSTALL_ROOT, loadConfig, repoOverlay, repoRoot, splitTopology } from '../pipeline/lib/config.mjs';
import { agentTextProblems } from '../pipeline/lib/instruction-check.mjs';
import { lintable } from '../pipeline/lib/lint.mjs';
import { councilDoctorRows } from '../pipeline/lib/council.mjs';
import { workflowProblems } from './lib/workflow-safety.mjs';
import { detect, draftProject, loadPacks } from './lib/detect.mjs';
import { draftConfig, scaffold, unfilledPlaceholders } from './lib/init.mjs';
import { policyPython, setupPythonVenv } from '../pipeline/lib/python.mjs';
import { autoMergeSetting, checkoutHost, reviewEnforcement, unprovidedRequired, unprovidedText } from './lib/code-host.mjs';
import { resolveToken } from '../pipeline/lib/hosts/index.mjs';
import { ciFor } from '../pipeline/lib/ci/index.mjs';
import { trackerFor } from '../board/lib/trackers/index.mjs';
const resolveHostToken = (host) => {
  try {
    return resolveToken(host.settings ?? {});
  } catch {
    return null;
  }
};
import { installSetup } from './install-setup.mjs';
import { codeOwnerReview, factoryCodeOwners } from '../review-gate/lib/codeowners.mjs';
import { check, FEATURE_DEFAULTS, MANIFEST, PIN, readPin, render, TOOLS, uninstall } from './lib/render.mjs';
import { loadAdapter, productRows } from './lib/adapters.mjs';
import { sweep } from './lib/automations.mjs';
import { CI_INFO, parseRemote, originRemote, products } from './lib/hosting.mjs';

const USAGE = `Usage: factory <command> [options]

  detect [--json]            read the codebase: languages, buildable units, tests, compose files, CI, docs
  init [--tools a,b] [--with graphify] [--without lsp,ci,agentFiles,gitHooks] [--owners @a,@org/team] [--force]
       [--interview] [--answers <file.json>] [--set <id>=<value>]... [--dry-run] [--questions]
                             create .factory/ (a draft config from \`detect\`, the version pin, starter
                             content) and render the generated files. In a terminal (or with --interview,
                             --answers or --set) it asks about every stage: code host, ticket board, CI,
                             merging and reviews, agents and models, UI verification, metrics, static
                             analysis and the client's scanner; detected values are the defaults to confirm.
                             Run again, it edits the existing config (never overwrites it). --dry-run prints
                             what it would write; --questions lists the question ids an answers file uses
  render                     write every generated file, block and JSON entry again (after changing
                             .factory/agents/, features, or the engine version)
  check                      exit 1 when a generated file is missing, outdated or was edited by hand (CI)
  uninstall [--all] [--dry-run]
                             remove everything in .factory/manifest.json (--all: .factory/ too)
  upgrade <version> [--install]
                             pin another engine version (--install fetches it into ~/.ai-app-factory)
  adapter check <tracker|host|ci|scanner> [--write [--yes]] [--json]
                             every operation of the configured adapter against the live service, read-only;
                             --write also creates one test ticket or draft pull request and removes it
  doctor                     what this machine and repository still need, including each configured code
                             host and tracker (token set, API reachable, permissions, required check)
  prune [--dry-run] [--json] remove the pipeline's disk use no run needs any more: build output of idle worktrees,
                             old stack-slot build folders, superseded stack images, unpinned engine installs and
                             the worktrees of merged or closed tickets (settings: \`prune\` in .factory/config.json)
  automations [--dry-run]    sweep the tracker for the automations a CI system cannot start on tracker events
                             (epic assignees, resolved escalations); the scheduled tracker job runs it
  config split               move the application's topology (services, stack ports/URLs/services, readiness)
                             from .factory/config.json to .factory/app.json, which product agents may change
  python [which|setup]       the Python the policy engine runs with; setup creates <install>/.venv with
                             architecture-policy/requirements.txt
  version                    the engine's version and where it is installed

Tools: ${TOOLS.join(', ')} (default: all). Features: ${Object.entries(FEATURE_DEFAULTS).map(([k, v]) => `${k} (${v ? 'on' : 'off'})`).join(', ')}.`;

const APP_COMMENT = "The application's topology: its services, how the test stack builds and reaches them, when they are ready. Agents that change the application keep it in step (a new service is registered here). Models, gates, review, policy and commands are governance and live in config.json. See docs/configuration.md in the factory.";

const engineVersion = () => JSON.parse(fs.readFileSync(path.join(INSTALL_ROOT, 'package.json'), 'utf8')).version;
const engineSource = () => {
  const r = spawnSync('git', ['remote', 'get-url', 'origin'], { cwd: INSTALL_ROOT, encoding: 'utf8', timeout: 60_000 });
  return r.status === 0 && r.stdout.trim() ? r.stdout.trim() : null;
};
const list = (v) => (typeof v === 'string' ? v.split(',').map((s) => s.trim()).filter(Boolean) : []);

function parse(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) positional.push(a);
    else if (a.slice(2) === 'set') (flags.set ??= []).push(argv[++i]);
    else if (['tools', 'with', 'without', 'owners', 'answers', 'kind', 'only'].includes(a.slice(2))) flags[a.slice(2)] = argv[++i];
    else flags[a.slice(2)] = true;
  }
  return { flags, positional };
}

const readJsonSafe = (f) => {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {
    return null;
  }
};
const have = (cmd, args = ['--version']) => spawnSync(cmd, args, { encoding: 'utf8', shell: process.platform === 'win32', timeout: 60_000 }).status === 0;

// A test stack: the stack section's compose file (default .factory/stack/docker-compose.yaml) exists.
const stackConfigured = (root, config) => fs.existsSync(path.join(root, config?.stack?.composeFile ?? '.factory/stack/docker-compose.yaml'));

// Agent prompts (definition, addendum, lessons) that contradict the factory guard; none without a config.
function promptChecks(root) {
  if (!fs.existsSync(path.join(root, '.factory/config.json'))) return [];
  try {
    return agentTextProblems(loadConfig('implement', root)).map(({ path: p, agent, source, problem }) => ({ path: p, problem: `${source === 'policy' || source === 'helper' ? `${source} text read by ${agent}` : `${agent}'s prompt`} ${problem}` }));
  } catch (error) {
    return [{ path: '.factory', problem: `agent prompts could not be assembled: ${error.message}` }];
  }
}

// The default code owners: the GitHub repository's owner, or the GitLab project's top-level group.
// Azure DevOps has no CODEOWNERS file (required reviewers by path are a branch policy).
const defaultOwners = (root) => {
  const host = checkoutHost(root);
  if (!host || !String(host.repo ?? '') || !host.hints?.codeOwnersFile) return null;
  return [`@${String(host.repo).split('/')[0]}`];
};

async function doctor(root, { load = (kind) => loadAdapter(kind, INSTALL_ROOT) } = {}) {
  const pin = readPin(root);
  // config.json with app.json (the application's topology) on top, as the engine reads them.
  const config = fs.existsSync(path.join(root, '.factory/config.json')) ? repoOverlay(root) : null;
  const used = products(root, { config: config ?? {} });
  // Products that authenticate through a signed-in CLI (GitHub's gh) say so; the REST ones are checked by productRows.
  const cliAuth = (() => {
    const out = new Map();
    for (const a of [checkoutHost(root, config ?? {}), (() => { try { return trackerFor({ ...(config ?? {}), root }); } catch { return null; } })()]) if (a?.cliAuth && !out.has(a.cliAuth.name)) out.set(a.cliAuth.name, a.cliAuth);
    return [...out.values()];
  })();
  const hooksPath = spawnSync('git', ['config', 'core.hooksPath'], { cwd: root, encoding: 'utf8', timeout: 60_000 }).stdout.trim();
  const rows = [
    ['Node.js 20 or later', Number(process.versions.node.split('.')[0]) >= 20, process.versions.node],
    ['.factory/config.json', Boolean(config), config ? `${config.project?.services?.length ?? 0} service(s), languages: ${(config.project?.languages ?? []).join(', ') || 'none'}` : 'run `factory init`'],
    ['engine version matches the pin', !pin.version || pin.version === engineVersion(), `pinned ${pin.version ?? 'none'}, installed ${engineVersion()}`],
    ['commands have no generator placeholders left', !config || unfilledPlaceholders(config, loadPacks(INSTALL_ROOT)).length === 0, config ? unfilledPlaceholders(config, loadPacks(INSTALL_ROOT)).map((k) => `{${k}} in .factory/config.json`).join(', ') : ''],
    ['generated files in step', fs.existsSync(path.join(root, MANIFEST)) && check(root, INSTALL_ROOT).filter((p) => !p.notice).length === 0, 'run `factory check` for the list'],
    ['git hooks', !pin.features.gitHooks || hooksPath === '.factory/githooks', hooksPath ? `core.hooksPath is ${hooksPath}` : 'run `git config core.hooksPath .factory/githooks`'],
    ['an agent CLI (claude, copilot or codex)', ['claude', 'copilot', 'codex'].some((c) => have(c)), 'needed for every agent the pipeline starts'],
    ...cliAuth.map((c) => [c.name, c.check(), c.note]),
    (() => {
      const py = policyPython();
      return ['Python with pyyaml and jsonschema (the policy engine)', Boolean(py.cmd), py.cmd ? `${py.executable} ${py.version}, from ${py.how}; doctor, \`factory policy\` and the review all use it` : `tried ${py.tried.join('; ')}. Run \`factory python setup\` (a virtualenv in the factory install) or set FACTORY_PYTHON; the review blocks while a policy is configured and cannot run`];
    })(),
    ['docker', have('docker', ['info']), 'needed for the test stack'],
    ...(stackConfigured(root, config) ? [['UI verifiers build the subtask\'s stack (implement.ui.teststackCmd)', Boolean(config?.implement?.ui?.teststackCmd?.length), config?.implement?.ui?.teststackCmd?.length ? config.implement.ui.teststackCmd.join(' ') : 'a test stack is configured but implement.ui.teststackCmd is not: UI verifier pairs would test whatever already runs on their slot. Set it to ["node", ".factory/bin/factory.mjs", "teststack"]']] : []),
    ...(pin.features.graphify ? [['graphify', have('graphify', ['--help']), 'needed for the code graph']] : []),
    ...(pin.features.demoVideo ? [['Playwright in this repository', fs.existsSync(path.join(root, 'node_modules/.bin/playwright')) || fs.existsSync(path.join(root, 'node_modules/.bin/playwright.cmd')), 'needed for e2e tests and demo videos: `npm ci`, then `npx playwright install chromium`']] : []),
  ];
  // Every council member a stage seats: its CLI installed and signed in, its model resolving for that CLI (council.mjs).
  if (config?.council) {
    try {
      rows.push(...councilDoctorRows(loadConfig(null, root), { probe: (cmd, args, env) => spawnSync(cmd, args, { encoding: 'utf8', env, shell: process.platform === 'win32', timeout: 60_000 }).status === 0 }));
    } catch (error) {
      rows.push(['council configuration', false, error.message]);
    }
  }
  // The PR opens finished (implement.preOpen): CI can prove a story branch's head before its PR exists, and every
  // delivered PR's run record shows no pipeline agent starting after the PR was ready (outside a hold).
  try {
    const { storyBranchPatterns } = await import('../implement/lib/pre-open.mjs');
    const full = loadConfig('implement', root);
    {
      // The CI adapter's capability; that the rendered definitions carry the branch triggers is `factory check`'s row
      // (generated files in step).
      const ci = ciFor(full);
      const branchRuns = Boolean(ci.capabilities?.branchPipelines);
      rows.push(['PRs open finished: CI runs on a story branch before its PR (implement.preOpen)', branchRuns, branchRuns ? `${ci.label ?? ci.type} runs the pipelines on pushes of the story branches (${storyBranchPatterns(full).join(', ')}); a PR's own runs reuse them where the definitions support it` : `${ci.label ?? ci.type} cannot run pipelines on a branch push: PRs open as drafts and are marked ready when their checks are green`]);
      const runs = fs.existsSync(path.join(root, '.factory/state/implement')) ? fs.readdirSync(path.join(root, '.factory/state/implement')).filter((f) => /^[A-Z][A-Z0-9]*-\d+\.json$/.test(f)).map((f) => readJsonSafe(path.join(root, '.factory/state/implement', f))).filter((r) => r?.readyAt) : [];
      const late = runs.filter((r) => r.readyAudit && r.readyAudit.ok === false);
      rows.push([`delivered PRs: no pipeline agent started after the PR was ready (${runs.length} checked)`, late.length === 0, late.length ? `agent runs after ready: ${late.map((r) => `${r.key} (${r.pr ?? 'no PR'}, ${r.readyAudit.after} run(s))`).join('; ')}` : runs.length ? 'every delivered PR was complete when it opened' : 'no PR opened under implement.preOpen yet']);
    }
  } catch (error) {
    rows.push(['PRs open finished (implement.preOpen)', false, error.message]);
  }
  const analysisWarnings = [];
  // Static analysis (opt-in): tools at their pinned versions, parsers, offline flags, rule sources, CI jobs rendered.
  if (config?.analysis) {
    try {
      const full = loadConfig('feature-verification', root);
      const { resolveAnalysis } = await import('../pipeline/lib/analysis/config.mjs');
      const { analysisDoctor } = await import('../pipeline/lib/analysis/doctor.mjs');
      const d = await analysisDoctor(full, resolveAnalysis(full), { manifest: readJsonSafe(path.join(root, MANIFEST)) });
      rows.push(...d.rows);
      analysisWarnings.push(...d.warnings);
    } catch (error) {
      rows.push(['static analysis configuration', false, error.message]);
    }
  }
  // No workflow hands the factory's token to forks or to anyone who can comment (public repositories).
  const unsafe = workflowProblems(root);
  const ciInfo = CI_INFO[used.ci.provider] ?? {};
  rows.push([ciInfo.safetyRow ?? 'pipelines keep FACTORY_TOKEN and agent credentials from forks', unsafe.length === 0, unsafe.length ? unsafe.map((p) => `${p.path}: ${p.problem}`).join('; ') : ciInfo.safetyNote ?? 'no pipeline hands secrets to forks']);
  // Every language the repository has a linter for in its packs is linted: an extension the packs map that
  // the repository tracks (outside precheck.lintExclude) but precheck.lint leaves out is a gap in every gate.
  if (config) {
    const mapped = new Set();
    for (const id of config.project?.languages ?? []) {
      const file = path.join(INSTALL_ROOT, 'packs', id, 'commands.json');
      if (!fs.existsSync(file)) continue;
      const c = JSON.parse(fs.readFileSync(file, 'utf8'));
      for (const m of [c.lint, c.lintFallback]) for (const ext of Object.keys(m ?? {})) mapped.add(ext);
    }
    const lint = { ...(loadConfig('feature-verification', root).precheck ?? {}) };
    const tracked = lintable({ precheck: lint }, spawnSync('git', ['ls-files'], { cwd: root, encoding: 'utf8', timeout: 60_000 }).stdout.split('\n').filter(Boolean));
    const missing = [...mapped].filter((ext) => !(lint.lint ?? {})[ext] && tracked.some((f) => f.endsWith(ext))).sort();
    rows.push(['linters cover every language the packs can lint', missing.length === 0, missing.length ? `${missing.join(', ')} file(s) are tracked but precheck.lint has no linter for them: add the pack's mapping (onboard-codebase skill)` : `precheck.lint: ${Object.keys(lint.lint ?? {}).sort().join(', ') || 'none'}`]);
  }
  // The language packs' own rows (packs/<id>/doctor.mjs exports checks(root)).
  for (const id of config?.project?.languages ?? []) {
    const file = path.join(INSTALL_ROOT, 'packs', id, 'doctor.mjs');
    if (fs.existsSync(file)) rows.push(...(await import(pathToFileURL(file).href)).checks(root));
  }
  // Warnings: a gate that exists but that the code host does not enforce. Reported loudly, not a failure, because
  // only the repository's owner can change it.
  const warnings = [...analysisWarnings];
  // The application's own test jobs that the host does not require (council C10, Opus 5): a person merging by hand is not
  // stopped by them. Named, with why: a job that runs for every PR under a name of its own is required by `review-gate enforce`.
  try {
    const uncovered = ciFor(config ?? {}).uncoveredChecks?.(root) ?? [];
    for (const u of uncovered) warnings.push([u.shared ? `the application's check "${u.name}" (${u.workflow}, job ${u.job}) shares a required check's name` : `the application's check "${u.name}" (${u.workflow}, job ${u.job}) is not required on the host`, u.reason]);
  } catch {
    // no CI definitions to read
  }
  // The configured code host and tracker when one is not GitHub: token, API, permissions, required check.
  const product = await productRows(root, config ?? {}, { load, used });
  rows.push(...product.rows);
  warnings.push(...product.warnings);
  if (pin.features.ci) {
    if (!(pin.owners ?? []).length) warnings.push(['code owners for the factory\'s files', 'no `owners` in .factory/factory.json: `factory init --owners @you` (or a team), then render']);
    const host = checkoutHost(root, config ?? {});
    const reachable = host && String(host.repo ?? '') && (host.cliAuth ? host.cliAuth.check() : Boolean(host.settings?.token || resolveHostToken(host)));
    let review = null;
    try {
      review = codeOwnerReview({ owners: factoryCodeOwners(root), author: host?.bot?.author?.() ?? null, botConfigured: Boolean(host?.bot?.configured?.()) });
    } catch {
      /* no settings to read: the plain check */
    }
    const requiredChecks = (() => {
      const own = readJsonSafe(path.join(root, '.factory', 'config.json'))?.implement?.reviewGate?.requiredChecks;
      if (Array.isArray(own)) return own;
      try {
        return ciFor({ ...(config ?? {}), root }).requiredChecks?.(root) ?? [];
      } catch {
        return [];
      }
    })();
    const name = host?.label ?? 'The code host';
    // A host that cannot require named checks: the gate refuses to merge until the head's expected pipelines are green
    // (its own evidence, bound to the SHA), and doctor says the host itself cannot enforce it.
    if (host && host.capabilities?.requiredChecks === false) warnings.push([`${name} requires review-quorum and the CI checks`, `${name} cannot require checks before a merge: the review gate itself refuses to merge until every expected pipeline of the head is green, bound to that SHA (docs/providers/capabilities.md)`]);
    // productRows already reported the host's review-quorum rule (a host it checks through its REST adapter).
    else if (![...product.rows, ...product.warnings].some((r) => /review-quorum/.test(r[0]))) {
      const provided = (() => {
        try {
          return ciFor({ ...(config ?? {}), root }).providedChecks?.(root) ?? null;
        } catch {
          return null;
        }
      })();
      const enforced = reachable ? reviewEnforcement(host, null, { review, requiredChecks, provided }) : null;
      const label = `${name} requires review-quorum and the CI checks (and code-owner review where someone can give it)`;
      if (enforced && !enforced[0]) warnings.push([label, enforced[1]]);
      else if (enforced) rows.push([label, true, enforced[1]]);
    }
    const auto = reachable ? autoMergeSetting(host) : null;
    if (auto && !auto[0]) warnings.push([`${name} allows auto-merge (the review gate's merges of Low bug fixes)`, auto[1]]);
    else if (auto) rows.push([`${name} allows auto-merge (the review gate's merges of Low bug fixes)`, true, auto[1]]);
  }
  // Free disk space (a run refuses to start below prune.minFreeGb, after pruning what it may).
  try {
    const { pruneContext, diskRoom } = await import('./lib/prune.mjs');
    const room = diskRoom(await pruneContext(root));
    rows.push([`free disk space at least prune.minFreeGb (${room.minFreeGb} GB)`, room.ok, room.freeGb == null ? 'df could not tell' : `${room.freeGb} GB free${room.ok ? '' : '; `factory prune --dry-run` shows what can go'}`]);
  } catch (error) {
    rows.push(['free disk space', false, error.message]);
  }
  // Optional tools: reported, never a failure.
  const optional = pin.features.demoVideo ? [['ffmpeg', have('ffmpeg', ['-version']), 'optional: animated previews in PR descriptions and faster frame extraction for the PR check (Playwright is the fallback)']] : [];
  for (const [what, ok, note] of rows) console.log(`${ok ? 'ok     ' : 'MISSING'}  ${what}${note ? `  (${note})` : ''}`);
  for (const [what, note] of warnings) console.log(`WARN     ${what}  (${note})`);
  for (const [what, ok, note] of optional) console.log(`${ok ? 'ok     ' : 'absent '}  ${what}${note ? `  (${note})` : ''}`);
  return rows.every(([, ok]) => ok) ? 0 : 1;
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const { flags, positional } = parse(rest);
  if (!command || command === 'help' || flags.help) return console.log(USAGE), 0;
  if (command === 'version') return console.log(flags.path ? INSTALL_ROOT : `ai-app-factory ${engineVersion()} (${INSTALL_ROOT})`), 0;
  const root = repoRoot();
  const packs = loadPacks(INSTALL_ROOT);
  switch (command) {
    case 'detect': {
      const found = detect(root, packs);
      if (flags.json) console.log(JSON.stringify({ ...found, project: draftProject(found, packs) }, null, 2));
      else {
        console.log(`${found.name}: ${found.fileCount} files`);
        for (const l of found.languages) console.log(`  ${l.name}: ${l.files} source file(s), ${l.units} unit(s)`);
        for (const u of found.units) console.log(`  ${u.kind.padEnd(9)} ${u.path}  (${u.pack})`);
        for (const [label, items] of [['compose', found.compose], ['Dockerfiles', found.dockerfiles], ['CI', found.ci], ['e2e', found.e2e]]) if (items.length) console.log(`  ${label}: ${items.join(', ')}`);
        if (!found.languages.length) console.log('  No language pack matches this codebase. `factory init` still works: fill .factory/config.json by hand or with the setup skills.');
      }
      return 0;
    }
    case 'init': {
      const configFile = path.join(root, '.factory/config.json');
      const existed = fs.existsSync(configFile);
      const before = readPin(root);
      const features = { ...before.features };
      for (const f of list(flags.with)) features[f] = true;
      for (const f of list(flags.without)) features[f] = false;
      const tools = flags.tools ? list(flags.tools) : before.tools;
      const unknown = [...tools.filter((x) => !TOOLS.includes(x)), ...Object.keys(features).filter((f) => !(f in FEATURE_DEFAULTS))];
      if (unknown.length) return console.error(`Unknown tool or feature: ${unknown.join(', ')}.\n\n${USAGE}`), 64;
      const found = detect(root, packs);
      // Code owners of the factory's files: --owners, the pin's, or the repository's owner on its code host.
      const owners = flags.owners ? list(flags.owners).map((o) => (o.startsWith('@') || o.includes('@') ? o : `@${o}`)) : before.owners ?? defaultOwners(root);
      const pinDraft = { version: engineVersion(), source: before.source ?? engineSource(), tools, features, ...(owners?.length ? { owners } : {}) };
      if (!flags['dry-run'] && !flags.questions) fs.mkdirSync(path.join(root, '.factory'), { recursive: true });
      // The setup interview: in a terminal, or with --interview / --answers / --set. Without them, a script that runs
      // `factory init` gets the draft from detection, as before the interview existed.
      const interviewOn = Boolean(flags.interview || flags.answers || flags.set?.length || (process.stdin.isTTY && process.stdout.isTTY && !flags.yes));
      if (flags.questions) {
        const { QUESTIONS } = await import('./lib/interview.mjs');
        for (const x of QUESTIONS) console.log(`${x.id.padEnd(26)} ${x.kind === 'choice' ? `[${x.choices.join('|')}] ` : `(${x.kind}) `}${x.ask}`);
        return 0;
      }
      let base = existed && !flags.force ? readJsonSafe(configFile) ?? {} : null;
      let app = null;
      if (!base) {
        // Topology (services, ports, URLs, readiness) goes to app.json, which the application's agents may
        // change; everything else is governance in config.json.
        const split = splitTopology(draftConfig(found, packs, { features }));
        base = split.governance;
        app = split.app;
      }
      let pin = pinDraft;
      let config = base;
      if (interviewOn) {
        const { interview, readAnswers, terminalAsk } = await import('./lib/interview.mjs');
        const answers = readAnswers(flags.answers ? fs.readFileSync(path.resolve(flags.answers), 'utf8') : '', flags.set ?? []);
        const asker = flags.answers || flags.set?.length || !process.stdin.isTTY ? null : terminalAsk();
        const probe = (cli) => have(cli, ['--version']);
        const r = await interview({ detected: { host: parseRemote(originRemote(root)) }, config: base, pin, answers, ask: asker, probe });
        config = r.config;
        pin = r.pin;
        if (flags['dry-run']) {
          const { changes } = await import('./lib/interview.mjs');
          console.log(JSON.stringify({ config: changes(existed ? readJsonSafe(configFile) ?? {} : {}, config), pin: changes(readPin(root), pin), answers: r.asked }, null, 2));
          return 0;
        }
        fs.writeFileSync(path.join(root, '.factory/interview.json'), `${JSON.stringify({ $comment: 'The setup interview\'s last answers (factory init). No secret is ever recorded: credentials are variable names.', at: new Date().toISOString(), answers: r.asked }, null, 2)}\n`);
      } else if (flags['dry-run']) {
        console.log(JSON.stringify({ config: existed && !flags.force ? [] : Object.keys(base) }, null, 2));
        return 0;
      }
      fs.writeFileSync(path.join(root, PIN), `${JSON.stringify(pin, null, 2)}\n`);
      if (!existed || flags.force || interviewOn) {
        fs.writeFileSync(configFile, `${JSON.stringify(config, null, 2)}\n`);
        if (app) fs.writeFileSync(path.join(root, APP_FILE), `${JSON.stringify({ $comment: APP_COMMENT, ...app }, null, 2)}\n`);
      }
      const used = products(root);
      const copied = scaffold(root, INSTALL_ROOT, { features, provider: used.ci.provider });
      const result = render(root, INSTALL_ROOT, { version: engineVersion() });
      const hooksPath = spawnSync('git', ['config', 'core.hooksPath'], { cwd: root, encoding: 'utf8', timeout: 60_000 }).stdout.trim();
      // external-call: local (a local git write is never killed or repeated)
      if (features.gitHooks && !hooksPath) spawnSync('git', ['config', 'core.hooksPath', '.factory/githooks'], { cwd: root });
      console.log(`${existed && !flags.force ? 'Kept' : 'Wrote'} .factory/config.json (${found.languages.map((l) => l.name).join(', ') || 'no language pack matched'}; ${found.units.filter((u) => u.kind === 'backend' || u.kind === 'frontend').length} service(s) drafted).`);
      if (copied.length) console.log(`Starter content: ${copied.join(', ')}.`);
      const left = unfilledPlaceholders(JSON.parse(fs.readFileSync(configFile, 'utf8')), packs);
      if (left.length) console.log(`Fill in .factory/config.json: ${left.map((k) => `{${k}}`).join(', ')} (several candidates and none named by CI; the language pack's commands.json says what each one is).`);
      console.log(`Rendered ${result.total} output(s), ${result.written.length} written. They are listed in ${MANIFEST}.`);
      console.log(`Code host ${used.host.type}${used.host.repo ? ` (${used.host.repo})` : ''}, tracker ${used.tracker.type ?? 'not set'}, CI ${used.ci.provider}.${used.tracker.type ? '' : ' Set tracker in .factory/config.json (jira or github; the setup-board skill), then render again.'}`);
      if (CI_INFO[used.ci.provider]?.afterRender) console.log(CI_INFO[used.ci.provider].afterRender);
      if (features.gitHooks && hooksPath && hooksPath !== '.factory/githooks') console.log(`git already uses core.hooksPath=${hooksPath}. Call the factory's hooks from yours: .factory/githooks/post-commit, post-merge and pre-push.`);
      console.log(['', 'The config is a draft from file names, not a reading of the code. Next, in an agent session in this repository:', '  1. onboard-codebase skill: corrects the project model (services, commands, test runners) and writes the agent addenda', '  2. setup-lsp, setup-teststack, author-architecture-policy: one per component you want', '  3. setup-host, setup-board and setup-observability: the PR identity and branch policies on the code host, the ticket tracker, and where agent metrics are stored', 'Then `factory doctor` shows what is still missing.'].join('\n'));
      return 0;
    }
    case 'adapter': {
      // `factory adapter check <kind> [--write] [--yes] [--json]`: the configured adapter's every operation, live.
      const [sub, kind] = positional;
      if (sub !== 'check' || !['tracker', 'host', 'ci', 'scanner'].includes(kind)) return console.error('Usage: factory adapter check <tracker|host|ci|scanner> [--write [--yes]] [--json]'), 64;
      const { conformance, formatReport } = await import('../pipeline/lib/providers/conformance.mjs');
      const { adapterFor, checkFixture, gitHelper } = await import('./lib/adapter-check.mjs');
      // The stage config that holds the kind's settings (the board's lanes and labels; the review gate's CI settings).
      const config = { ...loadConfig(kind === 'tracker' ? 'board' : 'implement', root), root };
      if (flags.write && !flags.yes) {
        if (!process.stdin.isTTY) return console.error('--write creates a test item and removes it again: confirm with --yes'), 64;
        const { createInterface } = await import('node:readline/promises');
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        const answer = await rl.question(`--write creates one test ${kind === 'tracker' ? 'ticket' : 'branch and draft pull request'} on the live service and removes or closes it again. Go ahead? [y/N] `);
        rl.close();
        if (!/^y(es)?$/i.test(answer.trim())) return console.log('Nothing written.'), 1;
      }
      const adapter = await adapterFor(kind, config);
      const fixture = await checkFixture(kind, config);
      const report = await conformance(kind, adapter, { write: Boolean(flags.write), fixture, git: gitHelper(root), log: flags.json ? () => {} : () => {} });
      console.log(flags.json ? JSON.stringify(report, null, 2) : formatReport(report));
      return report.ok ? 0 : 1;
    }
    case 'render': {
      const shipped = () => {
        try {
          return ciFor({ ...(readJsonSafe(path.join(root, '.factory', 'config.json')) ?? {}), root }).providedChecks?.(root) ?? null;
        } catch {
          return null;
        }
      };
      const before = shipped();
      const result = render(root, INSTALL_ROOT, { version: engineVersion() });
      console.log(`Rendered ${result.total} output(s): ${result.written.length} written${result.removed.length ? `, ${result.removed.length} removed` : ''}.`);
      for (const p of [...result.written, ...result.removed.map((p) => `${p} (removed)`)]) console.log(`  ${p}`);
      // e2e fixtures the repository edited itself: kept, and the difference from the factory's version is shown.
      for (const k of result.kept ?? []) console.log(`kept: ${k.path} differs from the factory's version (your edit; not refreshed):\n${k.diff}`);
      for (const p of promptChecks(root)) console.log(`warning: ${p.path}: ${p.problem}`);
      // Checks this release no longer ships (a removed workflow or job): a host rule that still requires one holds every
      // PR. Said here, with the host's rule read when it can be (read only; enforce is a person's step).
      const after = shipped();
      const gone = Array.isArray(before) && Array.isArray(after) ? before.filter((c) => !after.includes(c)) : [];
      if (gone.length) {
        console.log(`notice: this render removed the check(s) ${gone.map((c) => `"${c}"`).join(', ')} from the workflows.`);
        const bp = (() => {
          try {
            return checkoutHost(root, readJsonSafe(path.join(root, '.factory', 'config.json')) ?? {})?.repo?.branchProtection?.() ?? null;
          } catch {
            return null;
          }
        })();
        const stale = bp && !bp.unavailable ? unprovidedRequired(bp.requiredChecks ?? [], after) : null;
        if (stale?.length) console.log(`WARNING: ${unprovidedText('the repository', bp.branch ?? 'default branch', stale)}.`);
        else if (!stale) console.log("  If a host rule requires any of them, run 'factory review-gate enforce --dry-run', then 'factory review-gate enforce'; 'factory doctor' checks it.");
      }
      return 0;
    }
    case 'check': {
      const all = [...check(root, INSTALL_ROOT), ...promptChecks(root), ...workflowProblems(root)];
      // A repository's own edit of an e2e fixture is reported, not a failure (render keeps it).
      for (const p of all.filter((x) => x.notice)) console.log(`notice: ${p.path}: ${p.problem}`);
      const problems = all.filter((x) => !x.notice);
      if (!problems.length) return console.log('Generated files are in step with the factory.'), 0;
      for (const p of problems) console.log(`${p.path}: ${p.problem}`);
      console.log('\nRun `factory render` to write generated files again; change them through .factory/ (config, agent addenda, features), never by hand. Fix an agent instruction that contradicts the factory guard in its addendum or lessons (write-agent-addenda skill).');
      return 1;
    }
    case 'uninstall': {
      const result = uninstall(root, INSTALL_ROOT, { all: Boolean(flags.all), dryRun: Boolean(flags['dry-run']) });
      console.log(`${flags['dry-run'] ? 'Would remove' : 'Removed'} ${result.removed.length} generated output(s)${result.all ? ' and .factory/' : ''}.`);
      for (const p of result.removed) console.log(`  ${p}`);
      return 0;
    }
    case 'upgrade': {
      const version = positional[0];
      if (!version) return console.error('Usage: factory upgrade <version> [--install]'), 64;
      const pin = readPin(root);
      if (flags.install) {
        if (!pin.source) return console.error(`${PIN} has no "source" (the factory's git URL), so the version cannot be fetched. Set it, or install the engine yourself and set FACTORY_HOME.`), 1;
        const dest = path.join(os.homedir(), '.ai-app-factory', 'versions', version);
        if (!fs.existsSync(dest)) {
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          const clone = spawnSync('git', ['clone', '--depth', '1', '--branch', `v${version}`, pin.source, dest], { stdio: 'inherit', timeout: 600_000, killSignal: 'SIGKILL' });
          if (clone.status !== 0) return 1;
        }
        // The fetched version completes its own install (its packages, Chromium, the policy's Python, the
        // code-intelligence check) with its own install-setup.mjs, which needs nothing but Node: a fix to
        // installing reaches the version that has it. A version older than that gets this engine's steps.
        const own = path.join(dest, 'scripts', 'factory', 'install-setup.mjs');
        const setup = fs.existsSync(own)
          ? spawnSync(process.execPath, [own, root], { cwd: root, stdio: 'inherit' }).status
          : installSetup(dest, root);
        if (setup !== 0) return console.error(`the install of ${version} in ${dest} is incomplete (see above)`), 1;
        console.log(`Engine ${version} is in ${dest}.`);
      }
      fs.writeFileSync(path.join(root, PIN), `${JSON.stringify({ ...JSON.parse(fs.readFileSync(path.join(root, PIN), 'utf8')), version }, null, 2)}\n`);
      console.log(`Pinned ${version}. Run \`factory render\` with that engine and commit the result.`);
      return 0;
    }
    case 'install-setup':
      // Completes the install of the engine that runs this command (`upgrade --install` runs the fetched
      // version's scripts/factory/install-setup.mjs directly, before its packages exist).
      return installSetup(INSTALL_ROOT, root);
    case 'doctor':
      return await doctor(root);
    case 'prune': {
      const { pruneContext, planPrune, applyPrune, formatPlan, diskRoom } = await import('./lib/prune.mjs');
      const g = await pruneContext(root);
      const dryRun = Boolean(flags['dry-run']);
      const plan = planPrune(g);
      const done = dryRun ? plan : applyPrune(g, plan);
      const room = diskRoom(g);
      if (flags.json) console.log(JSON.stringify({ dryRun, entries: done, disk: room }, null, 2));
      else console.log(`${formatPlan(done, { dryRun })}\n${room.freeGb == null ? '' : `${room.freeGb} GB free (minimum ${room.minFreeGb} GB).`}`);
      return done.every((e) => e.ok !== false) ? 0 : 1;
    }
    case 'automations': {
      const config = repoOverlay(root);
      const adapter = await loadAdapter('tracker', INSTALL_ROOT);
      if (!adapter.available) return console.error(`factory automations: ${adapter.reason}`), 1;
      const board = path.join(INSTALL_ROOT, 'scripts/board/board.mjs');
      const run = (args) => {
        if (flags['dry-run']) return console.log(`would run: factory board ${args.join(' ')}`), 0;
        return spawnSync(process.execPath, [board, ...args], { cwd: root, stdio: 'inherit' }).status ?? 1;
      };
      const done = await sweep(config, { tracker: adapter.create({ ...config, root }), run, log: (m) => console.log(m) });
      console.log(`${done.epics} epic(s), ${done.escalations} escalation(s) checked.${done.failed.length ? ` Failed: ${done.failed.join('; ')}` : ''}`);
      return done.failed.length ? 1 : 0;
    }
    case 'config': {
      if (positional[0] !== 'split') return console.error('Usage: factory config split'), 64;
      const configFile = path.join(root, '.factory/config.json');
      const current = JSON.parse(fs.readFileSync(configFile, 'utf8'));
      const appFile = path.join(root, APP_FILE);
      const existing = fs.existsSync(appFile) ? JSON.parse(fs.readFileSync(appFile, 'utf8')) : {};
      const { governance, app } = splitTopology(current);
      const merged = { $comment: APP_COMMENT, ...existing };
      for (const [section, keys] of Object.entries(app)) merged[section] = { ...(existing[section] ?? {}), ...keys };
      fs.writeFileSync(configFile, `${JSON.stringify(governance, null, 2)}\n`);
      fs.writeFileSync(appFile, `${JSON.stringify(merged, null, 2)}\n`);
      console.log(`Moved ${Object.entries(app).flatMap(([s2, k]) => Object.keys(k).map((key) => `${s2}.${key}`)).join(', ') || 'nothing'} to ${APP_FILE}.`);
      const stale = promptChecks(root);
      for (const p of stale) console.log(`warning: ${p.path}: ${p.problem}`);
      if (stale.length) console.log(`Update those addenda and lessons (write-agent-addenda skill): agents follow them, and the guard denies ${'.factory/config.json'} to them.`);
      return 0;
    }
    case 'python': {
      if (positional[0] === 'setup') {
        const py = setupPythonVenv();
        console.log(`Policy engine Python: ${py}`);
      }
      const py = policyPython();
      if (!py.cmd) return console.error(`No Python with pyyaml and jsonschema (tried ${py.tried.join('; ')}). Run \`factory python setup\` or set FACTORY_PYTHON.`), 1;
      console.log(`${py.executable} ${py.version} (${py.how})`);
      return 0;
    }
    default:
      console.error(`Unknown command "${command}".\n\n${USAGE}`);
      return 64;
  }
}

try {
  process.exitCode = await main();
} catch (error) {
  console.error(`factory: ${error.message}`);
  process.exitCode = 1;
}
