import { z } from 'zod';
import { Box3, Group, Mesh, MeshStandardMaterial, BoxGeometry, SphereGeometry, CylinderGeometry, ConeGeometry, Vector3, MathUtils } from 'three';
import type { Vec3 } from '../types.ts';
import { componentsSchema } from '../components/model.ts';
import { motionSchema, transformSchema } from '../performance/motion.ts';

import { vector, identifier, partSchema, constructionSchema } from './toolkit/schema.ts';
import { evaluateAsset } from './toolkit/evaluate.ts';
export { evaluateAsset } from './toolkit/evaluate.ts';

export const assetReferenceSchema = z.strictObject({ id: identifier });
export const assetRecipeSchema = z.strictObject({
  name: z.string().trim().min(1).max(120), description: z.string().trim().min(1).max(1200), tags: z.array(z.string().trim().min(1).max(64)).min(1).max(20),
  parts: z.array(partSchema).min(1).max(2048), construction: constructionSchema.optional(),
});
export const assetSchema = assetRecipeSchema.extend({
  id: identifier, source: z.enum(['builtin', 'generated', 'edited']), createdAt: z.string(),
  bounds: z.strictObject({ min: vector(-1000, 1000), max: vector(-1000, 1000), size: vector(0.001, 1000) }),
  template: z.strictObject({ components: componentsSchema, track: motionSchema.nullable(), transform: transformSchema.optional() }).optional(),
});
export type AssetRecipe = z.infer<typeof assetRecipeSchema>;
export type AssetDefinition = z.infer<typeof assetSchema>;
export type AssetReference = z.infer<typeof assetReferenceSchema>;

export function validateRecipe(value: unknown): AssetRecipe {
  const recipe = assetRecipeSchema.parse(value), ids = new Set(recipe.parts.map(p => p.id));
  if (ids.size !== recipe.parts.length) throw new Error('Asset part IDs must be unique.');
  for (const part of recipe.parts) {
    if (part.joint && part.joint.min > part.joint.max) throw new Error(`Invalid joint range: ${part.id}`);
    const ancestors = new Set([part.id]); let parent = part.parentId;
    while (parent !== null) {
      if (!ids.has(parent) || ancestors.has(parent)) throw new Error(`Missing parent or cycle: ${part.id}`);
      ancestors.add(parent); parent = recipe.parts.find(p => p.id === parent)!.parentId;
    }
  }
  evaluateAsset(recipe); return recipe;
}

/** The stage and expert previews use exactly the same geometry and hierarchy. Metres, Y up, +Z forward. */
export function createAssetGroup(recipe: AssetRecipe): Group {
  const root = new Group(), bodies = new Map<string, Group>(), nodes = new Map<string, Group>();
  const evaluated = evaluateAsset(recipe); root.userData.evaluated = evaluated;
  for (const part of evaluated.parts) {
    const node = new Group(); node.name = part.name; node.userData.partId = part.id; node.userData.sourceId = part.sourceId; node.userData.generatedBy = part.generatedBy;
    node.position.fromArray(part.position); node.rotation.set(...part.rotation.map(MathUtils.degToRad) as Vec3); node.scale.fromArray(part.reflection ?? [1,1,1]);
    const pivot = new Group(), body = new Group();
    if (part.joint) { pivot.position.fromArray(part.joint.pivot); body.position.copy(pivot.position).negate(); pivot.userData.joint = part.joint; }
    node.add(pivot); pivot.add(body);
    if (part.kind !== 'group') {
    const geometry = part.kind === 'sphere' ? new SphereGeometry(0.5, 16, 10)
      : part.kind === 'cylinder' ? new CylinderGeometry(0.5, 0.5, 1, 20)
      : part.kind === 'cone' ? new ConeGeometry(0.5, 1, 20) : new BoxGeometry(1, 1, 1);
    const mesh = new Mesh(geometry, new MeshStandardMaterial({ color: part.color, roughness: 0.8 }));
    mesh.scale.fromArray(part.size); mesh.castShadow = true; mesh.receiveShadow = true; mesh.userData.baseColor = part.color;
    body.add(mesh); } bodies.set(part.id, body); nodes.set(part.id, node);
  }
  for (const part of evaluated.parts) (part.parentId ? bodies.get(part.parentId)! : root).add(nodes.get(part.id)!);
  root.updateMatrixWorld(true); return root;
}
export function disposeAssetGroup(root: Group): void {
  root.traverse(node => { if (node instanceof Mesh) { node.geometry.dispose(); for (const material of Array.isArray(node.material) ? node.material : [node.material]) material.dispose(); } });
}
export function recipeBounds(recipe: AssetRecipe): AssetDefinition['bounds'] {
  const root = createAssetGroup(recipe), box = new Box3().setFromObject(root, true);
  const bounds = { min: box.min.toArray() as Vec3, max: box.max.toArray() as Vec3, size: box.getSize(new Vector3()).toArray() as Vec3 };
  disposeAssetGroup(root); return bounds;
}
/** Joint axes live inside the already-rotated part node, shared by sandbox and expert previews. */
export function poseAssetJoints(root: Group, recipe: AssetRecipe, angles: Record<string, number>): void {
  const evaluated = root.userData.evaluated as ReturnType<typeof evaluateAsset> ?? evaluateAsset(recipe);
  for (const [id, angle] of Object.entries(angles)) {
    const part = evaluated.parts.find(p => p.id === id);
    if (!part?.joint || !Number.isFinite(angle) || angle < part.joint.min || angle > part.joint.max) throw new Error('Invalid joint test pose: ' + id);
    root.traverse(node => { if (node.userData.partId === id) node.children[0].rotation[part.joint!.axis] = MathUtils.degToRad(angle); });
  }
  root.updateMatrixWorld(true);
}
export function measureAsset(recipe: AssetRecipe, angles: Record<string, number> = {}) {
  const root = createAssetGroup(recipe);
  try {
    poseAssetJoints(root, recipe, angles); const box = new Box3().setFromObject(root, true);
    const joints: { partId: string; axisInPartSpace: string; axisInAssetSpace: number[]; pivotInAssetSpace: number[]; cylinderAxisInAssetSpace: number[] | null; poseDegrees: number }[] = [];
    const evaluated = root.userData.evaluated as ReturnType<typeof evaluateAsset>;
    root.traverse(node => {
      const part = evaluated.parts.find(p => p.id === node.userData.partId); if (!part?.joint) return;
      const pivot = node.children[0], mesh = pivot.children[0].children.find(c => c instanceof Mesh)!;
      const axis = new Vector3(part.joint.axis === 'x' ? 1 : 0, part.joint.axis === 'y' ? 1 : 0, part.joint.axis === 'z' ? 1 : 0);
      joints.push({ partId: part.id, axisInPartSpace: part.joint.axis, axisInAssetSpace: axis.transformDirection(node.matrixWorld).multiplyScalar(Math.sign(node.matrixWorld.determinant())).toArray(), pivotInAssetSpace: pivot.getWorldPosition(new Vector3()).toArray(), cylinderAxisInAssetSpace: part.kind === 'cylinder' ? new Vector3(0,1,0).transformDirection(mesh.matrixWorld).toArray() : null, poseDegrees: angles[part.id] ?? 0 });
    });
    return { bounds: { min: box.min.toArray(), max: box.max.toArray(), size: box.getSize(new Vector3()).toArray() }, partCount: evaluated.parts.filter(p => p.kind !== 'group').length, sourcePartCount: recipe.parts.filter(p => p.kind !== 'group').length, nodeCount: evaluated.parts.length, parameters: evaluated.parameters, anchors: evaluated.anchors, parts: evaluated.parts.map(p=>({id:p.id,sourceId:p.sourceId,generatedBy:p.generatedBy})), joints };
  } finally { disposeAssetGroup(root); }
}
export function createAsset(value: unknown, id: string, source: AssetDefinition['source'] = 'generated'): AssetDefinition {
  const recipe = validateRecipe(value), box = recipeBounds(recipe);
  const offset: Vec3 = [-(box.min[0] + box.max[0]) / 2, -box.min[1], -(box.min[2] + box.max[2]) / 2];
  if (recipe.construction) recipe.construction.offset = recipe.construction.offset.map((v,i)=>v+offset[i]) as Vec3;
  else for (const part of recipe.parts) if (part.parentId === null) part.position = part.position.map((v, i) => v + offset[i]) as Vec3;
  return validateAsset({ ...recipe, id, source, createdAt: new Date().toISOString(), bounds: recipeBounds(recipe) });
}
/** Read compatibility only: current assets and references never serialize a prefab version. */
export function migrateAssetValue(value: unknown): unknown {
  if (value && typeof value === 'object' && 'version' in value) {
    const { version, ...current } = value;
    z.number().int().positive().parse(version); return current;
  }
  return value;
}
export function migrateAssetDefinitions(values: unknown[]): AssetDefinition[] {
  const latest = new Map<string, { asset: AssetDefinition; order: number }>();
  for (const value of values) {
    const asset = validateAsset(value), order = value && typeof value === 'object' && 'version' in value ? Number(value.version) : Infinity;
    const previous = latest.get(asset.id);
    if (previous?.order === order) throw new Error('Asset IDs must be unique.');
    if (!previous || order > previous.order) latest.set(asset.id, { asset, order });
  }
  return [...latest.values()].map(entry => entry.asset);
}
export function validateAsset(value: unknown): AssetDefinition {
  const asset = assetSchema.parse(migrateAssetValue(value)); validateRecipe(assetRecipeSchema.strip().parse(asset));
  const actual = recipeBounds(asset);
  if (actual.min.some((v, i) => Math.abs(v - asset.bounds.min[i]) > 1e-5) || actual.max.some((v, i) => Math.abs(v - asset.bounds.max[i]) > 1e-5)
    || actual.size.some((v, i) => Math.abs(v - asset.bounds.size[i]) > 1e-5))
    throw new Error('Asset bounds must match its geometry.');
  return asset;
}
export function assetSummary(asset: AssetDefinition) {
  const evaluated = evaluateAsset(asset);
  return { id: asset.id, name: asset.name, description: asset.description, tags: asset.tags, dimensions: asset.bounds.size,
    bounds: asset.bounds, partCount: evaluated.parts.filter(p=>p.kind!=='group').length, sourcePartCount: asset.parts.filter(p=>p.kind!=='group').length, parameters: evaluated.parameters, movableParts: evaluated.parts.filter(p => p.joint).map(p => ({ id: p.id, name: p.name, joint: p.joint })) };
}
