import { z } from 'zod';
import { Matrix4 } from 'three';
import { constructionSchema, emptyConstruction, identifier, type Part, type RecipeGeometry, type Property } from './schema.ts';
import { evaluateAsset } from './evaluate.ts';
import { setMatrix, worldMatrices } from './transforms.ts';

export const constructionEdits = [
  z.strictObject({type:z.literal('set_construction'),construction:constructionSchema}),
  z.strictObject({type:z.literal('set_parameter'),id:identifier,value:z.number().finite()}),
  z.strictObject({type:z.literal('group_parts'),id:identifier,name:z.string().min(1).max(120),partIds:z.array(identifier).min(1).max(2048)}),
  z.strictObject({type:z.literal('duplicate_subtree'),partId:z.string().min(1).max(2048)}),
  z.strictObject({type:z.literal('make_unique'),partId:z.string().min(1).max(2048)}),
  z.strictObject({type:z.literal('bake_construction')}),
] as const;
export type ConstructionEdit = z.infer<ReturnType<typeof constructionEditSchema>>;
function constructionEditSchema() { return z.discriminatedUnion('type',constructionEdits); }

export function drivenProperties(recipe: RecipeGeometry,id:string): Property[] {
  const c=recipe.construction, constraint=c?.constraints.find(q=>q.targetId===id);
  return [...(c?.bindings.filter(b=>b.partId===id).map(b=>b.property)??[]), ...(constraint ? ['position.x','position.y','position.z'] as Property[] : []), ...(constraint?.type==='span' ? ['rotation.x','rotation.y','rotation.z',('size.'+constraint.axis)] as Property[] : [])];
}
export function editConstruction(draft: RecipeGeometry, edit: ConstructionEdit) {
  if(edit.type==='set_construction') { draft.construction=structuredClone(edit.construction); return; }
  if(edit.type==='set_parameter') {
    const parameter=draft.construction?.parameters.find(p=>p.id===edit.id); if(!parameter)throw new Error('Parameter not found: '+edit.id);
    parameter.value=edit.value; return;
  }
  if(edit.type==='group_parts') {
    if(draft.parts.some(p=>p.id===edit.id))throw new Error('Group ID already exists.');
    const selected=draft.parts.filter(p=>edit.partIds.includes(p.id));
    if(selected.length!==new Set(edit.partIds).size || !selected.length || selected.some(p=>p.parentId!==selected[0].parentId))throw new Error('Group parts must exist and share one parent.');
    const parentId=selected[0].parentId;
    draft.parts.push({id:edit.id,name:edit.name,parentId,kind:'group',position:[0,0,0],rotation:[0,0,0],size:[1,1,1],color:'#aabbcc',joint:null});
    selected.forEach(p=>p.parentId=edit.id); return;
  }
  const evaluated=evaluateAsset(draft), occupied=new Set(draft.parts.map(p=>p.id)); let serial=1;
  const newId=()=>{let id:string; do{id='independent_'+serial++;}while(occupied.has(id));occupied.add(id);return id;};
  const clean=(p:typeof evaluated.parts[number]):Part=>{const {sourceId:_,generatedBy:__,...part}=structuredClone(p);return part;};
  if(edit.type==='bake_construction') {
    const ids=new Map(evaluated.parts.map(p=>[p.id,p.generatedBy.length?newId():p.id]));
    draft.parts=evaluated.parts.map(p=>({...clean(p),id:ids.get(p.id)!,parentId:p.parentId?ids.get(p.parentId)!:null})); delete draft.construction; return;
  }
  const target=evaluated.parts.find(p=>p.id===edit.partId);
  if(!target || (edit.type==='make_unique' && !target.generatedBy.length))throw new Error('Only a generated copy can be made unique. Select the source to edit all copies.');
  const subtree=new Set([target.id]); let length=0;
  while(length!==subtree.size){length=subtree.size;evaluated.parts.forEach(p=>{if(p.parentId&&subtree.has(p.parentId))subtree.add(p.id);});}
  const parts=evaluated.parts.filter(p=>subtree.has(p.id)),ids=new Map(parts.map(p=>[p.id,newId()])),worlds=worldMatrices(evaluated.parts);
  const construction=draft.construction??=emptyConstruction();
  for(const p of parts){
    const copy=clean(p);copy.id=ids.get(p.id)!;copy.parentId=p.id===target.id?null:ids.get(p.parentId!)!;
    if(p.id===target.id)setMatrix(copy,new Matrix4().makeTranslation(...construction.offset.map(v=>-v) as [number,number,number]).multiply(worlds.get(p.id)!));
    draft.parts.push(copy);
  }
  if(edit.type==='make_unique')construction.excluded.push(target.id);
}
