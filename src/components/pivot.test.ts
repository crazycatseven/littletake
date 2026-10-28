import assert from 'node:assert/strict';
import test from 'node:test';
import { Euler, MathUtils, Matrix4, Quaternion, Vector3 } from 'three';
import { componentsSchema, componentScripts, inputController, movement, pivotOffset, type ObjectComponent } from './model.ts';
import { applyTransformModifiers, fromPivotPose, toPivotPose } from './transform.ts';
import { createDocument, createObject, evaluateTransform, History } from '../model.ts';
import { PerformanceSession } from '../performance/session.ts';
import { trackPoses } from '../performance/motion.ts';
import { builtinAssets, instantiateAsset, saveObjectAsset } from '../assets/library.ts';
import { draftFromAsset, editAsset, reviseAsset } from '../assets/edit.ts';
import { createProject, parseProject, serializeProject } from '../project/storage.ts';
import { projectContent } from '../project/model.ts';
import type { Transform, Vec3 } from '../types.ts';

const identity = (): Transform => ({position:[0,0,0],rotation:[0,0,0],scale:[1,1,1]});
const close = (actual: number[], expected: number[], tolerance = 1e-8) => actual.forEach((n,i) => assert.ok(Math.abs(n-expected[i]) <= tolerance, `${actual} != ${expected}`));
const worldPoint = (pose: Transform, point: Vec3) => new Vector3(...point).applyMatrix4(new Matrix4().compose(new Vector3(...pose.position), new Quaternion().setFromEuler(new Euler(...pose.rotation.map(MathUtils.degToRad) as Vec3)), new Vector3(...pose.scale))).toArray();

test('pivot changes only the handle, while rotation and nonuniform scale keep its world point fixed', () => {
  const before = identity(), components = [pivotOffset([1,0,0])], snapshot = structuredClone(before);
  close(toPivotPose(before, components).position, [1,0,0]);
  assert.deepEqual(before, snapshot);
  const rotated = {...identity(), rotation:[0,90,0] as Vec3};
  applyTransformModifiers(before, rotated, components);
  close(rotated.position, [1,0,1]); close(worldPoint(rotated, [1,0,0]), [1,0,0]);
  const arbitrary: Transform = {position:[3,5,-7],rotation:[25,70,-32],scale:[2,3,.5]};
  const modifiers = [pivotOffset([.3,-.6,1.4])], next = structuredClone(arbitrary);
  next.rotation = [-34,120,28]; next.scale = [4,.5,2];
  applyTransformModifiers(arbitrary, next, modifiers);
  close(worldPoint(next,[.3,-.6,1.4]), worldPoint(arbitrary,[.3,-.6,1.4]));
  close(fromPivotPose(toPivotPose(next, modifiers), modifiers).position, next.position);
  const disabled = [{...modifiers[0],enabled:false}], unchanged = structuredClone(next);
  applyTransformModifiers(arbitrary, unchanged, disabled); assert.deepEqual(unchanged,next);
});

test('a turning take records the pivot arc, survives replay, and stays unchanged when its pivot is edited', () => {
  const object = createObject('cube',1); object.transform = identity(); object.components = [pivotOffset([1,0,0]),movement('free')];
  const session = new PerformanceSession(object,0); session.start(5); session.keys.add('d');
  for(let i=0;i<120;i++)session.update(1/60,5);
  session.stop(); const kept = session.keep();
  assert.equal(object.track,null); close(kept.track!.to.position,[2,0,0]);
  for(const pose of trackPoses(kept.track!)) close(worldPoint(pose,[1,0,0]),[1,0,0]);
  for(const t of [.217,.719,1.253,1.839]) close(worldPoint(evaluateTransform(kept,t),[1,0,0]),[1,0,0],.002);
  const track = structuredClone(kept.track), displayed = evaluateTransform(kept,.719);
  kept.components = [pivotOffset([4,2,-3]),movement('free')];
  assert.deepEqual(kept.track,track); assert.deepEqual(evaluateTransform(kept,.719),displayed);
  session.discard(); assert.deepEqual(session.pose,object.transform);
  const translated = new PerformanceSession(object,0); translated.keys.add('w'); translated.update(.5,5);
  close(translated.pose.position,[0,0,.85]);
});

test('component stacks remain independent through prefab editing, project reopen, and undo', () => {
  const base = builtinAssets.find(a=>a.id==='builtin-door')!, components = [pivotOffset([-.475,0,0]),movement('free')];
  const asset = reviseAsset(base,editAsset(draftFromAsset(base),[{type:'set_components',components}]));
  const first = instantiateAsset(asset,'door-1',[1,0,0],5), second = instantiateAsset(asset,'door-2',[-1,0,0],5);
  (first.components![0] as Extract<ObjectComponent,{type:'pivot'}>).offset[0] = -1;
  assert.equal((second.components![0] as Extract<ObjectComponent,{type:'pivot'}>).offset[0],-.475);
  const scene = createDocument(); scene.objects=[first,second];
  const project = createProject(scene); project.assets=[asset];
  const history = new History(projectContent(project)); first.components![0].enabled=false; history.commit(projectContent(project));
  assert.equal(history.undo()!.scenes[0].objects[0].components![0].enabled,true);
  assert.equal(history.redo()!.scenes[0].objects[0].components![0].enabled,false);
  const restored = parseProject(serializeProject(project)); assert.deepEqual(restored.scenes[0].objects[0].components,first.components);
  const reusable = saveObjectAsset(second,[asset],'saved-pivot'); assert.deepEqual(reusable.template!.components,second.components);
});

test('pivot is passive and stackable; duplicate or competing input controllers are rejected without breaking legacy projects', () => {
  assert.equal(inputController([pivotOffset()]),undefined);
  assert.equal(inputController([pivotOffset(),movement()])?.type,'movement');
  assert.equal(inputController([movement(),pivotOffset()])?.type,'movement');
  assert.equal(componentsSchema.safeParse([pivotOffset(),movement()]).success,true);
  assert.equal(componentsSchema.safeParse([pivotOffset(),pivotOffset()]).success,false);
  assert.equal(componentsSchema.safeParse([movement(),{type:'hinge',enabled:true,speed:50}]).success,false);
  assert.equal(componentsSchema.safeParse([{type:'hinge',enabled:true,speed:50}]).success,true);
  assert.equal(componentScripts.hinge.addable,false);
  const object = createObject('cube',1); object.components=[pivotOffset([7,3,-2])];
  const session=new PerformanceSession(object,0); session.keys.add('d'); session.update(.5,5); assert.deepEqual(session.pose,object.transform);
});
