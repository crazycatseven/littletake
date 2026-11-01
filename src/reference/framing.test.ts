import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Euler, MathUtils, PerspectiveCamera, Vector3 } from 'three';
import { analysisSchema } from './analysis.ts';
import { fitReferenceActors, fitReferenceCameras, measureReferenceFraming, projectedBox } from './framing.ts';
import { evaluateTransform, parseDocument, serializeDocument } from '../model.ts';
import { saveObjectAsset, instantiateAsset } from '../assets/library.ts';
import { humanProxyParts } from '../assets/human.ts';
import {createAssetGroup,disposeAssetGroup,evaluateAsset,measureAsset,poseAssetJoints,validateAsset} from '../assets/model.ts';
import {applyProjectOperations,aimedCameraTransform} from '../scene-edit/operations.ts';
import {serializeContent,validateProjectContent} from '../project/model.ts';
import {Box3} from 'three';
import { validateDocument } from '../model.ts';
import type { Vec3 } from '../types.ts';

test('recorded close-shot failure is fitted to upper-body observations; placement, continuous tracks and prefab appearance survive save/reload',()=>{
  const fixture=JSON.parse(readFileSync(new URL('./fixtures/recorded-framing.json',import.meta.url),'utf8')),analysis=analysisSchema.parse(fixture.analysis),before=validateDocument(fixture.scene);
  const initial=measureReferenceFraming(before,analysis);assert.ok(Math.max(...initial.map(m=>m.centerError))>.35);
  const fitted=fitReferenceCameras(fitReferenceActors(fitReferenceCameras(before,analysis),analysis),analysis),metrics=measureReferenceFraming(fitted,analysis);
  assert.ok(metrics.every(m=>m.actual&&m.centerError<.09&&m.heightError<.16),JSON.stringify(metrics.filter(m=>!m.actual||m.centerError>=.09||m.heightError>=.16).map(m=>({name:m.name,time:m.time,center:m.centerError,height:m.heightError,occluders:m.occluders}))));
  assert.deepEqual(parseDocument(serializeDocument(fitted)),fitted);
  assert.deepEqual(fitted.shots,before.shots);
  for(const shot of before.shots){const oldCamera=before.cameras.find(camera=>camera.id===shot.cameraId)!,newCamera=fitted.cameras.find(camera=>camera.id===shot.cameraId)!;if(!oldCamera.track)continue;
    const heading=(camera:typeof oldCamera,time:number)=>{const forward=new Vector3(0,0,-1).applyEuler(new Euler(...evaluateTransform(camera,time).rotation.map(MathUtils.degToRad) as Vec3));return MathUtils.radToDeg(Math.atan2(forward.x,forward.z));},wrap=(angle:number)=>((angle+540)%360)-180;
    const corrections=analysis.frames.filter(frame=>frame.time>=shot.start&&frame.time<=shot.start+shot.duration).map(frame=>wrap(heading(newCamera,frame.time)-heading(oldCamera,frame.time)));
    assert.ok(corrections.every((value,index)=>!index||Math.abs(wrap(value-corrections[index-1]))<45),'A tracking correction cannot jump to the opposite side independently in the middle of a shot.');
  }
  for(const object of fitted.objects.filter(o=>!analysis.entities.some(e=>e.principal&&e.name===o.name)))assert.deepEqual(object,before.objects.find(o=>o.id===object.id));
  const frame=analysis.frames[1],shot=fitted.shots[frame.shotIndex],camera=fitted.cameras.find(c=>c.id===shot.cameraId)!,pose=evaluateTransform(camera,frame.time),view=new PerspectiveCamera(camera.fov,16/9,.05,500);
  view.position.fromArray(pose.position);view.rotation.set(...pose.rotation.map(MathUtils.degToRad) as Vec3);view.updateMatrixWorld(true);
  const actor=fitted.objects.find(o=>o.name===frame.subjects[0].name)!,full=projectedBox(actor,frame.time,view,0)!,upper=projectedBox(actor,frame.time,view,.85)!;
  assert.equal(full[3],1);assert.ok(upper[3]<.98,'Medium framing must crop off-screen legs, not shrink a full standing person.');
  assert.ok(humanProxyParts.find(p=>p.id==='nose')!.position[2]>0);assert.ok(humanProxyParts.filter(p=>p.id.endsWith('-foot')).every(p=>p.position[2]>0));
  const prefab=saveObjectAsset(actor,[],'saved-human'),instance=instantiateAsset(prefab,'reused-human',[4,0,3],fitted.duration);
  assert.equal(prefab.parts.find(p=>p.id==='head')!.color,humanProxyParts.find(p=>p.id==='head')!.color);
  assert.equal(prefab.parts.find(p=>p.id==='body-body')!.color.toLowerCase(),actor.color.toLowerCase());
  assert.equal(instance.color,'#ffffff');assert.deepEqual(instance.transform.position,[4,0,3]);assert.ok(instance.track?.samples?.length);
  assert.equal(evaluateAsset(prefab).parts.filter(part=>part.joint).length,18,'Saved and library humans share articulated head, torso, shoulders, wrists and limbs.');
  const rig=createAssetGroup(prefab),at=(id:string)=>{let point=new Vector3();rig.traverse(node=>{if(node.userData.partId===id)point=node.getWorldPosition(new Vector3());});return point;},rest=at('right-hand');
  try{poseAssetJoints(rig,prefab,{'right-upperarm':-45,'right-forearm':-60,head:20});const writing=at('right-hand');assert.ok(writing.y>rest.y+.3&&writing.z>rest.z+.3,'A hand must follow both shoulder and elbow; changing a root pose alone is insufficient.');poseAssetJoints(rig,prefab,{});assert.ok(at('right-hand').distanceTo(rest)<1e-9);}finally{disposeAssetGroup(rig);}
  const rigScene=structuredClone(fitted),rigActor={...structuredClone(actor),kind:'asset' as const,asset:{id:prefab.id},color:'#ffffff'};rigScene.objects[rigScene.objects.findIndex(o=>o.id===actor.id)]=rigActor;
  const faceAnalysis=structuredClone(analysis);for(const frame of faceAnalysis.frames)for(const subject of frame.subjects)if(subject.name===actor.name)subject.headBox=[.3,.1,.5,.3];
  const keyed=applyProjectOperations({name:'Rig framing',scenes:[rigScene],assets:[prefab]},[{type:'set_property_keys',sceneId:rigScene.id,id:actor.id,path:'jointAngles.head',keys:[{time:0,value:0,interpolation:'linear'},{time:rigScene.duration,value:25,interpolation:'linear'}]}],0);
  const neutralHeads=measureReferenceFraming(rigScene,faceAnalysis,{},[prefab]).filter(m=>m.name===actor.name),posedHeads=measureReferenceFraming(keyed.scenes[0],faceAnalysis,{},[prefab]).filter(m=>m.name===actor.name);
  assert.ok(posedHeads.every(m=>m.actualHead),'A principal prefab must retain face measurements; kind=asset cannot silently bypass them.');assert.notDeepEqual(posedHeads.map(m=>m.actualHead),neutralHeads.map(m=>m.actualHead),'Frame measurements must evaluate the actual keyed head pose.');
  const compound=JSON.parse(readFileSync(new URL('./fixtures/compound-framing.json',import.meta.url),'utf8')),observations=analysisSchema.parse(compound.analysis);
  assert.equal(compound.bindings.entrance_doors.length,2);
  const repaired=fitReferenceCameras(fitReferenceActors(fitReferenceCameras(compound.scene,observations,compound.bindings),observations,compound.bindings),observations,compound.bindings);
  assert.deepEqual(parseDocument(serializeDocument(repaired)),repaired);
  for(const entity of [...repaired.objects,...repaired.cameras])if(entity.track?.samples)assert.ok(entity.track.samples.every((s,i,all)=>!i||s.at>all[i-1].at));
  assert.ok(measureReferenceFraming(repaired,observations,compound.bindings).filter(m=>m.name==='entrance_doors').every(m=>m.actual),'A compound reference must measure the union of its visible components.');
  for(const frame of observations.frames){const camera=repaired.cameras.find(c=>c.id===repaired.shots[frame.shotIndex].cameraId)!,pose=evaluateTransform(camera,frame.time),right=new Vector3(1,0,0).applyEuler(new Euler(...pose.rotation.map(MathUtils.degToRad) as Vec3));right.y=0;right.normalize();
    for(const subject of frame.subjects.filter(s=>['left','right'].includes(s.facing))){const actor=repaired.objects.find(o=>compound.bindings[subject.name]?.includes(o.id)||o.name===subject.name);if(!actor||actor.kind!=='human')continue;const heading=evaluateTransform(actor,frame.time),forward=new Vector3(0,0,1).applyEuler(new Euler(...heading.rotation.map(MathUtils.degToRad) as Vec3));forward.y=0;forward.normalize();assert.ok(forward.dot(right)*(subject.facing==='right'?1:-1)>.7,'Equivalent XYZ Euler representations must not reverse the requested screen direction.');}
  }
});

test('recorded compound doorway opens per instance, clears real-part occlusion, and keeps pose and performance through prefab/save/reuse',()=>{
  const asset=validateAsset(JSON.parse(readFileSync(new URL('./fixtures/entrance-prefab.json',import.meta.url),'utf8'))),frozen=JSON.stringify(asset),joints=evaluateAsset(asset).parts.filter(part=>part.joint);
  assert.equal(joints.length,2);assert.ok(joints.some(part=>part.id.includes('~')),'Mirrored joint identities must survive serialization.');
  const door=instantiateAsset(asset,'door',[0,0,0],6);door.name='entrance';door.track={start:0,duration:3,from:structuredClone(door.transform),to:{...structuredClone(door.transform),position:[.1,0,0]}};
  const fixture=JSON.parse(readFileSync(new URL('./fixtures/recorded-framing.json',import.meta.url),'utf8')),actor=fixture.scene.objects.find((o:any)=>o.kind==='human');actor.id='actor';actor.name='Performer';actor.transform={position:[.3,0,-1],rotation:[0,0,0],scale:[1,1,1]};actor.track=null;
  const camera={id:'camera',name:'Camera',fov:45,transform:aimedCameraTransform([.3,1.6,4],[.3,1.6,-1]),track:null};
  const scene={format:'LittleTake.scene' as const,version:3 as const,id:'scene',name:'Doorway',duration:6,objects:[door,actor],cameras:[camera],shots:[{id:'shot',name:'Door',cameraId:'camera',start:0,duration:6}]};
  const analysis=analysisSchema.parse({summary:'A person visible through a held-open doorway.',entities:[{name:'Performer',principal:true,description:'Performer',color:'#582273'}],shots:[{start:0,duration:6,framing:'full_body',description:'Door'}],frames:[{time:0,shotIndex:0,subjects:[{name:'Performer',box:[.3,.2,.6,.9],headBox:null,bodyRegionId:null,headRegionId:null,facing:'front',action:'standing'}],setting:'Doorway'}],assumptions:[]});
  const before=measureReferenceFraming(scene,analysis,{},[asset]);assert.ok(before[0].occluders.includes('entrance'));
  const source={name:'Doors',scenes:[scene],assets:[asset]},opened=applyProjectOperations(source,joints.map(part=>({type:'set_asset_joint',sceneId:'scene',id:'door',partId:part.id,angle:85})),0);
  assert.ok(!measureReferenceFraming(opened.scenes[0],analysis,{},opened.assets)[0].occluders.includes('entrance'),'An open prefab must be tested by actual component geometry, never its enclosing solid box.');
  assert.deepEqual(opened.scenes[0].objects[0].track,door.track);assert.equal(JSON.stringify(asset),frozen);
  assert.deepEqual(validateProjectContent(JSON.parse(serializeContent(opened))),opened);
  const copy=saveObjectAsset(opened.scenes[0].objects[0],opened.assets!,'independent-door'),reused=instantiateAsset(copy,'reused',[5,0,2],6);
  assert.deepEqual(reused.jointAngles,opened.scenes[0].objects[0].jointAngles);assert.deepEqual(reused.transform.position,[5,0,2]);assert.deepEqual(reused.track!.to.position,[5.1,0,2]);
  const fresh={name:'Other project',scenes:[{...scene,id:'other',objects:[reused]}],assets:[copy]};assert.deepEqual(validateProjectContent(JSON.parse(serializeContent(fresh))),fresh);
  const group=createAssetGroup(asset);poseAssetJoints(group,asset,opened.scenes[0].objects[0].jointAngles!);const openDepth=new Box3().setFromObject(group).getSize(new Vector3()).z;poseAssetJoints(group,asset,{});assert.ok(openDepth>.6);assert.ok(Math.abs(new Box3().setFromObject(group).getSize(new Vector3()).z-asset.bounds.size[2])<1e-9);disposeAssetGroup(group);
  assert.ok(measureAsset(copy,copy.template?.jointAngles).bounds.size[2]>.6);
});
