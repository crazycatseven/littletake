import type { ProjectContent } from '../types.ts';
import { evaluateAsset } from '../assets/model.ts';
import { evaluateJointAngles } from '../model.ts';
import { matrixTransform, sceneWorldMatrices } from '../placement/hierarchy.ts';
import { scriptParameters, type ScriptDefinition } from './model.ts';
import { checkScript, idleScriptInput } from './runtime.ts';

/** One bounded check against a real instance, shared by Muse and the source editor. */
export async function checkProjectScript(script:ScriptDefinition,project:ProjectContent,target?:{sceneId:string;id:string}|null){
  const scene=target?project.scenes.find(s=>s.id===target.sceneId):project.scenes.find(s=>s.objects.some(o=>o.components?.some(c=>c.type==='script'&&c.scriptId===script.id)));
  const item=target?scene?.objects.find(o=>o.id===target.id):scene?.objects.find(o=>o.components?.some(c=>c.type==='script'&&c.scriptId===script.id));
  if(target&&!item)throw new Error('Choose an existing object to check this controller.');
  if(!scene||!item)return checkScript(script);
  const component=item.components?.find(c=>c.type==='script'&&c.scriptId===script.id),params=scriptParameters(script,component?.type==='script'?component.parameters:{},true);
  const asset=project.assets?.find(a=>a.id===item.asset?.id),limits=new Map<string,{min:number;max:number}>();
  if(asset)for(const part of evaluateAsset(asset).parts)if(part.joint)limits.set(part.id,part.joint);
  const angles=evaluateJointAngles(item,0),joints=Object.fromEntries([...limits].map(([id])=>[id,angles[id]??0])),pose=matrixTransform(sceneWorldMatrices(scene,0).get(item.id)!);
  return checkScript(script,Array.from({length:30},(_,i)=>({dt:1/60,time:i/60,pose,joints,input:{...idleScriptInput(),keys:{...idleScriptInput().keys,[i<15?'w':'d']:true}}})),params,limits);
}
