import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Euler, MathUtils, Matrix4, Quaternion, Vector3 } from 'three';
import { createObject, evaluateFov, evaluateTransform } from '../model.ts';
import { createProject, parseProject, serializeProject } from '../project/storage.ts';
import { instantiateAsset, saveObjectAsset } from '../assets/library.ts';
import { applyProjectOperations } from '../scene-edit/operations.ts';
import { projectContent } from '../project/model.ts';
import { PerformanceSession } from '../performance/session.ts';
import { transformSelection } from '../placement/transforms.ts';
import type { Transform, Vec3 } from '../types.ts';
import { duplicatePropertyKeys, emptyAnimation, evaluateAnimatedTransform, evaluateProperty, frameAtTime, keepRecordedTake, migrateMotionTrack, movePropertyKeys, propertyPaths, putKey, putTransformKeys, putVectorKeys, removePropertyKeys, retimeTake, timeAtFrame, validateAnimation } from './model.ts';

const pose = (position: Vec3, rotation: Vec3, scale: Vec3): Transform => ({ position, rotation, scale });
const quaternion = (rotation: Vec3) => new Quaternion().setFromEuler(new Euler(...rotation.map(MathUtils.degToRad) as Vec3, 'XYZ'));
const close = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-7, `${a} != ${b}`);

test('legacy performance migrates without changing its playback and stays editable as property channels', () => {
  const item = createObject('human', 1);
  item.transform = pose([1, 0, -2], [18, 80, 170], [1, 1, 1]);
  item.track = {
    start: .3, duration: 3.8, from: structuredClone(item.transform),
    samples: [
      { at: .125, transform: pose([2, .5, -1], [-31, 10, 190], [1, 1.1, 1]) },
      { at: .57, transform: pose([4, 1, 2], [20, -40, 245], [1.2, 1, .9]) },
    ],
    to: pose([6, 0, 4], [-20, -15, 350], [.8, 1.3, 1.1]),
  };
  const migrated = migrateMotionTrack(item.track);
  const reopened = validateAnimation(JSON.parse(JSON.stringify(migrated)), 6);
  assert.equal(reopened.curves['position.x']?.length, 4);
  assert.equal(reopened.takes[0].source, 'legacy');
  for (let frame = 0; frame <= 300; frame++) {
    const time = frame / 60, old = evaluateTransform(item, time), current = evaluateAnimatedTransform(reopened, item.transform, time);
    for (let i = 0; i < 3; i++) { close(old.position[i], current.position[i]); close(old.scale[i], current.scale[i]); }
    assert.ok(Math.abs(quaternion(old.rotation).dot(quaternion(current.rotation))) > 1 - 1e-10, `rotation changed at ${time}s`);
  }
  const before = evaluateAnimatedTransform(reopened, item.transform, 1.5);
  const changed: Vec3 = [...before.rotation]; changed[1] += 20;
  putKey(reopened, 'rotation.y', 1.5, changed[1], changed);
  for (let frame = 0; frame <= 300; frame++) {
    const time = frame / 60, old = evaluateAnimatedTransform(migrated, item.transform, time), edited = evaluateAnimatedTransform(reopened, item.transform, time);
    close(old.rotation[0], edited.rotation[0]); close(old.rotation[2], edited.rotation[2]);
  }
  close(evaluateAnimatedTransform(reopened, item.transform, 1.5).rotation[1], changed[1]);
  validateAnimation(JSON.parse(JSON.stringify(reopened)), 6);
});

test('group keys, component values, frame rate and project validation follow one time-based workflow', () => {
  const animation = emptyAnimation(), base = pose([1, 2, 3], [10, 20, 30], [1, 1, 1]);
  putTransformKeys(animation, 0, base);
  assert.equal(Object.keys(animation.curves).length, 9);
  putVectorKeys(animation, 'position', 2, [5, 2, 3]);
  putVectorKeys(animation, 'pivot', 2, [.5, 0, 0]);
  putKey(animation, 'fov', 2, 40);
  assert.deepEqual(propertyPaths('position'), ['position.x', 'position.y', 'position.z']);
  close(evaluateAnimatedTransform(animation, base, 1).position[0], 3);
  close(evaluateProperty(animation, 'pivot.x', 0, 2), .5);
  close(evaluateProperty(animation, 'fov', 45, 2), 40);
  assert.equal(frameAtTime(2, 24), 48); assert.equal(frameAtTime(2, 30), 60);
  assert.equal(timeAtFrame(60, 30), 2);
  const saved = JSON.stringify(animation), reopened = validateAnimation(JSON.parse(saved), 6);
  assert.equal(JSON.stringify(reopened), saved);
  const position = propertyPaths('position');
  duplicatePropertyKeys(reopened, position, 2, 3);
  assert.ok(position.every(path => reopened.curves[path]?.some(key => key.time === 3)));
  const beforeCollision = JSON.stringify(reopened);
  assert.throws(() => movePropertyKeys(reopened, position, 3, 0), /already exists/);
  assert.equal(JSON.stringify(reopened), beforeCollision);
  movePropertyKeys(reopened, position, 3, 4);
  assert.ok(position.every(path => reopened.curves[path]?.some(key => key.time === 4)));
  removePropertyKeys(reopened, position, 4);
  assert.equal(JSON.stringify(reopened), saved);
  const frames = [
    {time: 2.5, transform: pose([5,2,3],[10,20,30],[1,1,1])},
    {time: 2.75, transform: pose([6,2,4],[15,40,30],[1,1,1])},
    {time: 3.5, transform: pose([7,2,5],[20,60,30],[1,1,1])},
  ];
  const recorded = keepRecordedTake(reopened, 'take-1', frames, 6);
  assert.equal(reopened.takes.length, 0, 'the reviewed take does not change the original until kept');
  assert.equal(recorded.takes.length, 1);
  assert.ok([...position, ...propertyPaths('rotation')].every(path => recorded.curves[path]?.filter(key => key.take === 'take-1').length === frames.length));
  close(evaluateProperty(recorded, 'fov', 45, 2), 40);
  putKey(recorded, 'position.x', 4, 9);
  const beforeRetime = JSON.stringify(recorded);
  assert.throws(() => retimeTake(recorded, 'take-1', 3, 4, 6), /already exists/);
  assert.equal(JSON.stringify(recorded), beforeRetime, 'a timing collision must not lose recorded samples');
  removePropertyKeys(recorded, ['position.x'], 4);
  retimeTake(recorded, 'take-1', 3, 4, 6);
  assert.deepEqual(recorded.curves['position.x']!.filter(key => key.take === 'take-1').map(key => key.time), [3, 3.25, 4]);
  const savedTake = JSON.stringify(recorded), reopenedTake = validateAnimation(JSON.parse(savedTake), 6);
  assert.equal(JSON.stringify(reopenedTake), savedTake);
  assert.throws(() => validateAnimation({curves:{'movement.speed':[{time:0,value:1.7,interpolation:'linear'}]},takes:[]}, 6), /not animatable/);
  const damaged = JSON.parse(saved); damaged.curves['position.x'][1].time = 0;
  assert.throws(() => validateAnimation(damaged, 6), /Invalid keys/);
});

test('project save and reopen retains property keys and rejects invalid animation owners', () => {
  const project=createProject(),scene=project.scenes[0],object=scene.objects.find(item=>!item.track)!;
  const animation=emptyAnimation();putTransformKeys(animation,0,object.transform);
  putVectorKeys(animation,'position',2,[4,object.transform.position[1],object.transform.position[2]]);
  object.animation=animation;scene.fps=30;
  const camera=scene.cameras[0];camera.track=null;camera.animation=emptyAnimation();putKey(camera.animation,'fov',0,45);putKey(camera.animation,'fov',2,30);
  const saved=serializeProject(project),reopened=parseProject(saved),sceneAgain=reopened.scenes[0];
  assert.equal(sceneAgain.fps,30);close(evaluateTransform(sceneAgain.objects.find(item=>item.id===object.id)!,1).position[0],(object.transform.position[0]+4)/2);
  close(evaluateFov(sceneAgain.cameras[0],1),37.5);
  const invalid=JSON.parse(saved);invalid.scenes[0].objects.find((item:{id:string})=>item.id===object.id).animation.curves.fov=[{time:1,value:45,interpolation:'linear'}];
  assert.throws(()=>parseProject(JSON.stringify(invalid)),/only available on cameras/);
  const asset=saveObjectAsset(object,[], 'animated-cube'),instance=instantiateAsset(asset,'copy-1',[10,0,0],5);
  close(evaluateTransform(instance,1).position[0],10+(4-object.transform.position[0])/2);
  assert.equal(instance.track,null);assert.ok(instance.animation);
  assert.throws(()=>instantiateAsset(asset,'too-short',[0,0,0],1),/Invalid keys/);
  const before=projectContent(reopened),shifted=applyProjectOperations(before,[{type:'translate',sceneId:sceneAgain.id,id:object.id,offset:[2,0,0]}],1);
  close(evaluateTransform(shifted.scenes[0].objects.find(item=>item.id===object.id)!,1).position[0],evaluateTransform(sceneAgain.objects.find(item=>item.id===object.id)!,1).position[0]+2);
  close(evaluateTransform(sceneAgain.objects.find(item=>item.id===object.id)!,1).position[0],(object.transform.position[0]+4)/2);
  const frozen=applyProjectOperations(shifted,[{type:'set_motion',sceneId:sceneAgain.id,id:object.id,track:null}],1);
  assert.equal(frozen.scenes[0].objects.find(item=>item.id===object.id)!.animation,undefined);
  const controlled=shifted.scenes[0].objects.find(item=>item.id===object.id)!;
  const session=new PerformanceSession(controlled,1),original=evaluateTransform(controlled,1);
  session.pose.position[0]+=3;session.pose.rotation[1]+=20;const placed=session.placement();
  close(evaluateTransform(placed,1).position[0],original.position[0]+3);
  assert.equal(placed.animation!.curves['position.x']!.length,controlled.animation!.curves['position.x']!.length);
  const movedPose=structuredClone(original);movedPose.position[1]+=1;
  const moved=transformSelection([controlled],[{id:controlled.id,transform:movedPose}],1,true)[0];
  close(evaluateTransform(moved,1).position[1],original.position[1]+1);
  const rotatePose=structuredClone(original);rotatePose.rotation[1]+=45;
  const rotated=transformSelection([controlled],[{id:controlled.id,transform:rotatePose}],1,true)[0];
  close(evaluateTransform(rotated,1).position[1],original.position[1]);
  assert.ok(Math.abs(quaternion(evaluateTransform(rotated,1).rotation).dot(quaternion(rotatePose.rotation)))>1-1e-10);
  close(evaluateTransform(controlled,1).position[1],original.position[1]);
});

test('group rotation and uniform scale preserve every interpolated recorded pose', () => {
  const item=createObject('human',1);
  item.transform=pose([1,0,-2],[18,80,170],[1,1,1]);
  item.track={start:.3,duration:3.8,from:structuredClone(item.transform),samples:[
    {at:.125,transform:pose([2,.5,-1],[-31,10,190],[1,1.1,1])},
    {at:.57,transform:pose([4,1,2],[20,-40,245],[1.2,1,.9])},
  ],to:pose([6,0,4],[-20,-15,350],[.8,1.3,1.1])};
  item.animation=migrateMotionTrack(item.track);item.track=null;
  const before=evaluateTransform(item,1.4);
  const deltaRotation=new Quaternion().setFromAxisAngle(new Vector3(0,1,0),MathUtils.degToRad(37));
  const delta=new Matrix4().compose(new Vector3(2,1,-3),deltaRotation,new Vector3(1.3,1.3,1.3));
  const matrix=new Matrix4().compose(new Vector3(...before.position),quaternion(before.rotation),new Vector3(...before.scale)).premultiply(delta);
  const position=new Vector3(),rotation=new Quaternion(),scale=new Vector3();matrix.decompose(position,rotation,scale);
  const angles=new Euler().setFromQuaternion(rotation,'XYZ');
  const target=pose(position.toArray() as Vec3,[angles.x,angles.y,angles.z].map(MathUtils.radToDeg) as Vec3,scale.toArray() as Vec3);
  const transformed=transformSelection([item],[{id:item.id,transform:target}],1.4,true)[0];
  const session=new PerformanceSession(item,1.4);session.pose=structuredClone(target);const controlled=session.placement();
  for(let frame=0;frame<=300;frame++){
    const time=frame/60,old=evaluateTransform(item,time),next=evaluateTransform(transformed,time);
    const placed=evaluateTransform(controlled,time);
    const expectedPosition=new Vector3(...old.position).applyMatrix4(delta).toArray();
    const expectedRotation=deltaRotation.clone().multiply(quaternion(old.rotation));
    for(let axis=0;axis<3;axis++){close(next.position[axis],expectedPosition[axis]);close(next.scale[axis],old.scale[axis]*1.3);close(placed.position[axis],next.position[axis]);}
    assert.ok(Math.abs(quaternion(next.rotation).dot(expectedRotation))>1-1e-10,`rotation changed at ${time}s`);
    assert.ok(Math.abs(quaternion(placed.rotation).dot(expectedRotation))>1-1e-10,`control rotation changed at ${time}s`);
  }
  for(const path of Object.keys(item.animation.curves) as (keyof typeof item.animation.curves)[]){
    assert.deepEqual(transformed.animation!.curves[path]!.map(key=>[key.time,key.take]),item.animation.curves[path]!.map(key=>[key.time,key.take]));
  }
  assert.deepEqual(transformed.animation!.takes,item.animation.takes);
});

test('group rotation handles a single constant keyed axis without changing the visible orientation', () => {
  const item=createObject('human',1);item.transform=pose([0,0,0],[10,20,30],[1,1,1]);item.track=null;item.animation=emptyAnimation();
  putKey(item.animation,'rotation.x',0,45,[45,20,30]);
  const before=evaluateTransform(item,0),deltaRotation=new Quaternion().setFromAxisAngle(new Vector3(0,1,0),.6);
  const q=deltaRotation.clone().multiply(quaternion(before.rotation)),angles=new Euler().setFromQuaternion(q,'XYZ');
  const target=pose([...before.position],[angles.x,angles.y,angles.z].map(MathUtils.radToDeg) as Vec3,[...before.scale]);
  const transformed=transformSelection([item],[{id:item.id,transform:target}],0,true)[0];
  assert.ok(Math.abs(quaternion(evaluateTransform(transformed,0).rotation).dot(q))>1-1e-10);
});

test('unsafe independent animation curves are rejected without changing the original selection', () => {
  const item=createObject('human',1);item.track=null;item.animation=emptyAnimation();
  putKey(item.animation,'position.x',0,0);putKey(item.animation,'position.x',2,2);
  putKey(item.animation,'position.z',0,0);putKey(item.animation,'position.z',1,1);putKey(item.animation,'position.z',2,3);
  const before=JSON.stringify(item),current=evaluateTransform(item,0),target=structuredClone(current);target.rotation[1]+=45;
  assert.throws(()=>transformSelection([item],[{id:item.id,transform:target}],0,true),/different timing or interpolation/);
  assert.equal(JSON.stringify(item),before);
});

test('recording over the middle of a take separates the remaining sections without losing scale keys', () => {
  const from=pose([0,0,0],[0,0,0],[1,1,1]);
  const source=migrateMotionTrack({start:0,duration:4,from,samples:[.5,1.5,2.5,3.5].map(time=>({at:time/4,transform:pose([time,0,time],[0,time*10,0],[1+time/10,1,1])})),to:pose([4,0,4],[0,40,0],[1.4,1,1])});
  const saved=JSON.stringify(source),frames=[
    {time:1.2,transform:pose([1,0,1],[0,12,0],[1,1,1])},
    {time:2,transform:pose([2,0,3],[0,20,0],[1,1,1])},
    {time:2.8,transform:pose([3,0,4],[0,28,0],[1,1,1])},
  ];
  const result=keepRecordedTake(source,'take-1',frames,5);
  assert.equal(JSON.stringify(source),saved,'review must not mutate the source');
  assert.deepEqual(result.takes.map(take=>[take.start,take.end]),[[0,.5],[3.5,4],[1.2,2.8]]);
  const [left,right,recorded]=result.takes;
  assert.notEqual(left.id,right.id);
  assert.deepEqual(result.curves['position.x']!.filter(key=>key.take===left.id).map(key=>key.time),[0,.5]);
  assert.deepEqual(result.curves['position.x']!.filter(key=>key.take===right.id).map(key=>key.time),[3.5,4]);
  assert.deepEqual(result.curves['position.x']!.filter(key=>key.take===recorded.id).map(key=>key.time),[1.2,2,2.8]);
  for(const time of [1.5,2.5]){
    const key=result.curves['scale.x']!.find(key=>key.time===time)!;
    close(key.value,1+time/10);assert.equal(key.take,undefined);
  }
  validateAnimation(JSON.parse(JSON.stringify(result)),5);
  retimeTake(result,right.id,4,4.5,5);
  assert.deepEqual(result.curves['position.x']!.filter(key=>key.take===right.id).map(key=>key.time),[4,4.5]);
});
