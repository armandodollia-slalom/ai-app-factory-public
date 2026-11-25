// One-time migration of the legacy story folder (config.tickets.legacyDir) to the board:
//
//   board migrate                 dry run: where every file goes (issue, asset, ignored, unplaced)
//   board migrate --apply         GitHub writes: assets branch, issues, labels, sub-issues (idempotent)
//   board migrate --verify        fetch every ticket into a temp cache, compare with the files
//   board migrate --delete-local  after a passing verify of the current files: git rm the folder and
//                                 drop every reference to it
//
// Reports go to .factory/state/board/migration-report.{json,md}. See docs/ai-pipeline/board.md#migration.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { escapeRe, nowIso, readJson, writeJson } from '../../pipeline/lib/util.mjs';
import { buildAssetsCommit, exec, pushAssetsBranch } from './assets.mjs';
import { storyKind } from './board.mjs';
import { classifyLegacy, folderFingerprint, legacyRoot } from './legacy.mjs';
import { fetchTickets, issueIndex, ticketsRoot } from './source.mjs';
import { BODY_LIMIT, renderBody, sha256 } from './ticket-format.mjs';
import { trackerFor } from './trackers/index.mjs';
import { setting } from '../../pipeline/lib/settings.mjs';

// A tracker runner tests inject (a fake gh); null: the configured tracker as it is.
const defaultGh = null;
const PLACEHOLDER_SHA = '0'.repeat(40);
const reportBase = (config) => path.join(ticketsRoot(config), 'migration-report');
export const STORY_FOOTER = (config) => {
  return `Assign this issue to yourself and move it to **${setting(config, 'board.columns.ready')}** when it is ready for implementation (cards in **${setting(config, 'board.columns.backlog')}** are never picked up); the pipeline fetches the story from this issue.`;
};

export function labelsFor(config, t) {
  if (t.type === 'epic') return [setting(config, 'board.epicLabel')];
  if (t.type === 'spike') return [setting(config, 'board.spikeLabel')];
  const kind = storyKind(t.text);
  return [setting(config, 'board.storyLabel'), t.type === 'bug' ? 'bug' : 'enhancement', ...(kind === 'ui' ? ['frontend'] : kind === 'api' ? ['backend'] : [])];
}


// The dry-run plan. `index`: key -> issue (from the board), or null when offline.
export function planMigration(config, { gh = defaultGh, index = undefined } = {}) {
  const root = legacyRoot(config);
  const legacy = classifyLegacy(config, root);
  let map = index;
  let offline = null;
  if (map === undefined) {
    try {
      map = issueIndex(config, { gh });
    } catch (error) {
      map = null;
      offline = error.message;
    }
  }
  const tickets = legacy.tickets.map((t) => {
    const issue = map?.get(t.key) ?? null;
    const { body, spilled } = renderBody(t, t.text, { assets: manifestOf(config, t, PLACEHOLDER_SHA), footer: ['story', 'bug'].includes(t.type) ? STORY_FOOTER(config) : '' });
    return {
      key: t.key,
      type: t.type,
      title: t.title,
      source: t.source,
      generated: Boolean(t.generated),
      parent: t.parent,
      blockedBy: t.blockedBy,
      labels: labelsFor(config, t),
      issue: issue ? issue.number : map ? 'create' : 'unknown',
      assets: t.assets.length,
      bodyChars: body.length,
      spilled,
    };
  });
  const entries = [];
  for (const t of legacy.tickets) {
    const issue = tickets.find((x) => x.key === t.key).issue;
    if (t.source) entries.push({ source: t.source, kind: 'ticket', ticket: t.key, type: t.type, issue });
    for (const a of t.assets) entries.push({ source: a.source, kind: 'asset', ticket: t.key, issue, assetPath: a.path, sha256: a.sha256 });
  }
  for (const f of legacy.ignored) entries.push({ source: f, kind: 'ignored', reason: 'operating-system clutter' });
  for (const u of legacy.unplaced) entries.push({ source: u.source, kind: 'unplaced', reason: u.reason });
  entries.sort((a, b) => a.source.localeCompare(b.source));
  const count = (pred) => entries.filter(pred).length;
  return {
    generatedAt: nowIso(),
    repo: config.tickets.repo,
    legacyDir: config.tickets.legacyDir ?? null,
    present: Boolean(root),
    offline,
    fingerprint: root ? folderFingerprint(root, legacy.files) : null,
    tickets,
    entries,
    counts: {
      files: legacy.files.length,
      tickets: tickets.length,
      byType: Object.fromEntries(['story', 'bug', 'epic', 'spike'].map((type) => [type, tickets.filter((t) => t.type === type).length])),
      existingIssues: tickets.filter((t) => typeof t.issue === 'number').length,
      issuesToCreate: tickets.filter((t) => t.issue === 'create').length,
      generatedTickets: tickets.filter((t) => t.generated).length,
      ticketFiles: count((e) => e.kind === 'ticket'),
      assets: count((e) => e.kind === 'asset'),
      ignored: count((e) => e.kind === 'ignored'),
      unplaced: count((e) => e.kind === 'unplaced'),
      spilled: tickets.filter((t) => t.spilled).length,
      maxBodyChars: Math.max(0, ...tickets.map((t) => t.bodyChars)),
    },
  };
}

function manifestOf(config, t, commit) {
  return {
    repo: config.tickets.repo,
    branch: config.tickets.assetsBranch,
    commit,
    files: t.assets.map(({ path: p, name, kind, sha256: h, size }) => ({ path: p, name, kind, sha256: h, size })),
  };
}

export function formatPlan(plan, { summary = false } = {}) {
  const c = plan.counts;
  const lines = [
    `# Board migration ${plan.present ? 'plan' : '(nothing to migrate)'}`,
    '',
    `- Repository: ${plan.repo}`,
    `- Legacy folder: ${plan.legacyDir ?? '(not configured)'}${plan.present ? '' : ' (absent)'}`,
    plan.offline ? `- Board unreachable, issue numbers unknown: ${plan.offline.split('\n')[0]}` : null,
    `- Files: ${c.files} (ticket sources ${c.ticketFiles}, assets ${c.assets}, ignored ${c.ignored}, unplaced ${c.unplaced})`,
    `- Tickets: ${c.tickets} (stories ${c.byType.story}, bugs ${c.byType.bug}, epics ${c.byType.epic}, spikes ${c.byType.spike}; generated ${c.generatedTickets})`,
    `- Issues: ${c.existingIssues} existing, ${c.issuesToCreate} to create`,
    `- Bodies: largest ${c.maxBodyChars} of ${BODY_LIMIT} characters; ${c.spilled} spilled to an asset`,
  ].filter((l) => l !== null);
  if (summary) return lines.join('\n');
  lines.push('', '## Tickets', '', '| Key | Type | Issue | Parent | Assets | Body chars |', '| --- | --- | --- | --- | --- | --- |');
  for (const t of plan.tickets) lines.push(`| ${t.key} | ${t.type}${t.generated ? ' (generated)' : ''} | ${typeof t.issue === 'number' ? `#${t.issue}` : t.issue} | ${t.parent ?? ''} | ${t.assets} | ${t.bodyChars}${t.spilled ? ' (spilled)' : ''} |`);
  lines.push('', '## Files', '', '| File | Goes to |', '| --- | --- |');
  for (const e of plan.entries) {
    const to = e.kind === 'ticket' ? `${e.type} ${e.ticket} (${typeof e.issue === 'number' ? `#${e.issue}` : e.issue})` : e.kind === 'asset' ? `asset \`${e.assetPath}\` of ${e.ticket}` : `**${e.kind}**: ${e.reason}`;
    lines.push(`| \`${e.source}\` | ${to} |`);
  }
  return lines.join('\n');
}

export function writeReport(config, name, data, markdown) {
  const base = `${reportBase(config)}${name ? `-${name}` : ''}`;
  writeJson(`${base}.json`, data);
  fs.writeFileSync(`${base}.md`, `${markdown}\n`);
  return `${base}.md`;
}

// ---------------------------------------------------------------------------------------------
// Apply: assets branch, then epics, spikes and stories (create or update), labels, sub-issues
// ---------------------------------------------------------------------------------------------

const trackerOf = (config, gh) => (gh ? trackerFor(config, { gh }) : trackerFor(config));
const ensureSubIssue = (config, gh, parent, child) => trackerOf(config, gh).tickets.setParent(child, parent);

const norm = (s) => String(s ?? '').replace(/\r\n/g, '\n').trimEnd();

// Renders every ticket's body against the asset commit; returns { rendered, spills }.
function renderAll(config, legacy, commit, numbers) {
  const rendered = new Map();
  for (const t of legacy.tickets) {
    const links = Object.fromEntries([t.parent, ...t.blockedBy].filter((k) => k && numbers.has(k)).map((k) => [k, numbers.get(k)]));
    rendered.set(t.key, renderBody(t, t.text, { assets: manifestOf(config, t, commit), links, footer: ['story', 'bug'].includes(t.type) ? STORY_FOOTER(config) : '' }));
  }
  return rendered;
}

// The board's issue numbers by key, and the legacy tickets in the order a migration applies them: epics first, then
// spikes, then stories, so parents and blockers have numbers for links.
function migrationOrder(config, legacy, opts) {
  const index = issueIndex(config, opts);
  const order = (t) => ({ epic: 0, spike: 1 })[t.type] ?? 2;
  return { numbers: new Map([...index.entries()].map(([k, i]) => [k, i.number])), tickets: [...legacy.tickets].sort((a, b) => order(a) - order(b)) };
}

export function applyMigration(config, { gh = defaultGh, run = exec, log = () => {}, push = true } = {}) {
  const root = legacyRoot(config);
  if (!root) throw new Error(`nothing to migrate: ${config.tickets.legacyDir ?? 'tickets.legacyDir'} does not exist`);
  const legacy = classifyLegacy(config, root);
  const tr = trackerOf(config, gh);
  // A tracker with its own body codec gets the tickets through its API; the block format with an assets branch otherwise.
  if (!tr.traits?.blockBody) return applyToTracker(config, tr, legacy, root, { log });
  const spillPath = (t) => `files/${t.key}/${t.source ? path.posix.basename(t.source) : 'source.md'}`;

  // 1. Assets (and spilled sources) on the orphan branch.
  const draft = renderAll(config, legacy, PLACEHOLDER_SHA, new Map());
  const files = legacy.tickets.flatMap((t) => [
    ...t.assets.map((a) => ({ path: a.path, abs: path.join(root, a.source) })),
    ...(draft.get(t.key).spilled ? [{ path: spillPath(t), data: Buffer.from(t.text, 'utf8') }] : []),
  ]);
  const built = buildAssetsCommit(config, files, { message: `Board assets for ${legacy.tickets.length} tickets`, run });
  const commit = built.commit;
  if (built.changed) log(`assets: ${built.changes.length} file(s) committed to ${config.tickets.assetsBranch} (${commit.slice(0, 10)})`);
  const remote = run('git', ['ls-remote', 'origin', `refs/heads/${config.tickets.assetsBranch}`], { cwd: config.root });
  if (commit && push && remote.stdout.split(/\s/)[0] !== commit) {
    pushAssetsBranch(config, { run });
    log(`assets: pushed ${config.tickets.assetsBranch} at ${commit.slice(0, 10)}`);
  }

  // 2. Labels.
  for (const [name, color, description] of [[setting(config, 'board.spikeLabel'), 'c5def5', 'A research spike: findings that feed an epic']]) {
    try {
      tr.labels.ensure(name, { color, description });
    } catch {
      // as before: a label that cannot be created is not fatal here
    }
  }

  // 3. Issues: epics first, then spikes, then stories, so parents and blockers have numbers for links.
  const { numbers, tickets } = migrationOrder(config, legacy, { gh });
  const done = { created: [], updated: [], unchanged: [], linked: 0 };
  for (let pass = 0; pass < 2; pass++) {
    if (pass === 1 && !done.created.length) break;
    // Pass 0 creates or updates; pass 1 refreshes bodies whose links gained numbers in pass 0.
    const rendered = renderAll(config, legacy, commit ?? PLACEHOLDER_SHA, numbers);
    for (const t of tickets) {
      const { body } = rendered.get(t.key);
      const labels = labelsFor(config, t);
      const number = numbers.get(t.key);
      if (!number) {
        const created = tr.tickets.create({ type: t.type, key: t.key, title: t.title, body, labels });
        numbers.set(t.key, created.id);
        done.created.push(t.key);
        if (created.boardError) log(`${t.key}: could not add #${created.id} to project ${config.board.projectNumber} (${created.boardError}); run board setup`);
        log(`${t.key}: created #${numbers.get(t.key)}`);
        continue;
      }
      const current = tr.tickets.view(number, 'title,body,labels');
      const missing = labels.filter((l) => !(current.labels ?? []).includes(l));
      const edits = {};
      if (norm(current.body) !== norm(body)) edits.body = body;
      if (current.title !== t.title) edits.title = t.title;
      if (missing.length) edits.labels = { add: missing };
      if (!Object.keys(edits).length) {
        if (pass === 0) done.unchanged.push(t.key);
        continue;
      }
      tr.tickets.update(number, edits);
      if (!done.updated.includes(t.key) && !done.created.includes(t.key)) done.updated.push(t.key);
      done.unchanged = done.unchanged.filter((k) => k !== t.key);
      log(`${t.key}: updated #${number}`);
    }
  }
  // 4. Sub-issues: stories under their epic, spikes under the spike epic.
  for (const t of tickets.filter((x) => x.parent)) {
    if (!numbers.has(t.parent)) {
      log(`${t.key}: parent ${t.parent} has no issue; not linked`);
      continue;
    }
    if (ensureSubIssue(config, gh, numbers.get(t.parent), numbers.get(t.key))) done.linked++;
  }
  return { commit, ...done, numbers: Object.fromEntries(numbers) };
}

// The migration onto Jira or Azure Boards: no assets branch; every asset is an attachment of its ticket,
// named in the manifest. Idempotent like the GitHub path: existing tickets (found by key) are updated
// only when their text or title changed, and attachments are uploaded once.
function applyToTracker(config, tr, legacy, root, { log }) {
  const { numbers, tickets } = migrationOrder(config, legacy);
  const done = { created: [], updated: [], unchanged: [], linked: 0 };
  for (const t of tickets) {
    const files = t.assets.map((a) => ({ path: a.path, name: a.name, kind: a.kind, sha256: a.sha256, size: a.size, attachmentName: `${t.key}--${a.path.split('/').slice(2).join('--')}`, source: a.source }));
    const labels = labelsFor(config, t);
    let number = numbers.get(t.key);
    const current = number ? tr.tickets.get(number) : null;
    const have = number ? tr.tickets.attachments(number) : [];
    const assets = { tracker: tr.type, files: files.map(({ source: _source, ...f }) => ({ ...f, attachment: have.find((a) => a.name === f.attachmentName)?.id ?? null })) };
    const { body, meta } = tr.format.render(t, t.text, { assets });
    if (!number) {
      const created = tr.tickets.create({ type: t.type, key: t.key, title: t.title, body, labels, parent: t.parent ? numbers.get(t.parent) ?? null : null, meta });
      number = created.id;
      numbers.set(t.key, number);
      done.created.push(t.key);
      log(`${t.key}: created ${number}`);
    } else if (norm(current?.body) !== norm(body) || current?.title !== t.title) {
      tr.tickets.update(number, { body, title: t.title, labels: { add: labels }, meta });
      done.updated.push(t.key);
      log(`${t.key}: updated ${number}`);
    } else done.unchanged.push(t.key);
    let uploaded = false;
    for (const [i, f] of files.entries()) {
      if (assets.files[i].attachment) continue;
      assets.files[i].attachment = tr.tickets.attach(number, { name: f.attachmentName, data: fs.readFileSync(path.join(root, f.source)) }).id;
      uploaded = true;
    }
    if (uploaded) tr.tickets.update(number, { meta: { ...meta, assets } });
  }
  for (const t of tickets.filter((x) => x.parent && numbers.has(x.parent))) if (tr.tickets.setParent(numbers.get(t.key), numbers.get(t.parent))) done.linked++;
  return { commit: null, ...done, numbers: Object.fromEntries(numbers) };
}

// ---------------------------------------------------------------------------------------------
// Verify: fetch every ticket from GitHub into a temp cache and compare with the files
// ---------------------------------------------------------------------------------------------

export function verifyMigration(config, { gh = defaultGh, run = exec, allowUnplaced = false } = {}) {
  const root = legacyRoot(config);
  if (!root) throw new Error(`nothing to verify: ${config.tickets.legacyDir ?? 'tickets.legacyDir'} does not exist`);
  const legacy = classifyLegacy(config, root);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'board-verify-'));
  const tmpConfig = { ...config, tickets: { ...config.tickets, dir: tmp } };
  const diffs = [];
  const tickets = [];
  try {
    const results = fetchTickets(tmpConfig, legacy.tickets.map((t) => t.key), { refresh: true, gh, run });
    for (const t of legacy.tickets) {
      const r = results.find((x) => x.key === t.key);
      const dir = path.join(tmp, t.key);
      const row = { key: t.key, type: t.type, source: t.source, status: r.status, issue: null, content: 'missing', assets: { ok: 0, bad: 0 } };
      tickets.push(row);
      if (r.status !== 'fetched') {
        diffs.push({ key: t.key, what: 'fetch', detail: r.message ?? r.status });
        continue;
      }
      const meta = readJson(path.join(dir, 'meta.json'), {});
      row.issue = meta.issue?.number ?? null;
      if (meta.legacy) {
        diffs.push({ key: t.key, what: 'not migrated', detail: `#${row.issue} has no board-ticket metadata block` });
        continue;
      }
      const got = fs.readFileSync(path.join(dir, 'story.md'));
      const want = Buffer.from(t.text, 'utf8');
      row.content = got.equals(want) ? 'ok' : 'different';
      if (!got.equals(want)) diffs.push({ key: t.key, what: 'content', detail: `sha256 ${sha256(got).slice(0, 12)} on GitHub, ${sha256(want).slice(0, 12)} locally${t.source ? ` (${t.source})` : ''}` });
      const manifest = new Map((meta.assets?.files ?? []).map((f) => [f.path, f]));
      for (const a of t.assets) {
        const m = manifest.get(a.path);
        const file = path.join(dir, a.kind === 'mockup' ? 'mockups' : 'files', a.name);
        const ok = m && m.sha256 === a.sha256 && fs.existsSync(file) && sha256(fs.readFileSync(file)) === a.sha256;
        if (ok) row.assets.ok++;
        else {
          row.assets.bad++;
          diffs.push({ key: t.key, what: 'asset', detail: `${a.source} -> ${a.path}: ${!m ? 'not in the manifest' : m.sha256 !== a.sha256 ? 'manifest sha256 differs' : 'downloaded file differs or is missing'}` });
        }
        manifest.delete(a.path);
      }
      for (const extra of manifest.values()) diffs.push({ key: t.key, what: 'extra asset', detail: `${extra.path} is on the issue but not in the local files` });
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  if (legacy.unplaced.length && !allowUnplaced) for (const u of legacy.unplaced) diffs.push({ key: null, what: 'unplaced', detail: `${u.source}: ${u.reason}` });
  const report = {
    verifiedAt: nowIso(),
    repo: config.tickets.repo,
    legacyDir: config.tickets.legacyDir,
    fingerprint: folderFingerprint(root, legacy.files),
    files: legacy.files.length,
    passed: diffs.length === 0,
    allowUnplaced,
    unplaced: legacy.unplaced,
    tickets,
    issues: Object.fromEntries(tickets.filter((t) => t.issue).map((t) => [t.key, t.issue])),
    sources: Object.fromEntries(legacy.tickets.filter((t) => t.source).map((t) => [t.source, t.key])),
    differences: diffs,
  };
  const md = [
    `# Board migration verify: ${report.passed ? 'PASSED' : 'FAILED'}`,
    '',
    `- Verified: ${report.verifiedAt}`,
    `- Files: ${report.files}, tickets: ${tickets.length}, content ok: ${tickets.filter((t) => t.content === 'ok').length}, assets ok: ${tickets.reduce((n, t) => n + t.assets.ok, 0)}`,
    `- Differences: ${diffs.length}${allowUnplaced && legacy.unplaced.length ? ` (${legacy.unplaced.length} unplaced file(s) accepted with --allow-unplaced)` : ''}`,
    '',
    ...(diffs.length ? ['| Ticket | What | Detail |', '| --- | --- | --- |', ...diffs.map((d) => `| ${d.key ?? '-'} | ${d.what} | ${String(d.detail).replace(/\|/g, '\\|')} |`)] : ['Every ticket matches its file byte for byte, and every asset matches its sha256.']),
  ].join('\n');
  report.reportFile = writeReport(config, 'verify', report, md);
  writeReport(config, '', report, md);
  return report;
}

// ---------------------------------------------------------------------------------------------
// Delete the local folder once a verify passed for exactly these files
// ---------------------------------------------------------------------------------------------

// Files that name the legacy folder and how to drop the reference. Lines containing the folder name (or
// the marker below) are removed; JSON configs lose the key or array entry.
export const DELETE_MARKER = '(removed by board migrate --delete-local)';

export function deleteLocal(config, { run = exec, log = () => {}, dryRun = false } = {}) {
  const dir = config.tickets.legacyDir;
  const root = legacyRoot(config);
  const report = readJson(path.join(ticketsRoot(config), 'migration-report-verify.json'), null);
  if (!dir) return { ok: false, reason: 'tickets.legacyDir is not configured; nothing to delete' };
  if (!report) return { ok: false, reason: 'no verify report: run `node scripts/board/board.mjs migrate --verify` first' };
  if (!report.passed) return { ok: false, reason: `the last verify (${report.verifiedAt}) failed with ${report.differences.length} difference(s); fix them and verify again` };
  if (root && report.fingerprint !== folderFingerprint(root)) return { ok: false, reason: `the files changed since the last verify (${report.verifiedAt}); run migrate --apply and --verify again` };
  if (report.legacyDir !== dir) return { ok: false, reason: `the last verify was for ${report.legacyDir}, not ${dir}` };
  const changed = [];
  if (!dryRun && root) {
    // The verify covered the files as they are now (fingerprint), uncommitted edits included, so the
    // removal is staged from the index and the folder deleted from disk.
    const rm = run('git', ['rm', '-r', '-q', '--cached', '--ignore-unmatch', '--', dir], { cwd: config.root });
    if (rm.status !== 0) return { ok: false, reason: `git rm failed: ${String(rm.stderr).trim()}` };
    fs.rmSync(root, { recursive: true, force: true });
    changed.push(`${dir}/ (removed)`);
  }
  const edits = referenceEdits(config, dir, report);
  for (const e of edits) {
    if (!dryRun) fs.writeFileSync(path.join(config.root, e.file), e.text);
    changed.push(e.file);
  }
  if (!dryRun && edits.length) run('git', ['add', '--', ...edits.map((e) => e.file)], { cwd: config.root });
  const remaining = run('git', ['grep', '-n', '-I', '-F', dir, '--', '.', ':(exclude)graphify-out', ':(exclude).factory/state'], { cwd: config.root })
    .stdout.split('\n')
    .filter(Boolean)
    .filter((l) => !edits.some((e) => l.startsWith(`${e.file}:`)));
  for (const c of changed) log(`changed: ${c}`);
  return { ok: true, changed, remaining };
}

// The edits that remove every reference to the legacy folder from the files that carry one.
export function referenceEdits(config, dir, report = null) {
  const edits = [];
  const files = run_(config, ['grep', '-l', '-I', '-F', dir, '--', '.', ':(exclude)graphify-out', ':(exclude).factory/state', `:(exclude)${dir}`]);
  for (const file of files) {
    const abs = path.join(config.root, file);
    if (!fs.existsSync(abs)) continue;
    const text = fs.readFileSync(abs, 'utf8');
    let next = text;
    if (file.endsWith('.json')) {
      // Line edits keep the file's formatting; a full rewrite is the fallback.
      const q = escapeRe(JSON.stringify(dir));
      const lean = text.replace(new RegExp(`^\\s*"legacyDir":\\s*${q},?\\n`, 'm'), '').replace(new RegExp(`,\\s*${q}(?=\\s*\\])|${q}\\s*,\\s*`, 'g'), '');
      let valid;
      try {
        JSON.parse(lean);
        valid = !lean.includes(dir);
      } catch {
        valid = false;
      }
      if (valid) {
        if (lean !== text) edits.push({ file, text: lean });
        continue;
      }
      const data = JSON.parse(text);
      if (data.tickets?.legacyDir === dir) delete data.tickets.legacyDir;
      if (Array.isArray(data.storyGuard?.folders)) data.storyGuard.folders = data.storyGuard.folders.filter((f) => f !== dir);
      next = `${JSON.stringify(data, null, 2)}\n`;
      if (next.includes(dir)) next = text; // not a shape we know: leave it for the report
    } else if (/(^|\/)_index\.md$/.test(file) && report) {
      // Test plans recorded the story file; they now name the story's issue.
      next = text.replace(new RegExp(`^story-file:\\s*${escapeRe(dir)}/(\\S+)\\s*$`, 'm'), (m, rel) => {
        const key = report.sources?.[rel];
        const number = key ? report.issues?.[key] : null;
        return number ? `story-issue: https://github.com/${config.tickets.repo}/issues/${number}` : m;
      });
    } else if (/\.(ya?ml)$|(^|\/)\.[\w-]*ignore$/.test(file)) {
      next = text
        .split('\n')
        .filter((l) => !l.includes(dir) && !l.includes(DELETE_MARKER))
        .join('\n');
    }
    if (next !== text) edits.push({ file, text: next });
  }
  return edits;
}

function run_(config, args) {
  return exec('git', args, { cwd: config.root }).stdout.split('\n').filter(Boolean);
}
