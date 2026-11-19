// The CI system layer: which pipelines a pull request's head must run, their runs and their logs, behind one
// contract (providers/contracts.mjs `ci`) for every CI system. Rendering the CI definitions is the generator's
// (scripts/factory/lib/render.mjs and templates/ci/<provider>/); this is the runtime side the review gate, the
// implement run's CI wait and the PR check read.
//
//   const ci = ciFor(config)            // config.ci: { provider, url, token: "${ENV}", ... }
//   ci.expected({ head, base, changed, pr }); ci.runs({ head }); ci.log(runId, { failedOnly: true })
//
// Methods are synchronous (the review gate is): GitHub Actions runs gh; the REST systems block on the adapter
// layers' one synchronous bridge (../blocking.mjs). Without `ci.provider` the CI system is the code host's own
// (products.mjs). `custom` maps each operation to a command the repository declares (providers/custom.mjs).
import { resolveProducts } from '../products.mjs';
import { hostFor } from '../hosts/index.mjs';
import { createGithubHost } from '../hosts/github.mjs';
import { createGithubActions } from './github-actions.mjs';

// GitHub Actions' workflow reading, for the callers and tests that name it through this layer.
export { defaultRequiredChecks, expectedWorkflows, globRegex, triggers, workflowApplies } from './github-actions.mjs';

const BUILTIN = {
  'github-actions': (settings, deps) => createGithubActions(settings, deps),
};
const LAZY = {
  'gitlab-ci': () => import('./gitlab-ci.mjs').then((m) => m.createGitlabCi),
  'azure-pipelines': () => import('./azure-pipelines.mjs').then((m) => m.createAzurePipelines),
  jenkins: () => import('./jenkins.mjs').then((m) => m.createJenkins),
  circleci: () => import('./circleci.mjs').then((m) => m.createCircleci),
  'bitbucket-pipelines': () => import('./bitbucket-pipelines.mjs').then((m) => m.createBitbucketPipelines),
  custom: () => import('../providers/custom.mjs').then((m) => (settings, deps) => m.createCustomAdapter('ci', settings, deps)),
};
// The REST CI adapters are loaded once at start-up (top-level await), so ciFor stays synchronous.
for (const [type, load] of Object.entries(LAZY)) {
  try {
    BUILTIN[type] = await load();
  } catch (error) {
    if (error?.code !== 'ERR_MODULE_NOT_FOUND') throw error;
  }
}

export const CI_TYPES = Object.keys(BUILTIN);
const { scannersFor, scannerEvidence } = await import('../analysis/scanners/index.mjs');

// The resolved CI settings: { provider, url, repo (the host's), token, expected, ignore, ... }.
export function ciSettings(config, deps = {}) {
  const { ci, host } = resolveProducts(config ?? {}, deps.remote !== undefined ? { remote: deps.remote } : {});
  const own = config?.ci ?? {};
  return { ...own, provider: ci.provider, hostType: host.type, repo: own.repo ?? deps.repo ?? host.repo ?? config?.board?.repo ?? null, root: config?.root ?? null };
}

const cache = new WeakMap();
// The CI adapter of a repository's config. deps: { gh | run (GitHub runners), fetch, env, send, repo, remote }.
export function ciFor(config, deps = {}) {
  const plain = !Object.keys(deps).length && config && typeof config === 'object';
  if (plain && cache.has(config)) return cache.get(config);
  const settings = ciSettings(config, deps);
  const create = BUILTIN[settings.provider];
  if (!create) throw Object.assign(new Error(`ci.provider is "${settings.provider}"; use one of ${CI_TYPES.join(', ')}`), { code: 'config' });
  const adapter = create(settings, { ...deps, config });
  adapter.settings = settings;
  if (plain) cache.set(config, adapter);
  return adapter;
}

// The { host, ci } pair the CI evidence reads. `target` is a gh runner (GitHub with GitHub Actions: the gate's tests
// and older callers) with `repo`, or a repository config (with an optional gh runner for its GitHub adapters).
export function ciTarget(target, repo = null, gh = null) {
  if (typeof target === 'function') return { host: createGithubHost({ type: 'github', repo }, { gh: target }), ci: createGithubActions({ repo }, { gh: target }) };
  if (target?.host?.pr && typeof target?.ci?.runs === 'function') return target;
  const deps = gh ? { gh, ...(repo ? { repo } : {}) } : repo ? { repo } : {};
  const pair = { host: hostFor(target, deps).sync, ci: ciFor(target, deps) };
  // Commercial scanners in server mode join the head's evidence (analysis/scanners/index.mjs).
  if (target?.analysis?.commercial) {
    const scanners = scannersFor(target, repo ? { repo } : {});
    if (scanners.length) Object.assign(pair, { scanners, scannerEvidence, config: target });
  }
  return pair;
}
