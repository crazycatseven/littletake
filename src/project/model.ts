import { z } from 'zod';
import { validateDocument } from '../model.ts';
import type { ProjectContent } from '../types.ts';
import { migrateAssetDefinitions, validateJointAngles } from '../assets/model.ts';
import { scriptDefinitionSchema, scriptParameters } from '../scripts/model.ts';

const contentSchema = z.strictObject({ name: z.string().trim().min(1).max(120), scenes: z.array(z.unknown()).max(24), assets: z.array(z.unknown()).max(1000).optional(), scripts:z.array(scriptDefinitionSchema).max(64).optional() });
export function validateProjectContent(value: unknown): ProjectContent {
  const input = contentSchema.parse(value), scenes = input.scenes.map(validateDocument);
  if (new Set(scenes.map(scene => scene.id)).size !== scenes.length) throw new Error('Scene IDs must be unique in this project.');
  const assets = input.assets ? migrateAssetDefinitions(input.assets) : undefined, keys = new Set((assets ?? []).map(a => a.id));
  const scripts=input.scripts;
  if(new Set(scripts?.map(s=>s.id)).size!==(scripts?.length??0))throw new Error('Script IDs must be unique.');
  for(const scene of scenes)for(const object of scene.objects)for(const component of object.components??[])if(component.type==='script'){
    const script=scripts?.find(s=>s.id===component.scriptId);if(!script)throw new Error(`Missing script for ${object.id}.`);component.parameters=scriptParameters(script,component.parameters);
  }
  for (const scene of scenes) for (const object of scene.objects) if (object.asset && !keys.has(object.asset.id)) throw new Error(`Missing asset for ${object.id}.`);
  for(const scene of scenes)for(const object of scene.objects)if(object.jointAngles&&!object.asset)throw new Error('Joint angles require an asset instance.');

  for (const scene of scenes) for (const object of scene.objects) if (object.asset && (object.jointAngles || object.animation)) {
    validateJointAngles(assets!.find(asset => asset.id === object.asset!.id)!, object.jointAngles ?? {}, object.animation);
  }
  return { name: input.name, scenes, ...(assets ? { assets } : {}), ...(scripts ? {scripts} : {}) };
}
export function projectContent(project: ProjectContent): ProjectContent { return { name: project.name, scenes: project.scenes, ...(project.assets ? { assets: project.assets } : {}), ...(project.scripts ? {scripts:project.scripts} : {}) }; }
export function serializeContent(project: ProjectContent): string { return JSON.stringify(validateProjectContent(projectContent(project))); }
