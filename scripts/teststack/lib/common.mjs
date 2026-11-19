// Shared pieces of the test stack CLI: exit codes, the error type that carries one, logging and arguments.

/** Process exit codes. Stable, so agents can branch on them. */
export const EXIT = Object.freeze({ ok: 0, error: 1, notReady: 2, invalidScenario: 3, usage: 64 });

export class TestStackError extends Error {
  constructor(message, exitCode = EXIT.error, extra = {}) {
    super(message);
    this.exitCode = exitCode;
    this.extra = extra;
  }
}

export const usage = message => new TestStackError(message, EXIT.usage);

/** Progress goes to stderr; stdout carries exactly one JSON result line. */
export const log = message => process.stderr.write(`[teststack] ${message}\n`);

const VALUE_OPTIONS = new Set(['timeout', 'scenario', 'base', 'services', 'slot', 'root']);

/** Splits arguments into positionals and --options (`--name value` for value options, `--name=value` for any). */
export function parseArgs(args, valueOptions = VALUE_OPTIONS) {
  const options = {};
  const positionals = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith('--')) { positionals.push(arg); continue; }
    const eq = arg.indexOf('=');
    const name = eq < 0 ? arg.slice(2) : arg.slice(2, eq);
    if (eq >= 0) options[name] = arg.slice(eq + 1);
    else if (valueOptions.has(name)) {
      if (i + 1 >= args.length) throw usage(`--${name} requires a value.`);
      options[name] = args[++i];
    } else options[name] = true;
  }
  return { positionals, options };
}

export function intOption(options, name, fallback) {
  if (options[name] === undefined) return fallback;
  if (!/^\d+$/.test(String(options[name]))) throw usage(`--${name} expects an integer, got '${options[name]}'.`);
  return Number(options[name]);
}

/** Quotes an SQL identifier, keeping its case ("Order" -> "\"Order\""). */
export const quoteIdent = (identifier, quote = '"') => quote + String(identifier).replaceAll(quote, quote + quote) + quote;

/** `table` or `schema.table` as a quoted, case-preserving name; throws `invalid(message)` on anything else. */
export function qualifiedName(name, { quote = '"', invalid = message => new TestStackError(message, EXIT.invalidScenario) } = {}) {
  const parts = String(name).split('.');
  if (parts.length > 2 || parts.some(part => !part.trim())) throw invalid(`invalid table name '${name}'. Use 'Table' or 'schema.Table'.`);
  return parts.map(part => quoteIdent(part, quote)).join('.');
}

/** A single-quoted SQL string literal. */
export const sqlString = value => `'${String(value).replaceAll("'", "''")}'`;

export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
