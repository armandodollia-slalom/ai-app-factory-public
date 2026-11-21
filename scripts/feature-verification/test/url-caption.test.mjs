// The URL caption is drawn by the fixture itself, and a missing caption is not a blocking finding when the recorded steps
// prove the navigation (dogfood C15, C17, C23: test automation rounds spent on "no keyframe shows the URL").
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { demoteUrlCaptionGaps, navigationProof } from '../lib/verify.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..', '..', '..');
const R1 = JSON.parse(fs.readFileSync(path.join(here, 'fixtures-surp1-automation-r1.json'), 'utf8'));

test('SURP-1 replay: the five "no keyframe shows the URL or path caption" items of automation round 1 are notes when the spec asserts the URL', () => {
  const verdict = { score: 7, passed: false, gaps: R1.gaps, notes: [] };
  const spec = new Map([['e2e/teststack/surp-1.spec.ts', new Set(['TC-SURP-1-14'])]]);
  const proven = navigationProof({ root: '/x' }, { key: 'SURP-1' }, { files: spec, read: () => "await expect(page).toHaveURL(/\\/item\\/\\d+$/);" });
  const v = demoteUrlCaptionGaps(verdict, { navigationProven: proven, requiredScore: 9 });
  assert.equal(v.demotedUrlCaption, 5);
  assert.deepEqual(v.gaps, []);
  assert.equal(v.passed, true, 'a round whose only gaps were captions passes');
  assert.equal(v.notes.length, 5);
  // With a real gap as well the round still fails, without the caption items.
  const real = { case: 'TC-SURP-1-08', category: 'wrong-assertion', detail: 'The test asserts status 200 but the case expects 404 for a no-match pick.' };
  const mixed = demoteUrlCaptionGaps({ score: 7, passed: false, gaps: [...R1.gaps, real], notes: [] }, { navigationProven: proven, requiredScore: 9 });
  assert.equal(mixed.passed, false);
  assert.equal(mixed.gaps.length, 1);
  // Without proof of the navigation the gap stands.
  const none = demoteUrlCaptionGaps(verdict, { navigationProven: () => false, requiredScore: 9 });
  assert.equal(none.gaps.length, 5);
});

test('the fixture draws the URL on every keyframe and in the video, and lists it in keyframes/index.jsonl', () => {
  const fixtures = fs.readFileSync(path.join(ROOT, 'templates/e2e/fixtures.ts'), 'utf8');
  const capture = fixtures.slice(fixtures.indexOf('export async function captureKeyframe'));
  assert.ok(capture.indexOf('stampUrl(page)') < capture.indexOf('page.screenshot('), 'stamped before the screenshot');
  assert.match(capture, /unstampUrl\(page\)/);
  assert.match(capture, /index\.jsonl/);
  assert.match(fixtures, /attachShadow\(\{ mode: 'closed' \}\)/, 'test locators cannot see the caption');
  const demo = fs.readFileSync(path.join(ROOT, 'templates/e2e/demo.ts'), 'utf8');
  assert.match(demo, /page\.on\('framenavigated'/);
  // The URL caption is redacted before it is drawn (no secret in a query string reaches the video).
  assert.match(demo, /const url = \(await detector\(\)\)\(page\.url\(\)\)\.text;/);
  assert.match(demo, /URL \$\{escapeHtml\(url\)\}/);
});
