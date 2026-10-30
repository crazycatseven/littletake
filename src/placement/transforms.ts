import { animationFor, ensureAnimation, evaluateTransform } from '../model.ts';
import { repositionTrack, trackPoses, transformSchema } from '../performance/motion.ts';
import { evaluateProperty, putKey, transformAnimatedSelection } from '../animation/model.ts';
import type { SceneEntity, Transform } from '../types.ts';

export interface PoseUpdate { id: string; transform: Transform }
export type TransformPhase = 'start' | 'change' | 'end' | 'cancel';
/** XR grabbing edits the current key when present, otherwise moves the whole motion. */
export type TransformScope = boolean | 'keyframe-pose';

function updateKeyframePose(item: SceneEntity, pose: Transform, time: number): boolean {
  const original = structuredClone(animationFor(item));
  const times = [...new Set(Object.values(original?.curves ?? {}).flatMap(keys => keys?.map(key => key.time) ?? []))];
  const at = times.find(value => Math.abs(value - time) < 1e-6);
  if (at === undefined) return false;
  const before = evaluateTransform(item, time);
  const rotations = new Map(times.map(at => [at, evaluateTransform(item, at).rotation]));
  for (const [index, axis] of (['x', 'y', 'z'] as const).entries()) {
    if (Math.abs(pose.position[index] - before.position[index]) < 1e-8) continue;
    const path = `position.${axis}` as const;
    const animation = ensureAnimation(item);
    // Anchor missing channels at the other pose times so a lone key cannot
    // shift every pose. Existing keys and their interpolation metadata survive.
    for (const anchor of times) {
      if (Math.abs(anchor - at) < 1e-6 || animation.curves[path]?.some(key => Math.abs(key.time - anchor) < 1e-6)) continue;
      putKey(animation, path, anchor, evaluateProperty(original, path, item.transform.position[index], anchor));
    }
    const keyTime = animation.curves[path]?.find(key => Math.abs(key.time - at) < 1e-6)?.time ?? at;
    putKey(animation, path, keyTime, pose.position[index]);
  }
  if (pose.rotation.some((value, index) => Math.abs(value - before.rotation[index]) > 1e-8)) {
    const animation = ensureAnimation(item);
    for (const anchor of times) {
      if (Math.abs(anchor - at) < 1e-6) continue;
      for (const [index, axis] of (['x', 'y', 'z'] as const).entries()) {
        const path = `rotation.${axis}` as const;
        if (!animation.curves[path]?.some(key => Math.abs(key.time - anchor) < 1e-6))
          putKey(animation, path, anchor, rotations.get(anchor)![index], rotations.get(anchor));
      }
    }
    // Quaternion segments read the full orientation snapshot on every axis.
    for (const [index, axis] of (['x', 'y', 'z'] as const).entries()) {
      const path = `rotation.${axis}` as const;
      const keyTime = animation.curves[path]?.find(key => Math.abs(key.time - at) < 1e-6)?.time ?? at;
      putKey(animation, path, keyTime, pose.rotation[index], pose.rotation);
    }
  }
  return true;
}

/** Calculate the entire edit before touching live entities, including off-screen motion poses. */
export function transformSelection(before: SceneEntity[], updates: PoseUpdate[], time: number, wholeMotion: TransformScope): SceneEntity[] {
  const poses = new Map(updates.map(update => [update.id, update.transform]));
  if (poses.size !== before.length || before.some(item => !poses.has(item.id))) throw new Error('The selection changed. Try the transform again.');
  return before.map(source => {
    const item = structuredClone(source), pose = transformSchema.parse(poses.get(item.id));
    if (wholeMotion === 'keyframe-pose' && updateKeyframePose(item, pose, time)) return item;
    if (item.animation && wholeMotion) {
      const original=evaluateTransform(source,time);
      const animatedTransform=Object.entries(item.animation.curves).some(([path,keys])=>/^(position|rotation|scale)\./.test(path)&&keys?.length);
      if(!animatedTransform)item.transform=pose;
      else transformAnimatedSelection(item.animation,item.transform,original,pose);
    } else if (item.track && (wholeMotion || item.track.samples)) {
      repositionTrack(item.track, evaluateTransform(source, time), pose);
      item.transform = structuredClone(item.track.from);
    } else if (item.track) {
      const end = item.track.start + item.track.duration;
      if (time > item.track.start + .015 && time < end - .015) throw new Error('Choose a motion endpoint before editing its pose.');
      item.track[Math.abs(time - item.track.start) <= Math.abs(time - end) ? 'from' : 'to'] = pose;
    } else item.transform = pose;
    transformSchema.parse(item.transform);
    if (item.track) trackPoses(item.track).forEach(value => transformSchema.parse(value));
    return item;
  });
}
