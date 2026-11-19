// Code host access for the PR check, through the host contract (scripts/pipeline/lib/hosts). Kept under this name for
// the modules and tests that import it.
import { writeFile } from 'node:fs/promises';
import { fetchWithTimeout } from '../../pipeline/lib/external.mjs';
import { ATTACHMENT_PATTERNS, downloadHeaders, hostFor, rawFileUrl } from '../../pipeline/lib/hosts/index.mjs';
import { originRepo } from '../../pipeline/lib/products.mjs';

// The repository of the checkout: the CI system's own variable first (GITHUB_REPOSITORY), else the origin remote.
export function repoSlug(root) {
  if (process.env.GITHUB_REPOSITORY) return process.env.GITHUB_REPOSITORY;
  const repo = originRepo(root);
  if (!repo) throw new Error('cannot work out the repository from the origin remote');
  return repo;
}

// The code host of a config (or of a checkout root, for older callers).
const hostOf = (target) => {
  const config = typeof target === 'string' ? { root: target } : target;
  return hostFor(config, process.env.GITHUB_REPOSITORY ? { repo: process.env.GITHUB_REPOSITORY } : {});
};

export async function fetchPullRequest(target, number) {
  const host = hostOf(target);
  const pr = await host.pr.get(number);
  if (!pr) throw new Error(`pull request ${number} not found on ${host.repo}`);
  return { number: pr.number, title: pr.title, body: pr.body ?? '', url: pr.url, headRef: pr.head, baseRef: pr.base, headSha: pr.headSha, fromFork: Boolean(pr.fromFork) };
}

export async function commentOnPullRequest(target, number, body) {
  await hostOf(target).pr.comment(number, body);
}

// Video links in a PR body: direct files, and files a host serves as uploaded attachments.
export function videoLinks(text, extensions) {
  const ext = extensions.map((e) => e.slice(1)).join('|');
  const pattern = new RegExp(`https://[^\\s)"'<>\\]]+?\\.(?:${ext})(?=[\\s)"'<>\\]?#]|$)|${ATTACHMENT_PATTERNS.join('|')}`, 'gi');
  return [...new Set(text.match(pattern) ?? [])];
}

export const rawGitHubUrl = rawFileUrl;

export async function download(link, file, config = null) {
  const url = rawFileUrl(link);
  const response = await fetchWithTimeout(url, { headers: downloadHeaders(url, config), redirect: 'follow' }, { timeoutSec: 600 });
  if (!response.ok) throw new Error(`download failed: ${response.status}`);
  if ((response.headers.get('content-type') ?? '').startsWith('text/html')) {
    throw new Error('the link returned a web page, not a video (a private attachment without access?)');
  }
  await writeFile(file, Buffer.from(await response.arrayBuffer()));
}
