// Commercial scanners in server mode (analysis.commercial with mode "server"): the scan runs in the vendor's service or
// the client's CI, and the review gate reads its result for the pull request's head. The scanner's check on the host
// joins the expected evidence of every head, so an asynchronous result never lets a merge through early:
//   - the check not registered on the head yet, or still running      -> pending
//   - no result within analysis.commercial.timeoutMin of first asking -> failure (fail closed, said why)
//   - the check red, the vendor's own gate failed, or a finding the severity map rates blocking and nobody triaged in
//     the vendor's system                                              -> failure
//   - a read that fails                                                -> unknown (never green)
//
//   scannersFor(config, deps) -> [adapter]        scannerFor(config, deps) -> the first (factory adapter check scanner)
//   scannerEvidence(scanner, { head, pr, branch, checks, config, now }) -> { state, name, detail, findings, triaged }
//
// Adapters (contracts.mjs `scanner`): { type, label, capabilities, checkName(), result({ head, pr, branch }) ->
// { status pending|complete|failed, gate pass|fail|null, url, findings: [{ rule, severity, level, path, line, message,
// cwe, fingerprint, triage }] } }.
import fs from 'node:fs';
import path from 'node:path';
import { resolveAnalysis } from '../config.mjs';
import { cweOf, normalizeVendorSeverity, severityOf } from '../commercial.mjs';
import { createCheckOnly } from './check-only.mjs';
import { createGithubCodeScanning } from './github-code-scanning.mjs';
import { createSemgrep } from './semgrep.mjs';
import { createSonarqube } from './sonarqube.mjs';
import { createCustomAdapter } from '../../providers/custom.mjs';

// A client's own scanner in server mode: analysis.tools.<id>.commercial.server = { adapter: "custom", command, env,
// timeoutSec } runs the scanner contract's operations (result, checkName) through the custom adapter protocol
// (docs/providers/custom.md); the check name the settings give wins over the script's.
const createCustomScanner = (s, deps) => {
  const a = createCustomAdapter('scanner', { ...s.server, label: s.server?.label ?? `${s.vendor ?? s.scanner} (custom)`, root: s.root }, deps);
  const own = a.checkName;
  a.checkName = () => s.check ?? own() ?? null;
  return a;
};

export const SCANNER_ADAPTERS = { sonarqube: createSonarqube, 'github-code-scanning': createGithubCodeScanning, semgrep: createSemgrep, 'check-only': createCheckOnly, custom: createCustomScanner };

export function scannersFor(config, deps = {}) {
  let resolved;
  try {
    resolved = deps.resolved ?? resolveAnalysis(config);
  } catch {
    return [];
  }
  const out = [];
  for (const e of resolved?.commercial ?? []) {
    if (e.mode !== 'server') continue;
    const def = e.tool ?? resolved.allTools?.get(e.scanner);
    const c = def?.commercial ?? {};
    const create = SCANNER_ADAPTERS[c.server?.adapter ?? 'check-only'] ?? createCheckOnly;
    const raw = config.analysis?.commercial;
    const own = (Array.isArray(raw) ? raw : [raw]).find((x) => x?.scanner === e.scanner) ?? {};
    const s = { scanner: e.scanner, vendor: c.vendor, check: e.check ?? c.check ?? null, token: e.token, url: e.url ?? c.server?.url ?? null, project: e.project, deployment: own.deployment ?? null, refTemplate: own.refTemplate ?? null, toolName: own.toolName ?? null, repo: config.host?.repo ?? config.board?.repo ?? deps.repo ?? null, timeoutMin: e.timeoutMin, server: c.server ?? null, root: config.root ?? null };
    const adapter = create(s, deps);
    out.push(Object.assign(adapter, { id: e.scanner, settings: s, tool: def ?? { severity: null }, blocked: e.blocked ?? null }));
  }
  return out;
}

export function scannerFor(config, deps = {}) {
  const list = scannersFor(config, deps);
  if (!list.length) throw Object.assign(new Error('no commercial scanner in server mode is configured (analysis.commercial with "mode": "server")'), { code: 'config' });
  return list[0];
}

const RED = new Set(['failure', 'cancelled', 'timed_out', 'action_required', 'error']);
const matchesCheck = (name, want) => {
  const a = String(name ?? '').toLowerCase();
  const b = String(want).toLowerCase();
  return a === b || a.startsWith(`${b} `) || a.startsWith(`${b}/`) || a.startsWith(`${b}:`) || a.startsWith(`${b} (`);
};

// When the gate first asked for a scanner's result of a head (kept under the state dir), for the timeout.
function firstAsked(config, id, head, now) {
  const dir = path.join(config?.mainRoot ?? config?.root ?? '.', config?.stateDir ?? '.factory/state', 'scanners');
  const file = path.join(dir, `${id}-${head}.json`);
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')).since;
  } catch {
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ since: now }));
    } catch {
      /* read-only checkout: the timeout counts from now on every read, the CI wait's own deadline still applies */
    }
    return now;
  }
}

// One scanner's evidence for a head. `checks`: the host's checks of the head ([{ name, status, conclusion }]).
export function scannerEvidence(scanner, { head, pr = null, branch = null, checks = [], config = null, now = Date.now() } = {}) {
  const name = `${scanner.settings?.vendor ?? scanner.label} (${scanner.id})`;
  const out = (state, detail, extra = {}) => ({ state, name, detail, findings: [], triaged: [], ...extra });
  if (scanner.blocked) return out('failure', `${scanner.id} cannot run: ${scanner.blocked}`);
  const check = scanner.checkName?.() ?? null;
  // A result that is not bound to a commit needs the vendor's check on the head; without one nothing proves the result
  // is of this head, and the gate never calls it green.
  if (!check && !scanner.capabilities?.shaBound) return out('unknown', `${scanner.id}: its result is not bound to a commit and no check name is configured (analysis.commercial.check)`);
  const timeoutMin = scanner.settings?.timeoutMin ?? 60;
  const pending = (why) => {
    const since = firstAsked(config, scanner.id, head, now);
    if (now - since > timeoutMin * 60_000) return out('failure', `${scanner.id}: no result for ${String(head).slice(0, 7)} within ${timeoutMin} min (${why})`);
    return out('pending', `${scanner.id}: ${why}`);
  };
  if (check) {
    const mine = (checks ?? []).filter((c) => matchesCheck(c.name, check));
    if (!mine.length) return pending(`waiting for the "${check}" check on ${String(head).slice(0, 7)}`);
    if (mine.some((c) => c.status === 'completed' && RED.has(c.conclusion))) return out('failure', `${scanner.id}: the "${check}" check failed on ${String(head).slice(0, 7)}`, { url: mine.find((c) => c.url)?.url ?? null });
    if (mine.some((c) => c.status !== 'completed')) return pending(`the "${check}" check is running on ${String(head).slice(0, 7)}`);
  }
  let r;
  try {
    r = scanner.result({ head, pr, branch });
  } catch (error) {
    return out('unknown', `${scanner.id}: the result could not be read: ${String(error?.message ?? error).split('\n')[0]}`);
  }
  if (!r || r.status === 'pending') return pending(r?.note ?? 'the scan of this head has no result yet');
  if (r.status === 'failed') return out('failure', `${scanner.id}: the scan failed${r.note ? ` (${r.note})` : ''}`, { url: r.url ?? null });
  if (r.commit && r.commit !== head && scanner.capabilities?.shaBound) return pending(`the latest result is of ${String(r.commit).slice(0, 7)}, not the head`);
  const all = (r.findings ?? []).map((f) => {
    const vendorSeverity = normalizeVendorSeverity(f.severity);
    const g = { rule: f.rule, level: f.level ?? 'warning', file: f.path ?? null, line: f.line ?? null, message: f.message ?? f.rule, vendorSeverity, cwe: cweOf(f.cwe), vendorFingerprint: f.fingerprint ?? null, tool: scanner.id };
    return { ...g, severity: severityOf(scanner.tool, g), triage: f.triage && f.triage !== 'open' ? f.triage : null };
  });
  const triaged = all.filter((f) => f.triage && f.triage !== 'fixed');
  const open = all.filter((f) => !f.triage);
  const blocking = open.filter((f) => f.severity === 'blocking');
  if (r.gate === 'fail') return out('failure', `${scanner.id}: the vendor's quality gate failed`, { findings: open, triaged, url: r.url ?? null });
  if (blocking.length) return out('failure', `${scanner.id}: ${blocking.length} blocking finding(s) (${blocking.slice(0, 3).map((f) => `${f.rule} ${f.file ?? ''}${f.line ? `:${f.line}` : ''}`).join(', ')})`, { findings: open, triaged, url: r.url ?? null });
  return out('success', `${scanner.id}: ${open.length} open finding(s), none blocking${triaged.length ? `; ${triaged.length} triaged in the vendor's system` : ''}`, { findings: open, triaged, url: r.url ?? null });
}
