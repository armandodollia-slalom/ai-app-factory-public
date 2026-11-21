// Every place a finding is handed to an agent routes it by what resolves it (finding-route.mjs), with no exception for a
// pair kind or a stage (dogfood C23 at the PR check, C24 at the bug-fix pair: a test gap reached an agent that writes
// production code only). This guard enumerates the hand-off sites in the harness's code and fails when one carries no
// routing marker, or names a router the file does not call. A new site must say how it routes (or that it is not an agent).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const scripts = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
// What builds an agent's text from findings, gaps or bugs.
const HANDOFF = /\b(formatBugs|formatGaps|formatFindings|returnTask|pairImplementerTask|escalationTask|integrationTask|fixTaskText|feedbackLog\.given)\(/;
const DEFINITION = /^\s*(export )?(async )?function |^\s*export const \w+ = /;
const ROUTERS = ['pairHandoff', 'routeToRole', 'routeFindings', 'handOffTestGaps', 'productGapsOf', 'resolvesGiven'];
const MARKER = /\/\/ (route|not-routed|not-an-agent|task-builder): ?(.*)$/;

function sources(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!['test', 'node_modules', 'fixtures'].includes(e.name)) sources(p, out);
    } else if (e.name.endsWith('.mjs')) out.push(p);
  }
  return out;
}

export function handoffSites() {
  const sites = [];
  for (const file of sources(scripts)) {
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (!HANDOFF.test(line) || DEFINITION.test(line) || /^\s*\/\//.test(line)) return;
      let marker = null;
      for (let j = i; j >= Math.max(0, i - 8) && !marker; j--) {
        const m = lines[j].match(MARKER);
        if (m) marker = { kind: m[1], text: m[2] };
      }
      sites.push({ file: path.relative(scripts, file), line: i + 1, marker, source: lines.join('\n') });
    });
  }
  return sites;
}

test('every hand-off of findings to an agent is routed, or says why it is not an agent hand-off', () => {
  const sites = handoffSites();
  const all = sources(scripts).map((f) => fs.readFileSync(f, 'utf8')).join('\n');
  const callers = new Set(ROUTERS.filter((r) => new RegExp(`[^\\w.]${r}\\(`).test(all.replace(new RegExp(`(export )?(async )?function ${r}\\(|export const ${r} =`, 'g'), ''))));
  assert.ok(sites.length >= 30, `the scan found ${sites.length} sites; the pattern no longer matches the code`);
  const bare = sites.filter((s) => !s.marker).map((s) => `${s.file}:${s.line}`);
  assert.deepEqual(bare, [], 'hand-off sites with no routing marker');
  for (const s of sites.filter((x) => x.marker.kind === 'route')) {
    const router = ROUTERS.find((r) => s.marker.text.startsWith(r));
    assert.ok(router, `${s.file}:${s.line} names no known router: "${s.marker.text}"`);
    // Routed here, or upstream in the file that hands this site its findings (the marker says which).
    const here = new RegExp(`\\b${router}\\(`).test(s.source);
    assert.ok(here || /\(.+\)/.test(s.marker.text), `${s.file}:${s.line} says ${router}, its file never calls it and the marker does not say where it is routed`);
    assert.ok(callers.has(router), `${router} is called nowhere in the harness`);
  }
  // Every pair kind: the pair loop routes every round through pairHandoff, with no self-mode exception.
  const orchestrate = fs.readFileSync(path.join(scripts, 'implement/lib/orchestrate.mjs'), 'utf8');
  assert.match(orchestrate, /const handoff = pairHandoff\(blocking/);
  assert.doesNotMatch(orchestrate, /st\.self \? \{ mine: blocking/, 'a self-mode or later-change pair bypasses routing');
  // Not-routed sites are tool findings only.
  for (const s of sites.filter((x) => x.marker.kind === 'not-routed')) assert.match(s.marker.text, /^tool findings/, `${s.file}:${s.line}`);
});

test('the guard catches a bypass: an unmarked hand-off is reported', () => {
  const fake = ['function x(findings) {', '  feedback = `Fix these:\\n${formatFindings(findings)}`;', '}'].join('\n');
  const lines = fake.split('\n');
  const hit = lines.findIndex((l) => HANDOFF.test(l) && !DEFINITION.test(l));
  assert.equal(hit, 1);
  assert.ok(!lines.slice(0, 2).some((l) => MARKER.test(l)));
});
