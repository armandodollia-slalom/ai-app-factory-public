import assert from 'node:assert/strict';
import { test } from 'node:test';

// Council C3 (cost): six videos at 48 frames each made the video critic the most expensive step.
test('frames are budgeted across all of a PR\'s videos', async () => {
  const { framesPerVideo } = await import('../lib/video.mjs');
  const o = { maxFrames: 48, maxTotalFrames: 60, minFramesPerVideo: 6 };
  assert.equal(framesPerVideo(o, 1), 48);
  assert.equal(framesPerVideo(o, 6), 10);
  assert.equal(framesPerVideo(o, 20), 6, 'never fewer than the minimum per video');
});
