// `board fetch | publish | new | migrate`: the ticket content commands (bodies, assets, cache,
// migration). The lane commands (move, pick, review, ...) stay in board.mjs.
import fs from 'node:fs';
import path from 'node:path';
import { git } from '../../pipeline/lib/git.mjs';
import { spawnBackground } from '../../pipeline/lib/background.mjs';
import { listTickets, resetTicketMemo } from '../../pipeline/lib/tickets.mjs';
import { buildAssetsCommit, exec, pushAssetsBranch } from './assets.mjs';
import { blockersOf } from '../../implement/lib/batch.mjs';
import { epicSlugOf } from './board.mjs';
import { isBug, kebab, walkFiles } from './legacy.mjs';
import { STORY_FOOTER, applyMigration, deleteLocal, formatPlan, labelsFor, planMigration, verifyMigration, writeReport } from './migrate.mjs';
import { boardAvailable, epicChildren, fetchTickets, issueIndex, readMeta, ticketFile, writeTicket } from './source.mjs';
import { keepDecisions } from './escalation.mjs';
import { keepTriage } from '../../review-gate/lib/triage-section.mjs';
import { parseBody, sha256 } from './ticket-format.mjs';
import { trackerFor } from './trackers/index.mjs';

// A tracker runner tests inject (a fake gh); null: the configured tracker as it is.
const defaultGh = null;
const trackerOf = (config, gh) => (gh ? trackerFor(config, { gh }) : trackerFor(config));
const FV_CLI = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../feature-verification/feature-verification.mjs');

function requireBoard(config) {
  if (boardAvailable(config)) return true;
  console.error(`The board is not reachable from this checkout: origin must be ${config.tickets.repo} (and PIPELINE_BOARD / PIPELINE_TICKETS_OFFLINE unset), with gh logged in.`);
  return false;
}

// board fetch <KEY...> | --epic <EPIC> | --all [--refresh]
export function fetchCommand(config, { keys, epic, all, refresh, gh = defaultGh, log = console.error }) {
  if (!keys.length && !epic && !all) {
    console.error('Usage: board fetch <KEY...> | --epic <EPIC> | --all [--refresh]');
    return 2;
  }
  let wanted = keys.map((k) => (/^(epic|spike)-/i.test(k) ? k.toLowerCase() : k.toUpperCase()));
  let index;
  if (boardAvailable(config)) {
    try {
      index = issueIndex(config, { gh });
      if (all) wanted = [...index.keys()];
      if (epic) {
        const epicKey = /^epic-/i.test(epic) ? epic.toLowerCase() : `epic-${kebab(epic)}`;
        wanted.push(epicKey, ...epicChildren(config, epicKey, { gh, index }));
      }
    } catch (error) {
      log(`warning: GitHub unreachable (${error.message.split('\n')[0]}); using the cache`);
    }
  } else if (all || epic) {
    log('warning: the board is not reachable from this checkout; showing the cache');
    wanted.push(...listTickets(config).filter((t) => all || t.epic === epic || t.key === epic).map((t) => t.key));
  }
  const results = fetchTickets(config, [...new Set(wanted)], { refresh, gh, index, log });
  resetTicketMemo();
  let failed = 0;
  for (const r of results) {
    const where = path.relative(config.root, ticketFile(config, r.key));
    if (['missing', 'error'].includes(r.status)) failed++;
    console.log(`${r.key.padEnd(12)} ${r.status.padEnd(13)} ${['missing', 'error'].includes(r.status) ? r.message : where}${r.message && !['missing', 'error'].includes(r.status) ? `  (${r.message})` : ''}`);
  }
  // Stories are not commits any more, so a changed story starts its test plan here (opt-in, like the
  // old post-commit trigger): git config fv.autoPlan true.
  const changed = results.filter((r) => r.status === 'fetched' && ['story', 'bug'].includes(readMeta(config, r.key)?.type)).map((r) => r.key);
  if (changed.length && git(config.root, ['config', '--bool', 'fv.autoPlan']).stdout.trim() === 'true' && process.env.PIPELINE_CHILD !== '1') {
    const bg = spawnBackground(config, { script: FV_CLI, key: changed[0], stage: 'feature-verification', args: ['plan', ...changed] });
    console.log(`Stories changed (${changed.join(', ')}); writing test plans in the background (log ${bg.log}).`);
  }
  return failed ? 1 : 0;
}

// board publish <KEY> [--force]: writes the cached story (for example with the implementer's
// Implementation Notes) back to its issue. The assets stay pinned to the commit the issue already uses.
export function publishCommand(config, { key, force = false, gh = defaultGh }) {
  const meta = readMeta(config, key);
  if (!meta || !fs.existsSync(ticketFile(config, key))) {
    console.error(`${key} is not in the ticket cache.`);
    return 2;
  }
  const text = fs.readFileSync(ticketFile(config, key), 'utf8');
  if (sha256(Buffer.from(text, 'utf8')) === meta.contentHash && !force) {
    console.log(`${key}: unchanged since it was fetched; nothing to publish.`);
    return 0;
  }
  if (!boardAvailable(config)) {
    console.log(`${key}: the board is not reachable from this checkout; not published.`);
    return 0;
  }
  if (!meta.issue?.number) {
    console.error(`${key} has no issue; create it with \`board new\`.`);
    return 2;
  }
  const tr = trackerOf(config, gh);
  let current;
  try {
    current = (tr.tickets.view ?? tr.tickets.get)(meta.issue.number, 'updatedAt,body,title');
  } catch {
    current = null;
  }
  if (!current) {
    console.error(`${key}: could not read #${meta.issue.number}.`);
    return 1;
  }
  // Someone else changed the ticket when its source (the text between the markers) differs from what was
  // fetched. Comments and the generated parts (the pipeline's own board events, triage, decisions) move
  // updatedAt without touching the source, so updatedAt is the test only when the source cannot be read.
  let remote = null;
  try {
    remote = parseBody(current.body).content;
  } catch {
    remote = null;
  }
  const changed = remote != null ? sha256(Buffer.from(remote, 'utf8')) !== meta.contentHash : current.updatedAt !== meta.issue.updatedAt;
  if (changed && !force) {
    console.error(`${key}: #${meta.issue.number} changed on GitHub since it was fetched (${current.updatedAt}); fetch it, merge your edits, or pass --force to overwrite.`);
    return 1;
  }
  const ticket = { key, type: meta.type, title: meta.title, slug: meta.slug, source: meta.source, parent: meta.parent, blockedBy: ['story', 'bug'].includes(meta.type) ? blockersOf(text, key) : meta.blockedBy };
  // The ## Decisions a human recorded on the issue are outside the source; keep them.
  const rendered = tr.format.render(ticket, text, { assets: meta.assets, footer: ['story', 'bug'].includes(meta.type) ? STORY_FOOTER(config) : '' });
  const body = keepTriage(keepDecisions(rendered.body, current.body), current.body);
  try {
    tr.tickets.update(meta.issue.number, { body, meta: rendered.meta });
  } catch (error) {
    console.error(`${key}: updating #${meta.issue.number} failed: ${error.message.split('\n')[0]}`);
    return 1;
  }
  let after;
  try {
    after = (tr.tickets.view ?? tr.tickets.get)(meta.issue.number, 'updatedAt') ?? {};
  } catch {
    after = {};
  }
  writeTicket(config, key, { content: text, meta: { ...meta, ...ticket, sourceHash: sha256(Buffer.from(text, 'utf8')) }, issue: { ...meta.issue, updatedAt: after.updatedAt ?? meta.issue.updatedAt } });
  console.log(`${key}: published to #${meta.issue.number}.`);
  return 0;
}

// board new <file.md | -> [--type story|bug|epic|spike] [--key KEY] [--epic <epic-key>] [--mockups <dir>]
// Creates a ticket issue from Markdown (the story format in docs/ai-pipeline/writing-stories.md).
export function newCommand(config, { file, type, key: keyArg, epic, mockups, dryRun = false, gh = defaultGh, run = exec, stdin = () => fs.readFileSync(0, 'utf8') }) {
  const text = !file || file === '-' ? stdin() : fs.readFileSync(file, 'utf8');
  const heading = /^#\s+(.+)$/m.exec(text)?.[1]?.trim();
  if (!heading) {
    console.error('The Markdown needs a "# <title>" heading (for stories: "# <KEY>: <title>").');
    return 2;
  }
  const headingKey = /^([A-Z][A-Z0-9]*-\d+)\b/.exec(heading)?.[1];
  let key = keyArg?.toUpperCase() ?? headingKey;
  const kind = type ?? (key && isBug(key, text) ? 'bug' : 'story');
  if (['epic', 'spike'].includes(kind)) key = keyArg ?? `${kind}-${kebab(heading.replace(/^(Epic|Spike):\s*/i, ''))}`;
  if (!key) {
    console.error('Give the story key: "# SHOP-10: <title>" in the heading, or --key SHOP-10.');
    return 2;
  }
  const title = kind === 'epic' ? `Epic: ${heading.replace(/^Epic:\s*/i, '')}` : kind === 'spike' ? `Spike: ${heading.replace(/^Spike:\s*/i, '')}` : headingKey ? heading : `${key}: ${heading}`;
  const parent = epic ?? (kind === 'spike' ? null : epicSlugOf(text));
  const ticket = { key, type: kind, title, slug: ['story', 'bug'].includes(kind) ? `${key}-${kebab(title.replace(/^[A-Z][A-Z0-9]*-\d+:?\s*/, '')).slice(0, 60).replace(/-+$/, '')}` : key, source: null, parent, blockedBy: ['story', 'bug'].includes(kind) ? blockersOf(text, key) : [], text };
  if (!dryRun && !requireBoard(config)) return 2;
  const index = dryRun ? new Map() : issueIndex(config, { gh });
  if (index.has(key)) {
    console.error(`${key} already has an issue (#${index.get(key).number}); edit it on the tracker, or fetch it and \`board publish\`.`);
    return 2;
  }
  const tr = trackerOf(config, gh);
  // A tracker whose assets live on the repository's assets branch (block bodies), or one that takes attachments.
  const github = Boolean(tr.traits?.blockBody);
  let assets = github ? { repo: config.tickets.repo, branch: config.tickets.assetsBranch, commit: null, files: [] } : { tracker: tr.type, files: [] };
  let mockupFiles = [];
  if (mockups && !github) {
    // Trackers without a git branch keep mockups as ticket attachments (uploaded after the ticket exists).
    const dir = path.resolve(mockups);
    const folder = path.basename(dir);
    mockupFiles = walkFiles(dir).map((rel) => ({ rel, data: fs.readFileSync(path.join(dir, rel)) }));
    assets.files = mockupFiles.map((f) => ({ path: `mockups/${key}/${folder}/${f.rel}`, name: `${folder}/${f.rel}`, attachmentName: `${key}--${folder}--${f.rel}`.replace(/[\\/]/g, '--'), kind: 'mockup', sha256: sha256(f.data), size: f.data.length }));
  } else if (mockups) {
    const dir = path.resolve(mockups);
    const folder = path.basename(dir);
    const files = walkFiles(dir).map((rel) => ({ rel, abs: path.join(dir, rel), data: fs.readFileSync(path.join(dir, rel)) }));
    assets.files = files.map((f) => ({ path: `mockups/${key}/${folder}/${f.rel}`, name: `${folder}/${f.rel}`, kind: 'mockup', sha256: sha256(f.data), size: f.data.length }));
    if (!dryRun) {
      const built = buildAssetsCommit(config, files.map((f, i) => ({ path: assets.files[i].path, data: f.data })), { message: `Mockups for ${key}`, run });
      assets.commit = built.commit;
      if (built.changed) pushAssetsBranch(config, { run });
    }
  }
  const links = Object.fromEntries([parent, ...ticket.blockedBy].filter((k) => k && index.has(k)).map((k) => [k, index.get(k).number]));
  const { body, meta, spilled } = tr.format.render(ticket, text, { assets, links, footer: ['story', 'bug'].includes(kind) ? STORY_FOOTER(config) : '' });
  if (spilled) {
    console.error(`${key}: the story is too large for an issue body (or has mixed line endings); split it, or migrate it as a file.`);
    return 2;
  }
  const labels = labelsFor(config, ticket);
  if (dryRun) {
    console.log(`Would create ${kind} ${key} "${title}" (labels: ${labels.join(', ')}${parent ? `, sub-issue of ${parent}` : ''}, ${body.length} characters, ${assets.files.length} asset(s)).`);
    return 0;
  }
  let created;
  try {
    created = tr.tickets.create({ type: kind, key, title, body, labels, parent: parent && index.has(parent) ? index.get(parent).number : null, blockedBy: github ? [] : ticket.blockedBy.filter((k) => index.has(k)).map((k) => index.get(k).number), meta });
  } catch (error) {
    console.error(`Creating the ticket failed for ${key}: ${error.message.split('\n')[0]}`);
    return 1;
  }
  const number = created.id;
  const url = created.url;
  if (mockupFiles.length) {
    for (const [i, f] of mockupFiles.entries()) {
      const a = tr.tickets.attach(number, { name: assets.files[i].attachmentName, data: f.data });
      assets.files[i].attachment = a.id;
    }
    meta.assets = assets;
    tr.tickets.update(number, { meta });
  }
  let view;
  try {
    const v = github ? tr.tickets.view(number, 'updatedAt,state,labels') : tr.tickets.get(number);
    view = { updatedAt: v?.updatedAt ?? null, state: v?.raw?.state ?? (v?.state === 'closed' ? 'CLOSED' : 'OPEN') };
  } catch {
    view = {};
  }
  writeTicket(config, key, { content: text, meta, issue: { number, url, updatedAt: view.updatedAt ?? null, state: view.state ?? 'OPEN', title, labels } });
  console.log(`${key}: created ${url}${parent ? ` under ${parent}` : ''}.`);
  return 0;
}

// board migrate [--summary] | --apply | --verify [--allow-unplaced] | --delete-local [--dry-run]
export function migrateCommand(config, flags, { gh = defaultGh, run = exec } = {}) {
  if (flags['delete-local']) {
    const r = deleteLocal(config, { run, log: (m) => console.log(m), dryRun: Boolean(flags['dry-run']) });
    if (!r.ok) {
      console.error(`Refusing to delete: ${r.reason}.`);
      return 1;
    }
    console.log(`${flags['dry-run'] ? 'Would change' : 'Changed'} ${r.changed.length} path(s).`);
    if (r.remaining.length) {
      console.log(`References left for a human (not a shape migrate knows how to edit):\n${r.remaining.map((l) => `  ${l}`).join('\n')}`);
      return 1;
    }
    console.log(flags['dry-run'] ? 'No other references.' : 'No references to the legacy folder remain. Review and commit the change.');
    return 0;
  }
  if (flags.verify) {
    if (!requireBoard(config)) return 2;
    const report = verifyMigration(config, { gh, run, allowUnplaced: Boolean(flags['allow-unplaced']) });
    console.log(`Verify ${report.passed ? 'PASSED' : 'FAILED'}: ${report.tickets.length} ticket(s), ${report.differences.length} difference(s). Report: ${path.relative(config.root, report.reportFile)}`);
    return report.passed ? 0 : 1;
  }
  if (flags.apply) {
    if (!requireBoard(config)) return 2;
    const r = applyMigration(config, { gh, run, log: (m) => console.log(m) });
    resetTicketMemo();
    console.log(`Applied: ${r.created.length} created, ${r.updated.length} updated, ${r.unchanged.length} unchanged, ${r.linked} sub-issue link(s); assets at ${r.commit ? r.commit.slice(0, 10) : '(none)'}. Next: board migrate --verify`);
    return 0;
  }
  const plan = planMigration(config, { gh: boardAvailable(config) ? gh : () => ({ status: 1, stdout: '', stderr: 'board not reachable from this checkout' }) });
  const file = writeReport(config, 'plan', plan, formatPlan(plan));
  console.log(formatPlan(plan, { summary: true }));
  console.log(`\nDry run. Full plan: ${path.relative(config.root, file)} (and .json). Apply with --apply.`);
  return 0;
}
