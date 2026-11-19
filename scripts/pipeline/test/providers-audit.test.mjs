// The engine is provider-neutral: every call to a ticket tracker, code host, CI system or scanner goes through an
// adapter (providers/contracts.mjs). Engine code outside the adapter layers never runs the gh CLI, never calls a
// provider's API by URL, never imports a provider's adapter module and never branches on a provider's name. What a
// product can or cannot do is a capability the adapter declares (docs/providers/contracts.md).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

// The adapter layers: where product knowledge lives.
const ADAPTER_DIRS = ['scripts/pipeline/lib/hosts/', 'scripts/board/lib/trackers/', 'scripts/pipeline/lib/ci/', 'scripts/pipeline/lib/providers/', 'scripts/pipeline/lib/analysis/scanners/'];
// Registries: the one place each names the products it maps (a remote URL to a host, a host to its default tracker and
// CI system, a CI system to its rendered files).
const REGISTRIES = {
  'scripts/pipeline/lib/products.mjs': 'the product registry: parses remotes and applies the defaults',
  'scripts/factory/lib/hosting.mjs': 'the generator\'s view of the product registry',
  'scripts/factory/lib/adapters.mjs': 'loads the adapters for doctor; names each product for its rows',
  'scripts/factory/lib/render.mjs': 'renders templates/ci/<provider>/ per CI system (the CI adapters\' generator side)',
  'scripts/factory/lib/workflow-safety.mjs': 'checks the rendered CI definitions per CI system (generator side of the CI adapters)',
  'scripts/factory/lib/init.mjs': 'drafts the products from the remote and the interview\'s answers',
  'scripts/factory/lib/interview.mjs': 'the setup interview: names each product it offers',
  'scripts/pipeline/lib/analysis/ci.mjs': 'renders the analysis CI jobs per CI system (generator side of the CI adapters)',
  'scripts/pipeline/lib/bot.mjs': 'the GitHub App PR identity behind host.bot of the GitHub host adapter, and the neutral publisher',
  'scripts/pipeline/lib/bot-setup.mjs': 'the GitHub App PR identity setup behind host.bot.setup of the GitHub host adapter',
};

const PROVIDERS = ['github', 'gitlab', 'azure-devops', 'bitbucket', 'jira', 'azure-boards', 'linear', 'github-actions', 'gitlab-ci', 'azure-pipelines', 'jenkins', 'circleci', 'bitbucket-pipelines'];
const RULES = [
  { id: 'runs the gh CLI', re: /\b(?:run|exec|runCmd|spawnSync|spawn|execFile|execFileSync|runAsync)\(\s*['"]gh['"]|['"]gh['"],\s*\[|\bgh\(\s*\[\s*['"](?:pr|issue|api|run|project|label|repo|auth)['"]/ },
  { id: 'calls a provider API by URL', re: /api\.github\.com|uploads\.github\.com|gitlab\.com\/api|\/_apis\/|\.atlassian\.net\/rest|\/rest\/api\/[23]|api\.linear\.app|api\.bitbucket\.org|circleci\.com\/api/ },
  { id: 'imports a provider adapter module', re: /from\s+['"][^'"]*\/(?:hosts\/(?:github|gitlab|azure-devops|bitbucket)|trackers\/(?:github|jira|azure-boards|gitlab|linear)|ci\/(?:github-actions|gitlab-ci|azure-pipelines|jenkins|circleci|bitbucket-pipelines))\.mjs['"]/ },
  { id: 'branches on a provider name', re: new RegExp(`(?:[!=]==\\s*['"](?:${PROVIDERS.join('|')})['"]|['"](?:${PROVIDERS.join('|')})['"]\\s*[!=]==|case\\s+['"](?:${PROVIDERS.join('|')})['"]\\s*:)`) },
];

function engineFiles() {
  const out = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const rel = path.posix.join(dir, e.name);
      if (e.isDirectory()) {
        if (!['node_modules', 'test', 'tests', 'fixtures'].includes(e.name)) walk(rel);
      } else if (/\.(mjs|js)$/.test(e.name)) out.push(rel);
    }
  };
  walk('scripts');
  walk('bin');
  return out;
}

// Comment lines are prose: they may name products.
const code = (text) => text.split('\n').map((l) => (/^\s*(\/\/|\*|\/\*)/.test(l) ? '' : l.replace(/\s\/\/\s.*$/, '')));

test('no engine code outside the adapters calls gh, calls a provider API, imports a provider adapter or names a provider in a branch', () => {
  const offenders = [];
  for (const rel of engineFiles()) {
    if (ADAPTER_DIRS.some((d) => rel.startsWith(d)) || REGISTRIES[rel]) continue;
    code(fs.readFileSync(path.join(ROOT, rel), 'utf8')).forEach((line, i) => {
      for (const r of RULES) if (r.re.test(line)) offenders.push(`${rel}:${i + 1} ${r.id}: ${line.trim().slice(0, 140)}`);
    });
  }
  assert.deepEqual(offenders, [], `engine code that should go through an adapter:\n${offenders.join('\n')}`);
});

test('the registries and the adapter layers are the only exceptions, and each registry says why', () => {
  for (const [rel, why] of Object.entries(REGISTRIES)) assert.ok(why.length > 20, rel);
  for (const d of ADAPTER_DIRS.filter((x) => !x.includes('scanners'))) assert.ok(fs.existsSync(path.join(ROOT, d)), d);
});

test('the audit catches each kind of call it forbids', () => {
  const samples = ["run('gh', ['pr', 'view'])", "gh(['pr', 'merge', '5'])", 'fetch(`https://api.github.com/repos/${r}`)', "import { x } from '../pipeline/lib/hosts/github.mjs';", "if (host.type === 'github') {", "case 'jira':"];
  for (const s of samples) assert.ok(RULES.some((r) => r.re.test(s)), s);
  for (const s of ["host.pr.get(5)", "// GitHub's rulesets", "const label = host.label ?? 'GitHub';"]) assert.ok(!RULES.some((r) => r.re.test(code(s)[0])), s);
});
