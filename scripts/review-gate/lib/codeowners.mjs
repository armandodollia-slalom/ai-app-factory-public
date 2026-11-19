// Whether a code-owner review can ever be given on the pipeline's pull requests. GitHub never counts a pull
// request author's own review, so when the only code owner of the factory's files is also the author of the
// pipeline's pull requests (the developer's gh login, because the PR bot is not set up), a rule that requires
// code-owner review can never be met: every pipeline PR and every pin bump would need the admin bypass.
// `review-gate enforce` leaves such a rule out (and says what would make it satisfiable), and `factory doctor`
// reports a branch rule that requires it.
import fs from 'node:fs';
import path from 'node:path';

const CODEOWNERS = ['.github/CODEOWNERS', 'CODEOWNERS', 'docs/CODEOWNERS'];

/** The owners of `/.factory/` (the factory's governance) in the repository's CODEOWNERS, or [] when there are none. */
export function factoryCodeOwners(root) {
  for (const rel of CODEOWNERS) {
    const file = path.join(root, rel);
    if (!fs.existsSync(file)) continue;
    // CODEOWNERS: the last matching pattern wins; the factory writes `/.factory/ @owner ...`.
    const lines = fs.readFileSync(file, 'utf8').split('\n').map((l) => l.replace(/#.*$/, '').trim()).filter(Boolean);
    const line = [...lines].reverse().find((l) => /^\/?\.factory\/?\s/.test(l));
    return line ? line.split(/\s+/).slice(1) : [];
  }
  return [];
}

/**
 * { satisfiable, reason }: whether someone other than `author` (the login that opens the pipeline's PRs) is a
 * code owner. A team or an e-mail owner may hold other people, so it counts as satisfiable.
 */
export function codeOwnerReview({ owners, author, botConfigured = false }) {
  if (!owners?.length) return { satisfiable: false, reason: 'CODEOWNERS names no owner for .factory/' };
  const others = owners.filter((o) => o.includes('/') || o.includes('@', 1) || !author || o.replace(/^@/, '').toLowerCase() !== String(author).toLowerCase());
  if (others.length) return { satisfiable: true, reason: `code owners other than the PR author: ${others.join(' ')}` };
  return {
    satisfiable: false,
    reason: `the only code owner of .factory/ (${owners.join(' ')}) is also the author of the pipeline's pull requests (${author}${botConfigured ? '' : ', because the PR bot is not set up'}), and GitHub never counts an author's own review: a rule requiring code-owner review could only be met through the admin bypass. Set up the PR bot (\`factory bot setup\`) or add a second code owner (\`factory init --owners\`), then run \`factory review-gate enforce\` again`,
  };
}
