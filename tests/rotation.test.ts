import test from 'node:test';
import assert from 'node:assert/strict';
import { Euler, MathUtils, Matrix4, Quaternion, Vector3 } from 'three';
import { eulerDegrees } from '../src/rotation.ts';

const quaternion = (degrees: number[]) => new Quaternion().setFromEuler(new Euler(...degrees.map(MathUtils.degToRad) as [number, number, number], 'XYZ'));
const close = (actual: number[], expected: number[]) => actual.forEach((value, i) => assert.ok(Math.abs(value - expected[i]) < 1e-6, `${actual} ≈ ${expected}`));

test('a turn past 90° reads as yaw, not as ±180 flips', () => {
  for (const yaw of [100, 167.2, -135, 180, -179]) close(eulerDegrees(new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), MathUtils.degToRad(yaw))), [0, yaw, 0]);
  close(eulerDegrees(quaternion([180, -12.822, 180])), [0, -167.178, 0]);
});

test('both forms describe the same rotation and tilted cameras keep their pitch', () => {
  for (const degrees of [[-20, 150, 0], [30, -100, 5], [10, 45, -3], [170, 20, -160]]) {
    const q = quaternion(degrees), result = eulerDegrees(q);
    assert.ok(quaternion(result).angleTo(q) < 1e-6);
    assert.ok(Math.abs(result[0]) + Math.abs(result[2]) <= Math.abs(degrees[0]) + Math.abs(degrees[2]) + 1e-6);
  }
  const look = eulerDegrees(new Matrix4().lookAt(new Vector3(0, 2, -5), new Vector3(0, 1, 0), new Vector3(0, 1, 0)));
  assert.ok(Math.abs(look[1]) > 170 && Math.abs(look[0]) < 20 && Math.abs(look[2]) < 1e-6, String(look));
});
