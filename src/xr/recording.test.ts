import test from 'node:test';
import assert from 'node:assert/strict';
import { Euler, MathUtils, Quaternion } from 'three';
import { createObject, evaluateTransform, History } from '../model';
import { validateAnimation } from '../animation/model';
import { XRRecording, processRecording, interpolatePose, type PoseSample } from './recording';
import type { SceneObject, Transform } from '../types';

const pose = (x: number, yaw = 0): Transform => ({ position: [x, 0, -2], rotation: [0, yaw, 0], scale: [1, 1, 1] });
const q = (value: Transform) => new Quaternion().setFromEuler(new Euler(...value.rotation.map(MathUtils.degToRad) as [number, number, number]));

test('straight constant-speed recordings reduce to endpoints, even with small hand jitter', () => {
  for (const noise of [0, .006]) {
    const raw = Array.from({length: 301}, (_, i) => ({time: i / 30, transform: pose(i / 30 + (i > 0 && i < 300 ? Math.sin(i * 2) * noise : 0))}));
    const reduced = processRecording(raw);
    assert.equal(reduced.length, 2);
    assert.deepEqual(reduced[0], raw[0]); assert.deepEqual(reduced[1], raw.at(-1));
  }
});

test('sparse recording keeps significant turns and the timing of a stop', () => {
  const raw = Array.from({length: 121}, (_, i) => {
    const t = i / 30, transform = pose(t < 1 ? t : t < 2 ? 1 : 3 - t, t < 2 ? 0 : (t - 2) * 45);
    return {time: t, transform};
  });
  const reduced = processRecording(raw);
  assert.ok(reduced.length <= 12, `Expected a sparse take, got ${reduced.length}`);
  const at = (time: number) => {
    const next = reduced.findIndex(sample => sample.time >= time);
    const a = reduced[Math.max(0, next - 1)], b = reduced[next];
    return interpolatePose(a.transform, b.transform, b.time === a.time ? 0 : (time - a.time) / (b.time - a.time));
  };
  for (const t of [1.1, 1.5, 1.9]) assert.ok(Math.abs(at(t).position[0] - 1) <= .02);
  assert.ok(reduced.some(sample => Math.abs(sample.time - 1) <= .1));
  assert.ok(reduced.some(sample => Math.abs(sample.time - 2) <= .1));
  assert.ok(q(at(3)).angleTo(q(pose(0, 45))) <= MathUtils.degToRad(3));
});

test('XR take is isolated until apply, preserves out-of-range keys and scale, and supports one-step undo', () => {
  const item = createObject('cube', 1); item.transform = pose(0);
  item.animation = { takes: [], curves: {
    'position.x': [0, 1, 2, 3, 4].map(time => ({ time, value: time, interpolation: 'linear' })),
    'scale.x': [{ time: 0, value: 1, interpolation: 'linear' }, { time: 4, value: 2, interpolation: 'linear' }],
  } };
  const before = structuredClone(item), history = new History<SceneObject>(item), session = new XRRecording(item, 1, 4);
  assert.equal(session.mode, 'armed'); session.begin(1000);
  for (let i = 1; i <= 90; i++) session.sample(pose(1 + i / 90, i / 90 * 45), 1000 + i * 1000 / 90);
  session.stop(); assert.equal(session.mode, 'review'); assert.deepEqual(item, before);
  assert.equal(session.state().samples, 31); assert.ok(session.state().keys! < 15);
  const next = session.apply(); validateAnimation(next.animation, 4);
  assert.deepEqual(next.animation!.curves['scale.x'], before.animation!.curves['scale.x']);
  assert.deepEqual(next.animation!.curves['position.x']!.filter(key => key.time < 1 || key.time > 2), before.animation!.curves['position.x']!.filter(key => key.time < 1 || key.time > 2));
  assert.equal(next.animation!.takes.length, 1);
  assert.ok(Math.abs(evaluateTransform(next, 2).position[0] - 2) < 1e-8);
  history.commit(next); assert.deepEqual(history.undo(), before); assert.deepEqual(history.redo(), next);
  session.togglePreview(); session.advance(.5); assert.equal(session.time, 1.5);
  assert.deepEqual(session.preview(1.5), evaluateTransform(next, 1.5));
  session.advance(5); assert.equal(session.previewing, false); assert.equal(session.time, 2);
});

test('tracking cancellation, very short gestures and scene-end stopping never commit partial motion', () => {
  const item = createObject('cube', 1); item.transform = pose(0);
  const session = new XRRecording(item, 0, 2);
  session.begin(0); session.sample(pose(5), 50); session.stop();
  assert.equal(session.mode, 'armed'); assert.equal(session.time, 0); assert.deepEqual(session.pose, pose(0));
  session.begin(100); session.sample(pose(2), 500); session.cancelGrip();
  assert.equal(session.mode, 'armed'); assert.deepEqual(session.pose, pose(0));
  assert.throws(() => session.apply());
  session.begin(1000); session.sample(pose(4), 4000);
  assert.equal(session.mode, 'review'); assert.equal(session.apply().animation!.takes[0].end, 2);
  assert.throws(() => new XRRecording(item, 1.95, 2));
  assert.deepEqual(item.transform, pose(0));
});

test('smoothing removes jitter, preserves endpoints and rotations cross 180 degrees by the shortest arc', () => {
  const raw: PoseSample[] = Array.from({ length: 61 }, (_, i) => ({ time: i / 30, transform: pose(i / 30 + (i && i < 60 ? (i % 2 ? .003 : -.003) : 0), 170 + i / 3) }));
  const original = structuredClone(raw), processed = processRecording(raw);
  assert.deepEqual(raw, original); assert.deepEqual(processed[0], raw[0]); assert.deepEqual(processed.at(-1), raw.at(-1));
  assert.ok(processed.length < raw.length / 3);
  const middle = interpolatePose(pose(0, 179), pose(0, -179), .5);
  assert.ok(q(middle).angleTo(q(pose(0, 180))) < 1e-6);
  for (const sample of processed) assert.ok(Number.isFinite(sample.transform.rotation[1]));
});

test('sampling at different headset rates produces the same processed linear trajectory', () => {
  const item = createObject('cube', 1); item.transform = pose(0);
  const run = (rate: number) => {
    const session = new XRRecording(item, 0, 3); session.begin(0);
    for (let i = 1; i <= rate; i++) session.sample(pose(i / rate), i * 1000 / rate);
    session.stop(); return session;
  };
  const a = run(60), b = run(90);
  assert.equal(a.state().samples, b.state().samples);
  for (const time of [0, .2, .5, .8, 1]) assert.ok(Math.abs(a.preview(time).position[0] - b.preview(time).position[0]) < 1e-8);
});
