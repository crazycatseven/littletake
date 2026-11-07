import test from 'node:test';
import assert from 'node:assert/strict';
import { pixelInCrop } from './renderer.ts';

test('depth calibration reads render-target rows bottom-up when applying the camera crop', () => {
  const topHalf = [0, 0, 1, .5];
  assert.equal(pixelInCrop(0, 160, 90, topHalf), false, 'the first pixel read is the bottom-left corner');
  assert.equal(pixelInCrop(160 * 89, 160, 90, topHalf), true, 'the last row read is the top of the frame');
  assert.equal(pixelInCrop(159, 160, 90, [0, 0, .5, 1]), false, 'the end of a row is the right edge');
  let inside = 0; for (let pixel = 0; pixel < 160 * 90; pixel++) if (pixelInCrop(pixel, 160, 90, [.25, .25, .75, .75])) inside++;
  assert.equal(inside, 80 * 46);
});
