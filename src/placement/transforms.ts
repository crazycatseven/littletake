import { animationFor, ensureAnimation, evaluateTransform } from '../model.ts';
import { newId } from '../id.ts';
import { repositionTrack, trackPoses, transformSchema } from '../performance/motion.ts';
import { validateAnimation as validateAnimationForParent, evaluateProperty, putKey, transformAnimatedSelection } from '../animation/model.ts';
import { Matrix4, Vector3 } from 'three';
import { hierarchyRoots, descendants, matrixTransform, sceneEntities, sceneWorldMatrices, transformMatrix, validateParents } from './hierarchy.ts';
import type { SceneDocument, SceneEntity, Transform } from '../types.ts';

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

/** Change coordinates without publishing a partial hierarchy or losing motion keys. */
export function reparentScene(source: SceneDocument, ids: string[], parentId: string | null, time: number): SceneDocument {
  const scene = structuredClone(source), nodes = sceneEntities(scene), byId = new Map(nodes.map(item => [item.id,item]));
  if (!ids.length || ids.some(id => !byId.has(id)) || (parentId && !byId.has(parentId))) throw new Error('Choose objects and a parent in the current scene.');
  const roots = hierarchyRoots(nodes,ids), worlds = sceneWorldMatrices(source,time);
  const parentInverse = parentId ? worlds.get(parentId)!.clone().invert() : new Matrix4();
  for (const id of roots) {
    if (parentId && descendants(nodes,id).has(parentId)) throw new Error('An object cannot be parented to itself or its descendants.');
    const item = byId.get(id)!; if ((item.parentId??null)===parentId) continue;
    const delta = parentInverse.clone().multiply(item.parentId ? worlds.get(item.parentId)! : new Matrix4());
    const from = evaluateTransform(item,time), to = matrixTransform(delta.clone().multiply(transformMatrix(from)),true);
    let next: SceneEntity;
    // Axis-aligned non-uniform parents can preserve independent translation/scale
    // curves exactly when orientation stays constant. Other cases use the shared reducer.
    const diagonal = delta.elements.every((v,i) => [0,5,10,12,13,14,15].includes(i) || Math.abs(v)<1e-9) && [0,5,10].every(i=>delta.elements[i]>0);
    const constantRotation = item.animation && ['x','y','z'].every((axis,index) => (item.animation!.curves[`rotation.${axis}` as 'rotation.x']??[]).every(key => Math.abs(key.value-from.rotation[index])<1e-8 && (!key.orientation || key.orientation.every((v,i)=>Math.abs(v-from.rotation[i])<1e-8))));
    if (item.animation && diagonal && constantRotation) {
      next = structuredClone(item);
      const base = matrixTransform(delta.clone().multiply(transformMatrix(item.transform)),true);
      for (const [index,axis] of (['x','y','z'] as const).entries()) {
        for (const key of next.animation!.curves[`position.${axis}`]??[]) key.value=key.value*delta.elements[index*5]+delta.elements[12+index];
        for (const key of next.animation!.curves[`scale.${axis}`]??[]) key.value*=base.scale[index]/item.transform.scale[index];
      }
      next.transform=base;
    } else next=transformSelection([item],[{id,transform:to}],time,true)[0];
    // Legacy quaternion interpolation must also remain representable between keys.
    const times = item.track ? [0,1,...Array.from({length:Math.ceil(scene.duration*(scene.fps??24))+1},(_,i)=>Math.min(scene.duration,i/(scene.fps??24)))] : [time];
    for (const at of times) {
      const expected=delta.clone().multiply(transformMatrix(evaluateTransform(item,at))), actual=transformMatrix(evaluateTransform(next,at));
      const magnitude=Math.max(1,...expected.elements.map(Math.abs));
      if(expected.elements.some((v,i)=>Math.abs(v-actual.elements[i])>magnitude*1e-6)) throw new Error('This parent would distort the existing animation. Use uniform parent scale before changing the hierarchy.');
    }
    transformSchema.parse(next.transform);
    if(next.animation)validateAnimationForParent(next.animation,scene.duration);
    if (parentId) next.parentId=parentId; else delete next.parentId;
    Object.assign(item,next); if(!parentId)delete item.parentId;
  }
  validateParents(nodes); return scene;
}

export function duplicateHierarchy(source: SceneDocument, ids: string[], time: number): {scene:SceneDocument;ids:string[]} {
  const scene=structuredClone(source),nodes=sceneEntities(scene),roots=hierarchyRoots(nodes,ids),included=new Set(roots.flatMap(id=>[...descendants(nodes,id)]));
  if(scene.objects.length+scene.objects.filter(item=>included.has(item.id)).length>100||scene.cameras.length+scene.cameras.filter(item=>included.has(item.id)).length>128)throw new Error('Scene object or camera limit reached.');
  const mapping=new Map<string,string>();
  for(const item of nodes.filter(item=>included.has(item.id)))mapping.set(item.id,('kind' in item?'object-':'camera-')+newId());
  const worlds=sceneWorldMatrices(source,time);
  for(const original of nodes.filter(item=>included.has(item.id))){
    const item=structuredClone(original);item.id=mapping.get(original.id)!;
    if(item.parentId&&mapping.has(item.parentId))item.parentId=mapping.get(item.parentId);
    if(roots.includes(original.id)){
      item.name=item.name.slice(0,110)+' copy';
      const offset=new Vector3(1,0,0);
      if(original.parentId){const inverse=worlds.get(original.parentId)!.clone().invert();offset.applyMatrix4(inverse).sub(new Vector3().applyMatrix4(inverse));}
      for(const pose of [item.transform,...(item.track?trackPoses(item.track):[])])pose.position=pose.position.map((v,i)=>v+offset.getComponent(i)) as Transform['position'];
      if(item.animation)for(const [i,axis] of (['x','y','z'] as const).entries())for(const key of item.animation.curves[`position.${axis}`]??[])key.value+=offset.getComponent(i);
    }
    if('kind' in item)scene.objects.push(item);else scene.cameras.push(item);
  }
  return {scene,ids:roots.map(id=>mapping.get(id)!)};
}
