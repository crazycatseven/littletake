import { Euler, MathUtils, Quaternion, Vector3 } from 'three';
import { z } from 'zod';
import { evaluateTransform, migrateMotionTrack, propertyPaths, validateAnimation, type PropertyAnimation } from '../animation/model.ts';
import { sceneEntities, worldTransform } from '../placement/hierarchy.ts';
import type { ProjectContent, SceneEntity, Transform, Vec3 } from '../types.ts';
import { eulerDegrees } from '../rotation.ts';

const id = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const vector = (limit: number) => z.tuple([z.number().min(-limit).max(limit), z.number().min(-limit).max(limit), z.number().min(-limit).max(limit)]);
export const performanceTargetSchema = z.strictObject({ sceneId: id, entityId: id, takeId: id, shotId: id.nullable() });
export type PerformanceTarget = z.infer<typeof performanceTargetSchema>;
export const MAX_PERFORMANCE_TAKES = 8;
export const performanceKey = (target: PerformanceTarget) => `${target.sceneId}:${target.entityId}:${target.takeId}`;
export const performanceSelectionSchema = z.array(performanceTargetSchema).min(1).max(MAX_PERFORMANCE_TAKES).refine(targets =>
  new Set(targets.map(performanceKey)).size === targets.length && new Set(targets.map(target => target.sceneId)).size === 1,
  'Select distinct recordings from one scene.');
/** Reopen the earlier single-take conversation scope in the same canonical list format. */
export const savedPerformanceSchema = z.preprocess(value => value && !Array.isArray(value) ? [value] : value, performanceSelectionSchema);
/** Sparse corrections to an existing performance, rather than a replacement recording format. */
export const refinementSchema = z.strictObject({
  smoothness: z.number().min(0).max(1),
  anchors: z.array(z.strictObject({ time: z.number().min(0).max(60), position: vector(1000), rotation: vector(360000) })).max(24),
});
export type Refinement = z.infer<typeof refinementSchema>;
export const performanceCandidateSchema = z.strictObject({ summary: z.string().min(1).max(3000),
  refinements: z.array(z.strictObject({ targetIndex: z.number().int().min(0).max(MAX_PERFORMANCE_TAKES - 1), refinement: refinementSchema })).min(1).max(MAX_PERFORMANCE_TAKES) });
export type PerformanceCandidate = z.infer<typeof performanceCandidateSchema>;
export const performanceRequestSchema = z.strictObject({
  targets: performanceSelectionSchema,
  candidate: performanceCandidateSchema.optional(),
});
export type PerformanceRequest = z.infer<typeof performanceRequestSchema>;
export const refineTakeOperationSchema = z.strictObject({ type: z.literal('refine_take'), sceneId: id, id, takeId: id, refinement: refinementSchema });

export function performanceTake(project: ProjectContent, target: PerformanceTarget) {
  const scene = project.scenes.find(scene => scene.id === target.sceneId);
  const item = scene && sceneEntities(scene).find(item => item.id === target.entityId);
  if (!scene || !item) throw new Error('The recorded object no longer exists. Select a recording again.');
  const animation = item.animation ?? (item.track ? migrateMotionTrack(item.track) : undefined);
  const take = animation?.takes.find(take => take.id === target.takeId);
  if (!animation || !take) throw new Error('This recording no longer exists. Select a recording again.');
  if (!['position', 'rotation'].some(group => propertyPaths(group as 'position' | 'rotation').some(path => animation.curves[path]?.some(key => key.take === take.id))))
    throw new Error('This take has no recorded movement to refine.');
  if ('kind' in item && item.components?.some(component => component.type === 'followPath' && component.enabled))
    throw new Error('Disable Follow Path before refining this recorded movement; it overrides the recorded position.');
  const shot = scene.shots.find(shot => shot.id === target.shotId);
  if (target.shotId && !shot) throw new Error('The viewing shot no longer exists. Select a recording again.');
  if ('fov' in item && shot?.cameraId !== item.id) throw new Error('Choose a shot belonging to this camera to review its recording.');
  return { scene, item, animation, take };
}

export function performanceSelection(project: ProjectContent, targets: PerformanceTarget[]) {
  const selected = performanceSelectionSchema.parse(targets).map(target => ({ target, ...performanceTake(project, target) }));
  for (const [index, entry] of selected.entries()) if (selected.slice(index + 1).some(other => other.item.id === entry.item.id && Math.min(entry.take.end, other.take.end) - Math.max(entry.take.start, other.take.start) > 1e-7))
    throw new Error('These recordings overlap on the same object. Select non-overlapping takes.');
  return selected;
}

export function takeEvidenceTimes(start: number, end: number, count = 6): number[] {
  return Array.from({ length: count }, (_, index) => start + (end - start) * index / (count - 1));
}

/** A shared image budget and deduplication keep a multi-take review at two model calls. */
export function performanceFrames(project: ProjectContent, targets: PerformanceTarget[]) {
  const selected = performanceSelection(project, targets), count = Math.min(6, Math.floor(24 / selected.length));
  const frames: { time: number; view: 'shot' | 'top_down'; shotId: string | null }[] = [];
  for (const { target, take } of selected) for (const time of takeEvidenceTimes(take.start, take.end, count)) {
    const frame = { time, view: target.shotId ? 'shot' as const : 'top_down' as const, shotId: target.shotId };
    if (!frames.some(other => other.view === frame.view && other.shotId === frame.shotId && Math.abs(other.time - time) < 1e-7)) frames.push(frame);
  }
  const firstTime = Math.min(...selected.map(entry => entry.take.start));
  if (targets.some(target => target.shotId) && !frames.some(frame => frame.view === 'top_down' && frame.shotId === null && Math.abs(frame.time - firstTime) < 1e-7)) frames.push({ time: firstTime, view: 'top_down', shotId: null });
  return frames;
}

export function performanceOperations(targets: PerformanceTarget[], candidate: PerformanceCandidate) {
  const parsed = performanceCandidateSchema.parse(candidate), indexes = parsed.refinements.map(entry => entry.targetIndex);
  if (indexes.length !== targets.length || new Set(indexes).size !== targets.length || indexes.some(index => index >= targets.length))
    throw new Error('The proposal must account for every selected recording exactly once.');
  return targets.map((target, index) => ({ type: 'refine_take' as const, sceneId: target.sceneId, id: target.entityId, takeId: target.takeId,
    refinement: parsed.refinements.find(entry => entry.targetIndex === index)!.refinement }));
}

const quaternion = (rotation: Vec3) => new Quaternion().setFromEuler(new Euler(...rotation.map(MathUtils.degToRad) as Vec3, 'XYZ'));
const degrees = eulerDegrees;

/** Preserve the take's clock, endpoints, other channels and surrounding keys exactly. */
export function refineRecordedTake(item: SceneEntity, takeId: string, value: Refinement, duration: number): PropertyAnimation {
  const refinement = refinementSchema.parse(value), animation = structuredClone(item.animation ?? (item.track ? migrateMotionTrack(item.track) : undefined));
  const take = animation?.takes.find(take => take.id === takeId);
  if (!animation || !take) throw new Error('Unknown recorded take.');
  if (!refinement.smoothness && !refinement.anchors.length) return validateAnimation(animation, duration);
  const source = { ...item, animation }, { start, end } = take;
  let previous = start;
  for (const anchor of refinement.anchors) {
    if (anchor.time <= previous + 1e-7 || anchor.time >= end - 1e-7) throw new Error('Correction anchors must increase strictly inside the recorded interval. The endpoints stay fixed.');
    previous = anchor.time;
  }
  const smoothed = (time: number): Transform => {
    const original = evaluateTransform(source, time), radius = Math.min(.12, (end - start) / 12, time - start, end - time);
    if (!refinement.smoothness || radius < 1e-7) return original;
    const position = new Vector3(), rotation = new Quaternion(); let weight = 0;
    for (let index = -4; index <= 4; index++) {
      const pose = evaluateTransform(source, time + index * radius / 4), w = 5 - Math.abs(index);
      position.addScaledVector(new Vector3(...pose.position), w);
      if (!weight) rotation.copy(quaternion(pose.rotation)); else rotation.slerp(quaternion(pose.rotation), w / (weight + w));
      weight += w;
    }
    return { position: new Vector3(...original.position).lerp(position.divideScalar(weight), refinement.smoothness).toArray(),
      rotation: degrees(quaternion(original.rotation).slerp(rotation, refinement.smoothness)), scale: original.scale };
  };
  const anchors = [{ time: start, ...evaluateTransform(source, start) }, ...refinement.anchors, { time: end, ...evaluateTransform(source, end) }].map(anchor => {
    const base = smoothed(anchor.time);
    return { time: anchor.time, offset: new Vector3(...anchor.position).sub(new Vector3(...base.position)),
      rotation: quaternion(base.rotation).invert().multiply(quaternion(anchor.rotation)) };
  });
  // Keep actual input samples, including off-grid pauses and turns. Sparse legacy tracks
  // need extra samples to express smooth corrections using the ordinary linear curves.
  const originalTimes = [...new Set(Object.values(animation.curves).flatMap(keys => keys?.filter(key => key.take === take.id).map(key => key.time) ?? []))];
  const times = new Set<number>([start, end, ...originalTimes, ...refinement.anchors.map(anchor => anchor.time)]);
  if (originalTimes.length < (end - start) * 20) {
    const count = Math.ceil((end - start) * 30);
    for (let index = 1; index < count; index++) times.add(start + (end - start) * index / count);
  }
  const frames = [...times].sort((a, b) => a - b).map(time => {
    const base = smoothed(time);
    const index = Math.max(1, anchors.findIndex(anchor => anchor.time >= time));
    const from = anchors[index - 1], to = anchors[index];
    const t = MathUtils.clamp((time - from.time) / (to.time - from.time), 0, 1), alpha = t * t * (3 - 2 * t);
    return { time, position: new Vector3(...base.position).add(from.offset.clone().lerp(to.offset, alpha)).toArray(),
      rotation: degrees(quaternion(base.rotation).multiply(from.rotation.clone().slerp(to.rotation, alpha))) };
  });
  for (const group of ['position', 'rotation'] as const) for (const [axis, path] of propertyPaths(group).entries()) {
    const keys = animation.curves[path];
    // A position-only recording must not acquire a new rotation channel, or vice versa.
    if (!keys?.some(key => key.take === take.id)) continue;
    if (keys.some(key => key.time > start && key.time < end && key.take !== take.id)) throw new Error('This interval contains keys outside the recording. Select an intact recording to refine.');
    const replacements = frames.map(frame => {
      const boundary = (frame.time === start || frame.time === end) && keys.find(key => key.time === frame.time);
      return boundary || { time: frame.time, value: frame[group][axis], take: take.id,
        interpolation: group === 'rotation' ? 'quaternion' as const : 'linear' as const, ...(group === 'rotation' ? { orientation: frame.rotation } : {}) };
    });
    // Older scalar Euler takes need a complete orientation at the closing quaternion key.
    if (group === 'rotation') for (const key of replacements) key.orientation ??= evaluateTransform(source, key.time).rotation;
    animation.curves[path] = [...keys.filter(key => key.time < start), ...replacements, ...keys.filter(key => key.time > end)];
  }
  return validateAnimation(animation, duration);
}

/** Compact numeric evidence accompanies the images; coordinates explicitly include parent motion. */
export function performanceContext(project: ProjectContent, target: PerformanceTarget) {
  const { scene, item, animation, take } = performanceTake(project, target);
  const count = Math.min(120, Math.max(6, Math.ceil((take.end - take.start) * 10)));
  const samples = Array.from({ length: count + 1 }, (_, index) => {
    const time = take.start + (take.end - take.start) * index / count;
    return { time, local: evaluateTransform({ ...item, animation }, time), world: worldTransform(scene, item.id, time) };
  });
  return { target, subject: { id: item.id, name: item.name, kind: 'kind' in item ? item.kind : 'camera', parentId: item.parentId ?? null },
    range: { start: take.start, end: take.end }, samples,
    scene: sceneEntities(scene).map(entity => ({ id: entity.id, name: entity.name, kind: 'kind' in entity ? entity.kind : 'camera',
      atStart: worldTransform(scene, entity.id, take.start), atEnd: worldTransform(scene, entity.id, take.end) })) };
}
