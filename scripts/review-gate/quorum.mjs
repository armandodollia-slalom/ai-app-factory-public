#!/usr/bin/env node
// The `review-quorum` check (the review-quorum CI job): passes when approvals from distinct people (not
// the author, not stale approvals from before the latest push) reach the PR's `approvals:N` label. A PR
// without that label, or with `approvals:0`, passes. It reads the PR through the code host
// (scripts/pipeline/lib/hosts: GitHub through gh, GitLab or Azure DevOps through their APIs) and
// lib/quorum.mjs only, so CI runs it from the base branch, never the PR's own copy.
//
//   node scripts/review-gate/quorum.mjs <pr number> [--repo owner/name]
// The PR number may also come from PR_NUMBER, CI_MERGE_REQUEST_IID (GitLab) or
// SYSTEM_PULLREQUEST_PULLREQUESTID (Azure Pipelines); the repository from host.repo in
// .factory/config.json, the origin remote, --repo or GITHUB_REPOSITORY (GitHub).
import { appendText } from '../pipeline/lib/redact.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { hostFor } from '../pipeline/lib/hosts/index.mjs';
import { quorum } from './lib/quorum.mjs';
import { toReview } from './lib/github.mjs';
import { MARKER, parseState } from './lib/gate.mjs';

const args = process.argv.slice(2);
const env = process.env;
const pr = args.find((a) => /^\d+$/.test(a)) ?? env.PR_NUMBER ?? env.CI_MERGE_REQUEST_IID ?? env.SYSTEM_PULLREQUEST_PULLREQUESTID;
const repoAt = args.indexOf('--repo');
const repo = repoAt >= 0 ? args[repoAt + 1] : env.GITHUB_REPOSITORY;
const root = process.cwd();

// The repository's host settings (only `host` is needed; a missing or broken config means defaults).
let host;
try {
  host = JSON.parse(fs.readFileSync(path.join(root, '.factory/config.json'), 'utf8')).host;
} catch {
  host = undefined;
}
const config = { root, ...(host ? { host } : {}) };
if (!pr) {
  console.error('Usage: quorum.mjs <pr number> [--repo owner/name] (or PR_NUMBER and GITHUB_REPOSITORY)');
  process.exit(2);
}
const h = hostFor(config, repo ? { repo } : {});
if (!String(h.repo)) {
  console.error('quorum.mjs: cannot tell the repository: pass --repo owner/name, set host.repo, or run it in a checkout with an origin remote');
  process.exit(2);
}
// Self-contained, so it carries its own copy of the external-call rule: the host's calls time out, and these reads
// are retried twice.
async function retried(what, call) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await call();
    } catch (error) {
      if (attempt >= 3 || error.status === 404 || error.code === 'not-found') throw error;
      await new Promise((r) => setTimeout(r, 2000 * attempt));
      console.error(`quorum.mjs: ${what} failed (${String(error.message).split('\n')[0]}); retrying`);
    }
  }
}
const p = await retried('reading the pull request', () => h.pr.get(pr));
if (!p) {
  console.error(`quorum.mjs: pull request ${pr} not found on ${h.repo}`);
  process.exit(2);
}
const reviews = (await retried('reading the reviews', () => h.pr.reviews(pr))).map(toReview);
// A host without pull request labels (Bitbucket): the gate keeps approvals:N in its notice comment's state.
let labels = p.labels;
if (h.capabilities?.labels === false) {
  const notice = (await retried('reading the gate notice', () => h.pr.comments(pr))).filter((c) => String(c.body ?? '').includes(MARKER)).at(-1);
  const st = parseState(notice?.body);
  labels = st && Number.isFinite(Number(st.approvals)) ? [`approvals:${Number(st.approvals)}`] : [];
}
const result = quorum({ labels, reviews, author: p.author, headSha: p.headSha });
console.log(`review-quorum: ${result.pass ? 'pass' : 'fail'}: ${result.summary}`);
if (env.GITHUB_STEP_SUMMARY) appendText(env.GITHUB_STEP_SUMMARY, `### review-quorum: ${result.pass ? 'pass' : 'waiting for approvals'}\n\n${result.summary}\n`);
process.exit(result.pass ? 0 : 1);
