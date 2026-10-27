import { Matrix4, Vector3 } from 'three';
import { resolveDependencies } from './dependencies.ts';
import { mirrorCopies } from './mirror.ts';
import { arrayCopies } from './array.ts';
import { emptyConstruction, MAX_EVALUATED_PARTS, type Part, type RecipeGeometry } from './schema.ts';
import { setMatrix, worldMatrices } from './transforms.ts';
import type { Vec3 } from '../../types.ts';

export type ResolvedPart = Part & { sourceId:string; generatedBy:string[] };
export function evaluateAsset(recipe: RecipeGeometry) {
  const construction = recipe.construction ?? emptyConstruction();
  const resolved = resolveDependencies(recipe.parts,construction);
  let parts: ResolvedPart[] = resolved.parts.map(p=>({...p,sourceId:p.id,generatedBy:[]}));
  const modifierIds = new Set<string>();
  for (const modifier of construction.modifiers) {
    if (modifierIds.has(modifier.id)) throw new Error('Duplicate modifier ID: ' + modifier.id); modifierIds.add(modifier.id);
    if (!resolved.worlds.has(modifier.targetId)) throw new Error('Modifier target not found: ' + modifier.targetId);
    if (modifier.type === 'mirror' && modifier.referenceId && !resolved.worlds.has(modifier.referenceId)) throw new Error('Mirror reference not found: ' + modifier.referenceId);
    if (!modifier.enabled) continue;
    const worlds = worldMatrices(parts), targets = parts.filter(p=>p.sourceId===modifier.targetId), before = [...parts];
    for (const target of targets) {
      const ids = new Set([target.id]); let length=0;
      while (length!==ids.size) { length=ids.size; before.forEach(p=>{if(p.parentId&&ids.has(p.parentId))ids.add(p.id);}); }
      const subtree = before.filter(p=>ids.has(p.id));
      const copies = modifier.type==='mirror' ? mirrorCopies(modifier,modifier.referenceId ? resolved.worlds.get(modifier.referenceId)! : new Matrix4(),worlds.get(target.id)!) : arrayCopies(modifier,resolved.scalar,worlds.get(target.id)!);
      if (parts.length + copies.length * subtree.length > MAX_EVALUATED_PARTS) throw new Error(`Construction exceeds the ${MAX_EVALUATED_PARTS}-node evaluation budget. Reduce array count or split the asset.`);
      for (const copy of copies) {
        const suffix = '~' + modifier.id + '.' + copy.key;
        for (const p of subtree) {
          const clone: ResolvedPart = {...structuredClone(p), id:p.id+suffix, parentId:p.id===target.id ? target.parentId : p.parentId!+suffix, generatedBy:[...p.generatedBy,modifier.id]};
          if (p.id===target.id) setMatrix(clone,(target.parentId ? worlds.get(target.parentId)!.clone().invert() : new Matrix4()).multiply(copy.matrix));
          parts.push(clone);
        }
      }
    }
  }
  const excluded = new Set(construction.excluded); let length = -1;
  while (length !== excluded.size) { length = excluded.size; parts.forEach(p => { if (p.parentId && excluded.has(p.parentId)) excluded.add(p.id); }); }
  parts = parts.filter(p=>!excluded.has(p.id));
  for (const p of parts) if (!p.parentId) p.position = p.position.map((v,i)=>v+construction.offset[i]) as Vec3;
  if (!parts.some(p=>p.kind!=='group')) throw new Error('An asset needs at least one visible primitive.');
  if (parts.length > MAX_EVALUATED_PARTS) throw new Error('Construction evaluation budget exceeded.');
  const ids = new Set(parts.map(p=>p.id)); if (ids.size!==parts.length) throw new Error('Generated part ID collision.');
  const anchors = Object.fromEntries([...resolved.anchorMatrices].map(([id,m])=>[id,new Vector3().setFromMatrixPosition(m).add(new Vector3(...construction.offset)).toArray()]));
  return { parts, parameters:resolved.parameters, anchors };
}
