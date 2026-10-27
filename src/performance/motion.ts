import { Euler, MathUtils, Matrix4, Quaternion, Vector3 } from 'three';
import { z } from 'zod';
import type { MotionTrack, Transform, Vec3 } from '../types.ts';

const vector = (min: number, max: number) => z.tuple([z.number().min(min).max(max), z.number().min(min).max(max), z.number().min(min).max(max)]);
export const transformSchema = z.strictObject({ position: vector(-1000, 1000), rotation: vector(-360000, 360000), scale: vector(.01, 100) });
export const samplesSchema = z.array(z.strictObject({ at: z.number().gt(0).lt(1), transform: transformSchema })).max(3600).refine(samples => samples.every((s, i) => i === 0 || s.at > samples[i - 1].at), 'Recorded samples must be in time order.');
export const motionSchema = z.strictObject({ start: z.number().min(0).max(60), duration: z.number().min(.1).max(60), from: transformSchema, to: transformSchema, samples: samplesSchema.optional() }).refine(t => t.start + t.duration <= 60 + 1e-9, 'Motion must finish within 60 seconds.');

export function trackPoses(track: MotionTrack): Transform[] { return [track.from, ...(track.samples ?? []).map(s => s.transform), track.to]; }

/** Move the whole performance around the pose shown at the playhead. */
export function repositionTrack(track: MotionTrack, from: Transform, to: Transform): void {
  const matrix = (pose: Transform) => new Matrix4().compose(new Vector3(...pose.position), new Quaternion().setFromEuler(new Euler(...pose.rotation.map(MathUtils.degToRad) as Vec3, 'XYZ')), new Vector3(...pose.scale));
  const delta = matrix(to).multiply(matrix(from).invert());
  for (const pose of trackPoses(track)) {
    const position = new Vector3(), rotation = new Quaternion(), scale = new Vector3();
    delta.clone().multiply(matrix(pose)).decompose(position, rotation, scale);
    const euler = new Euler().setFromQuaternion(rotation, 'XYZ');
    pose.position = position.toArray() as Vec3; pose.rotation = [euler.x, euler.y, euler.z].map(MathUtils.radToDeg) as Vec3; pose.scale = scale.toArray() as Vec3;
  }
}

export function recordedTrack(frames: { time: number; transform: Transform }[]): MotionTrack {
  const first = frames[0], last = frames.at(-1)!;
  const duration = last.time - first.time;
  if (duration < .1) throw new Error('Record for at least 0.1 seconds.');
  return { start: first.time, duration, from: structuredClone(first.transform), to: structuredClone(last.transform),
    samples: frames.slice(1, -1).map(frame => ({ at: (frame.time - first.time) / duration, transform: structuredClone(frame.transform) })) };
}
