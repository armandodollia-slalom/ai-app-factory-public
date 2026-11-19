// D-C7-3: tickets closed as not planned (spent held-out tickets) were moved to Done and given late outcomes.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { abandonedReason, recordAbandoned } from '../lib/outcomes.mjs';

test('a ticket closed as not planned is abandoned, recorded once; a completed one is not', () => {
  assert.equal(abandonedReason({ state: 'CLOSED', stateReason: 'NOT_PLANNED' }), 'NOT_PLANNED');
  assert.equal(abandonedReason({ state: 'CLOSED', stateReason: 'duplicate' }), 'DUPLICATE');
  assert.equal(abandonedReason({ state: 'CLOSED', stateReason: 'COMPLETED' }), null);
  assert.equal(abandonedReason({ state: 'CLOSED' }), null);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'abandoned-'));
  const config = { root, stateDir: '.factory/state', metricsDir: '.factory/metrics' };
  const rec = recordAbandoned(config, 'X-1', 'NOT_PLANNED');
  assert.deepEqual([rec.type, rec.story, rec.reason], ['abandoned', 'X-1', 'not_planned']);
  assert.equal(recordAbandoned(config, 'X-1', 'NOT_PLANNED'), null, 'once');
});
