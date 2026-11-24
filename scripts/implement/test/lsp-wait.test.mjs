import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { lspAdapter } from '../lib/lsp.mjs';
import { lspSection } from '../lib/implement.mjs';

// A fake lspd: `start` answers "slots are in use" until its counter file reaches `freeAfter`.
function fakeLspd(dir, freeAfter) {
  const script = path.join(dir, 'lspd.mjs');
  fs.writeFileSync(script, `import fs from 'node:fs';
const f = ${JSON.stringify(path.join(dir, 'count'))};
const n = (fs.existsSync(f) ? Number(fs.readFileSync(f, 'utf8')) : 0) + 1;
fs.writeFileSync(f, String(n));
const busy = n <= ${freeAfter};
console.log(JSON.stringify({ ok: true, leased: busy ? 'unavailable' : 'running', servers: { csharp: busy ? { status: 'unavailable', reason: 'all 1 leased language server slots are in use (/wt/other)' } : { status: 'running' } } }));
`);
  return script;
}
const config = (dir, script, extra = {}) => ({ root: dir, lsp: { client: { lspdCmd: [process.execPath, script], leaseWaitPollSec: 0.05, ...extra } } });

// Dogfood C5: CHK-1 started without the C# server because a finished run held the only slot.
test('a run waits a bounded time for a free language server slot, and records what it had to go without', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lsp-wait-'));
  const freed = lspAdapter(config(dir, fakeLspd(dir, 2), { leaseWaitSec: 30 }), { mainRoot: dir });
  const r = await freed.start(dir);
  assert.equal(r.servers.csharp.status, 'running', 'the slot freed while it waited');
  assert.equal(fs.readFileSync(path.join(dir, 'count'), 'utf8'), '3');
  assert.deepEqual(freed.unavailable(dir), []);

  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'lsp-wait-'));
  const never = lspAdapter(config(dir2, fakeLspd(dir2, 1000), { leaseWaitSec: 0.2 }), { mainRoot: dir2 });
  await never.start(dir2);
  assert.match(never.unavailable(dir2)[0], /^csharp \(all 1 leased language server slots are in use/);
  assert.match(lspSection(never.unavailable(dir2)), /^- Code intelligence: this run went without csharp \(all 1 leased/);
  assert.equal(lspSection([]), '');
});
