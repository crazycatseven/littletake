import assert from 'node:assert/strict';
import test from 'node:test';
import { createObject, evaluateTransform } from '../model';
import { transformSelection } from './transforms';
import { validateAnimation } from '../animation/model';

test('near-grab rotation edits only the current legacy key and keeps quaternion metadata valid', () => {
  const item = createObject('cube', 1), from = structuredClone(item.transform), to = structuredClone(from);
  to.rotation = [30, 60, 10];
  item.track = { start: 0, duration: 2, from, to, samples: [{ at: .5, transform: structuredClone(from) }] };
  const pose = evaluateTransform(item, 1); pose.rotation = [20, 40, 15];
  const [edited] = transformSelection([item], [{ id: item.id, transform: pose }], 1, 'keyframe-pose');
  evaluateTransform(edited, 1).rotation.forEach((value, index) => assert.ok(Math.abs(value - pose.rotation[index]) < 1e-8));
  for (const time of [0, 2]) assert.deepEqual(evaluateTransform(edited, time), evaluateTransform(item, time));
  validateAnimation(edited.animation, 2);
  for (const axis of ['x', 'y', 'z']) assert.deepEqual(edited.animation!.curves[`rotation.${axis}` as 'rotation.x']![1].orientation, pose.rotation);
});

test('XR translation updates only the current key, preserving metadata and other poses', () => {
  const item = createObject('cube', 1);
  item.animation = { takes: [], curves: {
    'position.x': [0, 1, 2].map(time => ({ time, value: time, interpolation: 'smooth' as const })),
    'rotation.y': [{ time: 0, value: 0, interpolation: 'linear' }, { time: 2, value: 90, interpolation: 'linear' }],
  } };
  const original = structuredClone(item), pose = evaluateTransform(item, 1);
  pose.position[0] += 3; pose.position[1] += 2;
  const [edited] = transformSelection([item], [{ id: item.id, transform: pose }], 1, 'keyframe-pose');
  assert.deepEqual(evaluateTransform(edited, 1), pose);
  for (const time of [0, 2]) assert.deepEqual(evaluateTransform(edited, time), evaluateTransform(original, time));
  assert.deepEqual(edited.animation!.curves['position.x'], [
    { time: 0, value: 0, interpolation: 'smooth' },
    { time: 1, value: 4, interpolation: 'smooth' },
    { time: 2, value: 2, interpolation: 'smooth' },
  ]);
  assert.deepEqual(edited.animation!.curves['rotation.y'], original.animation!.curves['rotation.y']);
  assert.deepEqual(edited.transform, original.transform);
  assert.deepEqual(item, original);
  // Every drag sample is calculated from the transaction snapshot; returning
  // to the starting pose leaves no inserted keys or undo entry.
  assert.deepEqual(transformSelection([item], [{ id: item.id, transform: evaluateTransform(item, 1) }], 1, 'keyframe-pose'), [original]);
});

test('XR key editing handles legacy samples and exact-time tolerance without shifting other samples', () => {
  const item = createObject('cube', 1), from = structuredClone(item.transform), to = structuredClone(from);
  to.position[0] += 4;
  const middle = structuredClone(from); middle.position[0] += 2;
  item.track = { start: 0, duration: 2, from, to, samples: [{ at: .5, transform: middle }] };
  const pose = evaluateTransform(item, 1); pose.position[2] += 1;
  const [edited] = transformSelection([item], [{ id: item.id, transform: pose }], 1 + 1e-9, 'keyframe-pose');
  assert.equal(edited.track, null);
  assert.deepEqual(evaluateTransform(edited, 1), pose);
  for (const time of [0, 2]) assert.deepEqual(evaluateTransform(edited, time), evaluateTransform(item, time));
  assert.equal(edited.animation!.curves['position.z']!.length, 3);
});

test('XR between keys retains whole-motion translation and static objects still move', () => {
  const item = createObject('cube', 1);
  item.animation = { takes: [], curves: { 'position.x': [0, 2].map(time => ({ time, value: time, interpolation: 'linear' as const })) } };
  const pose = evaluateTransform(item, 1); pose.position[0] += 3;
  assert.deepEqual(transformSelection([item], [{ id: item.id, transform: pose }], 1, 'keyframe-pose'),
    transformSelection([item], [{ id: item.id, transform: pose }], 1, true));
  delete item.animation;
  assert.deepEqual(transformSelection([item], [{ id: item.id, transform: pose }], 1, 'keyframe-pose')[0].transform, pose);
});
