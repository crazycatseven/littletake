import { Euler, Matrix4, MathUtils, Quaternion, Vector3 } from 'three';
import type { Part } from './schema.ts';
import type { Vec3 } from '../../types.ts';

export const localMatrix = (part: Part) => new Matrix4().compose(new Vector3(...part.position), new Quaternion().setFromEuler(new Euler(...part.rotation.map(MathUtils.degToRad) as Vec3)), new Vector3(...(part.reflection ?? [1,1,1])));
export function setMatrix(part: Part, matrix: Matrix4) {
  const position = new Vector3(), rotation = new Quaternion(), scale = new Vector3(); matrix.decompose(position, rotation, scale);
  if (scale.toArray().some(v => Math.abs(Math.abs(v) - 1) > 1e-6)) throw new Error('Construction frames must remain rigid.');
  part.position = position.toArray() as Vec3;
  const euler = new Euler().setFromQuaternion(rotation, 'XYZ'); part.rotation = [euler.x,euler.y,euler.z].map(MathUtils.radToDeg) as Vec3;
  const reflection = scale.toArray().map(v => v < 0 ? -1 : 1) as [1|-1,1|-1,1|-1];
  if (reflection.some(v => v < 0)) part.reflection = reflection; else delete part.reflection;
}
export function worldMatrices(parts: Part[]) {
  const byId = new Map(parts.map(p => [p.id,p])), matrices = new Map<string,Matrix4>(), visiting = new Set<string>();
  const world = (id: string): Matrix4 => {
    if (matrices.has(id)) return matrices.get(id)!;
    const part = byId.get(id); if (!part) throw new Error('Missing part: ' + id);
    if (visiting.has(id)) throw new Error('Parent cycle: ' + id); visiting.add(id);
    const matrix = (part.parentId ? world(part.parentId).clone() : new Matrix4()).multiply(localMatrix(part)); matrices.set(id,matrix); visiting.delete(id); return matrix;
  };
  parts.forEach(p => world(p.id)); return matrices;
}
