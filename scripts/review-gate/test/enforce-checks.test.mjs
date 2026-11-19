// Council C9 (Opus route B): `review-gate enforce` wrote a ruleset requiring review-quorum only, so GitHub could merge a
// head whose CI had not run. The ruleset now also requires the CI checks that run for every pull request, and doctor
// reports a ruleset that requires less.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { defaultRequiredChecks, desiredRuleset } from '../lib/enforcement.mjs';
import { reviewEnforcement } from '../../factory/lib/github.mjs';

function repoWith(workflows) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'enforce-'));
  fs.mkdirSync(path.join(root, '.github', 'workflows'), { recursive: true });
  for (const [f, text] of Object.entries(workflows)) fs.writeFileSync(path.join(root, '.github', 'workflows', f), text);
  return root;
}

test('the default required checks are the jobs of the workflows that run for every pull request', () => {
  const root = repoWith({
    'factory-gate.yml': 'name: AI app factory\non:\n  pull_request:\njobs:\n  pipeline: {runs-on: x}\n  policy: {runs-on: x}\n  lint: {runs-on: x}\n  feature-verification:\n    uses: ./.github/workflows/fv.yml\n',
    'fv.yml': 'name: fv\non:\n  workflow_call:\njobs:\n  check: {runs-on: x}\n',
    'markdownlint.yml': 'name: Markdownlint\non:\n  pull_request:\njobs:\n  lint: {runs-on: x}\n',
    'pr-validation.yml': "name: v\non:\n  pull_request:\n    paths-ignore: ['**.md']\njobs:\n  test: {runs-on: x}\n",
    'playwright.yml': 'name: p\non:\n  pull_request:\n    branches: [main]\njobs:\n  test: {runs-on: x}\n',
    'demo.yml': "name: PR demo video\non:\n  pull_request:\n    types: [opened, synchronize, closed]\njobs:\n  record:\n    if: github.event.action != 'closed'\n    runs-on: x\n  cleanup:\n    if: github.event.action == 'closed'\n    runs-on: x\n",
    'pr-check.yml': 'name: PR check\non:\n  pull_request:\n    types: [labeled, synchronize]\njobs:\n  check: {runs-on: x}\n',
    'quorum.yml': 'name: review-quorum\non:\n  pull_request:\njobs:\n  review-quorum: {runs-on: x}\n',
    'matrix.yml': 'name: m\non: pull_request\njobs:\n  build:\n    strategy: {matrix: {os: [a, b]}}\n    runs-on: x\n',
  });
  assert.deepEqual(defaultRequiredChecks(root), ['feature-verification / check', 'lint', 'pipeline', 'policy', 'record']);
  const rule = desiredRuleset('main', { codeOwners: false, requiredChecks: defaultRequiredChecks(root) }).rules[0];
  assert.deepEqual(rule.parameters.required_status_checks.map((c) => c.context), ['review-quorum', 'feature-verification / check', 'lint', 'pipeline', 'policy', 'record']);
});

test('doctor reports a ruleset that requires review-quorum but not the CI checks', () => {
  const ruleset = (contexts) => (args) => {
    if (args[1] === 'repos/a/b') return { status: 0, stdout: 'main' };
    if (args[1] === 'repos/a/b/rules/branches/main') return { status: 0, stdout: JSON.stringify([{ type: 'required_status_checks', parameters: { required_status_checks: contexts.map((context) => ({ context })) } }]) };
    return { status: 1, stdout: '', stderr: 'HTTP 404 Branch not protected' };
  };
  const review = { satisfiable: false, reason: 'no other code owner' };
  const [ok, note] = reviewEnforcement('a/b', ruleset(['review-quorum']), { review, requiredChecks: ['pipeline', 'lint'] });
  assert.equal(ok, false);
  assert.match(note, /does not require the CI checks pipeline, lint/);
  assert.equal(reviewEnforcement('a/b', ruleset(['review-quorum', 'pipeline', 'lint']), { review, requiredChecks: ['pipeline', 'lint'] })[0], true);
});

test('the reuse job a story-branch workflow renders is not a check to require', async () => {
  const { withBranchRuns } = await import('../../factory/lib/pre-open-ci.mjs');
  const gate = withBranchRuns('name: AI app factory\non:\n  pull_request:\njobs:\n  pipeline: {runs-on: x}\n  lint: {runs-on: x}\n', { patterns: ['feat/**'] });
  const analysis = withBranchRuns('name: Static analysis\non:\n  pull_request:\njobs:\n  sast: {name: Security patterns (SAST), runs-on: x}\n', { patterns: ['feat/**'] });
  assert.match(gate, /^ {2}reuse:/m);
  const root = repoWith({ 'factory-gate.yml': gate, 'factory-analysis.yml': analysis });
  assert.deepEqual(defaultRequiredChecks(root), ['Security patterns (SAST)', 'lint', 'pipeline']);
});
