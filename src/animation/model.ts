import { Euler, MathUtils, Matrix4, Quaternion, Vector3 } from 'three';
import { z } from 'zod';
import type { MotionTrack, Transform, Vec3 } from '../types.ts';

const axes = ['x', 'y', 'z'] as const;
export type AnimationAxis = typeof axes[number];
export type VectorProperty = 'position' | 'rotation' | 'scale' | 'pivot';
export type PropertyPath = `${VectorProperty}.${AnimationAxis}` | 'fov';
export type Interpolation = 'linear' | 'constant' | 'smooth' | 'quaternion';
export interface PropertyKey {
  time: number;
  value: number;
  interpolation: Interpolation;
  /** The complete rotation used by a quaternion segment. Values are Euler degrees in XYZ order. */
  orientation?: Vec3;
  take?: string;
}
export interface AnimationTake { id: string; start: number; end: number; source: 'recorded' | 'legacy' }
export interface PropertyAnimation {
  curves: Partial<Record<PropertyPath, PropertyKey[]>>;
  takes: AnimationTake[];
}

const paths = [...(['position', 'rotation', 'scale', 'pivot'] as const).flatMap(group => axes.map(axis => `${group}.${axis}` as PropertyPath)), 'fov'] as PropertyPath[];
const pathSet = new Set<string>(paths);
const orientationSchema = z.tuple([z.number().min(-360000).max(360000), z.number().min(-360000).max(360000), z.number().min(-360000).max(360000)]);
const takeId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const keySchema = z.strictObject({
  time: z.number().min(0).max(60), value: z.number(),
  interpolation: z.enum(['linear', 'constant', 'smooth', 'quaternion']),
  orientation: orientationSchema.optional(), take: takeId.optional(),
});
export const animationSchema = z.strictObject({
  curves: z.record(z.string(), z.array(keySchema).max(3602)),
  takes: z.array(z.strictObject({ id: takeId, start: z.number().min(0).max(60), end: z.number().min(0).max(60), source: z.enum(['recorded', 'legacy']) })).max(100),
});

export function propertyPaths(group: VectorProperty): PropertyPath[] { return axes.map(axis => `${group}.${axis}` as PropertyPath); }
export function emptyAnimation(): PropertyAnimation { return { curves: {}, takes: [] }; }
export function frameAtTime(time: number, fps: number): number { return Math.round(time * fps); }
export function timeAtFrame(frame: number, fps: number): number { return frame / fps; }

function limits(path: PropertyPath): [number, number] {
  if (path === 'fov') return [10, 120];
  if (path.startsWith('rotation.')) return [-360000, 360000];
  if (path.startsWith('scale.')) return [.01, 100];
  return [-1000, 1000];
}

/** Validates the serialized form before it can enter a project. */
export function validateAnimation(value: unknown, duration: number): PropertyAnimation {
  if (!Number.isFinite(duration) || duration <= 0 || duration > 60) throw new Error('Invalid scene duration.');
  const parsed = animationSchema.parse(value), ids = new Map<string, AnimationTake>();
  for (const take of parsed.takes) {
    if (ids.has(take.id) || take.end <= take.start || take.end > duration + 1e-9) throw new Error('Invalid animation take.');
    ids.set(take.id, take);
  }
  for (const [name, keys] of Object.entries(parsed.curves)) {
    if (!pathSet.has(name)) throw new Error(`Property ${name} is not animatable.`);
    const path = name as PropertyPath, [min, max] = limits(path);
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      if (key.time > duration + 1e-9 || key.value < min || key.value > max || (i > 0 && key.time <= keys[i - 1].time)) throw new Error(`Invalid keys for ${path}.`);
      const take = key.take && ids.get(key.take);
      if (key.take && (!take || key.time < take.start - 1e-9 || key.time > take.end + 1e-9)) throw new Error(`Invalid animation take for ${path}.`);
      if (key.interpolation === 'quaternion' && (!path.startsWith('rotation.') || !key.orientation || (i + 1 < keys.length && !keys[i + 1].orientation))) throw new Error(`Invalid quaternion segment for ${path}.`);
      if (key.orientation && !path.startsWith('rotation.')) throw new Error(`Orientation is invalid for ${path}.`);
    }
  }
  return parsed as PropertyAnimation;
}

function quaternion(rotation: Vec3): Quaternion {
  return new Quaternion().setFromEuler(new Euler(...rotation.map(MathUtils.degToRad) as Vec3, 'XYZ'));
}

/** Curves hold their first and last values outside the keyed interval. */
export function evaluateProperty(animation: PropertyAnimation | null | undefined, path: PropertyPath, base: number, time: number): number {
  if (!Number.isFinite(time)) throw new Error('Playback time must be finite.');
  const keys = animation?.curves[path];
  if (!keys?.length) return base;
  if (time <= keys[0].time) return keys[0].value;
  if (time >= keys[keys.length - 1].time) return keys[keys.length - 1].value;
  let low = 1, high = keys.length - 1;
  while (low < high) { const mid = (low + high) >>> 1; if (keys[mid].time < time) low = mid + 1; else high = mid; }
  const from = keys[low - 1], to = keys[low];
  let alpha = (time - from.time) / (to.time - from.time);
  if (from.interpolation === 'constant') return time === to.time ? to.value : from.value;
  if (from.interpolation === 'smooth') alpha = alpha * alpha * (3 - 2 * alpha);
  if (from.interpolation === 'quaternion') {
    if (!from.orientation || !to.orientation || !path.startsWith('rotation.')) throw new Error('Invalid quaternion animation.');
    const rotation = new Euler().setFromQuaternion(quaternion(from.orientation).slerp(quaternion(to.orientation), alpha), 'XYZ');
    return MathUtils.radToDeg([rotation.x, rotation.y, rotation.z][axes.indexOf(path.at(-1) as AnimationAxis)]);
  }
  return MathUtils.lerp(from.value, to.value, alpha);
}

export function evaluateAnimatedTransform(animation: PropertyAnimation | null | undefined, base: Transform, time: number): Transform {
  const pose = structuredClone(base);
  for (const group of ['position', 'rotation', 'scale'] as const) for (const [index, axis] of axes.entries()) {
    pose[group][index] = evaluateProperty(animation, `${group}.${axis}`, base[group][index], time);
  }
  return pose;
}

/** Converts every legacy sample without resampling and preserves its quaternion interpolation. */
export function migrateMotionTrack(track: MotionTrack): PropertyAnimation {
  const animation = emptyAnimation(), sampled = Boolean(track.samples?.length), take = sampled ? 'legacy-motion' : undefined;
  if (take) animation.takes.push({ id: take, start: track.start, end: track.start + track.duration, source: 'legacy' });
  const poses = [
    { time: track.start, transform: track.from },
    ...(track.samples ?? []).map(sample => ({ time: track.start + sample.at * track.duration, transform: sample.transform })),
    { time: track.start + track.duration, transform: track.to },
  ];
  for (const group of ['position', 'rotation', 'scale'] as const) for (const [index, axis] of axes.entries()) {
    animation.curves[`${group}.${axis}`] = poses.map(({ time, transform }) => ({
      time, value: transform[group][index], interpolation: group === 'rotation' ? 'quaternion' : 'linear',
      ...(group === 'rotation' ? { orientation: [...transform.rotation] as Vec3 } : {}), ...(take ? { take } : {}),
    }));
  }
  return animation;
}

function assertCanPut(animation: PropertyAnimation, path: PropertyPath, time: number, value: number, orientation?: Vec3): void {
  if (!pathSet.has(path) || !Number.isFinite(time) || time < 0 || time > 60 || !Number.isFinite(value)) throw new Error('Invalid keyframe.');
  const [min, max] = limits(path); if (value < min || value > max) throw new Error('Keyframe value is outside the supported range.');
  if (path.startsWith('rotation.') && (!orientation || !orientationSchema.safeParse(orientation).success)) throw new Error('Rotation keys require an orientation.');
  if (!path.startsWith('rotation.') && orientation) throw new Error('Only rotation keys accept an orientation.');
  const keys = animation.curves[path];
  if (keys && keys.length >= 3602 && !keys.some(key => Math.abs(key.time - time) < 1e-8)) throw new Error('Too many keys in this channel.');
}

/** Key one scalar channel. Rotation keys retain a full orientation for any adjacent quaternion segment. */
export function putKey(animation: PropertyAnimation, path: PropertyPath, time: number, value: number, orientation?: Vec3): void {
  assertCanPut(animation, path, time, value, orientation);
  const keys = animation.curves[path] ?? (animation.curves[path] = []), existing = keys.find(key => Math.abs(key.time - time) < 1e-8);
  if (existing) { existing.value = value; if (orientation) existing.orientation = [...orientation]; return; }
  const previous = [...keys].reverse().find(key => key.time < time);
  const interpolation: Interpolation = previous?.interpolation === 'quaternion' && path.startsWith('rotation.') ? 'quaternion' : 'linear';
  keys.push({ time, value, interpolation, ...(orientation ? { orientation: [...orientation] as Vec3 } : {}) });
  keys.sort((a, b) => a.time - b.time);
}

/** Key a vector as one operation while retaining independent axis channels. */
export function putVectorKeys(animation: PropertyAnimation, group: VectorProperty, time: number, values: Vec3): void {
  const snapshot = group === 'rotation' ? values : undefined;
  for (const [index, path] of propertyPaths(group).entries()) assertCanPut(animation, path, time, values[index], snapshot);
  for (const [index, path] of propertyPaths(group).entries()) putKey(animation, path, time, values[index], snapshot);
}

export function putTransformKeys(animation: PropertyAnimation, time: number, transform: Transform): void {
  for (const group of ['position', 'rotation', 'scale'] as const) for (const [index, path] of propertyPaths(group).entries()) assertCanPut(animation, path, time, transform[group][index], group === 'rotation' ? transform.rotation : undefined);
  for (const group of ['position', 'rotation', 'scale'] as const) putVectorKeys(animation, group, time, transform[group]);
}

function updateTakeRanges(animation: PropertyAnimation): void {
  for (const take of [...animation.takes]) {
    const keys = Object.values(animation.curves).flatMap(curve => curve ?? []).filter(key => key.take === take.id);
    const times = keys.map(key => key.time);
    if (!times.length || Math.min(...times) === Math.max(...times)) {
      for (const key of keys) delete key.take;
      animation.takes = animation.takes.filter(item => item !== take);
    } else { take.start = Math.min(...times); take.end = Math.max(...times); }
  }
}

/** Editing a grouped marker operates on the keys that actually exist at that time. */
export function movePropertyKeys(animation: PropertyAnimation, paths: PropertyPath[], from: number, to: number): void {
  if (!Number.isFinite(to) || to < 0 || to > 60) throw new Error('Invalid keyframe time.');
  const selected = [...new Set(paths)].flatMap(path => {
    const curve = animation.curves[path], key = curve?.find(item => Math.abs(item.time - from) < 1e-8);
    return curve && key ? [{ curve, key }] : [];
  });
  if (selected.some(({ curve, key }) => curve.some(item => item !== key && Math.abs(item.time - to) < 1e-8))) throw new Error('A key already exists at that time.');
  for (const { curve, key } of selected) { key.time = to; curve.sort((a, b) => a.time - b.time); }
  updateTakeRanges(animation);
}

export function removePropertyKeys(animation: PropertyAnimation, paths: PropertyPath[], time: number): void {
  for (const path of new Set(paths)) {
    const curve = animation.curves[path];
    if (curve) animation.curves[path] = curve.filter(key => Math.abs(key.time - time) >= 1e-8);
  }
  updateTakeRanges(animation);
}

export function duplicatePropertyKeys(animation: PropertyAnimation, paths: PropertyPath[], from: number, to: number): void {
  if (!Number.isFinite(to) || to < 0 || to > 60) throw new Error('Invalid keyframe time.');
  const selected = [...new Set(paths)].flatMap(path => {
    const curve = animation.curves[path], key = curve?.find(item => Math.abs(item.time - from) < 1e-8);
    return curve && key ? [{ path, curve, key }] : [];
  });
  if (selected.some(({ curve }) => curve.length >= 3602 || curve.some(key => Math.abs(key.time - to) < 1e-8))) throw new Error('A key already exists at that time, or the channel is full.');
  for (const { curve, key } of selected) {
    const { take: _take, ...copy } = key;
    curve.push({ ...structuredClone(copy), time: to });
    curve.sort((a, b) => a.time - b.time);
  }
}

export function setKeyInterpolation(animation: PropertyAnimation, paths: PropertyPath[], time: number, interpolation: Exclude<Interpolation, 'quaternion'>): void {
  for (const path of new Set(paths)) {
    const key = animation.curves[path]?.find(item => Math.abs(item.time - time) < 1e-8);
    if (key) key.interpolation = interpolation;
  }
}

/** Keep a reviewed performance in the same position/rotation curves used by manual keys. */
export function keepRecordedTake(animation: PropertyAnimation, id: string, frames: { time: number; transform: Transform }[], duration: number): PropertyAnimation {
  if (!takeId.safeParse(id).success || animation.takes.some(take => take.id === id) || animation.takes.length >= 100) throw new Error('Invalid or duplicate take ID.');
  if (frames.length < 2 || frames.length > 3602 || !Number.isFinite(duration) || duration <= 0 || duration > 60) throw new Error('Invalid recording.');
  const start = frames[0].time, end = frames[frames.length - 1].time;
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end > duration + 1e-9 || end - start < .1 - 1e-9 || frames.some((frame, index) => index > 0 && frame.time <= frames[index - 1].time)) throw new Error('Recorded samples must be in time order and inside the scene.');
  const next = structuredClone(animation);
  for (const group of ['position', 'rotation'] as const) for (const [index, path] of propertyPaths(group).entries()) {
    const current = (next.curves[path] ?? []).filter(key => key.time < start - 1e-8 || key.time > end + 1e-8);
    if (current.length + frames.length > 3602) throw new Error('Too many keys in this channel.');
    const recorded: PropertyKey[] = frames.map(frame => {
      const value = frame.transform[group][index], orientation = group === 'rotation' ? frame.transform.rotation : undefined;
      assertCanPut(emptyAnimation(), path, frame.time, value, orientation);
      return { time: frame.time, value, interpolation: group === 'rotation' ? 'quaternion' : 'linear', ...(orientation ? { orientation: [...orientation] as Vec3 } : {}), take: id };
    });
    next.curves[path] = [...current, ...recorded].sort((a, b) => a.time - b.time);
  }
  // An overwritten take can have surviving samples on both sides. Keep each
  // surviving section separately draggable, including any legacy scale keys.
  const usedIds = new Set([...next.takes.map(take => take.id), id]);
  let splitIndex = 1;
  const splitId = () => { let candidate: string; do candidate = `take-split-${splitIndex++}`; while (usedIds.has(candidate)); usedIds.add(candidate); return candidate; };
  for (const take of [...next.takes]) {
    if (take.end < start - 1e-8 || take.start > end + 1e-8) continue;
    const keys = Object.values(next.curves).flatMap(curve => curve ?? []).filter(key => key.take === take.id);
    const left = keys.filter(key => key.time < start - 1e-8), right = keys.filter(key => key.time > end + 1e-8);
    for (const key of keys) if (key.time >= start - 1e-8 && key.time <= end + 1e-8) delete key.take;
    let kept = false;
    for (const part of [left, right]) {
      const times = part.map(key => key.time), first = Math.min(...times), last = Math.max(...times);
      if (!part.length || last - first < 1e-8) { for (const key of part) delete key.take; continue; }
      const partId = kept ? splitId() : take.id;
      for (const key of part) key.take = partId;
      if (kept) next.takes.push({ id: partId, start: first, end: last, source: take.source });
      else { take.start = first; take.end = last; kept = true; }
    }
    if (!kept) next.takes = next.takes.filter(item => item !== take);
  }
  updateTakeRanges(next);
  if (next.takes.length >= 100) throw new Error('Too many surviving recording sections. Delete one before keeping this take.');
  next.takes.push({ id, start, end, source: 'recorded' });
  return validateAnimation(next, duration);
}

/** Retime all channels of a take together without discarding samples. */
export function retimeTake(animation: PropertyAnimation, id: string, start: number, end: number, duration: number): void {
  const take = animation.takes.find(item => item.id === id);
  if (!take || !Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end > duration + 1e-9 || end - start < .1 - 1e-9) throw new Error('Invalid take range.');
  const mapTime = (time: number) => start + (time - take.start) / (take.end - take.start) * (end - start);
  for (const curve of Object.values(animation.curves)) {
    if (!curve) continue;
    const moving = curve.filter(key => key.take === id), fixed = curve.filter(key => key.take !== id);
    if (moving.some(key => fixed.some(other => Math.abs(other.time - mapTime(key.time)) < 1e-8))) throw new Error('A key already exists at the new take time.');
  }
  for (const curve of Object.values(animation.curves)) {
    if (!curve) continue;
    for (const key of curve) if (key.take === id) key.time = mapTime(key.time);
    curve.sort((a, b) => a.time - b.time);
  }
  take.start = start; take.end = end;
}

/** Transform a complete keyed path without changing its timing or interpolation. */
export function transformAnimatedSelection(animation: PropertyAnimation, base: Transform, from: Transform, to: Transform): void {
  const matrix=(pose:Transform)=>new Matrix4().compose(new Vector3(...pose.position),quaternion(pose.rotation),new Vector3(...pose.scale));
  const delta=matrix(to).multiply(matrix(from).invert()),translation=new Vector3(),rotation=new Quaternion(),scale=new Vector3();
  delta.decompose(translation,rotation,scale);
  const reconstructed=new Matrix4().compose(translation,rotation,scale);
  const magnitude=Math.max(1,...delta.elements.map(Math.abs));
  if(delta.elements.some((value,index)=>Math.abs(value-reconstructed.elements[index])>magnitude*1e-7)||Math.max(scale.x,scale.y,scale.z)-Math.min(scale.x,scale.y,scale.z)>1e-6*Math.max(scale.x,scale.y,scale.z))throw new Error('This group transform would skew animated objects. Use uniform scale and edit other axes on their tracks.');
  const amount=scale.x,e=delta.elements,source=structuredClone(animation),oldBase=structuredClone(base);
  const positionCurves=axes.map(axis=>source.curves[`position.${axis}`]??[]);
  const resultPosition: (PropertyKey[]|undefined)[]=[];
  for(let row=0;row<3;row++){
    const active=axes.map((_,column)=>column).filter(column=>Math.abs(e[column*4+row])>1e-9&&positionCurves[column].length);
    if(!active.length){resultPosition.push(undefined);continue;}
    const reference=positionCurves[active[0]];
    for(const column of active.slice(1)){
      const other=positionCurves[column];
      if(other.length!==reference.length||other.some((key,index)=>Math.abs(key.time-reference[index].time)>1e-8||key.interpolation!==reference[index].interpolation||key.take!==reference[index].take))throw new Error('These position channels have different timing or interpolation. Align their keys before rotating this selection.');
    }
    resultPosition.push(reference.map(key=>{
      const old=evaluateAnimatedTransform(source,oldBase,key.time).position;
      const value=new Vector3(...old).applyMatrix4(delta).toArray()[row];
      return {time:key.time,value,interpolation:key.interpolation,...(key.take?{take:key.take}:{})};
    }));
  }
  const changedRotation=Math.abs(rotation.w)<1-1e-12,rotationCurves=axes.map(axis=>source.curves[`rotation.${axis}`]??[]),activeRotation=rotationCurves.filter(keys=>keys.length),resultRotation:(PropertyKey[]|undefined)[]=[...rotationCurves];
  let constantBaseRotation:Vec3|undefined;
  if(changedRotation&&activeRotation.length){
    const first=rotationCurves.map((keys,index)=>keys[0]?.value??oldBase.rotation[index]);
    const constant=rotationCurves.every((keys,axis)=>keys.every((key,index)=>{
      if(Math.abs(key.value-first[axis])>=1e-8)return false;
      if(key.interpolation!=='quaternion'||index===keys.length-1)return true;
      const next=keys[index+1];
      if(!key.orientation||!next.orientation||Math.abs(quaternion(key.orientation).dot(quaternion(next.orientation)))<1-1e-10)return false;
      const angles=new Euler().setFromQuaternion(quaternion(key.orientation),'XYZ');
      return Math.abs(MathUtils.radToDeg([angles.x,angles.y,angles.z][axis])-first[axis])<1e-8;
    }));
    if(constant){
      const orientation=new Euler().setFromQuaternion(rotation.clone().multiply(quaternion(first as Vec3)),'XYZ');
      const value=[orientation.x,orientation.y,orientation.z].map(MathUtils.radToDeg) as Vec3;
      constantBaseRotation=value;
      for(let index=0;index<3;index++)if(rotationCurves[index].length)resultRotation[index]=rotationCurves[index].map(key=>({...key,value:value[index],orientation:[...value]}));
    }else{
      const reference=rotationCurves[0];
      if(rotationCurves.some(keys=>keys.length!==reference.length)||reference.length<2)throw new Error('These rotation axes have independent keys. Edit their tracks before rotating this selection.');
      for(let index=0;index<reference.length;index++)for(const [axis,keys] of rotationCurves.entries()){
        const key=keys[index],ref=reference[index];
        if(Math.abs(key.time-ref.time)>1e-8||key.interpolation!==ref.interpolation||key.take!==ref.take||!key.orientation||!ref.orientation||key.orientation.some((value,i)=>Math.abs(value-ref.orientation![i])>1e-8)||Math.abs(key.value-key.orientation[axis])>1e-8||(index<reference.length-1&&!['quaternion','constant'].includes(ref.interpolation)))throw new Error('These rotation axes have independent interpolation. Edit their tracks before rotating this selection.');
      }
      const values=reference.map(key=>{
        const old=evaluateAnimatedTransform(source,oldBase,key.time).rotation;
        const angles=new Euler().setFromQuaternion(rotation.clone().multiply(quaternion(old)),'XYZ');
        return [angles.x,angles.y,angles.z].map(MathUtils.radToDeg) as Vec3;
      });
      for(let axis=0;axis<3;axis++)resultRotation[axis]=reference.map((key,index)=>({time:key.time,value:values[index][axis],interpolation:key.interpolation,orientation:[...values[index]],...(key.take?{take:key.take}:{})}));
    }
  }
  const position=new Vector3(...oldBase.position).applyMatrix4(delta).toArray() as Vec3;
  const baseRotation=changedRotation?new Euler().setFromQuaternion(rotation.clone().multiply(quaternion(oldBase.rotation)),'XYZ'):null;
  const newBase:Transform={position,rotation:constantBaseRotation??(baseRotation?[baseRotation.x,baseRotation.y,baseRotation.z].map(MathUtils.radToDeg) as Vec3:[...oldBase.rotation]),scale:oldBase.scale.map(value=>value*amount) as Vec3};
  const next=structuredClone(source);
  for(const [index,axis] of axes.entries()){
    if(resultPosition[index])next.curves[`position.${axis}`]=resultPosition[index];else delete next.curves[`position.${axis}`];
    if(changedRotation&&activeRotation.length&&resultRotation[index]?.length)next.curves[`rotation.${axis}`]=resultRotation[index];
    const scaleKeys=next.curves[`scale.${axis}`];if(scaleKeys)for(const key of scaleKeys)key.value*=amount;
  }
  validateAnimation(next,60);
  if(newBase.position.some(value=>Math.abs(value)>1000)||newBase.scale.some(value=>value<.01||value>100))throw new Error('Placement exceeds the scene limits.');
  Object.assign(base,newBase);Object.assign(animation,next);
}
