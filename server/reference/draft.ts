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
  // + 0 turns -0 into 0, so a saved and reloaded scene compares equal.
  return { position: [...position] as Vec3, rotation: [angles.x, angles.y, angles.z].map(angle => MathUtils.radToDeg(angle) + 0) as Vec3, scale: [1, 1, 1] };
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

/**
 * A clip with hard cuts: one shared set, actor motion over the whole clip as timed keys,
 * and one camera per shot in cut order. Shot ranges come from the detected cuts, not the model.
 */
const objectKey = z.strictObject({ time: z.number().min(0).max(60), transform });
const shotCamera = z.strictObject({
  position: vector, target: vector, fov: z.number().min(15).max(100),
  motion: z.strictObject({ ...timing, from: cameraPose, to: cameraPose }).nullable(),
});
export const multiShotProposalSchema = z.strictObject({
  name: z.string().trim().min(1).max(120),
  summary: z.string().trim().min(1).max(1500),
  assumptions: z.array(z.string().trim().min(1).max(300)).max(8),
  objects: z.array(z.strictObject({
    name: z.string().trim().min(1).max(120), kind: z.enum(['cube', 'sphere', 'cylinder', 'cone', 'plane', 'human']),
    transform, keys: z.array(objectKey).max(12),
  })).min(1).max(24),
  shots: z.array(z.strictObject({ camera: shotCamera })).min(1).max(12),
});
export const multiShotProposalJSONSchema = z.toJSONSchema(multiShotProposalSchema, { target: 'draft-7' });

/** Shot ranges for a clip cut at `cuts`, in clip seconds. */
export function shotRanges(duration: number, cuts: number[]): { start: number; end: number }[] {
  const bounds = [0, ...cuts.filter(at => at > 0 && at < duration), duration];
  return bounds.slice(1).map((end, index) => ({ start: bounds[index], end }));
}

export function sceneFromMultiShotProposal(value: unknown, duration: number, cuts: number[]): { scene: SceneDocument; summary: string; assumptions: string[] } {
  try {
    const proposal = multiShotProposalSchema.parse(value), ranges = shotRanges(duration, cuts), notes: string[] = [];
    const objects = proposal.objects.map((item, index) => {
      const keys = [...item.keys].sort((a, b) => a.time - b.time).filter((key, i, all) => i === 0 || key.time - all[i - 1].time >= .05);
      if (keys.some(key => key.time > duration + .001)) throw new Error('Motion exceeds the clip.');
      const track = keys.length >= 2 ? {
        start: keys[0].time, duration: keys.at(-1)!.time - keys[0].time, from: keys[0].transform as Transform, to: keys.at(-1)!.transform as Transform,
        ...(keys.length > 2 ? { samples: keys.slice(1, -1).map(key => ({ at: (key.time - keys[0].time) / (keys.at(-1)!.time - keys[0].time), transform: key.transform as Transform })) } : {}),
      } : null;
      return { id: `object-${index + 1}`, name: item.name, kind: item.kind, color: '#deded7', transform: (track?.from ?? item.transform) as Transform, track };
    });
    // The detected cuts decide how many shots there are; extra cameras are dropped and missing ones repeat the last.
    if (proposal.shots.length !== ranges.length) notes.push(`Muse described ${proposal.shots.length} camera${proposal.shots.length === 1 ? '' : 's'} for ${ranges.length} detected shots; ${proposal.shots.length > ranges.length ? 'extra cameras were dropped' : 'the last camera was reused for the remaining shots'}.`);
    const cameras = ranges.map((range, index) => {
      const camera = proposal.shots[Math.min(index, proposal.shots.length - 1)].camera, motion = camera.motion;
      let track = null;
      if (motion) {
        // A camera move belongs to its own shot; clamp it into that range rather than letting it run across a cut.
        const start = Math.min(Math.max(motion.start, range.start), range.end - .1), end = Math.min(Math.max(start + .1, motion.start + motion.duration), range.end);
        track = { start, duration: end - start, from: cameraTransform(motion.from.position, motion.from.target), to: cameraTransform(motion.to.position, motion.to.target) };
      }
      return { id: `camera-${index + 1}`, name: `Camera ${index + 1}`, fov: camera.fov, transform: track?.from ?? cameraTransform(camera.position, camera.target), track };
    });
    const scene = validateDocument({
      format: 'LittleTake.scene', version: 3, id: 'scene-1', name: proposal.name, duration, objects, cameras,
      shots: ranges.map((range, index) => ({ id: `shot-${index + 1}`, name: `Shot ${index + 1}`, cameraId: `camera-${index + 1}`, start: range.start, duration: range.end - range.start })),
    });
    return { scene, summary: proposal.summary, assumptions: [...proposal.assumptions, ...notes].slice(0, 9) };
  } catch { throw new AIError('invalid_scene', 'The AI scene could not be loaded safely. Your current scene is unchanged. Please try again.'); }
}
