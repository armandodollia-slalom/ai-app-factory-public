// CI on a story branch before its pull request exists (implement.preOpen, docs/ai-pipeline/implement.md#the-pr-opens-finished).
//
// The pipeline pushes the story branch and waits for the same pipelines a PR would run, on the same SHA, before it opens
// the PR. To keep that from doubling every run, a PR event's run of the same workflow REUSES the push run instead of
// repeating it: a first `reuse` job (only on pull_request) checks that this workflow's push run on this exact head
// concluded success in every job, and that the base is not ahead of the head (so the PR's merge result is the pushed
// head itself). Only then do the workflow's other jobs stand down; otherwise, or when the check itself fails, they run in
// full. Nothing is counted green because it was skipped: the PR run's verdict is the reuse job's own verified success,
// and the push run whose jobs carry the required check names succeeded on the same SHA.
//
// Provider neutral: the decision is the CI adapter's `branchPipelines` capability and implement.preOpen.branches; each
// CI system renders it in its own syntax. GitHub Actions is rendered here; the other systems run their pipelines on
// branch pushes by their own rules (GitLab branch pipelines, multibranch Jenkins, CircleCI and Bitbucket on push) and
// repeat them on the PR.
import { createRequire } from 'node:module';

// Loaded when a workflow is transformed, not when the module loads: a copy of the scripts without node_modules (a
// stage run from a scratch checkout) still loads everything that imports render.
const requireHere = createRequire(import.meta.url);
let yamlLib = null;
const yaml = () => (yamlLib ??= requireHere('yaml'));

// The workflows of the GitHub Actions templates that run before the PR (the gate, static analysis, the demo video).
export const PRE_OPEN_WORKFLOWS = ['.github/workflows/factory-gate.yml', '.github/workflows/factory-analysis.yml'];

const REUSE_SCRIPT = [
  'set -u',
  'wf="${WORKFLOW_REF#*/*/}"; wf="${wf%@*}"',
  'reused=false',
  'behind=$(gh api "repos/$GITHUB_REPOSITORY/compare/$BASE_REF...$HEAD_SHA" --jq .behind_by 2>/dev/null || echo unknown)',
  'run=$(gh api "repos/$GITHUB_REPOSITORY/actions/runs?head_sha=$HEAD_SHA&event=push&per_page=50" --jq "[.workflow_runs[] | select(.path == \\"$wf\\" and .conclusion == \\"success\\")][0].id // empty" 2>/dev/null || true)',
  'if [ "$behind" = "0" ] && [ -n "$run" ]; then',
  // Every job must have passed, except the reuse job itself and the jobs that only run when a PR closes (ALLOW_SKIPPED).
  '  open=$(gh api "repos/$GITHUB_REPOSITORY/actions/runs/$run/jobs?per_page=100" --jq "[.jobs[] | . as \\$j | select(\\$j.name != \\"reuse\\" and \\$j.conclusion != \\"success\\" and ((\\$j.conclusion == \\"skipped\\" and ((env.ALLOW_SKIPPED // \\"\\") | split(\\",\\") | index(\\$j.name) != null)) | not))] | length" 2>/dev/null || echo 1)',
  '  if [ "$open" = "0" ]; then reused=true; echo "Every job of $wf passed on $HEAD_SHA in its story-branch push run: $GITHUB_SERVER_URL/$GITHUB_REPOSITORY/actions/runs/$run (reused, not repeated)"; fi',
  'fi',
  '[ "$reused" = true ] || echo "No complete green push run of $wf on $HEAD_SHA with the base not ahead (behind_by=$behind, run=${run:-none}): the jobs run in full"',
  'echo "reused=$reused" >> "$GITHUB_OUTPUT"',
].join('\n');

const REUSE_JOB = {
  name: 'reuse',
  if: "github.event_name == 'pull_request'",
  'runs-on': 'ubuntu-latest',
  'timeout-minutes': 5,
  permissions: { actions: 'read', contents: 'read' },
  outputs: { reused: '${{ steps.check.outputs.reused }}' },
  steps: [{ id: 'check', name: 'The same jobs already passed on this head before the PR opened', env: { GH_TOKEN: '${{ github.token }}', HEAD_SHA: '${{ github.event.pull_request.head.sha }}', BASE_REF: '${{ github.event.pull_request.base.ref }}', WORKFLOW_REF: '${{ github.workflow_ref }}', ALLOW_SKIPPED: '' }, run: REUSE_SCRIPT }],
};

// The GitHub Actions workflow with its push trigger for the story branches and the reuse job; unchanged when it has no
// pull_request trigger or the patterns are empty.
export function withBranchRuns(text, { patterns = [] } = {}) {
  if (!patterns.length) return text;
  const YAML = yaml();
  const doc = YAML.parseDocument(text);
  const on = doc.get('on', true) ?? doc.get(true, true);
  if (!on || !YAML.isMap(on) || !on.has('pull_request')) return text;
  on.set('push', doc.createNode({ branches: patterns }));
  const jobs = doc.get('jobs', true);
  if (!YAML.isMap(jobs) || jobs.has('reuse')) return text;
  const closedOnly = [];
  for (const item of jobs.items) {
    const job = item.value;
    if (!YAML.isMap(job)) continue;
    // A job that only runs when a PR closes (cleanup) has nothing to reuse; its skip in the push run is expected.
    const cond = String(job.get('if') ?? '');
    if (/action == 'closed'/.test(cond) && !/event_name == 'push'/.test(cond)) {
      closedOnly.push(String(job.get('name') ?? item.key?.value ?? item.key));
      continue;
    }
    const needs = job.get('needs');
    const list = needs == null ? [] : YAML.isSeq(needs) ? needs.items.map((n) => String(n.value ?? n)) : [String(needs)];
    job.set('needs', doc.createNode(['reuse', ...list.filter((n) => n !== 'reuse')]));
    job.set('if', `\${{ !cancelled() && needs.reuse.outputs.reused != 'true'${cond ? ` && (${cond.replace(/^\$\{\{\s*|\s*\}\}$/g, '').replace(/\s+/g, ' ').trim()})` : ''} }}`);
  }
  const reuse = structuredClone(REUSE_JOB);
  reuse.steps[0].env.ALLOW_SKIPPED = closedOnly.join(',');
  jobs.items.unshift(doc.createPair('reuse', reuse));
  return doc.toString({ lineWidth: 0, indentSeq: false });
}
