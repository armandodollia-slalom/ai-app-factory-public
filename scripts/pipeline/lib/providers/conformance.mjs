// The conformance suite of an adapter: every operation of its contract (contracts.mjs), exercised against the live
// service, read-mostly. `factory adapter check <kind>` runs it on the configured adapter; the tests run the same suite
// against a fake server of every built-in and against the custom adapter's sample script.
//
//   read  (default)  only reads: what each read operation returns is checked for the contract's shape; operations the
//                    adapter does not have are failures, ones it declares unsupported are reported with the capability
//                    the harness then degrades by.
//   write (--write)  also creates one test item and cleans it up: a ticket (commented, labelled, moved, closed and
//                    archived where the board can), a branch and a draft pull request (commented, a status posted on its
//                    head, then closed and the branch deleted). Only with the person's agreement.
//
// Returns { kind, type, results: [{ op, status: pass|fail|unsupported|skipped, detail, ms }], summary }.
import { CAPABILITIES, CONTRACTS, resolveOp } from './contracts.mjs';

const isUnsupported = (e) => e?.name === 'UnsupportedError' || e?.unsupported === true;
const short = (v) => {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return String(s ?? '').replace(/\s+/g, ' ').slice(0, 120);
};

// Shape checks of the contract's normalised values.
const SHAPES = {
  pr: (p) => p && Number.isFinite(Number(p.number)) && ['open', 'merged', 'closed'].includes(p.state) && 'headSha' in p && 'head' in p && 'base' in p,
  ticket: (t) => t && t.id != null && ['open', 'closed'].includes(t.state) && typeof t.title === 'string',
  run: (r) => r && r.id != null && ['queued', 'running', 'completed'].includes(r.status),
  check: (c) => c && typeof c.name === 'string' && ['pending', 'completed'].includes(c.status),
  review: (r) => r && ['approved', 'changes_requested', 'commented', 'dismissed', 'pending'].includes(r.state),
};

export async function conformance(kind, adapter, { write = false, log = () => {}, fixture = {}, git = null } = {}) {
  const results = [];
  const ctx = {};
  const record = (op, status, detail, ms = 0) => {
    results.push({ op, status, detail: short(detail), ms });
    log(`${status.padEnd(11)} ${op}${detail ? `: ${short(detail)}` : ''}`);
  };
  // Runs one operation; `expect(value)` returns true or a reason. A missing function fails; UnsupportedError reports the
  // capability the contract names.
  async function step(op, args = [], { expect = () => true, need = null, quiet = false } = {}) {
    if (need && !need()) return record(op, 'skipped', typeof need.why === 'string' ? need.why : 'needs an earlier result');
    const def = CONTRACTS[kind].find((o) => o.id === op);
    const fn = resolveOp(adapter, op);
    if (!fn) return record(op, def?.capability ? 'unsupported' : 'fail', def?.capability ? `not implemented (capability ${def.capability}: ${CAPABILITIES[kind][def.capability]?.degrade ?? ''})` : 'the adapter has no such operation');
    const t0 = Date.now();
    try {
      const value = await fn.fn.apply(fn.owner, args);
      const ok = expect(value);
      if (ok === true) record(op, 'pass', quiet ? '' : value, Date.now() - t0);
      else record(op, 'fail', typeof ok === 'string' ? ok : `unexpected answer: ${short(value)}`, Date.now() - t0);
      return value;
    } catch (error) {
      if (isUnsupported(error)) record(op, 'unsupported', `${error.message}${def?.capability ? ` (capability ${def.capability})` : ''}`, Date.now() - t0);
      else record(op, 'fail', error.message, Date.now() - t0);
      return undefined;
    }
  }
  const arr = (v) => Array.isArray(v) || 'not a list';

  if (kind === 'host') {
    await step('identity', [], { expect: (v) => Boolean(v && (v.login || v.id)) || 'no login or id' });
    ctx.branch = await step('repo.defaultBranch', [], { expect: (v) => (typeof v === 'string' && v.length > 0) || 'no branch' });
    await step('repo.list', ['.', ctx.branch], { expect: (v) => v === null || arr(v), need: () => ctx.branch });
    await step('repo.file', [fixture.file ?? 'README.md', ctx.branch], { expect: (v) => v === null || typeof v === 'string', need: () => ctx.branch });
    await step('repo.permissions', [], { expect: (v) => Boolean(v && 'push' in v) || 'no push flag' });
    await step('repo.branchProtection', [ctx.branch], { expect: (v) => v === null || typeof v === 'object', need: () => ctx.branch });
    await step('repo.settings', [], { expect: (v) => Boolean(v && 'autoMergeAllowed' in v) || 'no autoMergeAllowed' });
    await step('repo.enforceReviewGate', [{ dryRun: true, codeOwners: false }], { expect: (v) => Boolean(v?.action) || 'no action', quiet: true });
    const prs = await step('pr.list', [{ state: 'all', limit: 5 }], { expect: (v) => arr(v) === true && v.every(SHAPES.pr) ? true : 'not a list of pull requests', quiet: true });
    ctx.pr = fixture.pr ?? prs?.[0]?.number ?? null;
    const has = Object.assign(() => ctx.pr != null, { why: 'the repository has no pull request to read' });
    const got = await step('pr.get', [ctx.pr], { expect: (v) => SHAPES.pr(v) || 'not a pull request', need: has, quiet: true });
    ctx.head = got?.headSha;
    await step('pr.comments', [ctx.pr], { expect: arr, need: has, quiet: true });
    await step('pr.reviews', [ctx.pr], { expect: (v) => (Array.isArray(v) && v.every(SHAPES.review)) || 'not a list of reviews', need: has, quiet: true });
    await step('pr.reviewComments', [ctx.pr], { expect: arr, need: has, quiet: true });
    await step('pr.commits', [ctx.pr], { expect: (v) => (Array.isArray(v) && v.every((c) => c.sha)) || 'commits without sha', need: has, quiet: true });
    await step('pr.files', [ctx.pr], { expect: (v) => (Array.isArray(v) && v.every((f) => f.path)) || 'files without path', need: has, quiet: true });
    await step('pr.diff', [ctx.pr], { expect: (v) => typeof v === 'string' || 'not text', need: has, quiet: true });
    await step('pr.checks', [ctx.pr], { expect: (v) => v == null || (Array.isArray(v) && v.every(SHAPES.check)) || 'not a list of checks', need: has, quiet: true });
    await step('pr.mergeState', [ctx.pr, { tries: 1 }], { expect: (v) => Boolean(v && ['open', 'merged', 'closed'].includes(v.state) && v.mergeState) || 'no state', need: has });
    await step('pr.autoMergeArmed', [ctx.pr], { expect: (v) => v == null || typeof v === 'boolean', need: has });
    await step('issues.search', [{ text: 'factory', state: 'open' }], { expect: arr, quiet: true });
    if (write) {
      const branch = `factory-conformance-${Date.now()}`;
      const pushed = git ? git.pushBranch(branch) : false;
      const opened = await step('pr.open', [{ head: branch, base: ctx.branch, title: 'factory adapter check (closed automatically)', body: 'Opened by `factory adapter check host --write`; it is closed and its branch deleted by the same run.', draft: true }], { expect: (v) => SHAPES.pr(v) || 'not a pull request', need: Object.assign(() => pushed, { why: 'the test branch could not be pushed' }), quiet: true });
      const n = opened?.number;
      const open = Object.assign(() => n != null, { why: 'no test pull request' });
      await step('pr.comment', [n, 'factory adapter check: comment <!-- factory-conformance -->', { marker: '<!-- factory-conformance -->' }], { need: open, quiet: true });
      await step('pr.comment', [n, 'factory adapter check: edited in place <!-- factory-conformance -->', { marker: '<!-- factory-conformance -->' }], { need: open, quiet: true });
      await step('pr.update', [n, { body: 'factory adapter check: body updated.' }], { need: open, quiet: true });
      await step('repo.ensureLabel', ['factory-conformance', { color: 'ededed', description: 'factory adapter check' }], { quiet: true });
      let headNow;
      try {
        const g = resolveOp(adapter, 'pr.get');
        headNow = n != null && g ? (await g.fn.apply(g.owner, [n]))?.headSha ?? null : null;
      } catch {
        headNow = null;
      }
      await step('pr.setStatus', [headNow ?? git?.head?.(), { name: 'factory-conformance', state: 'success', description: 'factory adapter check' }], { need: open, quiet: true });
      await step('pr.requestReviewers', [n, []], { need: open, quiet: true });
      await step('pr.close', [n, { comment: 'factory adapter check done; closing.' }], { need: open, quiet: true });
      if (pushed) git.deleteBranch(branch);
    }
    for (const op of ['pr.merge', 'pr.cancelAutoMerge', 'pr.uploadAttachment', 'issues.create', 'repo.enforceReviewGate']) if (!results.some((r) => r.op === op)) record(op, 'skipped', op === 'pr.merge' ? 'never merged by a check (the review gate exercises it)' : 'not exercised by a check (it changes the repository)');
  }

  if (kind === 'tracker') {
    await step('reachable', [], { expect: (v) => v?.ok === true || `not reachable: ${v?.reason}` });
    await step('identity', [], { expect: (v) => Boolean(v && (v.login || v.id)) || 'no login' });
    await step('active', [], { expect: (v) => typeof v === 'boolean' || 'not a boolean' });
    await step('available', [], { expect: (v) => typeof v === 'boolean' || 'not a boolean' });
    await step('board.lanes', [], { expect: (v) => (Array.isArray(v) && v.length === 7) || 'not the seven lanes' });
    const list = await step('tickets.list', [{ state: 'all' }], { expect: (v) => (Array.isArray(v) && v.every(SHAPES.ticket)) || 'not a list of tickets', quiet: true });
    ctx.ticket = fixture.ticket ?? list?.[0]?.id ?? null;
    const has = Object.assign(() => ctx.ticket != null, { why: 'the board has no ticket to read' });
    const tk = await step('tickets.get', [ctx.ticket], { expect: (v) => SHAPES.ticket(v) || 'not a ticket', need: has, quiet: true });
    await step('tickets.search', [{ text: String(tk?.title ?? 'factory').split(/\s+/)[0], state: 'all' }], { expect: arr, quiet: true });
    await step('tickets.comments', [ctx.ticket], { expect: arr, need: has, quiet: true });
    await step('tickets.children', [ctx.ticket], { expect: arr, need: has, quiet: true });
    await step('tickets.parent', [ctx.ticket], { expect: (v) => v === null || SHAPES.ticket(v), need: has, quiet: true });
    await step('tickets.attachments', [ctx.ticket], { expect: arr, need: has, quiet: true });
    await step('tickets.history', [ctx.ticket], { expect: arr, need: has, quiet: true });
    await step('board.lane', [ctx.ticket], { need: has });
    await step('board.items', [{ repoScoped: true }], { expect: arr, quiet: true });
    await step('board.fields.get', [ctx.ticket], { expect: (v) => v == null || typeof v === 'object', need: has });
    await step('format.parse', [tk ?? { body: '', title: '', key: 'X-1' }], { expect: (v) => typeof v?.content === 'string' || v?.legacy === true || v?.spilled != null || 'no content, and not a legacy or spilled body', quiet: true });
    await step('board.setup', [{ dryRun: true }], { expect: (v) => Boolean(v && Array.isArray(v.done) && Array.isArray(v.manual)) || 'no { done, manual }', quiet: true });
    await step('board.fields.ensure', [{ dryRun: true }], { expect: arr, quiet: true });
    if (write) {
      const created = await step('tickets.create', [{ type: 'story', title: 'factory adapter check (closed automatically)', body: 'Created by `factory adapter check tracker --write`; the same run closes it.' }], { expect: (v) => SHAPES.ticket(v) || 'not a ticket', quiet: true });
      const id = created?.id;
      const made = Object.assign(() => id != null, { why: 'no test ticket' });
      await step('tickets.comment', [id, 'factory adapter check <!-- factory-conformance -->', { marker: '<!-- factory-conformance -->' }], { need: made, quiet: true });
      await step('tickets.comment', [id, 'factory adapter check, edited <!-- factory-conformance -->', { marker: '<!-- factory-conformance -->' }], { need: made, quiet: true });
      await step('tickets.update', [id, { title: 'factory adapter check (closing)' }], { need: made, quiet: true });
      await step('tickets.link', [id, { url: 'https://example.invalid/pull/1', title: 'factory adapter check link' }], { need: made, quiet: true });
      await step('board.move', [id, 'ready'], { need: made, quiet: true });
      await step('board.move', [id, 'backlog'], { need: made, quiet: true });
      await step('tickets.update', [id, { state: 'closed' }], { need: made, quiet: true });
    }
    if (tk?.key) await step('tickets.find', [tk.key], { expect: (v) => v === null || v?.number != null || 'no number' });
    for (const o of CONTRACTS.tracker) if (!results.some((r) => r.op === o.id)) record(o.id, 'skipped', o.mode === 'read' ? 'a read the check does not make (it needs a file, a person\'s ticket or a card)' : write ? 'not exercised (it would change a ticket that is not the check\'s own)' : 'a write: run with --write');
  }

  if (kind === 'ci') {
    const target = fixture.head ? fixture : null;
    const has = Object.assign(() => Boolean(target?.head), { why: 'needs a head commit (fixture, or the latest pull request of the host)' });
    await step('expected', [{ head: target?.head, base: target?.base ?? 'main', changed: target?.changed ?? [], pr: target?.pr ?? null, branch: target?.branch ?? null, settings: {} }], { expect: (v) => (Array.isArray(v) && v.every((w) => (w.id ?? w.path) && w.name)) || 'not a list of pipelines', need: has });
    // The two modes the evidence relies on (council C10, round C16): what a replacement head owes (activities), and what a
    // push of a story branch runs before its PR exists (mode push, with the adapter's branchPipelines capability).
    for (const [label, extra] of [['expected (replacement head)', { mode: 'pr', activities: ['synchronize'] }], ...(adapter?.capabilities?.branchPipelines ? [['expected (branch push)', { mode: 'push', branch: target?.branch ?? 'feat/conformance' }]] : [])]) {
      if (!has()) {
        record(label, 'skipped', has.why);
        continue;
      }
      const t0 = Date.now();
      try {
        const v = await adapter.expected({ head: target.head, base: target.base ?? 'main', changed: target.changed ?? [], pr: extra.mode === 'push' ? null : target.pr ?? null, settings: {}, ...extra, branch: extra.branch ?? target.branch ?? null });
        const okList = Array.isArray(v) && v.every((w) => (w.id ?? w.path) && w.name && typeof w.required === 'boolean');
        record(label, okList ? 'pass' : 'fail', okList ? `${v.filter((w) => w.required).length} owed${v.some((w) => w.prOnly) ? `, ${v.filter((w) => w.prOnly).length} only on a PR` : ''}` : 'not a list of pipelines with a boolean `required`', Date.now() - t0);
      } catch (error) {
        record(label, isUnsupported(error) ? 'unsupported' : 'fail', error.message, Date.now() - t0);
      }
    }
    const runs = await step('runs', [{ head: target?.head, branch: target?.branch ?? null, pr: target?.pr ?? null }], { expect: (v) => (Array.isArray(v) && v.every(SHAPES.run)) || 'not a list of runs', need: has, quiet: true });
    const id = fixture.runId ?? runs?.[0]?.id;
    await step('log', [id, { failedOnly: false }], { expect: (v) => typeof v === 'string' || 'not text', need: Object.assign(() => id != null, { why: 'no run to read' }), quiet: true });
    await step('requiredChecks', [fixture.root ?? process.cwd()], { expect: arr });
    record('rerun', 'skipped', 'not exercised by a check (it starts a pipeline)');
  }

  if (kind === 'scanner') {
    await step('checkName', [], { expect: (v) => v == null || typeof v === 'string' });
    await step('result', [{ head: fixture.head, pr: fixture.pr ?? null, branch: fixture.branch ?? null }], { expect: (v) => Boolean(v && ['pending', 'complete', 'failed'].includes(v.status) && Array.isArray(v.findings ?? [])) || 'no { status, findings }', need: Object.assign(() => Boolean(fixture.head), { why: 'needs a head commit' }), quiet: true });
  }

  const count = (s) => results.filter((r) => r.status === s).length;
  const summary = { pass: count('pass'), fail: count('fail'), unsupported: count('unsupported'), skipped: count('skipped') };
  return { kind, type: adapter?.type ?? null, label: adapter?.label ?? null, results, summary, ok: summary.fail === 0 };
}

export function formatReport(r) {
  const lines = [`${r.label ?? r.type} (${r.kind}): ${r.summary.pass} pass, ${r.summary.fail} fail, ${r.summary.unsupported} unsupported, ${r.summary.skipped} skipped`];
  for (const x of r.results) lines.push(`  ${x.status.padEnd(11)} ${x.op}${x.detail ? `  ${x.detail}` : ''}`);
  return lines.join('\n');
}
