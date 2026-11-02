import { Euler, MathUtils, Matrix4, Quaternion } from 'three';
import type { Vec3 } from './types.ts';

const wrap = (degrees: number): number => {
  const value = ((degrees + 180) % 360 + 360) % 360 - 180;
  return value === -180 ? 180 : value;
};

/**
 * XYZ Euler degrees for a rotation. Every rotation has two XYZ forms, (x, y, z) and (x+180, 180-y, z+180).
 * Three.js picks by |y| ≤ 90, so turning a standing person past 90° reads as (180, 80, 180). This keeps the
 * form whose X and Z stay nearest zero, so a pure turn always reads as yaw.
 */
export function eulerDegrees(rotation: Quaternion | Matrix4): Vec3 {
  const euler = rotation instanceof Matrix4 ? new Euler().setFromRotationMatrix(rotation, 'XYZ') : new Euler().setFromQuaternion(rotation, 'XYZ');
  const direct = [euler.x, euler.y, euler.z].map(MathUtils.radToDeg) as Vec3;
  const flipped: Vec3 = [wrap(direct[0] + 180), wrap(180 - direct[1]), wrap(direct[2] + 180)];
  const tilt = (value: Vec3) => Math.abs(value[0]) + Math.abs(value[2]);
  return (tilt(flipped) < tilt(direct) - 1e-9 ? flipped : direct).map(value => Math.abs(value) < 1e-9 ? 0 : value) as Vec3;
}
