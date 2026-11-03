import { z } from 'zod';
import { scriptDefinitionSchema, parametersSchema, scriptParameters } from './model.ts';
import type { ProjectContent } from '../types.ts';

const id=z.string().min(1).max(64);
export const scriptOperationSchema=z.discriminatedUnion('type',[
  z.strictObject({type:z.literal('upsert_script'),sceneId:id,script:scriptDefinitionSchema,expectedRevision:z.number().int().nonnegative()}),
  z.strictObject({type:z.literal('remove_script'),sceneId:id,scriptId:id}),
  z.strictObject({type:z.literal('attach_script'),sceneId:id,id,scriptId:id,parameters:parametersSchema,replaceController:z.boolean()}),
  z.strictObject({type:z.literal('detach_script'),sceneId:id,id}),
]);
export type ScriptOperation=z.infer<typeof scriptOperationSchema>;
export function isScriptOperation(value:{type:string}):value is ScriptOperation {return ['upsert_script','remove_script','attach_script','detach_script'].includes(value.type);}
export function scriptOnlyChange(before:ProjectContent,after:ProjectContent,sceneId:string,controlledId:string):boolean {
  const controller=(project:ProjectContent)=>project.scenes.find(s=>s.id===sceneId)?.objects.find(o=>o.id===controlledId)?.components?.find(c=>c.type==='script');
  const a=controller(before),b=controller(after);if(!a||!b||a.type!=='script'||b.type!=='script'||a.scriptId!==b.scriptId||!b.enabled)return false;
  const strip=(project:ProjectContent)=>{const copy=structuredClone(project);delete copy.scripts;for(const scene of copy.scenes)for(const object of scene.objects)if(object.components)object.components=object.components.filter(c=>c.type!=='script');return JSON.stringify(copy);};
  return strip(before)===strip(after);
}
export function applyScriptOperation(project:ProjectContent,operation:ScriptOperation){
  const scene=project.scenes.find(s=>s.id===operation.sceneId);if(!scene)throw new Error('Select an existing scene for script changes.');
  if(operation.type==='upsert_script'){
    const before=project.scripts?.find(s=>s.id===operation.script.id);
    if((before?.revision??0)!==operation.expectedRevision||operation.script.revision!==operation.expectedRevision+1)throw new Error('Script revision changed. Read the current script and try again.');
    project.scripts=[...(project.scripts??[]).filter(s=>s.id!==operation.script.id),structuredClone(operation.script)];
    for(const s of project.scenes)for(const object of s.objects)for(const c of object.components??[])if(c.type==='script'&&c.scriptId===operation.script.id)c.parameters=scriptParameters(operation.script,c.parameters,true);
    return;
  }
  if(operation.type==='remove_script'){
    if(project.scenes.some(s=>s.objects.some(o=>o.components?.some(c=>c.type==='script'&&c.scriptId===operation.scriptId))))throw new Error('Detach this script from its objects before deleting it.');
    project.scripts=project.scripts?.filter(s=>s.id!==operation.scriptId);return;
  }
  const object=scene.objects.find(o=>o.id===operation.id);if(!object)throw new Error('Scripts can be attached only to a scene object.');
  if(operation.type==='detach_script'){object.components=object.components?.filter(c=>c.type!=='script');return;}
  const script=project.scripts?.find(s=>s.id===operation.scriptId);if(!script)throw new Error('Create or read this project script before attaching it.');
  const controllers=object.components?.filter(c=>['movement','hinge','script'].includes(c.type))??[];
  if(controllers.length&&!operation.replaceController)throw new Error('This object already has a controller. Explicitly replace it or choose another object.');
  object.components=[...(object.components??[]).filter(c=>!['movement','hinge','script'].includes(c.type)),{type:'script',enabled:true,scriptId:script.id,parameters:scriptParameters(script,operation.parameters)}];
}
