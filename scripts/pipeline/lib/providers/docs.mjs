// The provider docs' generated parts (docs/providers/): the contract reference and each built-in's capability table,
// from the contracts and the adapters' own CAPABILITIES, so the docs cannot drift from the code. Each generated part
// sits between `<!-- generated:<id> -->` and `<!-- /generated:<id> -->` in its page; the providers-docs test fails when
// a page's part differs from what the code says, and `node scripts/pipeline/lib/providers/docs.mjs --write` rewrites them.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CAPABILITIES, CONTRACTS, KINDS } from './contracts.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

// Every built-in adapter, with how it was verified. `live` is a read-only `factory adapter check` against a real service
// (only where a login already existed on the build machine), `fakes` the conformance suite against an in-memory fake built
// from the vendor's documentation (scripts/pipeline/test/fakes/providers-fake-server.mjs, hosts-fakes.mjs).
export const BUILTINS = [
  { kind: 'host', type: 'github', label: 'GitHub', page: 'hosts/github.md', module: 'scripts/pipeline/lib/hosts/github.mjs', verified: 'live', note: 'read-only `factory adapter check host` against the public test repository, 2026-11-17: 20 pass, 4 skipped (write checks); the v0.2.68 suites unchanged' },
  { kind: 'host', type: 'gitlab', label: 'GitLab', page: 'hosts/gitlab.md', module: 'scripts/pipeline/lib/hosts/gitlab.mjs', verified: 'fakes' },
  { kind: 'host', type: 'azure-devops', label: 'Azure Repos', page: 'hosts/azure-repos.md', module: 'scripts/pipeline/lib/hosts/azure-devops.mjs', verified: 'fakes' },
  { kind: 'host', type: 'bitbucket', label: 'Bitbucket Cloud (alpha)', page: 'hosts/bitbucket.md', module: 'scripts/pipeline/lib/hosts/bitbucket.mjs', verified: 'fakes' },
  { kind: 'tracker', type: 'github', label: 'GitHub Issues and Projects', page: 'trackers/github.md', module: 'scripts/board/lib/trackers/github.mjs', verified: 'live', note: 'read-only `factory adapter check tracker` against the public test repository and its project, 2026-11-17: 20 pass, 16 skipped (write checks); the v0.2.68 suites unchanged' },
  { kind: 'tracker', type: 'jira', label: 'Jira (Cloud and Data Center)', page: 'trackers/jira.md', module: 'scripts/board/lib/trackers/jira.mjs', verified: 'fakes' },
  { kind: 'tracker', type: 'azure-boards', label: 'Azure Boards', page: 'trackers/azure-boards.md', module: 'scripts/board/lib/trackers/azure-boards.mjs', verified: 'fakes' },
  { kind: 'tracker', type: 'gitlab', label: 'GitLab Issues', page: 'trackers/gitlab.md', module: 'scripts/board/lib/trackers/gitlab.mjs', verified: 'fakes' },
  { kind: 'tracker', type: 'linear', label: 'Linear', page: 'trackers/linear.md', module: 'scripts/board/lib/trackers/linear.mjs', verified: 'fakes' },
  { kind: 'ci', type: 'github-actions', label: 'GitHub Actions', page: 'ci/github-actions.md', module: 'scripts/pipeline/lib/ci/github-actions.mjs', verified: 'live', note: 'read-only `factory adapter check ci` against the public test repository, 2026-11-17: 4 pass, 1 skipped (rerun); the v0.2.68 suites unchanged' },
  { kind: 'ci', type: 'gitlab-ci', label: 'GitLab CI', page: 'ci/gitlab-ci.md', module: 'scripts/pipeline/lib/ci/gitlab-ci.mjs', verified: 'fakes' },
  { kind: 'ci', type: 'azure-pipelines', label: 'Azure Pipelines', page: 'ci/azure-pipelines.md', module: 'scripts/pipeline/lib/ci/azure-pipelines.mjs', verified: 'fakes' },
  { kind: 'ci', type: 'jenkins', label: 'Jenkins', page: 'ci/jenkins.md', module: 'scripts/pipeline/lib/ci/jenkins.mjs', verified: 'fakes' },
  { kind: 'ci', type: 'circleci', label: 'CircleCI', page: 'ci/circleci.md', module: 'scripts/pipeline/lib/ci/circleci.mjs', verified: 'fakes' },
  { kind: 'ci', type: 'bitbucket-pipelines', label: 'Bitbucket Pipelines (alpha)', page: 'ci/bitbucket-pipelines.md', module: 'scripts/pipeline/lib/ci/bitbucket-pipelines.mjs', verified: 'fakes' },
  { kind: 'scanner', type: 'sonarqube', label: 'SonarQube (server mode)', page: 'commercial-scanners.md', module: 'scripts/pipeline/lib/analysis/scanners/sonarqube.mjs', verified: 'fakes' },
  { kind: 'scanner', type: 'github-code-scanning', label: 'GitHub code scanning (server mode)', page: 'commercial-scanners.md', module: 'scripts/pipeline/lib/analysis/scanners/github-code-scanning.mjs', verified: 'fakes', note: 'fakes; one live read-only call (2026-11-17) to the public test repository answered 404 "no analysis found" (read as pending)' },
  { kind: 'scanner', type: 'semgrep', label: 'Semgrep (server mode)', page: 'commercial-scanners.md', module: 'scripts/pipeline/lib/analysis/scanners/semgrep.mjs', verified: 'fakes' },
  { kind: 'scanner', type: 'check-only', label: 'Snyk, Checkmarx One, Veracode (server mode: their check on the head)', page: 'commercial-scanners.md', module: 'scripts/pipeline/lib/analysis/scanners/check-only.mjs', verified: 'fakes' },
];

const cell = (v) => String(v ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
const mark = (v) => (v === true ? 'yes' : v === 'partial' ? 'partial' : 'no');

// The operations of every kind, as Markdown tables.
export function contractsMarkdown() {
  const out = [];
  for (const kind of KINDS) {
    out.push(`### ${kind}`, '', '| Operation | Mode | Needs capability | What it does | Arguments | Returns |', '| --- | --- | --- | --- | --- | --- |');
    for (const o of CONTRACTS[kind]) out.push(`| \`${o.id}\` | ${o.mode} | ${o.capability ? `\`${o.capability}\`` : 'required'} | ${cell(o.summary)} | ${cell(o.args ? `\`${o.args}\`` : 'none')} | ${cell(o.returns ? `\`${o.returns}\`` : 'nothing')} |`);
    out.push('', `Capabilities of a ${kind} adapter (\`safety\`: the harness keeps the safety property another way, never by skipping it):`, '', '| Capability | Safety | Means | Without it |', '| --- | --- | --- | --- |');
    for (const [c, v] of Object.entries(CAPABILITIES[kind])) out.push(`| \`${c}\` | ${v.safety ? 'yes' : 'no'} | ${cell(v.summary)} | ${cell(v.degrade)} |`);
    out.push('');
  }
  return out.join('\n').trimEnd();
}

// One built-in's capability table: what it has, and how the harness degrades where it has not.
export function capabilityMarkdown(kind, caps) {
  const out = ['| Capability | This adapter | Without it, the harness |', '| --- | --- | --- |'];
  for (const [c, v] of Object.entries(CAPABILITIES[kind])) out.push(`| \`${c}\` | ${mark(caps?.[c])} | ${caps?.[c] === true ? 'nothing to change' : cell(v.degrade)} |`);
  return out.join('\n');
}

export function builtinsMarkdown() {
  const out = ['| Kind | Service | Verified | Page |', '| --- | --- | --- | --- |'];
  for (const b of BUILTINS) out.push(`| ${b.kind} | ${b.label} | ${b.verified === 'live' ? 'live (read-only) and fakes' : 'fakes only'}${b.note ? `: ${cell(b.note)}` : ''} | [${b.page}](${b.page}) |`);
  return out.join('\n');
}

// The commercial scanner definitions (packs/commercial/analysis.json): mode, token variable, licence, verification.
export function commercialMarkdown() {
  const tools = JSON.parse(fs.readFileSync(path.join(ROOT, 'packs/commercial/analysis.json'), 'utf8')).tools;
  const out = ['| Definition | Product | Modes | Token variable the CLI reads | Licence to accept | Server adapter | Verified | Docs (read) |', '| --- | --- | --- | --- | --- | --- | --- | --- |'];
  for (const [id, t] of Object.entries(tools)) {
    const c = t.commercial;
    out.push(`| \`${id}\` | ${cell(c.product)} | ${c.modes.join(', ')} | \`${c.tokenEnv}\`${c.otherEnv?.length ? ` (and ${c.otherEnv.map((e) => `\`${e}\``).join(', ')})` : ''} | \`${t.licence}\` | ${c.modes.includes('server') ? `\`${c.server?.adapter ?? 'check-only'}\`, check \`${cell(c.check)}\`` : 'none'} | ${c.verified ? 'yes' : 'no'} | ${c.docs.map((d, i) => `[${i + 1}](${d})`).join(' ')} (${c.docsRead}) |`);
  }
  out.push('', 'Notes on each definition, as the pack records them:', '');
  for (const [id, t] of Object.entries(tools)) out.push(`- \`${id}\`: ${cell(t.commercial.verifiedNote)}`);
  return out.join('\n');
}

// The setup interview's questions (scripts/factory/lib/interview.mjs), as `factory init --questions` lists them.
export async function interviewMarkdown() {
  const { QUESTIONS } = await import(path.join(ROOT, 'scripts/factory/lib/interview.mjs'));
  const out = ['| Section | Answer id | Question | Answer | Asked |', '| --- | --- | --- | --- | --- |'];
  for (const q of QUESTIONS) out.push(`| ${cell(q.section)} | \`${q.id}\` | ${cell(q.ask).replace(/</g, '\\<')} | ${q.kind === 'choice' ? (q.choices ?? []).map((c) => `\`${c}\``).join(', ') : q.kind === 'variable' ? 'a variable NAME' : q.kind} | ${q.when ? 'when it applies' : 'always'} |`);
  return out.join('\n');
}

// Every generated part: { file (relative to docs/providers), id, text }.
export async function generatedParts() {
  const parts = [{ file: 'contracts.md', id: 'contracts', text: contractsMarkdown() }, { file: 'README.md', id: 'builtins', text: builtinsMarkdown() }, { file: 'commercial-scanners.md', id: 'commercial-definitions', text: commercialMarkdown() }, { file: 'setup.md', id: 'interview', text: await interviewMarkdown() }];
  // The worked examples of the custom adapter, verbatim (the conformance tests run these same files).
  for (const ex of ['custom-tracker', 'custom-scanner']) parts.push({ file: 'custom.md', id: `example-${ex}`, text: `\`\`\`js\n${fs.readFileSync(path.join(ROOT, 'docs/providers/examples', `${ex}.mjs`), 'utf8').trimEnd()}\n\`\`\`` });
  for (const b of BUILTINS) {
    const mod = await import(path.join(ROOT, b.module));
    parts.push({ file: b.page, id: `capabilities-${b.type}`, text: capabilityMarkdown(b.kind, mod.CAPABILITIES) });
  }
  return parts;
}

const block = (id, text) => `<!-- generated:${id} -->\n${text}\n<!-- /generated:${id} -->`;
const BLOCK = (id) => new RegExp(`<!-- generated:${id} -->[\\s\\S]*?<!-- /generated:${id} -->`);

// [{ file, id, problem }]: pages whose generated part is missing or out of date.
export async function staleParts(docsDir = path.join(ROOT, 'docs/providers')) {
  const out = [];
  for (const p of await generatedParts()) {
    const file = path.join(docsDir, p.file);
    const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
    if (text === null) out.push({ ...p, problem: 'page missing' });
    else if (!BLOCK(p.id).test(text)) out.push({ ...p, problem: `no <!-- generated:${p.id} --> block` });
    else if (text.match(BLOCK(p.id))[0] !== block(p.id, p.text)) out.push({ ...p, problem: 'out of date' });
  }
  return out;
}

export async function writeParts(docsDir = path.join(ROOT, 'docs/providers')) {
  for (const p of await generatedParts()) {
    const file = path.join(docsDir, p.file);
    const text = fs.readFileSync(file, 'utf8');
    if (BLOCK(p.id).test(text)) fs.writeFileSync(file, text.replace(BLOCK(p.id), () => block(p.id, p.text)));
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--write')) await writeParts();
  const stale = await staleParts();
  for (const s of stale) console.log(`${s.file}: ${s.id}: ${s.problem}`);
  process.exitCode = stale.length ? 1 : 0;
}
