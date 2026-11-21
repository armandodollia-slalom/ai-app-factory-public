// A host rule that requires a check no workflow of the checkout provides holds every PR for ever. Dogfood: a release
// removed the CI demo-video workflow, its `record` job stayed required in the branch ruleset, and every PR (the pin PR
// with all its checks green) was BLOCKED until a person ran `factory review-gate enforce`. Doctor flags it, render says
// so when it removes a check, and enforce writes exactly the checks the shipped workflows run.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { providedChecks, defaultRequiredChecks } from '../../pipeline/lib/ci/github-actions.mjs';
import { reviewEnforcement, unprovidedRequired } from '../lib/code-host.mjs';
import { desiredRuleset } from '../../pipeline/lib/hosts/index.mjs';

const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'req-checks-')));
const workflow = (root, file, text) => {
  fs.mkdirSync(path.join(root, '.github/workflows'), { recursive: true });
  fs.writeFileSync(path.join(root, '.github/workflows', file), text);
};

function shippedRepo() {
  const root = tmp();
  workflow(root, 'factory-gate.yml', 'name: AI app factory\non:\n  pull_request:\njobs:\n  lint:\n    runs-on: ubuntu-latest\n    steps: [{ run: "true" }]\n  pipeline:\n    runs-on: ubuntu-latest\n    steps: [{ run: "true" }]\n');
  workflow(root, 'tests.yml', 'name: eShop tests\non:\n  pull_request:\njobs:\n  test:\n    name: eShop tests\n    runs-on: ubuntu-latest\n    strategy: { matrix: { os: [a, b] } }\n    steps: [{ run: "true" }]\n');
  return root;
}

test('providedChecks lists every check a pull request can produce; unprovidedRequired finds the required ones no workflow runs', () => {
  const root = shippedRepo();
  assert.deepEqual(providedChecks(root), ['eShop tests', 'lint', 'pipeline']);
  // review-quorum is the gate's own status; a matrix job's checks are "<name> (<entry>)".
  assert.deepEqual(unprovidedRequired(['review-quorum', 'lint', 'pipeline', 'eShop tests (a)', 'record'], providedChecks(root)), ['record']);
  // A CI system that cannot list its checks flags nothing.
  assert.deepEqual(unprovidedRequired(['record'], null), []);
  // What enforce writes is derived from the shipped workflows, so it never requires a check they do not run.
  const want = desiredRuleset('main', { codeOwners: false, requiredChecks: defaultRequiredChecks(root) });
  const contexts = JSON.stringify(want).match(/"context":"[^"]+"/g).map((c) => c.slice(11, -1));
  assert.deepEqual(unprovidedRequired(contexts, providedChecks(root)), []);
});

test('doctor: a host rule that requires a check no shipped workflow provides is flagged, with the way out', () => {
  const root = shippedRepo();
  const host = (requiredChecks) => ({
    repo: Object.assign(Object.create(null), { toString: () => 'o/r', branchProtection: () => ({ enforced: true, branch: 'main', requiredChecks, requiredApprovals: 0, codeOwnerReview: false, via: ['ruleset'] }) }),
    pr: {},
    capabilities: { codeOwners: false },
    label: 'GitHub',
  });
  const stale = reviewEnforcement(host(['review-quorum', 'lint', 'pipeline', 'record']), null, { requiredChecks: ['lint', 'pipeline'], provided: providedChecks(root) });
  assert.equal(stale[0], false);
  assert.match(stale[1], /o\/r's main requires "record", which no workflow in this checkout provides: every PR waits for it for ever\. Run 'factory review-gate enforce --dry-run', then 'factory review-gate enforce'/);
  const fine = reviewEnforcement(host(['review-quorum', 'lint', 'pipeline']), null, { requiredChecks: ['lint', 'pipeline'], provided: providedChecks(root) });
  assert.equal(fine[0], true, fine[1]);
});
