import { z } from 'zod';
import { applyProjectOperations, MAX_EDIT_OPERATIONS, operationSchema } from '../../src/scene-edit/operations.ts';
import { projectContent } from '../../src/project/model.ts';
import { projectChanges } from '../../src/project/changes.ts';
import { inspectSpatial } from '../../src/spatial/methods.ts';
import { spatialQuerySchema } from '../../src/spatial/schema.ts';
import type { ProjectDocument } from '../../src/project/storage.ts';
import type { SceneEntity } from '../../src/types.ts';
import { checkVisibility, inspectParts } from './geometry.ts';
import type { LittleTakeRoom } from './room.ts';

export const INSTRUCTIONS = `LittleTake is a 3D previs editor: scenes hold objects, cameras and shots on one action clock in seconds. These tools edit a project room on a LittleTake server; every open browser page of that project shows your edits live and can undo them.
Workflow: list_projects → open_project → get_scene → inspect (get_entity, inspect_parts, inspect_spatial, check_visibility) → apply_operations → inspect again to verify. apply_operations is atomic: all operations apply or none do.
Coordinates: right-handed, X right, Y up, Z toward the default front camera, metres, XYZ Euler angles in degrees. Humans and rigs have their origin at the feet; yaw 0 faces +Z. Primitives are centred and 1 m at scale 1. Cameras look along local -Z; prefer aim_camera {position, target, fov}.
Times in operations are absolute scene time. Shots select [start, start+duration] of that clock and reference one camera.
A cone's axis and tip are local +Y and its pivot is its centre. For a jet from source S to target T, point the tip back at S and key position with scale: the centre must move from S to the midpoint while scale Y grows from ~0 to |T-S|, so the jet grows out of S instead of out of its middle. Mark fire, smoke, sparks, magic and similar shapes with set_effect so the depth pass leaves them out.
Asset rigs are posed with jointAngles.<partId> property keys (set_property_keys, path "jointAngles.<partId>"), in degrees within each joint's min/max (see inspect_parts or get_entity).
Before claiming an action reads on camera, run check_visibility for that camera and time: an object hidden behind another is absent from the frame and from any depth pass made from it.`;

type Args = Record<string, unknown>;
export interface Tool { name: string; description: string; inputSchema: Record<string, unknown>; run(args: Args): Promise<unknown> }

const vec3 = { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3 };
const operationTypes = operationSchema.options.map(option => {
  const literal = (option as unknown as { shape: { type: { value?: string; values?: Set<string> } } }).shape.type;
  return literal.value ?? [...literal.values ?? []][0]!;
});

function animated(entity: SceneEntity): string[] {
  const paths = Object.keys(entity.animation?.curves ?? {}), joints = paths.filter(path => path.startsWith('jointAngles.')).length;
  return [...paths.filter(path => !path.startsWith('jointAngles.')), ...(joints ? [`jointAngles × ${joints}`] : []), ...(entity.track ? ['track'] : [])];
}
function overview(project: ProjectDocument, code: string) {
  return { code, name: project.name, revision: project.revision, activeSceneId: project.activeSceneId,
    scenes: project.scenes.map(scene => ({ id: scene.id, name: scene.name, duration: scene.duration, objects: scene.objects.length, cameras: scene.cameras.length, shots: scene.shots.length })),
    assets: (project.assets ?? []).map(asset => ({ id: asset.id, name: asset.name, parts: asset.parts.length, joints: asset.parts.filter(part => part.joint).length })) };
}
function sceneSummary(project: ProjectDocument, sceneId: string) {
  const scene = project.scenes.find(item => item.id === sceneId);
  if (!scene) throw new Error(`Unknown scene ${sceneId}. Scenes: ${project.scenes.map(item => item.id).join(', ')}`);
  const assets = new Map((project.assets ?? []).map(asset => [asset.id, asset.name]));
  return {
    id: scene.id, name: scene.name, duration: scene.duration, fps: scene.fps,
    objects: scene.objects.map(object => ({ id: object.id, name: object.name, kind: object.kind,
      ...(object.asset ? { assetId: object.asset.id, assetName: assets.get(object.asset.id) } : {}), ...(object.parentId ? { parentId: object.parentId } : {}), ...(object.hidden ? { hidden: true } : {}),
      transform: object.transform, animated: animated(object) })),
    cameras: scene.cameras.map(camera => ({ id: camera.id, name: camera.name, fov: camera.fov, ...(camera.parentId ? { parentId: camera.parentId } : {}), transform: camera.transform, animated: animated(camera) })),
    shots: scene.shots.map(shot => ({ id: shot.id, name: shot.name, cameraId: shot.cameraId, start: shot.start, duration: shot.duration })),
  };
}
const issues = (error: z.ZodError) => error.issues.slice(0, 6).map(issue => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ');
const number = (value: unknown, name: string) => { if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${name} must be a number.`); return value; };
const text = (value: unknown, name: string) => { if (typeof value !== 'string' || !value) throw new Error(`${name} is required.`); return value; };

export function littleTakeTools(room: LittleTakeRoom): Tool[] {
  const current = async () => (await room.get()).project;
  const sceneOf = (project: ProjectDocument, value: unknown) => (typeof value === 'string' && value) || project.activeSceneId || project.scenes[0]?.id || '';
  return [
    { name: 'list_projects', description: 'List projects saved on the LittleTake server (code, name, last update). Open one with open_project.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      run: async () => ({ projects: (await room.list()).map(item => ({ code: item.code, name: item.name, updatedAt: new Date(item.updatedAt).toISOString() })) }) },
    { name: 'open_project', description: 'Join a project by its code as an extra editor. Browser pages on the same project stay open and see your edits live.',
      inputSchema: { type: 'object', properties: { code: { type: 'string', description: 'Project code shown in LittleTake (Share / project list).' } }, required: ['code'], additionalProperties: false },
      run: async args => { const opened = await room.open(text(args.code, 'code')); return overview(opened.project, opened.code); } },
    { name: 'get_scene', description: 'Objects, cameras and shots of one scene with their base transforms and which properties are animated. Defaults to the active scene.',
      inputSchema: { type: 'object', properties: { sceneId: { type: 'string' } }, additionalProperties: false },
      run: async args => { const project = await current(); return sceneSummary(project, sceneOf(project, args.sceneId)); } },
    { name: 'get_entity', description: 'Full JSON of one object or camera: transform, motion track, every animation curve and, for an asset instance, its joints with limits.',
      inputSchema: { type: 'object', properties: { sceneId: { type: 'string' }, id: { type: 'string' } }, required: ['id'], additionalProperties: false },
      run: async args => {
        const project = await current(), scene = project.scenes.find(item => item.id === sceneOf(project, args.sceneId)), id = text(args.id, 'id');
        const entity = scene && [...scene.objects, ...scene.cameras].find(item => item.id === id);
        if (!entity) throw new Error(`Unknown object or camera ${id}.`);
        const asset = 'asset' in entity && entity.asset ? project.assets?.find(item => item.id === entity.asset!.id) : undefined;
        return { entity, ...(asset ? { joints: asset.parts.filter(part => part.joint).map(part => ({ partId: part.id, name: part.name, ...part.joint })) } : {}) };
      } },
    { name: 'inspect_parts', description: 'World position, forward (+Z) and up (+Y) of asset parts at a time, after joint animation. Use it to put effects at a mouth, props in a hand, or to check a pose. Defaults to every jointed part.',
      inputSchema: { type: 'object', properties: { sceneId: { type: 'string' }, id: { type: 'string', description: 'Asset instance object ID.' }, time: { type: 'number' },
        parts: { type: 'array', items: { type: 'object', properties: { partId: { type: 'string' }, offset: { ...vec3, description: 'Point in the part\'s local frame, metres.' } }, required: ['partId'], additionalProperties: false } } },
        required: ['id', 'time'], additionalProperties: false },
      run: async args => { const project = await current(); return inspectParts(projectContent(project), sceneOf(project, args.sceneId), text(args.id, 'id'), number(args.time, 'time'), args.parts as never); } },
    { name: 'inspect_spatial', description: 'World or object/camera-frame bounds, support surface, anchors and pairwise gaps of objects at a time (the same measurements Muse uses).',
      inputSchema: { type: 'object', properties: { sceneId: { type: 'string' }, time: { type: 'number' }, objectIds: { type: 'array', items: { type: 'string' }, minItems: 1 },
        frame: { type: 'object', description: '{"kind":"world"} (default), {"kind":"object","id":...} or {"kind":"camera","id":...}' } }, required: ['time', 'objectIds'], additionalProperties: false },
      run: async args => {
        const project = await current(), query = spatialQuerySchema.safeParse({ sceneId: sceneOf(project, args.sceneId), time: args.time, objectIds: args.objectIds, frame: args.frame ?? { kind: 'world' } });
        if (!query.success) throw new Error(issues(query.error));
        return inspectSpatial(projectContent(project), query.data);
      } },
    { name: 'check_visibility', description: 'How much of an object, or of its parts whose ID starts with partPrefix (e.g. "shield"), a camera sees at a time: share inside the frame and share actually visible (not hidden behind any object), the share of the frame it covers, plus its on-screen box. Camera defaults to the shot playing at that time.',
      inputSchema: { type: 'object', properties: { sceneId: { type: 'string' }, id: { type: 'string' }, time: { type: 'number' }, cameraId: { type: 'string' }, partPrefix: { type: 'string' } }, required: ['id', 'time'], additionalProperties: false },
      run: async args => { const project = await current();
        return checkVisibility(projectContent(project), sceneOf(project, args.sceneId), number(args.time, 'time'), text(args.id, 'id'), { cameraId: args.cameraId as string | undefined, partPrefix: args.partPrefix as string | undefined }); } },
    { name: 'operation_schema', description: 'JSON Schema of LittleTake scene operations. Call with types to get only those (recommended), or without to list every type.',
      inputSchema: { type: 'object', properties: { types: { type: 'array', items: { type: 'string', enum: operationTypes } } }, additionalProperties: false },
      run: async args => {
        const types = Array.isArray(args.types) ? args.types as string[] : [];
        if (!types.length) return { types: operationTypes };
        return Object.fromEntries(types.map(type => {
          const option = operationSchema.options[operationTypes.indexOf(type)];
          if (!option) throw new Error(`Unknown operation type ${type}.`);
          return [type, z.toJSONSchema(option, { target: 'draft-7', unrepresentable: 'any' })];
        }));
      } },
    { name: 'apply_operations', description: `Apply LittleTake scene operations atomically (the same operations and validation Muse's edits use) and publish them to the project room. Every open browser page updates live. Types: ${operationTypes.join(', ')}. Use operation_schema for exact fields.`,
      inputSchema: { type: 'object', properties: {
        operations: { type: 'array', items: { type: 'object', properties: { type: { type: 'string', enum: operationTypes } }, required: ['type'] }, minItems: 1, maxItems: MAX_EDIT_OPERATIONS },
        time: { type: 'number', description: 'Scene time the edit is made at (used by pose-relative operations). Default 0.' } }, required: ['operations'], additionalProperties: false },
      run: async args => {
        const parsed = z.array(operationSchema).min(1).max(MAX_EDIT_OPERATIONS).safeParse(args.operations);
        if (!parsed.success) throw new Error('Invalid operations: ' + issues(parsed.error));
        const before = await current(), content = applyProjectOperations(projectContent(before), parsed.data, typeof args.time === 'number' ? args.time : 0);
        const changes = projectChanges(before, { ...before, ...content });
        if (!changes.length) return { applied: parsed.data.length, changed: false, revision: before.revision };
        const after = await room.edit(changes, before.revision);
        return { applied: parsed.data.length, changed: true, changes: changes.length, revision: after.project.revision };
      } },
  ];
}
