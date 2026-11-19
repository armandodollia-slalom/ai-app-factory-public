// The ticket tracker layer (scripts/board/lib/trackers/): Markdown <-> ADF / wiki markup / HTML, the
// tracker choice, and the Jira (Cloud and Data Center) and Azure Boards adapters against fake REST
// servers (test/fixtures/fake-tracker-server.mjs, on a worker thread): every interface method,
// pagination, an auth failure, a 429 retry and a self-hosted base URL. GitHub's adapter is checked
// against the in-memory GitHub of fake-github.mjs; the board stage's own tests cover the rest of it.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { adfToMd, htmlToMd, mdToAdf, mdToHtml, mdToWiki, wikiToMd } from '../lib/trackers/markdown.mjs';
import { TrackerError, trackerFor, trackerType } from '../lib/trackers/index.mjs';
import { expandEnv, laneOf } from '../lib/trackers/shared.mjs';
import { metaBlock, splitDescription } from '../lib/trackers/azure-boards.mjs';
import { githubTracker } from '../lib/trackers/github.mjs';
import { fetchTickets, readMeta, ticketDir, ticketFile } from '../lib/source.mjs';
import { newCommand } from '../lib/ticket-commands.mjs';
import { fakeGitHub } from './fake-github.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(here, 'fixtures', 'fake-tracker-server.mjs');
const TEMPLATE = /## Template\n\n```markdown\n([\s\S]*?)```/.exec(fs.readFileSync(path.join(here, '../../../docs/ai-pipeline/writing-stories.md'), 'utf8'))[1];
const RICH = `${TEMPLATE}
## More

Some \`code\` and _em_ and ~~gone~~ and [a link](https://x.y/z) and ![img](https://x/y.png).
Line two with snake_case and 3 * 4 and a [FE] tag.

\`\`\`js
const a = 1;
\`\`\`

> quoted **text**

---

* parent
  * child one
  * child two
* next

1. first
2. second

<!-- pipeline-decisions:begin -->

## Decisions

<!-- pipeline-decisions:end -->
`;

const temps = [];
after(() => {
  for (const t of temps) fs.rmSync(t, { recursive: true, force: true });
});

async function startFake(kind, { prefix = '', auth }) {
  const worker = new Worker(SERVER, { workerData: { kind, prefix, auth } });
  const { port } = await new Promise((resolve, reject) => {
    worker.once('message', resolve);
    worker.once('error', reject);
  });
  const root = `http://127.0.0.1:${port}`;
  return {
    url: `${root}${prefix}`,
    state: async () => (await fetch(`${root}/__fake/state`)).json(),
    seed: async (data) => fetch(`${root}/__fake/seed`, { method: 'POST', body: JSON.stringify(data) }),
    fail: async (rule) => fetch(`${root}/__fake/fail`, { method: 'POST', body: JSON.stringify(rule) }),
    close: () => worker.terminate(),
  };
}

const LANES = { backlog: 'Backlog', ready: 'Ready', inProgress: 'In Progress', testing: 'Testing', review: 'Pending Review', failed: 'Failed', done: 'Done' };
const baseConfig = (tracker) => ({ root: os.tmpdir(), stateDir: '.factory/state', board: { columns: LANES, epicLabel: 'epic', spikeLabel: 'spike', storyLabel: 'story', blockedLabel: 'needs-human' }, tracker });

// ---------------------------------------------------------------------------------------------
describe('Markdown conversion', () => {
  for (const [name, to, from] of [
    ['ADF (Jira Cloud)', mdToAdf, adfToMd],
    ['wiki markup (Jira Data Center)', mdToWiki, wikiToMd],
    ['HTML (Azure Boards)', mdToHtml, htmlToMd],
  ]) {
    it(`${name}: the story template comes back byte for byte, and a richer story is stable`, () => {
      assert.equal(from(to(TEMPLATE)), TEMPLATE);
      const once = from(to(RICH));
      assert.equal(from(to(once)), once, 'a second round trip changes nothing');
      for (const needle of ['* **Blocked by:** <KEY-1>, <KEY-2>', '| `code` | string | yes | 3-20 characters, letters and digits, case-insensitive |', '1. **Given** <state>', '[a link](https://x.y/z)', '```js\nconst a = 1;\n```', '  * child one', '<!-- pipeline-decisions:begin -->', 'snake_case and 3 * 4 and a [FE] tag', '> quoted **text**', '~~gone~~']) assert.ok(once.includes(needle), `${name} keeps ${needle}`);
    });
  }

  it('writes each format natively', () => {
    const adf = mdToAdf('# T\n\n| a | b |\n| --- | --- |\n| 1 | **2** |\n');
    assert.equal(adf.type, 'doc');
    assert.deepEqual(adf.content[0], { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'T' }] });
    assert.equal(adf.content[1].type, 'table');
    assert.deepEqual(adf.content[1].content[1].content[1].content[0].content[0], { type: 'text', text: '2', marks: [{ type: 'strong' }] });
    assert.equal(mdToWiki('## H\n\n* a `b`\n\n| x | y |\n| --- | --- |\n| 1 | 2 |\n'), 'h2. H\n\n* a {{b}}\n\n||x||y||\n|1|2|\n');
    assert.equal(mdToHtml('Tom & <Jerry> **x**'), '<p>Tom &amp; &lt;Jerry&gt; <strong>x</strong></p>');
  });

  it('reads what people write in the tracker: panels, mentions, Jira macros, Azure markup', () => {
    assert.equal(adfToMd({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'mention', attrs: { text: '@Jo' } }, { type: 'text', text: ' see ' }, { type: 'inlineCard', attrs: { url: 'https://e.x' } }] }, { type: 'panel', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'note' }] }] }] }), '@Jo see <https://e.x>\n\n> note\n');
    assert.equal(wikiToMd('h1. Title\n\n{noformat}\nraw\n{noformat}\n\nbq. quoted\n\n# one\n## nested\n'), '# Title\n\n```\nraw\n```\n\n> quoted\n\n1. one\n   1. nested\n');
    assert.equal(htmlToMd('<div><b>Bold</b> text<br>next line</div><ul><li>a</li><li>b</li></ul>'), '**Bold** text\nnext line\n\n* a\n* b\n');
  });
});

// ---------------------------------------------------------------------------------------------
describe('tracker choice and shared helpers', () => {
  it('follows tracker.type, then the code host, and defaults to GitHub', () => {
    assert.equal(trackerType({}), 'github');
    assert.equal(trackerType({ tracker: { type: 'jira' } }), 'jira');
    assert.equal(trackerType({ host: { type: 'azure-devops' } }), 'azure-boards');
    assert.equal(trackerType({ host: { type: 'azure-devops' }, tracker: { type: 'jira' } }), 'jira');
    assert.equal(trackerType({ host: { type: 'gitlab' } }), 'gitlab', 'GitLab issues are the GitLab host\'s own board');
    assert.throws(() => trackerType({ host: { type: 'bitbucket' } }), /set tracker.type/, 'Bitbucket names its board (Jira, usually)');
    assert.throws(() => trackerType({ tracker: { type: 'trello' } }), /use one of github, jira, azure-boards, gitlab, linear, custom/);
    assert.equal(trackerFor({ board: {} }).type, 'github');
  });

  it('expands ${ENV} and names a missing variable', () => {
    assert.equal(expandEnv('Bearer ${TRACKER_TEST_TOKEN}', { TRACKER_TEST_TOKEN: 'abc' }), 'Bearer abc');
    assert.throws(() => expandEnv('${TRACKER_TEST_MISSING}', {}), (e) => e instanceof TrackerError && /TRACKER_TEST_MISSING/.test(e.message));
    assert.equal(laneOf({ board: { columns: LANES }, tracker: { lanes: { review: 'In Review' } } }, 'in review'), 'review');
  });
});

// ---------------------------------------------------------------------------------------------
describe('Jira Cloud (REST v3, ADF)', () => {
  let fake;
  let tracker;
  const auth = `Basic ${Buffer.from('me@example.com:jira-secret').toString('base64')}`;
  before(async () => {
    process.env.TRACKER_TEST_JIRA_USER = 'me@example.com';
    process.env.TRACKER_TEST_JIRA_TOKEN = 'jira-secret';
    fake = await startFake('jira-cloud', { auth });
    tracker = trackerFor(baseConfig({ type: 'jira', deployment: 'cloud', url: fake.url, project: 'SHOP', auth: { user: '${TRACKER_TEST_JIRA_USER}', token: '${TRACKER_TEST_JIRA_TOKEN}' }, board: { id: 7 }, fields: { severity: 'customfield_10050', impact: 'customfield_10051', confidence: 'customfield_10052' } }));
  });
  after(() => fake.close());

  it('tickets: create, get by Jira key and factory key, list with pagination, children, parent, update', async () => {
    assert.deepEqual(tracker.reachable(), { ok: true, reason: null });
    assert.equal(tracker.identity().id, 'acc-1');
    const epic = tracker.tickets.create({ type: 'epic', key: 'epic-checkout', title: 'Epic: Checkout', body: '# Epic: Checkout\n\nAll of it.\n', labels: ['epic'] });
    assert.equal(epic.id, 'SHOP-1');
    const rendered = tracker.format.render({ key: 'PROMO-3', type: 'story', title: 'PROMO-3: [FE] Coupons', slug: 'PROMO-3-coupons' }, TEMPLATE);
    const story = tracker.tickets.create({ type: 'story', key: 'PROMO-3', title: 'PROMO-3: [FE] Coupons', body: rendered.body, labels: ['story', 'frontend'], parent: epic.id, blockedBy: [], fields: { severity: 'High' }, meta: rendered.meta });
    for (let i = 0; i < 3; i++) tracker.tickets.create({ type: 'story', title: `Extra ${i}`, body: 'x\n', parent: epic.id });
    const byKey = tracker.tickets.get('PROMO-3');
    assert.equal(byKey.id, story.id);
    assert.equal(byKey.key, 'PROMO-3');
    assert.equal(byKey.body, TEMPLATE, 'the description comes back exactly (the property keeps the Markdown)');
    assert.equal(byKey.parent, 'SHOP-1');
    assert.equal(byKey.meta.slug, 'PROMO-3-coupons');
    assert.equal(tracker.tickets.get('SHOP-2').key, 'PROMO-3');
    assert.equal(tracker.tickets.get('NOPE-404'), null);
    const parsed = tracker.format.parse(byKey);
    assert.equal(parsed.content, TEMPLATE);
    assert.equal(parsed.edited, false);
    const all = tracker.tickets.list();
    assert.equal(all.length, 5, 'three pages of two');
    assert.deepEqual(tracker.tickets.children(epic.id).map((t) => t.id), ['SHOP-2', 'SHOP-3', 'SHOP-4', 'SHOP-5']);
    assert.deepEqual(tracker.tickets.parent(story.id), { id: 'SHOP-1', number: 'SHOP-1', url: `${fake.url}/browse/SHOP-1` });
    assert.equal(tracker.tickets.setParent('SHOP-5', 'SHOP-1'), false);
    tracker.tickets.update(story.id, { title: 'PROMO-3: [FE] Coupon entry', labels: { add: ['needs-human'], remove: ['frontend'] }, fields: { impact: 'Low', confidence: 80 } });
    const after1 = tracker.tickets.get(story.id);
    assert.equal(after1.title, 'PROMO-3: [FE] Coupon entry');
    assert.deepEqual(after1.labels.sort(), ['factory-key-PROMO-3', 'needs-human', 'story']);
    assert.deepEqual(tracker.board.fields.get(story.id), { severity: 'High', impact: 'Low', confidence: 80 });
    const st = await fake.state();
    assert.deepEqual(st.issues['SHOP-2'].fields.customfield_10050, { value: 'High' });
    assert.ok(st.requests.some((r) => r.path === '/rest/api/3/search/jql'), 'Cloud searches through /search/jql');
    assert.equal(st.issues['SHOP-2'].fields.description.type, 'doc', 'the description is ADF');
  });

  it('a person editing the description: the converted text is read and flagged as edited', async () => {
    const st = await fake.state();
    const desc = st.issues['SHOP-2'].fields.description;
    desc.content.push({ type: 'paragraph', content: [{ type: 'text', text: 'Added in Jira.' }] });
    await fake.seed({ issues: { 'SHOP-2': { ...st.issues['SHOP-2'], fields: { ...st.issues['SHOP-2'].fields, description: desc } } } });
    const t = tracker.tickets.get('PROMO-3');
    assert.ok(t.body.endsWith('Added in Jira.\n'));
    const parsed = tracker.format.parse(t);
    assert.equal(parsed.edited, true);
    assert.equal(parsed.meta.key, 'PROMO-3', 'the metadata survives the edit');
  });

  it('comments: hidden markers in a comment property, upsert by marker, pagination', async () => {
    tracker.tickets.comment('SHOP-2', 'Claimed.\n\n<!-- pipeline-board:{"seq":1} -->');
    for (let i = 0; i < 2; i++) tracker.tickets.comment('SHOP-2', `note ${i}`);
    const r = tracker.tickets.comment('SHOP-2', 'Evidence v2\n\n<!-- pipeline-epic-evidence:{"a":1} -->', { marker: /pipeline-epic-evidence/ });
    assert.equal(r.created, true);
    const again = tracker.tickets.comment('SHOP-2', 'Evidence v3\n\n<!-- pipeline-epic-evidence:{"a":2} -->', { marker: /pipeline-epic-evidence/ });
    assert.equal(again.created, false);
    const list = tracker.tickets.comments('SHOP-2');
    assert.equal(list.length, 4, 'two pages');
    assert.equal(list[0].body, 'Claimed.\n\n<!-- pipeline-board:{"seq":1} -->');
    assert.equal(list[3].body, 'Evidence v3\n\n<!-- pipeline-epic-evidence:{"a":2} -->');
    const st = await fake.state();
    assert.ok(!JSON.stringify(st.comments['SHOP-2'][0].body).includes('<!--'), 'the marker is not in the visible comment');
  });

  it('attachments, pull request links, lanes, board items and setup', async () => {
    const a = tracker.tickets.attach('SHOP-2', { name: 'Main.png', data: Buffer.from([1, 2, 3, 250]) });
    assert.equal(a.name, 'Main.png');
    const list = tracker.tickets.attachments('SHOP-2');
    assert.equal(list.length, 1);
    assert.deepEqual([...tracker.tickets.download(list[0])], [1, 2, 3, 250]);
    tracker.tickets.link('SHOP-2', { url: 'https://dev.azure.com/acme/shop/_git/app/pullrequest/9', title: 'PR 9' });
    tracker.tickets.link('SHOP-2', { url: 'https://dev.azure.com/acme/shop/_git/app/pullrequest/9', title: 'PR 9' });
    const st = await fake.state();
    assert.equal(Object.keys(st.remoteLinks['SHOP-2']).length, 1, 'a link is idempotent');
    assert.equal(tracker.board.lane('SHOP-2'), 'backlog');
    assert.equal(tracker.board.move('SHOP-2', 'inProgress'), true);
    assert.equal(tracker.board.lane('SHOP-2'), 'inProgress');
    assert.equal(tracker.board.move('SHOP-2', 'inProgress'), false);
    assert.throws(() => tracker.board.move('SHOP-2', 'failed'), /no transition .* to "Failed"/);
    const items = tracker.board.items();
    assert.equal(items.find((i) => i.key === 'PROMO-3').column, 'inProgress');
    assert.equal(items.find((i) => i.key === 'PROMO-3').severity, 'High');
    assert.equal(tracker.board.items({ lane: 'inProgress' }).length, 1);
    const before1 = (await fake.state()).requests.filter((r) => r.method !== 'GET' && r.method !== 'POST').length;
    const s = tracker.board.setup({ dryRun: true });
    assert.ok(s.manual.some((m) => /status "Failed"/.test(m)), 'a missing status is for a person');
    assert.ok(s.manual.some((m) => /custom field "Complexity"/.test(m)), 'a missing field is for a person');
    assert.ok(s.manual.some((m) => /issue type "Task"/.test(m)));
    assert.ok(s.manual.some((m) => /Failed|statuses .* to columns/.test(m)));
    const after1 = (await fake.state()).requests.filter((r) => r.method !== 'GET' && r.method !== 'POST').length;
    assert.equal(after1, before1, 'setup changes nothing');
  });

  it('board new with mockups, then board fetch: attachments carry the mockups, checked by sha256', () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'jira-new-')));
    temps.push(root);
    const mock = path.join(root, 'PROMO-7-cart');
    fs.mkdirSync(path.join(mock, 'img'), { recursive: true });
    fs.writeFileSync(path.join(mock, 'README.md'), '# Cart\n');
    fs.writeFileSync(path.join(mock, 'img', 'Main.png'), Buffer.from([137, 80, 78, 71]));
    const story = path.join(root, 'PROMO-7.md');
    fs.writeFileSync(story, TEMPLATE.replace('# [FE] <Feature title>', '# PROMO-7: [FE] Cart'));
    const config = { ...baseConfig({ type: 'jira', deployment: 'cloud', url: fake.url, project: 'SHOP', auth: { user: '${TRACKER_TEST_JIRA_USER}', token: '${TRACKER_TEST_JIRA_TOKEN}' } }), root, tickets: { dir: '.factory/state/board', repo: null } };
    const log = console.log;
    console.log = () => {};
    let code;
    try {
      code = newCommand(config, { file: story, mockups: mock });
    } finally {
      console.log = log;
    }
    assert.equal(code, 0);
    fs.rmSync(path.join(root, '.factory'), { recursive: true });
    const [r] = fetchTickets(config, ['PROMO-7']);
    assert.equal(r.status, 'fetched', r.message);
    assert.equal(fs.readFileSync(ticketFile(config, 'PROMO-7'), 'utf8'), TEMPLATE.replace('# [FE] <Feature title>', '# PROMO-7: [FE] Cart'));
    assert.deepEqual([...fs.readFileSync(path.join(ticketDir(config, 'PROMO-7'), 'mockups', 'PROMO-7-cart', 'img', 'Main.png'))], [137, 80, 78, 71]);
    assert.equal(readMeta(config, 'PROMO-7').slug, 'PROMO-7-fe-cart', 'the metadata came back from the issue property');
  });

  it('retries a 429 (Retry-After) and refuses a bad token clearly', async () => {
    await fake.fail({ path: '/rest/api/3/myself', status: 429, times: 2, retryAfter: 0 });
    assert.equal(tracker.identity().id, 'acc-1');
    const st = await fake.state();
    assert.equal(st.requests.filter((r) => r.path === '/rest/api/3/myself').length, 5, 'two refused, then answered (plus the two earlier calls)');
    process.env.TRACKER_TEST_JIRA_BAD = 'wrong';
    const bad = trackerFor(baseConfig({ type: 'jira', deployment: 'cloud', url: fake.url, project: 'SHOP', auth: { user: 'me@example.com', token: '${TRACKER_TEST_JIRA_BAD}' } }));
    assert.throws(() => bad.identity(), (e) => e.code === 'auth' && /check the token/.test(e.message));
    assert.equal(bad.reachable().ok, false);
    assert.throws(() => bad.tickets.history('SHOP-2'), (e) => e.unsupported === true);
  });
});

// ---------------------------------------------------------------------------------------------
describe('Jira Data Center (REST v2, wiki markup, self-hosted base path)', () => {
  let fake;
  let tracker;
  before(async () => {
    process.env.TRACKER_TEST_JIRA_PAT = 'dc-pat';
    fake = await startFake('jira-dc', { prefix: '/jira', auth: 'Bearer dc-pat' });
    tracker = trackerFor(baseConfig({ type: 'jira', url: fake.url, project: 'SHOP', auth: { token: '${TRACKER_TEST_JIRA_PAT}' }, fields: { epicLink: 'customfield_10014' } }));
  });
  after(() => fake.close());

  it('detects Data Center, writes wiki markup, links epics through Epic Link, pages with startAt', async () => {
    const epic = tracker.tickets.create({ type: 'epic', title: 'Epic', body: 'E\n' });
    assert.equal(tracker.deployment, 'datacenter');
    for (let i = 0; i < 3; i++) tracker.tickets.create({ type: 'story', title: `S${i}`, body: TEMPLATE, parent: epic.id });
    const st = await fake.state();
    assert.equal(typeof st.issues['SHOP-2'].fields.description, 'string');
    assert.match(st.issues['SHOP-2'].fields.description, /^h1\. \\\[FE\\\] <Feature title>/);
    assert.equal(st.issues['SHOP-2'].fields.customfield_10014, 'SHOP-1');
    assert.ok(st.requests.every((r) => r.path.startsWith('/jira/')), 'every call goes under the base path');
    assert.equal(tracker.tickets.children('SHOP-1').length, 3);
    assert.ok((await fake.state()).requests.some((r) => r.path === '/jira/rest/api/2/search'));
    // A ticket a person wrote in Jira (no factory metadata) reads as a story.
    await fake.seed({ issues: { 'SHOP-9': { key: 'SHOP-9', id: '9', fields: { summary: 'Native story', description: 'h2. Goal\n\n* one\n* two', issuetype: { name: 'Story' }, labels: [], status: { name: 'Ready', statusCategory: { key: 'new' } }, updated: '2026-11-01T00:00:00Z', issuelinks: [] } } } });
    const native = tracker.tickets.get('SHOP-9');
    assert.equal(tracker.format.parse(native).content, '# SHOP-9: Native story\n\n## Goal\n\n* one\n* two\n');
    assert.equal(tracker.board.lane('SHOP-9'), 'ready');
    tracker.tickets.comment('SHOP-9', 'hello **world**');
    assert.equal(tracker.tickets.comments('SHOP-9')[0].body, 'hello **world**');
  });

  it('feeds the ticket cache: board fetch of a Jira ticket', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'jira-cache-')));
    temps.push(root);
    const config = { ...baseConfig({ type: 'jira', url: fake.url, project: 'SHOP', auth: { token: '${TRACKER_TEST_JIRA_PAT}' }, fields: { epicLink: 'customfield_10014' } }), root, tickets: { dir: '.factory/state/board', repo: null } };
    const results = fetchTickets(config, ['SHOP-9']);
    assert.equal(results[0].status, 'fetched', results[0].message);
    assert.equal(fs.readFileSync(ticketFile(config, 'SHOP-9'), 'utf8'), '# SHOP-9: Native story\n\n## Goal\n\n* one\n* two\n');
    assert.equal(readMeta(config, 'SHOP-9').issue.number, 'SHOP-9');
  });
});

// ---------------------------------------------------------------------------------------------
describe('Azure Boards (Azure DevOps Server base path)', () => {
  let fake;
  let tracker;
  const auth = `Basic ${Buffer.from(':ado-pat').toString('base64')}`;
  before(async () => {
    process.env.TRACKER_TEST_ADO_PAT = 'ado-pat';
    fake = await startFake('azure', { prefix: '/tfs/DefaultCollection', auth });
    tracker = trackerFor(baseConfig({ type: 'azure-boards', url: fake.url, project: 'Shop', auth: { token: '${TRACKER_TEST_ADO_PAT}' }, board: { team: 'Shop Team', board: 'Stories' }, fields: { severity: 'Custom.Severity', impact: 'Custom.Impact' } }));
  });
  after(() => fake.close());

  it('work items: create with parent, blockers, tags and metadata; get by AB id and factory key; update', async () => {
    assert.equal(tracker.reachable().ok, true);
    assert.equal(tracker.identity().login, 'jo@example.com');
    const epic = tracker.tickets.create({ type: 'epic', key: 'epic-checkout', title: 'Epic: Checkout', body: 'E\n', labels: ['epic'] });
    const blocker = tracker.tickets.create({ type: 'story', key: 'PROMO-2', title: 'PROMO-2: first', body: 'b\n', parent: epic.id });
    const rendered = tracker.format.render({ key: 'PROMO-3', type: 'story', title: 'PROMO-3: [FE] Coupons', slug: 'PROMO-3-coupons' }, TEMPLATE);
    const story = tracker.tickets.create({ type: 'story', key: 'PROMO-3', title: 'PROMO-3: [FE] Coupons', body: rendered.body, labels: ['story'], parent: epic.id, blockedBy: [blocker.id], fields: { severity: 'Medium' }, meta: rendered.meta });
    assert.equal(story.key, 'PROMO-3');
    const got = tracker.tickets.get(`AB-${story.id}`);
    assert.equal(got.id, story.id);
    assert.equal(got.body, TEMPLATE, 'the HTML description converts back to the template exactly');
    assert.equal(got.meta.slug, 'PROMO-3-coupons', 'the metadata block is read back');
    assert.deepEqual(got.blockedBy, [blocker.id]);
    assert.equal(tracker.tickets.get('PROMO-3').id, story.id);
    assert.equal(tracker.tickets.get('epic-checkout').id, epic.id);
    assert.equal(tracker.format.parse(got).edited, false);
    assert.deepEqual(tracker.tickets.children(epic.id).map((t) => t.id).sort(), [blocker.id, story.id].sort());
    assert.equal(tracker.tickets.parent(story.id).id, epic.id);
    tracker.tickets.update(story.id, { labels: { add: ['needs-human'] }, title: 'PROMO-3: [FE] Coupon entry', fields: { impact: 'High' } });
    const after1 = tracker.tickets.get(story.id);
    assert.deepEqual(after1.labels, ['story', 'factory-key-PROMO-3', 'needs-human']);
    assert.equal(after1.meta.key, 'PROMO-3', 'a title edit keeps the metadata');
    assert.deepEqual(tracker.board.fields.get(story.id), { severity: 'Medium', impact: 'High' });
    const st = await fake.state();
    const create = st.requests.find((r) => r.method === 'POST' && r.path.includes('/workitems/$User%20Story'));
    assert.equal(create.contentType, 'application/json-patch+json');
    assert.ok(st.requests.every((r) => r.path.startsWith('/tfs/DefaultCollection/')));
    assert.ok(st.requests.every((r) => /api-version=7\.1/.test(r.search)));
    // The history: the descriptions of earlier revisions.
    assert.ok(tracker.tickets.history(story.id).includes(TEMPLATE));
    assert.equal(tracker.tickets.setParent(story.id, blocker.id), true);
    assert.equal(tracker.tickets.parent(story.id).id, blocker.id);
  });

  it('the metadata block survives a person editing the description', () => {
    const html = `<p>Edited by a person</p>${metaBlock({ key: 'K-1', sourceHash: 'x' })}<p>after</p>`;
    const { meta, html: rest } = splitDescription(html);
    assert.equal(meta.key, 'K-1');
    assert.equal(rest, '<p>Edited by a person</p><p>after</p>');
  });

  it('lists in batches of 200 and pages comments by continuation token', async () => {
    const items = {};
    for (let id = 1000; id < 1205; id++) items[id] = { id, rev: 1, fields: { 'System.Title': `bulk ${id}`, 'System.WorkItemType': 'Task', 'System.State': 'Ready', 'System.Tags': 'bulk' }, relations: [] };
    await fake.seed({ items });
    const bulk = tracker.tickets.list({ label: 'bulk' });
    assert.equal(bulk.length, 205);
    assert.equal(bulk[0].type, 'spike');
    const st = await fake.state();
    assert.equal(st.requests.filter((r) => r.path.endsWith('/workitemsbatch')).at(-1).body.ids.length, 5, 'the second batch');
    for (let i = 0; i < 3; i++) tracker.tickets.comment(1000, `c${i}`);
    tracker.tickets.comment(1000, 'evidence 1\n\n<!-- pipeline-epic-evidence:{"a":1} -->', { marker: 'pipeline-epic-evidence' });
    tracker.tickets.comment(1000, 'evidence 2\n\n<!-- pipeline-epic-evidence:{"a":2} -->', { marker: 'pipeline-epic-evidence' });
    const comments = tracker.tickets.comments(1000);
    assert.equal(comments.length, 4);
    assert.equal(comments[3].body, 'evidence 2\n\n<!-- pipeline-epic-evidence:{"a":2} -->');
  });

  it('attachments, links, lanes, items, setup; 429 retry and a bad token', async () => {
    const a = tracker.tickets.attach(1000, { name: 'Main.html', data: Buffer.from('<html>') });
    const list = tracker.tickets.attachments(1000);
    assert.equal(list[0].name, 'Main.html');
    assert.equal(tracker.tickets.download(list[0]).toString(), '<html>');
    assert.ok(a.sha256);
    tracker.tickets.link(1000, { url: 'https://gitlab.example.com/g/p/-/merge_requests/4', title: 'MR 4' });
    assert.equal(tracker.tickets.link(1000, { url: 'https://gitlab.example.com/g/p/-/merge_requests/4', title: 'MR 4' }).created, false);
    assert.equal(tracker.board.lane(1000), 'ready');
    tracker.board.move(1000, 'testing');
    assert.equal(tracker.board.lane(1000), 'testing');
    assert.equal(tracker.board.items({ lane: 'testing' }).length, 1);
    const s = tracker.board.setup({ dryRun: true });
    assert.ok(s.manual.some((m) => /state "Failed"/.test(m)));
    assert.ok(s.manual.some((m) => /field "Complexity"/.test(m)));
    assert.ok(s.manual.some((m) => /map the states .* to columns/.test(m)));
    await fake.fail({ path: '/_apis/connectionData', status: 503, times: 1, retryAfter: 0 });
    assert.equal(tracker.identity().id, 'u-1');
    process.env.TRACKER_TEST_ADO_BAD = 'nope';
    const bad = trackerFor(baseConfig({ type: 'azure-boards', url: fake.url, project: 'Shop', auth: { token: '${TRACKER_TEST_ADO_BAD}' } }));
    assert.throws(() => bad.tickets.get(1000), (e) => e.code === 'auth');
    assert.throws(() => trackerFor(baseConfig({ type: 'azure-boards', url: fake.url, project: 'Shop', auth: { token: '${TRACKER_TEST_ADO_UNSET}' } })).tickets.get(1), /TRACKER_TEST_ADO_UNSET/);
  });
});

// ---------------------------------------------------------------------------------------------
describe('GitHub tracker (in-memory gh)', () => {
  it('wraps issues, sub-issues, comments and the body format with the same gh calls', () => {
    const hub = fakeGitHub('acme/shop');
    const config = { root: os.tmpdir(), stateDir: '.factory/state', tickets: { repo: 'acme/shop' }, board: { repo: 'acme/shop', columns: LANES, epicLabel: 'epic', storyLabel: 'story' } };
    const tracker = githubTracker(config, { gh: hub.gh });
    const epic = tracker.tickets.create({ title: 'Epic: Checkout', body: 'epic', labels: ['epic'] });
    const { body, meta } = tracker.format.render({ key: 'PROMO-3', type: 'story', title: 'PROMO-3: x', slug: 's', parent: 'epic-checkout' }, TEMPLATE);
    const story = tracker.tickets.create({ title: 'PROMO-3: x', body, labels: ['story'], parent: epic.id });
    assert.equal(story.id, 2);
    assert.deepEqual(tracker.tickets.children(epic.id).map((t) => t.id), [2]);
    const viewed = tracker.tickets.view(2);
    assert.equal(viewed.key, 'PROMO-3');
    assert.equal(tracker.format.parse(viewed).content, TEMPLATE);
    assert.equal(meta.key, 'PROMO-3');
    assert.deepEqual(tracker.tickets.list().map((t) => t.id), [1, 2]);
    tracker.tickets.update(2, { labels: { add: ['needs-human'] } });
    assert.ok(hub.issues.get(2).labels.includes('needs-human'));
    assert.ok(hub.calls.some((c) => c[0] === 'issue' && c[1] === 'create' && c.includes('--body-file')));
  });
});
