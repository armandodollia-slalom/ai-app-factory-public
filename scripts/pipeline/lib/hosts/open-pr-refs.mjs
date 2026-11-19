// Prints one git refspec per open pull request of this checkout's code host, so a script can fetch the
// heads of pull requests from forks (scripts/graphify-prune-cache.sh). GitHub: refs/pull/N/head; GitLab:
// refs/merge-requests/N/head; Azure DevOps: refs/pull/N/merge (Azure has no head ref for a PR). Exits 1
// when the host cannot be asked; the caller then skips fork pull requests.
import { loadConfig } from '../config.mjs';
import { hostFor } from './index.mjs';

export const prRef = (type, n) => (type === 'gitlab' ? `refs/merge-requests/${n}/head` : type === 'azure-devops' ? `refs/pull/${n}/merge` : `refs/pull/${n}/head`);

if (process.argv[1]?.endsWith('open-pr-refs.mjs')) {
  try {
    const host = hostFor(loadConfig());
    for (const pr of host.sync.pr.list({ state: 'open', limit: 200 })) console.log(`${pr.number} ${prRef(host.type, pr.number)}`);
  } catch (error) {
    console.error(`[graphify] open pull requests not listed: ${String(error.message).split('\n')[0]}`);
    process.exit(1);
  }
}
