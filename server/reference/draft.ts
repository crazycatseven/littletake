import { z } from 'zod';
import { Euler, MathUtils, Matrix4, Vector3 } from 'three';
import { validateDocument } from '../../src/model.ts';
import type { SceneDocument, Transform, Vec3 } from '../../src/types.ts';
import { AIError } from '../ai/provider.ts';

const vector = z.array(z.number().min(-100).max(100)).length(3);
const transform = z.strictObject({ position: vector, rotation: z.array(z.number().min(-360).max(360)).length(3), scale: z.array(z.number().min(0.01).max(30)).length(3) });
const timing = { start: z.number().min(0).max(60), duration: z.number().min(0.1).max(60) };
const cameraPose = z.strictObject({ position: vector, target: vector });
export const proposalSchema = z.strictObject({
  name: z.string().trim().min(1).max(120),
  summary: z.string().trim().min(1).max(1500),
  assumptions: z.array(z.string().trim().min(1).max(300)).max(8),
  objects: z.array(z.strictObject({
    name: z.string().trim().min(1).max(120), kind: z.enum(['cube', 'sphere', 'cylinder', 'cone', 'plane', 'human']),
    transform, motion: z.strictObject({ ...timing, from: transform, to: transform }).nullable(),
  })).min(1).max(24),
  camera: z.strictObject({
    position: vector, target: vector, fov: z.number().min(15).max(100),
    motion: z.strictObject({ ...timing, from: cameraPose, to: cameraPose }).nullable(),
  }),
});
export const proposalJSONSchema = z.toJSONSchema(proposalSchema, { target: 'draft-7' });

function cameraTransform(position: number[], target: number[]): Transform {
  const eye = new Vector3(...position as Vec3), look = new Vector3(...target as Vec3);
  if (eye.distanceTo(look) < 0.05) throw new Error('Camera needs a distinct target.');
  const angles = new Euler().setFromRotationMatrix(new Matrix4().lookAt(eye, look, new Vector3(0, 1, 0)), 'XYZ');
  return { position: [...position] as Vec3, rotation: [angles.x, angles.y, angles.z].map(MathUtils.radToDeg) as Vec3, scale: [1, 1, 1] };
}

/** Convert an AI estimate into the same validated, editable scene used by manual authoring. */
export function sceneFromProposal(value: unknown, duration: number): { scene: SceneDocument; summary: string; assumptions: string[] } {
  try {
    const proposal = proposalSchema.parse(value);
    const trackTime = (motion: { start: number; duration: number }) => {
      if (motion.start + motion.duration > duration + 0.001) throw new Error('Motion exceeds the clip.');
      return { start: motion.start, duration: Math.min(motion.duration, duration - motion.start) };
    };
    const objects = proposal.objects.map((item, index) => ({
      id: `object-${index + 1}`, name: item.name, kind: item.kind, color: '#deded7', transform: item.transform as Transform,
      track: item.motion ? { ...trackTime(item.motion), from: item.motion.from as Transform, to: item.motion.to as Transform } : null,
    }));
    const cameraMotion = proposal.camera.motion;
    const scene = validateDocument({
      format: 'LittleTake.scene', version: 3, id: 'scene-1', name: proposal.name, duration, objects,
      cameras: [{ id: 'camera', name: 'Camera 1', fov: proposal.camera.fov, transform: cameraTransform(proposal.camera.position, proposal.camera.target),
        track: cameraMotion ? { ...trackTime(cameraMotion), from: cameraTransform(cameraMotion.from.position, cameraMotion.from.target), to: cameraTransform(cameraMotion.to.position, cameraMotion.to.target) } : null,
      }],
      shots: [{ id: 'shot-1', name: 'Shot 1', cameraId: 'camera', start: 0, duration }],
    });
    return { scene, summary: proposal.summary, assumptions: proposal.assumptions };
  } catch { throw new AIError('invalid_scene', 'The AI scene could not be loaded safely. Your current scene is unchanged. Please try again.'); }
}
