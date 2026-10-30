import { z } from 'zod';
import { validateDocument } from '../model.ts';
import type { ProjectContent } from '../types.ts';
import { migrateAssetDefinitions } from '../assets/model.ts';

const contentSchema = z.strictObject({ name: z.string().trim().min(1).max(120), scenes: z.array(z.unknown()).max(24), assets: z.array(z.unknown()).max(1000).optional() });
export function validateProjectContent(value: unknown): ProjectContent {
  const input = contentSchema.parse(value), scenes = input.scenes.map(validateDocument);
  if (new Set(scenes.map(scene => scene.id)).size !== scenes.length) throw new Error('Scene IDs must be unique in this project.');
  const assets = input.assets ? migrateAssetDefinitions(input.assets) : undefined, keys = new Set((assets ?? []).map(a => a.id));
  for (const scene of scenes) for (const object of scene.objects) if (object.asset && !keys.has(object.asset.id)) throw new Error(`Missing asset for ${object.id}.`);
  return { name: input.name, scenes, ...(assets ? { assets } : {}) };
}
export function projectContent(project: ProjectContent): ProjectContent { return { name: project.name, scenes: project.scenes, ...(project.assets ? { assets: project.assets } : {}) }; }
export function serializeContent(project: ProjectContent): string { return JSON.stringify(validateProjectContent(projectContent(project))); }
