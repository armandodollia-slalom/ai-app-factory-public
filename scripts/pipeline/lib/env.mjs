// `${NAME}` expansion for settings that reference secrets (the metrics sink, the code host and the ticket
// tracker tokens). Secrets never go in the config: the value is read from the environment when it is used.

// Replaces every `${NAME}` in `text` with the environment variable NAME. Throws, naming the variable and
// `what` needs it, when it is not set (or, with `emptyIsMissing`, empty). The message never holds a value.
export function expandEnv(text, env = process.env, what = 'the setting', { emptyIsMissing = false } = {}) {
  return String(text).replace(/\$\{([A-Z0-9_]+)\}/gi, (_m, name) => {
    if (env[name] == null || (emptyIsMissing && env[name] === '')) throw new Error(`${what} needs the environment variable ${name}, which is not set`);
    return env[name];
  });
}

// The value of a secret setting, or null when it is absent or names a variable that is not set.
export function secretSetting(value, env = process.env) {
  if (value == null || value === '') return null;
  try {
    return expandEnv(value, env) || null;
  } catch {
    return null;
  }
}
