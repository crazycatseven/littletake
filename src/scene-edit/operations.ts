import { z } from 'zod';
import { Euler, MathUtils, Matrix4, Vector3 } from 'three';
import { createEmptyScene, evaluateTransform, sceneEntity } from '../model.ts';
import { validateProjectContent } from '../project/model.ts';
import type { ProjectContent, SceneEntity, Vec3 } from '../types.ts';
import { trackPoses } from '../performance/motion.ts';
import { assetSchema, validateAsset } from '../assets/model.ts';
import { instantiateAsset } from '../assets/library.ts';
import { isSpatialOperation, spatialOperationSchema } from '../spatial/schema.ts';
import { solveSpatial } from '../spatial/methods.ts';

const vector = (min: number, max: number) => z.array(z.number().min(min).max(max)).length(3) as unknown as z.ZodType<Vec3>;
const position = vector(-1000, 1000);
const rotation = vector(-360000, 360000);
const scale = vector(0.01, 100);
const transform = z.strictObject({ position, rotation, scale });
const track = z.strictObject({ start: z.number().min(0).max(60), duration: z.number().min(0.1).max(60), from: transform, to: transform });
const id = z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/);
const name = z.string().trim().min(1).max(120);
const color = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const pose = z.enum(['static', 'start', 'end']);
export const viewSchema = z.enum(['top_down', 'shot']);
export type SceneView = z.infer<typeof viewSchema>;
export interface SceneSnapshot {
  view: SceneView; time: number; width: number; height: number; dataUrl: string;
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number } | null;
}

const cameraFields = { id, name, fov: z.number().min(10).max(120), transform, track: track.nullable() };
const shotFields = { id, name, cameraId: id, start: z.number().min(0).max(60), duration: z.number().min(0.1).max(60) };
// Historical chat receipts keep their original proposed framing; this is never offered to the model.
export const legacyShotOperationSchema = z.strictObject({ type: z.literal('add_shot'), sceneId: id, shot: z.strictObject({ ...cameraFields, ...shotFields }) });
export const operationSchema = z.union([
  ...spatialOperationSchema.options,
  z.strictObject({ type: z.literal('instantiate_asset'), sceneId: id, id, name, asset: assetSchema, transform, track: track.nullable() }),
  z.strictObject({ type: z.literal('add_scene'), sceneId: id, name, duration: z.number().min(1).max(60) }),
  z.strictObject({ type: z.literal('remove_scene'), sceneId: id }),
  z.strictObject({ type: z.literal('rename_scene'), sceneId: id, name }),
  z.strictObject({ type: z.literal('add_camera'), sceneId: id, camera: z.strictObject(cameraFields) }),
  z.strictObject({ type: z.literal('remove_camera'), sceneId: id, id }),
  z.strictObject({ type: z.literal('add_shot'), sceneId: id, shot: z.strictObject(shotFields) }),
  z.strictObject({ type: z.literal('remove_shot'), sceneId: id, id }),
  z.strictObject({ type: z.literal('set_shot_range'), sceneId: id, id, cameraId: id, start: z.number().min(0).max(60), duration: z.number().min(0.1).max(60) }),
  z.strictObject({ sceneId: id, type: z.literal('translate'), id, offset: position }),
  z.strictObject({ sceneId: id, type: z.literal('set_transform'), id, pose, transform }),
  z.strictObject({ sceneId: id, type: z.literal('set_motion'), id, track: track.nullable() }),
  z.strictObject({ sceneId: id, type: z.literal('aim_camera'), id, pose, position, target: position, fov: z.number().min(10).max(120) }),
  z.strictObject({ sceneId: id, type: z.literal('rename'), id, name }),
  z.strictObject({ sceneId: id, type: z.literal('set_color'), id, color }),
  z.strictObject({ sceneId: id, type: z.literal('add_object'), object: z.strictObject({ id, name, kind: z.enum(['cube', 'sphere', 'cylinder', 'cone', 'plane', 'human']), color, transform, track: track.nullable() }) }),
  z.strictObject({ sceneId: id, type: z.literal('remove_object'), id }),
  z.strictObject({ sceneId: id, type: z.literal('set_duration'), duration: z.number().min(1).max(60) }),
]);
export const objectCountSchema = z.strictObject({
  sceneId: id, source: z.string().min(1).max(200), comparison: z.enum(['at_most', 'exactly']), count: z.number().int().min(0).max(100),
});
export const editPlanSchema = z.strictObject({
  summary: z.string().trim().min(1).max(4000),
  requestedViews: z.array(viewSchema).max(2),
  operations: z.array(operationSchema).max(64),
  objectCounts: z.array(objectCountSchema).max(24).optional(),
});
export type SceneOperation = z.infer<typeof operationSchema>;
export type EditPlan = z.infer<typeof editPlanSchema>;

function poseTarget(item: SceneEntity, target: z.infer<typeof pose>) {
  if (item.animation) throw new Error(`${item.id} has property animation. Edit its keys before changing its pose.`);
  if (target === 'static') {
    if (item.track) throw new Error(`${item.id} is animated. Edit its start/end pose or translate its whole path.`);
    return item.transform;
  }
  if (!item.track) throw new Error(`${item.id} has no motion track.`);
  return item.track[target === 'start' ? 'from' : 'to'];
}

/** Pure, atomic document changes shared by the server and the editor. */
export function applyProjectOperations(source: ProjectContent, operations: SceneOperation[], time: number): ProjectContent {
  const project = validateProjectContent(source);
  if (!Number.isFinite(time) || time < 0 || time > 60) throw new Error('Invalid scene time.');
  const parsed = z.array(operationSchema).max(64).parse(operations);
  for (const [index, operation] of parsed.entries()) {
    if (operation.type === 'add_scene') {
      if (project.scenes.some(scene => scene.id === operation.sceneId)) throw new Error(`Operation ${index + 1} (add_scene): Scene ID ${operation.sceneId} already exists. Edit that scene using its existing ID instead of adding it again.`);
      project.scenes.push({ ...createEmptyScene(operation.sceneId, operation.name), duration: operation.duration }); continue;
    }
    const doc = project.scenes.find(scene => scene.id === operation.sceneId);
    if (!doc) throw new Error(`Operation ${index + 1} (${operation.type}): Unknown scene: ${operation.sceneId}. ${source.scenes.some(scene => scene.id === operation.sceneId) ? 'Earlier operations removed this scene. ' : ''}Available scene IDs: ${project.scenes.map(scene => scene.id).join(', ') || '(none)'}.`);
    const find = (id: string): SceneEntity => {
      const item = sceneEntity(doc, id);
      if (!item) throw new Error(`Operation ${index + 1} (${operation.type}): Unknown entity: ${id} in scene ${doc.id}. Available entity IDs: ${[...doc.objects, ...doc.cameras, ...doc.shots].map(item => item.id).join(', ') || '(none)'}.`);
      return item;
    };
    if (isSpatialOperation(operation)) {
      const result = solveSpatial(project, operation);
      for (const update of result.updates) {
        const item = find(update.id);
        item.transform = structuredClone(update.transform);
        item.track = structuredClone(update.track);
        if (update.animation) item.animation = structuredClone(update.animation);
        else delete item.animation;
      }
      continue;
    }
    switch (operation.type) {
      case 'remove_scene': project.scenes = project.scenes.filter(scene => scene.id !== doc.id); break;
      case 'rename_scene': doc.name = operation.name; break;
      case 'add_camera': doc.cameras.push(structuredClone(operation.camera)); break;
      case 'remove_camera': {
        const item = find(operation.id);
        if ('kind' in item) throw new Error('Select a camera to remove.');
        if (doc.shots.some(shot => shot.cameraId === item.id)) throw new Error('Remove or reassign shots before removing their camera.');
        doc.cameras = doc.cameras.filter(camera => camera.id !== item.id); break;
      }
      case 'add_shot': doc.shots.push(structuredClone(operation.shot)); break;
      case 'remove_shot': { if (!doc.shots.some(shot => shot.id === operation.id)) throw new Error('Select a shot.'); doc.shots = doc.shots.filter(shot => shot.id !== operation.id); break; }
      case 'set_shot_range': {
        const item = doc.shots.find(shot => shot.id === operation.id); if (!item) throw new Error('Select a shot.');
        item.start = operation.start; item.duration = operation.duration; item.cameraId = operation.cameraId;
        break;
      }
      case 'translate': {
        const item = find(operation.id);
        for (const target of [item.transform, ...(item.track ? trackPoses(item.track) : [])]) {
          target.position = target.position.map((value, index) => value + operation.offset[index]) as Vec3;
        }
        if(item.animation)for(const [index,axis] of (['x','y','z'] as const).entries())for(const key of item.animation.curves[`position.${axis}`]??[])key.value+=operation.offset[index];
        break;
      }
      case 'set_transform': Object.assign(poseTarget(find(operation.id), operation.pose), structuredClone(operation.transform)); break;
      case 'set_motion': {
        const item = find(operation.id);
        if (operation.track === null) item.transform = evaluateTransform(item, time);
        else item.transform = structuredClone(operation.track.from);
        delete item.animation;item.track = structuredClone(operation.track); break;
      }
      case 'aim_camera': {
        const eye = new Vector3(...operation.position), target = new Vector3(...operation.target);
        if (eye.distanceToSquared(target) < 1e-8) throw new Error('Camera position and target must differ.');
        const euler = new Euler().setFromRotationMatrix(new Matrix4().lookAt(eye, target, new Vector3(0, 1, 0)), 'XYZ');
        const camera = find(operation.id); if (!('fov' in camera)) throw new Error('Select a camera.');
        const cameraPose = poseTarget(camera, operation.pose);
        cameraPose.position = [...operation.position];
        cameraPose.rotation = [euler.x, euler.y, euler.z].map(MathUtils.radToDeg) as Vec3;
        camera.fov = operation.fov; break;
      }
      case 'rename': (doc.shots.find(shot => shot.id === operation.id) ?? find(operation.id)).name = operation.name; break;
      case 'set_color': {
        const item = find(operation.id); if (!('color' in item)) throw new Error('The camera has no material.');
        item.color = operation.color; break;
      }
      case 'add_object': doc.objects.push(structuredClone(operation.object)); break;
      case 'instantiate_asset': {
        const asset = validateAsset(operation.asset);
        project.assets = [...(project.assets ?? []).filter(a => a.id !== asset.id), asset];
        const instance=instantiateAsset(asset,operation.id,operation.transform.position,doc.duration);
        instance.name=operation.name;instance.transform=structuredClone(operation.transform);
        if(operation.track)instance.track=structuredClone(operation.track);
        doc.objects.push(instance);break;
      }
      case 'remove_object': {
        if (!('kind' in find(operation.id))) throw new Error('Select an object to remove.');
        doc.objects = doc.objects.filter(object => object.id !== operation.id); break;
      }
      case 'set_duration': doc.duration = operation.duration; break;
    }
  }
  return validateProjectContent(project);
}
