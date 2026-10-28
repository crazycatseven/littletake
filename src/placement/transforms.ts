import { evaluateTransform } from '../model';
import { repositionTrack, trackPoses, transformSchema } from '../performance/motion';
import { transformAnimatedSelection } from '../animation/model';
import type { SceneEntity, Transform } from '../types';

export interface PoseUpdate { id: string; transform: Transform }
export type TransformPhase = 'start' | 'change' | 'end' | 'cancel';

/** Calculate the entire edit before touching live entities, including off-screen motion poses. */
export function transformSelection(before: SceneEntity[], updates: PoseUpdate[], time: number, wholeMotion: boolean): SceneEntity[] {
  const poses = new Map(updates.map(update => [update.id, update.transform]));
  if (poses.size !== before.length || before.some(item => !poses.has(item.id))) throw new Error('The selection changed. Try the transform again.');
  return before.map(source => {
    const item = structuredClone(source), pose = transformSchema.parse(poses.get(item.id));
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
