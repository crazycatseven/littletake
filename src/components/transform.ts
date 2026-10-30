import { Euler, MathUtils, Quaternion, Vector3 } from 'three';
import type { ObjectComponent } from './model.ts';
import type { Transform, Vec3 } from '../types.ts';

export const activePivot = (components: ObjectComponent[] = []) => components.find(c => c.type === 'pivot' && c.enabled) as Extract<ObjectComponent, {type:'pivot'}> | undefined;

function offsetInWorld(pose: Transform, components?: ObjectComponent[]): Vector3 {
  const pivot = activePivot(components);
  if (!pivot) return new Vector3();
  const rotation = new Quaternion().setFromEuler(new Euler(...pose.rotation.map(MathUtils.degToRad) as Vec3, 'XYZ'));
  return new Vector3(...pivot.offset).multiply(new Vector3(...pose.scale)).applyQuaternion(rotation);
}

/** Geometry poses stay authoritative; the editable pivot is a separate local offset. */
export function toPivotPose(pose: Transform, components?: ObjectComponent[]): Transform {
  return {...structuredClone(pose), position: new Vector3(...pose.position).add(offsetInWorld(pose, components)).toArray() as Vec3};
}

export function fromPivotPose(pose: Transform, components?: ObjectComponent[]): Transform {
  return {...structuredClone(pose), position: new Vector3(...pose.position).sub(offsetInWorld(pose, components)).toArray() as Vec3};
}

/** Compensate an input transform around its pivot, preserving any requested translation. */
export function applyTransformModifiers(before: Transform, after: Transform, components?: ObjectComponent[]): void {
  if (!activePivot(components)) return;
  after.position = new Vector3(...after.position).add(offsetInWorld(before, components).sub(offsetInWorld(after, components))).toArray() as Vec3;
}
