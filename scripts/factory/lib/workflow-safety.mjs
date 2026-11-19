// The repository's workflows must not hand the factory's token (or any secret) to code or events from outside
// the repository. On a public repository that is the difference between a private factory and a leaked one.
// `factory check` fails on each problem; `factory doctor` lists them.
//
// - `pull_request_target` and `workflow_run` run with secrets on behalf of a pull request from a fork: a
//   workflow with such a trigger may not use FACTORY_TOKEN, `secrets: inherit`, or check out the PR's code.
// - `issue_comment`, `discussion_comment` and `pull_request_review_comment` can be triggered by anyone on a
//   public repository: a job that uses FACTORY_TOKEN must check `author_association` first.
// GitLab CI (.gitlab-ci.yml, .gitlab/ci/*.yml) and Azure Pipelines (.azure-pipelines/*.yml) have no comment
// triggers (tracker automations run on a schedule), so the risk there is a fork's merge request: a job that
// runs the agent (its credential, and FACTORY_TOKEN) on merge request pipelines must exclude forks
// (GitLab: `$CI_MERGE_REQUEST_SOURCE_PROJECT_ID == $CI_PROJECT_ID` in the rule; Azure:
// `System.PullRequest.IsFork` in the job's condition).
import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';

const FORK_TRIGGERS = ['pull_request_target', 'workflow_run'];
const ANYONE_TRIGGERS = ['issue_comment', 'discussion_comment', 'pull_request_review_comment'];

export function workflowProblems(root) {
  return [...githubProblems(root), ...gitlabProblems(root), ...azureProblems(root)];
}

const yamlFiles = (root, dir) => (fs.existsSync(path.join(root, dir)) ? fs.readdirSync(path.join(root, dir)).filter((f) => /\.ya?ml$/.test(f)).sort().map((f) => `${dir}/${f}`) : []);
const readYaml = (root, rel) => {
  const text = fs.readFileSync(path.join(root, rel), 'utf8');
  try {
    return { text, doc: parse(text) };
  } catch {
    return { text, doc: null };
  }
};

// GitLab CI: a job that extends `.factory-agent` (or names an agent credential) and runs on merge request
// pipelines must keep forks out in that rule.
const GITLAB_RESERVED = new Set(['stages', 'variables', 'workflow', 'include', 'default', 'image', 'services', 'cache', 'before_script', 'after_script']);
function gitlabProblems(root) {
  const problems = [];
  for (const rel of [...(fs.existsSync(path.join(root, '.gitlab-ci.yml')) ? ['.gitlab-ci.yml'] : []), ...yamlFiles(root, '.gitlab/ci')]) {
    const { doc } = readYaml(root, rel);
    for (const [name, job] of Object.entries(doc ?? {})) {
      if (name.startsWith('.') || GITLAB_RESERVED.has(name) || !job || typeof job !== 'object') continue;
      const ext = [job.extends ?? []].flat();
      const agent = ext.includes('.factory-agent') || /ANTHROPIC_API_KEY|OPENAI_API_KEY|COPILOT_GITHUB_TOKEN|FACTORY_TOKEN/.test(JSON.stringify(job.script ?? ''));
      const open = (job.rules ?? []).filter((r) => /merge_request_event/.test(String(r?.if ?? '')) && !/CI_MERGE_REQUEST_SOURCE_PROJECT_ID\s*==\s*\$CI_PROJECT_ID/.test(String(r.if)));
      if (agent && open.length) problems.push({ path: rel, problem: `job ${name} runs the agent with its credentials on merge request pipelines, also for a fork's merge request run in this project: add \`&& $CI_MERGE_REQUEST_SOURCE_PROJECT_ID == $CI_PROJECT_ID\` to its rule` });
    }
  }
  return problems;
}

// Azure Pipelines: a pipeline with a `pr:` trigger whose job installs the agent CLI must not run for forks.
function azureProblems(root) {
  const problems = [];
  for (const rel of yamlFiles(root, '.azure-pipelines')) {
    const { doc } = readYaml(root, rel);
    if (!doc || doc.pr === 'none' || doc.pr === undefined) continue;
    for (const job of doc.jobs ?? []) {
      const steps = JSON.stringify(job?.steps ?? []);
      if (!/factory-agent-cli\.yml/.test(steps)) continue;
      if (!/System\.PullRequest\.IsFork/.test(String(job.condition ?? ''))) problems.push({ path: rel, problem: `job ${job.job ?? '?'} runs the agent with its credentials on pull request builds, also for forks: add \`ne(variables['System.PullRequest.IsFork'], 'True')\` to its condition (and keep "Make secrets available to builds of forks" off)` });
    }
  }
  return problems;
}

function githubProblems(root) {
  const dir = path.join(root, '.github/workflows');
  if (!fs.existsSync(dir)) return [];
  const problems = [];
  for (const file of fs.readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).sort()) {
    const rel = `.github/workflows/${file}`;
    const text = fs.readFileSync(path.join(dir, file), 'utf8');
    let doc;
    try {
      doc = parse(text);
    } catch {
      continue;
    }
    const on = doc?.on ?? doc?.true; // YAML 1.1 reads a bare `on` as true
    const triggers = typeof on === 'string' ? [on] : Array.isArray(on) ? on : Object.keys(on ?? {});
    const secretsUsed = /secrets\.FACTORY_TOKEN|secrets:\s*inherit/.test(text);
    const fork = triggers.filter((t) => FORK_TRIGGERS.includes(t));
    if (fork.length && secretsUsed) problems.push({ path: rel, problem: `${fork.join(', ')} runs with secrets for pull requests from forks, and this workflow uses FACTORY_TOKEN (or secrets: inherit): use pull_request instead` });
    if (fork.length && /ref:\s*\$\{\{\s*github\.event\.pull_request\.head\.(sha|ref)/.test(text)) problems.push({ path: rel, problem: `${fork.join(', ')} checks out the pull request's own code with the base repository's permissions` });
    const anyone = triggers.filter((t) => ANYONE_TRIGGERS.includes(t));
    if (anyone.length && /secrets\.FACTORY_TOKEN/.test(text) && !/author_association/.test(text)) problems.push({ path: rel, problem: `${anyone.join(', ')} can be triggered by anyone on a public repository, and this workflow uses FACTORY_TOKEN without checking author_association` });
  }
  return problems;
}
