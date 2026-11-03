import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CatmullRomCurve3, Vector3 } from 'three';
import { fitPath, pathCurve, pathHandles, pathMatrix, setPathHandle, setPathHandleMode, insertPathPoint, type MotionPath } from './model.ts';
import { createEmptyScene, createObject, ensureAnimation, History, parseDocument, serializeDocument } from '../model.ts';
import { followPath } from '../components/model.ts';
import { putKey } from '../animation/model.ts';
import { matrixTransform, sceneWorldMatrices } from '../placement/hierarchy.ts';
import { instantiateAsset, saveObjectAsset } from '../assets/library.ts';
import type { Vec3 } from '../types.ts';

test('sparse path authoring survives playback, child inheritance, undo, save/reopen and prefab reuse',()=>{
  const line=Array.from({length:800},(_,i)=>[i/80,0,Math.sin(i)*.001] as Vec3);
  assert.equal(fitPath(line).length,2,'pointer sampling noise must not create editable knots');
  const stroke=Array.from({length:600},(_,i)=>{const t=i/599;return [t*12,0,Math.sin(t*Math.PI*2)*3] as Vec3;});
  const points=fitPath(stroke);assert.ok(points.length>=4&&points.length<=12,`a smooth S should need a few knots, got ${points.length}`);
  assert.deepEqual(points[0],stroke[0]);assert.deepEqual(points.at(-1),stroke.at(-1));
  const curve=pathCurve(points),samples=curve.getPoints(1800);let error=0;
  for(const p of stroke){const source=new Vector3(...p);error=Math.max(error,Math.min(...samples.map(q=>q.distanceTo(source))));}
  assert.ok(error<.13,`the sparse curve must preserve the drawn shape; error ${error}`);
  const scene=createEmptyScene();scene.duration=12;scene.paths=[{id:'path-1',name:'Dive',points:[[0,4,0],[2,-2,4],[4,8,9]]}];
  const dragon=createObject('cube',1),rider=createObject('human',2);dragon.transform.scale=[2,2,2];dragon.components=[followPath('path-1')];rider.parentId=dragon.id;rider.transform.position=[0,1,0];scene.objects=[dragon,rider];
  const animation=ensureAnimation(dragon);for(const [time,value] of [[0,0],[5,.5],[8,.5],[12,1]])putKey(animation,'followPath.progress',time,value);
  putKey(animation,'scale.x',0,2);putKey(animation,'scale.x',12,3);
  const history=new History(scene),start=matrixTransform(sceneWorldMatrices(scene,0).get(dragon.id)!);assert.deepEqual(start.position,[0,4,0]);
  const hold=sceneWorldMatrices(scene,6),later=sceneWorldMatrices(scene,7);
  assert.ok(matrixTransform(hold.get(dragon.id)!).position.every((v,i)=>Math.abs(v-matrixTransform(later.get(dragon.id)!).position[i])<1e-8));
  const inherited=new Vector3(0,1,0).applyMatrix4(hold.get(dragon.id)!);assert.ok(inherited.distanceTo(new Vector3(...matrixTransform(hold.get(rider.id)!).position))<1e-8);
  assert.ok(Math.abs(matrixTransform(hold.get(dragon.id)!).rotation[0])>1,'tangent following must include pitch');
  const oldCurve=pathCurve(scene.paths[0].points);scene.paths[0].points=scene.paths[0].points.map((p,i)=>i===1?[p[0],-6,p[2]]:p);history.commit(scene);
  assert.notEqual(pathCurve(scene.paths[0].points),oldCurve,'editing must invalidate the shared playback/export curve');
  const reopened=parseDocument(serializeDocument(scene));assert.deepEqual(reopened.paths,scene.paths);assert.deepEqual(reopened.objects[0].animation,animation);
  assert.deepEqual(sceneWorldMatrices(reopened,6).get(dragon.id)!.elements,sceneWorldMatrices(scene,6).get(dragon.id)!.elements);
  assert.equal(history.undo()!.paths![0].points[1][1],-2);assert.equal(history.redo()!.paths![0].points[1][1],-6);
  const invalid=structuredClone(scene);invalid.paths=[];assert.throws(()=>serializeDocument(invalid),/follow path must belong/);
  const asset=saveObjectAsset(dragon,[],'saved-dragon'),instance=instantiateAsset(asset,'copy',[0,0,0],12);
  assert.equal(instance.components?.find(c=>c.type==='followPath')?.pathId,'','scene path references must not escape through reusable prefabs');
});

test('independent Bezier path handles and object transforms survive shared followers, splitting, history and save/reopen',()=>{
  const scene=createEmptyScene(),path:MotionPath={id:'path-1',name:'Bridge route',points:[[0,2,0],[3,-2,4],[8,4,7]]};scene.paths=[path];
  assert.equal(parseDocument(serializeDocument(scene)).paths!.length,1,'a curve exists without any follower');assert.equal(scene.objects.length,0);
  const legacy=new CatmullRomCurve3(path.points.map(p=>new Vector3(...p)),false,'centripetal'),automatic=pathCurve(path);
  for(let i=0;i<=400;i++)assert.ok(automatic.getPoint(i/400).distanceTo(legacy.getPoint(i/400))<1e-10,'automatic Bezier conversion must preserve old routes');
  const history=new History(scene),anchors=structuredClone(path.points),oppositeLength=Math.hypot(...pathHandles(path)[1].in);
  setPathHandle(path,1,'out',[3,4,0]);assert.equal(pathHandles(path)[1].mode,'aligned');assert.deepEqual(path.points,anchors);
  assert.ok(Math.abs(Math.hypot(...pathHandles(path)[1].in)-oppositeLength)<1e-10);assert.ok(new Vector3(...pathHandles(path)[1].in).cross(new Vector3(...pathHandles(path)[1].out)).length()<1e-10);
  assert.notEqual(pathCurve(path),automatic,'changing handles must invalidate playback/export without moving anchors');
  setPathHandleMode(path,1,'free');const outgoing=[...pathHandles(path)[1].out];setPathHandle(path,1,'in',[-1,2,3]);assert.deepEqual(pathHandles(path)[1].out,outgoing,'Free preserves the other handle');
  const shaped=pathCurve(path);insertPathPoint(path,0);assert.equal(path.points.length,4);
  for(let i=0;i<=300;i++){const t=i/300,next=t<=.5?t*4/3:(1+t*2)/3;assert.ok(shaped.getPoint(t).distanceTo(pathCurve(path).getPoint(next))<1e-9,'inserting a control point must preserve both adjacent cubic shapes');}
  path.transform={position:[12,4,-8],rotation:[15,70,0],scale:[2,1,3]};history.commit(scene);
  const dragon=createObject('cube',1),visitor=createObject('human',2),visitorFollow=followPath(path.id);dragon.components=[followPath(path.id)];if(visitorFollow.type==='followPath')visitorFollow.progress=.8;visitor.components=[visitorFollow];scene.objects=[dragon,visitor];
  const animation=ensureAnimation(dragon);putKey(animation,'followPath.progress',0,.1);putKey(animation,'followPath.progress',scene.duration,1);const keys=structuredClone(animation);
  const atStart=pathCurve(path).getPoint(0),expectedStart=new Vector3(...path.points[0]).applyMatrix4(pathMatrix(path));assert.ok(atStart.distanceTo(expectedStart)<1e-10);
  for(const [object,progress] of [[dragon,.1],[visitor,.8]] as const){const position=matrixTransform(sceneWorldMatrices(scene,0).get(object.id)!).position;assert.ok(new Vector3(...position).distanceTo(pathCurve(path).getPointAt(progress))<1e-8);}
  assert.deepEqual(dragon.animation,keys,'editing a shared route must not add or replace follower keyframes');
  const reopened=parseDocument(serializeDocument(scene));assert.deepEqual(reopened.paths,scene.paths);assert.deepEqual(sceneWorldMatrices(reopened,2).get(dragon.id)!.elements,sceneWorldMatrices(scene,2).get(dragon.id)!.elements);
  assert.equal(history.undo()!.paths![0].transform,undefined);assert.deepEqual(history.redo()!.paths![0].transform,path.transform);
  const malformed=structuredClone(scene);malformed.paths![0].handles!.pop();assert.throws(()=>serializeDocument(malformed),/Each path point needs two handles/);
  setPathHandleMode(path,1,'auto');assert.equal(pathHandles(path)[1].mode,'auto');
});
