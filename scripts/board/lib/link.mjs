// Linking a pull request (on any code host) to its ticket (on any tracker): `board review` calls it once
// the story's PR exists.
import { hostFor } from '../../pipeline/lib/hosts/index.mjs';
import { trackerFor } from './trackers/index.mjs';

// Links the pull request to the ticket. When the tracker's tickets close from a pull request on this host (GitHub
// issues and a GitHub PR, GitLab issues and a GitLab merge request), the closing keyword goes in the PR body, edited
// through the code host layer. Any other combination: the tracker's own link (a remote link, a hyperlink, a comment),
// whatever product hosts the code.
export function linkPullRequest(config, issue, pr, story, { host = hostFor(config), tracker = trackerFor(config), log = () => {} } = {}) {
  const closes = tracker.prClosingKeyword?.(issue, host) ?? null;
  if (closes) {
    const view = host.sync.pr.get(pr);
    if (view && !String(view.body ?? '').includes(closes)) host.sync.pr.update(view.number, { body: `${String(view.body ?? '').trimEnd()}\n\n${closes}\n` });
    return;
  }
  try {
    tracker.tickets.link(issue.number, { url: pr, title: `Pull request for ${story.key}` });
  } catch (error) {
    log(`${story.key}: pull request not linked: ${error.message.split('\n')[0]}`);
  }
}
