// `featureVerification.enabled`: the automatic test planning and test writing (the stop hook, the pre-push check and an
// implement run's wait for verified tests). FV_SKIP=1 turns it off for one shell; FV_SKIP=0 turns it on.
import { setting } from '../../pipeline/lib/settings.mjs';

export const fvEnabled = (config, env = process.env) => (env.FV_SKIP === '1' ? false : env.FV_SKIP === '0' ? true : setting(config, 'featureVerification.enabled') !== false);
