import { Euler, MathUtils, Matrix4, Quaternion, Vector3 } from 'three';
import { evaluateTransform } from '../animation/model.ts';
import type { SceneDocument, SceneEntity, Transform, Vec3 } from '../types.ts';
import { eulerDegrees } from '../rotation.ts';

export function sceneEntities(scene: SceneDocument): SceneEntity[] { return [...scene.objects, ...scene.cameras]; }
export function transformMatrix(pose: Transform): Matrix4 {
  return new Matrix4().compose(new Vector3(...pose.position), new Quaternion().setFromEuler(new Euler(...pose.rotation.map(MathUtils.degToRad) as Vec3, 'XYZ')), new Vector3(...pose.scale));
}
export function matrixTransform(matrix: Matrix4, exact = false): Transform {
  const position = new Vector3(), quaternion = new Quaternion(), scale = new Vector3(); matrix.decompose(position, quaternion, scale);
  if (exact) {
    const copy = new Matrix4().compose(position, quaternion, scale), magnitude = Math.max(1, ...matrix.elements.map(Math.abs));
    if (matrix.elements.some((v,i) => !Number.isFinite(v) || Math.abs(v-copy.elements[i]) > magnitude*1e-7) || Math.min(scale.x,scale.y,scale.z) <= 0)
      throw new Error('This parent has a rotation and non-uniform scale combination that cannot preserve the world pose. Use uniform parent scale first.');
  }
  return { position: position.toArray(), rotation: eulerDegrees(quaternion), scale: scale.toArray() };
}
export function validateParents(entities: SceneEntity[]): void {
  const nodes = new Map(entities.map(item => [item.id,item])), done = new Set<string>(), visiting = new Set<string>();
  const visit = (item: SceneEntity) => {
    if (done.has(item.id)) return;
    if (visiting.has(item.id)) throw new Error('An object cannot be parented to itself or its descendants.');
    visiting.add(item.id);
    if (item.parentId !== undefined) { const parent = nodes.get(item.parentId); if (!parent) throw new Error('Parent must belong to the same scene: '+item.parentId); visit(parent); }
    visiting.delete(item.id); done.add(item.id);
  };
  entities.forEach(visit);
}
export function sceneWorldMatrices(scene: SceneDocument, time: number, override?: { id: string; pose: Transform }): Map<string,Matrix4> {
  const nodes = new Map(sceneEntities(scene).map(item => [item.id,item])), result = new Map<string,Matrix4>(), visiting = new Set<string>();
  const world = (id: string): Matrix4 => {
    if (result.has(id)) return result.get(id)!;
    const item = nodes.get(id); if (!item || visiting.has(id)) throw new Error('Invalid parent hierarchy: '+id);
    visiting.add(id);
    const matrix = (item.parentId ? world(item.parentId).clone() : new Matrix4()).multiply(transformMatrix(override?.id===id ? override.pose : evaluateTransform(item,time)));
    visiting.delete(id); result.set(id,matrix); return matrix;
  };
  nodes.forEach(item => world(item.id)); return result;
}
export function worldTransform(scene: SceneDocument, id: string, time: number): Transform { return matrixTransform(sceneWorldMatrices(scene,time).get(id)!); }
export function localTransform(scene: SceneDocument, id: string, world: Transform, time: number): Transform {
  const item = sceneEntities(scene).find(item => item.id===id); if (!item) throw new Error('Unknown entity: '+id);
  if (!item.parentId) return structuredClone(world);
  return matrixTransform(sceneWorldMatrices(scene,time).get(item.parentId)!.clone().invert().multiply(transformMatrix(world)),true);
}
/** Transform selected ancestors once, while descendants continue to inherit them. */
export function hierarchyRoots(entities: { id:string; parentId?:string|null }[], ids: string[]): string[] {
  const nodes = new Map(entities.map(item => [item.id,item])), chosen = new Set(ids);
  return [...chosen].filter(id => {
    let item = nodes.get(id); const seen = new Set<string>();
    while (item?.parentId) { if (chosen.has(item.parentId)) return false; if (seen.has(item.parentId)) throw new Error('Parent cycle.'); seen.add(item.parentId); item=nodes.get(item.parentId); }
    return nodes.has(id);
  });
}
export function descendants(entities: { id:string; parentId?:string|null }[], id: string): Set<string> {
  const result = new Set([id]); let count = 0;
  while (result.size!==count) { count=result.size; entities.forEach(item => { if (item.parentId && result.has(item.parentId)) result.add(item.id); }); }
  return result;
}
export function effectivelyHidden(scene: SceneDocument, id: string): boolean {
  const nodes = new Map(sceneEntities(scene).map(item => [item.id,item])); let item = nodes.get(id); const seen = new Set<string>();
  while (item && !seen.has(item.id)) { if ('hidden' in item && item.hidden) return true; seen.add(item.id); item=item.parentId ? nodes.get(item.parentId) : undefined; }
  return false;
}
