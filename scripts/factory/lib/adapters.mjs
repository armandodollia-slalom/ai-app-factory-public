// The generator's view of the code host and ticket tracker adapters (scripts/pipeline/lib/hosts/ and
// scripts/board/lib/trackers/, ADAPTERS.md). They are loaded lazily: an install without one of them still
// renders, checks and runs doctor, which then reports "adapter not available" for that product.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { comboProblem, envNames, products, TOKEN_VARS } from './hosting.mjs';

export const ADAPTER_MODULES = {
  host: { file: 'scripts/pipeline/lib/hosts/index.mjs', factory: 'hostFor' },
  tracker: { file: 'scripts/board/lib/trackers/index.mjs', factory: 'trackerFor' },
};

// { available: true, create(config) } or { available: false, reason }.
export async function loadAdapter(kind, installRoot) {
  const { file, factory } = ADAPTER_MODULES[kind];
  const abs = path.join(installRoot, file);
  if (!fs.existsSync(abs)) return { available: false, reason: `adapter not available: ${file} is not part of this install` };
  try {
    const mod = await import(pathToFileURL(abs).href);
    if (typeof mod[factory] !== 'function') return { available: false, reason: `adapter not available: ${file} does not export ${factory}()` };
    return { available: true, create: (config) => mod[factory](config) };
  } catch (error) {
    return { available: false, reason: `adapter not available: ${file} failed to load (${error.message})` };
  }
}

// The adapters detect the host from the checkout's origin, so they need the root.
const withRoot = (config, root) => (config?.root ? config : { ...config, root });

const LABEL = { github: 'GitHub', gitlab: 'GitLab', 'azure-devops': 'Azure DevOps', bitbucket: 'Bitbucket', custom: 'the custom adapter', jira: 'Jira', 'azure-boards': 'Azure Boards', linear: 'Linear' };
const firstLine = (e) => String(e?.message ?? e).split('\n')[0].slice(0, 200);
const missingVars = (names, env) => names.filter((n) => !env[n]);

// The `${NAME}` variables a section's token and auth name.
function tokenVars(section) {
  const named = [];
  const walk = (v) => (typeof v === 'string' ? named.push(...envNames(v)) : v && typeof v === 'object' ? Object.values(v).forEach(walk) : null);
  walk(section?.token);
  walk(section?.auth);
  return named.length ? [...new Set(named)] : [];
}

// Doctor rows for each configured product other than GitHub (whose `gh` rows doctor already has):
// the token variable is set, the API answers, the token reaches the repository or project, and (a warning,
// like GitHub's) the default branch requires the review-quorum check. `load(kind)` returns the adapter
// loader result; tests pass fakes.
export async function productRows(root, config, { load, env = process.env, used = products(root, { config }) } = {}) {
  const rows = [];
  const warnings = [];
  const problem = comboProblem(used);
  rows.push([`host ${used.host.type}, tracker ${used.tracker.type ?? 'none'}, CI ${used.ci.provider}`, !problem, problem ?? `host from ${used.host.source}, CI from ${used.ci.source}`]);

  if (used.host.type !== 'github') {
    const name = LABEL[used.host.type] ?? used.host.type;
    const vars = tokenVars(config.host);
    rows.push([`${name} token variable`, vars.length > 0 && !missingVars(vars, env).length, vars.length ? (missingVars(vars, env).length ? `${missingVars(vars, env).join(', ')} not set in this environment` : `${vars.join(', ')} set`) : `set host.token in .factory/config.json, for example "\${${TOKEN_VARS[used.host.type]}}"`]);
    const adapter = await load('host');
    if (!adapter.available) rows.push([`${name} adapter`, false, adapter.reason]);
    else {
      try {
        const host = adapter.create(withRoot(config, root));
        const who = await host.identity();
        rows.push([`${name} API reachable`, true, `as ${who?.login ?? who?.id ?? 'unknown'} at ${used.host.url}`]);
        const branch = await host.repo.defaultBranch();
        rows.push([`${name} token can read ${host.repo?.name ?? used.host.repo ?? 'the repository'}`, Boolean(branch), `default branch ${branch}`]);
        // host.repo.permissions() -> { push, pullRequests, readPolicies } (GitHub, GitLab); Azure DevOps
        // throws UnsupportedError (no such API for a PAT): a warning with what to check by hand.
        if (typeof host.repo.permissions === 'function') try {
          const perms = await host.repo.permissions();
          const ok = perms && perms.push !== false && perms.pullRequests !== false;
          rows.push([`${name} token may push branches and open pull requests`, Boolean(ok), ok ? `push and pull requests allowed${perms.accessLevel != null ? ` (access level ${perms.accessLevel})` : ''}` : `the token cannot ${perms?.push === false ? 'push branches' : 'open pull requests'}: give it Developer (GitLab) or Contribute (Azure DevOps) on ${used.host.repo ?? 'the repository'}`]);
        } catch (error) {
          if (error?.name !== 'UnsupportedError') throw error;
          warnings.push([`${name} token may push branches and open pull requests`, firstLine(error)]);
        }
        try {
          const protection = await host.repo.branchProtection(branch);
          const checks = (protection?.requiredChecks ?? []).map(String);
          const quorum = checks.some((c) => /review-quorum/i.test(c));
          if (!protection?.enforced || !quorum) warnings.push([`${name} requires the review-quorum check on ${branch}`, protection ? `required checks: ${checks.join(', ') || 'none'}${protection.enforced ? '' : ' (not enforced)'}: add review-quorum (docs/hosts-and-trackers.md)` : 'no branch protection or policy on the default branch']);
          else rows.push([`${name} requires the review-quorum check on ${branch}`, true, `required approvals: ${protection.requiredApprovals ?? 'none'}`]);
        } catch (error) {
          warnings.push([`${name} branch protection readable`, `${firstLine(error)} (the token needs Maintainer on GitLab, or Edit policies on Azure DevOps, to read it)`]);
        }
      } catch (error) {
        rows.push([`${name} API reachable`, false, firstLine(error)]);
      }
    }
  }

  if (!used.tracker.type) rows.push(['ticket tracker', false, `${LABEL[used.host.type] ?? used.host.type} has no tracker the factory uses: set tracker in .factory/config.json (setup-board skill)`]);
  else if (used.tracker.type !== 'github') {
    const name = LABEL[used.tracker.type] ?? used.tracker.type;
    const vars = tokenVars(config.tracker);
    rows.push([`${name} credential variables`, vars.length > 0 && !missingVars(vars, env).length, vars.length ? (missingVars(vars, env).length ? `${missingVars(vars, env).join(', ')} not set in this environment` : `${vars.join(', ')} set`) : 'set tracker.auth in .factory/config.json with ${NAME} references (docs/hosts-and-trackers.md)']);
    const adapter = await load('tracker');
    if (!adapter.available) rows.push([`${name} adapter`, false, adapter.reason]);
    else {
      try {
        const tracker = adapter.create(withRoot(config, root));
        const reach = await tracker.reachable();
        rows.push([`${name} API reachable`, Boolean(reach?.ok), reach?.reason ?? (reach?.ok ? tracker.webUrl ?? '' : 'no reason given')]);
        if (reach?.ok) {
          // A dry run of board setup (the tracker contract: { url, done, manual }). Jira and Azure Boards
          // create nothing themselves: `done` lists what was checked, `manual` what a person must create
          // or map (statuses, issue types, custom fields, board columns).
          const plan = await tracker.board.setup({ dryRun: true });
          const manual = plan?.manual ?? [];
          const ok = !manual.length;
          rows.push([`${name} has the lanes, types and fields the factory needs`, ok, ok ? `${(plan?.done ?? []).length} check(s) passed${plan?.url ? ` (${plan.url})` : ''}` : `by hand: ${manual.join('; ')}`]);
        }
      } catch (error) {
        rows.push([`${name} API reachable`, false, firstLine(error)]);
      }
    }
  }
  // A commercial scanner (analysis.commercial): its credential variables set here, its licence accepted by a person.
  // CI reads the same names from its own secret store (doctor cannot see that store: the CI job fails closed, naming
  // the missing variable).
  try {
    const { resolveAnalysis } = await import('../../pipeline/lib/analysis/config.mjs');
    for (const e of resolveAnalysis(withRoot(config, root))?.commercial ?? []) {
      const vendor = e.tool?.commercial?.vendor ?? e.scanner;
      const vars = tokenVars({ token: e.token, auth: e.env });
      const missing = missingVars(vars, env);
      rows.push([`${vendor} scanner (${e.scanner}, ${e.mode}) credential variables`, vars.length > 0 && !missing.length, vars.length ? (missing.length ? `${missing.join(', ')} not set in this environment` : `${vars.join(', ')} set`) : 'set analysis.commercial.token to a ${NAME} reference (docs/providers/commercial-scanners.md)']);
      rows.push([`${vendor} scanner (${e.scanner}) licence accepted by a named person`, !e.blocked, e.blocked ?? 'accepted (analysis.acceptLicence)']);
      if (e.mode === 'server' && !(e.check ?? e.tool?.commercial?.check)) rows.push([`${vendor} scanner (${e.scanner}) check name`, false, 'set analysis.commercial.check to the name of the check the scanner reports on a pull request: without it no result can be bound to a head']);
    }
  } catch (error) {
    rows.push(['commercial scanner settings', false, firstLine(error)]);
  }
  return { rows, warnings, used };
}
