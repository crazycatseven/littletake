import assert from 'node:assert/strict';
import test from 'node:test';
import { trimRange } from './timeline.ts';

test('trim at an exact off-frame cut, move the clip by either edge and keep at least one frame', () => {
  const fps = 24, cut = 3.47, cuts = [0, cut, 8];
  const trimmed = trimRange('end', 3.5, { start: 1, end: 4 }, 8, fps, cuts, .05);
  assert.equal(trimmed.end, cut);
  const moved = trimRange('range', cut + .02, trimmed, 8, fps, cuts, .05);
  assert.equal(moved.start, cut);
  assert.ok(Math.abs(moved.end - moved.start - (trimmed.end - trimmed.start)) < 1e-8);
  const atEnd = trimRange('range', 8 - (cut - 1) - .02, trimmed, 8, fps, cuts, .05);
  assert.equal(atEnd.end, 8);
  const oneFrame = trimRange('start', 8, trimmed, 8, fps, cuts, .05);
  assert.ok(Math.abs(oneFrame.end - oneFrame.start - 1/fps) < 1e-8);
  assert.equal(trimRange('end', 3.5, trimmed, 8, fps, [], .05).end, 3.5);
});
