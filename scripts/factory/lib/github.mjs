// Kept for the modules and tests that import the doctor's code host checks by this name: they are provider-neutral
// and live in code-host.mjs.
import { hostFor, resolveToken } from '../../pipeline/lib/hosts/index.mjs';
import { autoMergeSetting, originRepo, reviewEnforcement } from './code-host.mjs';

export { autoMergeSetting, reviewEnforcement };
// The repository of the origin remote ("owner/name" on GitHub), or null.
export const githubRepo = (root) => originRepo(root);

// Doctor's check for the repository's code host: { product, result: [ok, note] } or null when it cannot be asked (no
// repository; a host whose credentials are not set).
export async function hostEnforcement(root, config, { ghSignedIn = () => true, review = null, requiredChecks = [] } = {}) {
  let host;
  try {
    host = hostFor({ ...(config ?? {}), root });
  } catch {
    return null;
  }
  if (!String(host.repo)) return null;
  const cliAuth = !host.settings?.token && !resolveToken(host.settings);
  if (cliAuth && !ghSignedIn()) return null;
  return { product: host.label ?? host.type, result: reviewEnforcement(host.sync, null, { review, requiredChecks }) };
}
