import { z } from 'zod';
import { Euler, MathUtils, Matrix4, Vector3 } from 'three';
import { cloneDocument, evaluateTransform, validateDocument } from '../model.ts';
import type { SceneDocument, SceneEntity, Vec3 } from '../types.ts';

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

export const operationSchema = z.union([
  z.strictObject({ type: z.literal('translate'), id, offset: position }),
  z.strictObject({ type: z.literal('set_transform'), id, pose, transform }),
  z.strictObject({ type: z.literal('set_motion'), id, track: track.nullable() }),
  z.strictObject({ type: z.literal('aim_camera'), pose, position, target: position, fov: z.number().min(10).max(120) }),
  z.strictObject({ type: z.literal('rename'), id, name }),
  z.strictObject({ type: z.literal('set_color'), id, color }),
  z.strictObject({ type: z.literal('add_object'), object: z.strictObject({ id, name, kind: z.enum(['cube', 'sphere', 'cylinder', 'cone', 'plane', 'human']), color, transform, track: track.nullable() }) }),
  z.strictObject({ type: z.literal('remove_object'), id }),
  z.strictObject({ type: z.literal('set_duration'), duration: z.number().min(1).max(60) }),
]);
export const editPlanSchema = z.strictObject({
  summary: z.string().trim().min(1).max(600),
  requestedViews: z.array(viewSchema).max(2),
  operations: z.array(operationSchema).max(32),
});
export type SceneOperation = z.infer<typeof operationSchema>;
export type EditPlan = z.infer<typeof editPlanSchema>;

function poseTarget(item: SceneEntity, target: z.infer<typeof pose>) {
  if (target === 'static') {
    if (item.track) throw new Error(`${item.id} is animated. Edit its start/end pose or translate its whole path.`);
    return item.transform;
  }
  if (!item.track) throw new Error(`${item.id} has no motion track.`);
  return item.track[target === 'start' ? 'from' : 'to'];
}

/** Pure, atomic document changes shared by the server and the editor. */
export function applySceneOperations(source: SceneDocument, operations: SceneOperation[], time: number): SceneDocument {
  const doc = cloneDocument(validateDocument(source));
  if (!Number.isFinite(time) || time < 0 || time > doc.duration) throw new Error('Invalid scene time.');
  const parsed = z.array(operationSchema).max(32).parse(operations);
  const find = (target: string): SceneEntity => {
    const item = target === 'camera' ? doc.camera : doc.objects.find(object => object.id === target);
    if (!item) throw new Error(`Unknown scene object: ${target}`);
    return item;
  };
  for (const operation of parsed) {
    switch (operation.type) {
      case 'translate': {
        const item = find(operation.id);
        for (const target of [item.transform, ...(item.track ? [item.track.from, item.track.to] : [])]) {
          target.position = target.position.map((value, index) => value + operation.offset[index]) as Vec3;
        }
        break;
      }
      case 'set_transform': Object.assign(poseTarget(find(operation.id), operation.pose), structuredClone(operation.transform)); break;
      case 'set_motion': {
        const item = find(operation.id);
        if (operation.track === null) item.transform = evaluateTransform(item, time);
        else item.transform = structuredClone(operation.track.from);
        item.track = structuredClone(operation.track); break;
      }
      case 'aim_camera': {
        const eye = new Vector3(...operation.position), target = new Vector3(...operation.target);
        if (eye.distanceToSquared(target) < 1e-8) throw new Error('Camera position and target must differ.');
        const euler = new Euler().setFromRotationMatrix(new Matrix4().lookAt(eye, target, new Vector3(0, 1, 0)), 'XYZ');
        const cameraPose = poseTarget(doc.camera, operation.pose);
        cameraPose.position = [...operation.position];
        cameraPose.rotation = [euler.x, euler.y, euler.z].map(MathUtils.radToDeg) as Vec3;
        doc.camera.fov = operation.fov; break;
      }
      case 'rename': find(operation.id).name = operation.name; break;
      case 'set_color': {
        const item = find(operation.id); if (!('color' in item)) throw new Error('The camera has no material.');
        item.color = operation.color; break;
      }
      case 'add_object': doc.objects.push(structuredClone(operation.object)); break;
      case 'remove_object': {
        find(operation.id); if (operation.id === 'camera') throw new Error('The shot camera cannot be removed.');
        doc.objects = doc.objects.filter(object => object.id !== operation.id); break;
      }
      case 'set_duration': doc.duration = operation.duration; break;
    }
  }
  return validateDocument(doc);
}
