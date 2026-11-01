import {worldTransform,effectivelyHidden} from '../placement/hierarchy.ts';
import { Box3, Euler, MathUtils, Matrix4, Mesh, PerspectiveCamera, Quaternion, Ray, Vector3 } from 'three';
import { ensureAnimation,evaluateFov, evaluateJointAngles, evaluateTransform, setTransformMotion } from '../model.ts';
import {putKey,jointProperty} from '../animation/model.ts';
import { recordedTrack } from '../performance/motion.ts';
import type { SceneCamera, SceneDocument, SceneObject, Transform, Vec3,ImageBounds } from '../types.ts';
import {clipFrameBox} from '../scene-snapshot.ts';
import type { ReferenceAnalysis } from './analysis.ts';
import { humanProxyPoints } from '../assets/human.ts';
import type { ReferenceBindings } from './types.ts';
import {createAssetGroup,evaluateAsset,poseAssetJoints,type AssetDefinition} from '../assets/model.ts';

type Box=[number,number,number,number];
const unitBox:Vec3[]=[];for(const x of [-.5,.5])for(const y of [-.5,.5])for(const z of [-.5,.5])unitBox.push([x,y,z]);
type AssetSurfaces={parts:{box:Box3;points:Vec3[]}[];face:Vec3[];forward:Vec3;human:boolean};
const assetSolids=new WeakMap<AssetDefinition,Map<string,AssetSurfaces>>();
const assetRoots=new WeakMap<AssetDefinition,ReturnType<typeof createAssetGroup>>();
function assetSurfaces(asset:AssetDefinition,angles:Record<string,number>={}){
  let poses=assetSolids.get(asset);if(!poses){poses=new Map();assetSolids.set(asset,poses);}const key=JSON.stringify(angles);let surfaces=poses.get(key);if(surfaces)return surfaces;
  surfaces={parts:[],face:[],forward:[0,0,1],human:asset.tags.includes('person')||['head','left-thigh','right-thigh'].every(id=>asset.parts.some(part=>part.id===id))};
  let root=assetRoots.get(asset);if(!root){root=createAssetGroup(asset);assetRoots.set(asset,root);}poseAssetJoints(root,asset,angles);
  root.traverse(node=>{if(!(node instanceof Mesh))return;node.geometry.computeBoundingBox();const local=node.geometry.boundingBox!,box=local.clone().applyMatrix4(node.matrixWorld),points=unitBox.map(point=>new Vector3(...point.map((value,axis)=>value<0?local.min.getComponent(axis):local.max.getComponent(axis)) as Vec3).applyMatrix4(node.matrixWorld).toArray() as Vec3);surfaces!.parts.push({box,points});
    let part=node.parent;while(part&&!part.userData.partId)part=part.parent;const id=part?.userData.partId as string|undefined;
    if(surfaces!.human&&id==='head')surfaces!.forward=new Vector3(0,0,1).transformDirection(node.matrixWorld).toArray() as Vec3;
    if(surfaces!.human&&id==='head'&&node.geometry.type==='SphereGeometry')for(let row=0;row<=8;row++){const y=-.95+row/8*1.55,r=Math.sqrt(1-y*y);for(let column=0;column<=16;column++){const angle=(-110+column/16*220)*Math.PI/180;surfaces!.face.push(new Vector3(Math.sin(angle)*r*.5,y*.5,Math.cos(angle)*r*.5).applyMatrix4(node.matrixWorld).toArray() as Vec3);}}
    else if(surfaces!.human&&(id==='head'||id==='nose'||id?.endsWith('-eye')))surfaces!.face.push(...points);
  });if(poses.size>=128)poses.delete(poses.keys().next().value!);poses.set(key,surfaces);return surfaces;
}
function partBounds(asset:AssetDefinition,angles:Record<string,number>={}){return assetSurfaces(asset,angles).parts.map(part=>part.box);}
function person(object:SceneObject,assets:AssetDefinition[]){const asset=assets.find(asset=>asset.id===object.asset?.id);return object.kind==='human'||!!asset&&assetSurfaces(asset).human;}
function rootMoves(item:SceneObject|SceneCamera){return !!item.track||Object.keys(item.animation?.curves??{}).some(path=>/^(position|rotation|scale)\./.test(path));}
function atPose(object:SceneObject,pose:Transform,time:number){const proxy=structuredClone(object);setTransformMotion(proxy,null,time);proxy.transform=pose;return proxy;}
function cameraFor(p:number[]){const camera=new PerspectiveCamera(p[5],16/9,.05,500);camera.position.set(p[0],p[1],p[2]);camera.quaternion.setFromEuler(new Euler(p[3],p[4],0,'YXZ'));camera.updateMatrixWorld(true);return camera;}
function parameters(camera:SceneCamera,time:number){const pose=evaluateTransform(camera,time),q=new Quaternion().setFromEuler(new Euler(...pose.rotation.map(MathUtils.degToRad) as Vec3)),e=new Euler().setFromQuaternion(q,'YXZ');return [...pose.position,e.x,e.y,evaluateFov(camera,time)];}
function transform(p:number[]):Transform{const e=new Euler().setFromQuaternion(cameraFor(p).quaternion,'XYZ');return {position:p.slice(0,3) as Vec3,rotation:[e.x,e.y,e.z].map(MathUtils.radToDeg) as Vec3,scale:[1,1,1]};}
/** Project the complete proxy bound, then clip to the video frame just like a visible source box. */
export function projectedBox(object:SceneObject,time:number,camera:PerspectiveCamera,bodyBottom=0,headOnly=false,assets:AssetDefinition[]=[]):Box|null{
  const pose=evaluateTransform(object,time),q=new Quaternion().setFromEuler(new Euler(...pose.rotation.map(MathUtils.degToRad) as Vec3)),matrix=new Matrix4().compose(new Vector3(...pose.position),q,new Vector3(...pose.scale));
  const asset=assets.find(asset=>asset.id===object.asset?.id),surfaces=asset?assetSurfaces(asset,evaluateJointAngles(object,time)):null,bound=surfaces?.parts.reduce((box,part)=>box.union(part.box),new Box3()),human=object.kind==='human'||!!surfaces?.human;
  const points=object.kind==='human'?humanProxyPoints(bodyBottom,headOnly):surfaces?.human?(headOnly?surfaces.face:surfaces.parts.filter(part=>part.box.max.y>=bodyBottom).flatMap(part=>part.points.map(point=>[point[0],Math.max(bodyBottom,point[1]),point[2]] as Vec3))):bound?unitBox.map(point=>point.map((value,axis)=>value<0?bound.min.getComponent(axis):bound.max.getComponent(axis)) as Vec3):unitBox,e=new Matrix4().multiplyMatrices(camera.projectionMatrix,camera.matrixWorldInverse).multiply(matrix).elements;
  let x0=Infinity,y0=Infinity,x1=-Infinity,y1=-Infinity,front=false;
  for(const [x,y,z] of points){
    const w=e[3]*x+e[7]*y+e[11]*z+e[15];if(w<=.05){if(human)return null;continue;}front=true;
    const px=((e[0]*x+e[4]*y+e[8]*z+e[12])/w+1)/2,py=(1-(e[1]*x+e[5]*y+e[9]*z+e[13])/w)/2;x0=Math.min(x0,px);x1=Math.max(x1,px);y0=Math.min(y0,py);y1=Math.max(y1,py);
  }
  if(!front||x1<0||y1<0||x0>1||y0>1)return null;
  return [Math.max(0,x0),Math.max(0,y0),Math.min(1,x1),Math.min(1,y1)];
}
const boxLoss=(a:Box,b:Box)=>4*((a[0]+a[2]-b[0]-b[2])/2)**2+2*(a[1]-b[1])**2+1.5*((a[3]-a[1])-(b[3]-b[1]))**2+.5*((a[2]-a[0])-(b[2]-b[0]))**2;
function faceDirection(object:SceneObject,time:number,assets:AssetDefinition[]){const asset=assets.find(asset=>asset.id===object.asset?.id),forward=new Vector3(...(asset?assetSurfaces(asset,evaluateJointAngles(object,time)).forward:[0,0,1] as Vec3)).applyEuler(new Euler(...evaluateTransform(object,time).rotation.map(MathUtils.degToRad) as Vec3));forward.y=0;return forward.normalize();}
function neck(object:SceneObject,assets:AssetDefinition[]){return assets.find(asset=>asset.id===object.asset?.id)?.parts.find(part=>part.id==='head_yaw')?.joint;}
function imageDirection(facing:ReferenceAnalysis['frames'][number]['subjects'][number]['bodyFacing'],view:PerspectiveCamera,pose:Transform){
  const toward=view.position.clone().sub(new Vector3(...pose.position));toward.y=0;toward.normalize();const right=new Vector3(1,0,0).applyQuaternion(view.quaternion);right.y=0;right.normalize();
  if(facing==='right')return right;if(facing==='left')return right.negate();if(facing==='front')return toward;if(facing==='back')return toward.negate();
  if(facing==='three_quarter'){const current=new Vector3(0,0,1).applyEuler(new Euler(...pose.rotation.map(MathUtils.degToRad) as Vec3));return toward.addScaledVector(right,current.dot(right)<0?-1:1).normalize();}return null;
}
function walkingHeading(object:SceneObject,time:number,action:string,assets:AssetDefinition[]){
  if(!neck(object,assets)||!/walk|run|cross|enter/i.test(action))return null;
  const before=evaluateTransform(object,Math.max(0,time-.1)).position,after=evaluateTransform(object,time+.1).position,x=after[0]-before[0],z=after[2]-before[2];return Math.hypot(x,z)>.01?MathUtils.radToDeg(Math.atan2(x,z)):null;
}
function facingLoss(object:SceneObject,time:number,view:PerspectiveCamera,subject:ReferenceAnalysis['frames'][number]['subjects'][number],assets:AssetDefinition[]){
  let forward=faceDirection(object,time,assets);const toward=view.position.clone().sub(new Vector3(...evaluateTransform(object,time).position));toward.y=0;toward.normalize();const right=new Vector3(1,0,0).applyQuaternion(view.quaternion);right.y=0;right.normalize();
  const target=subject.facing==='right'?right:subject.facing==='left'?right.negate():subject.facing==='front'?toward:subject.facing==='back'?toward.clone().negate():null;
  const pose=evaluateTransform(object,time),joint=neck(object,assets),bodyJoint=assets.find(asset=>asset.id===object.asset?.id)?.parts.find(part=>part.id==='body_yaw')?.joint,walking=walkingHeading(object,time,subject.action,assets),root=walking??worldHeading(pose),bodyTarget=imageDirection(subject.bodyFacing,view,pose);
  const desiredBody=bodyTarget?MathUtils.radToDeg(Math.atan2(bodyTarget.x,bodyTarget.z)):root,body=root+(bodyJoint&&bodyTarget?MathUtils.clamp(((desiredBody-root+540)%360)-180,bodyJoint.min,bodyJoint.max):evaluateJointAngles(object,time).body_yaw??0);
  if(joint&&target){const desired=MathUtils.radToDeg(Math.atan2(target.x,target.z)),delta=((desired-body+540)%360)-180,yaw=MathUtils.degToRad(body+MathUtils.clamp(delta,joint.min,joint.max));forward=new Vector3(Math.sin(yaw),0,Math.cos(yaw));}
  const torso=new Vector3(Math.sin(MathUtils.degToRad(body)),0,Math.cos(MathUtils.degToRad(body)));
  const bodyTurn=Math.abs(((desiredBody-root+540)%360)-180),walkTwist=walking!==null&&bodyTarget?Math.max(0,bodyTurn-35)/90:0;
  return (target?(1-forward.dot(target))**2:0)+(bodyTarget?(1-torso.dot(bodyTarget))**2*.5:0)+walkTwist**2*2+(subject.headBox?Math.max(0,-.05-forward.dot(toward))**2*2:0);
}
function subjectLoss(object:SceneObject,time:number,view:PerspectiveCamera,bottom:number,subject:ReferenceAnalysis['frames'][number]['subjects'][number],box:Box|null,assets:AssetDefinition[]=[],frameBounds?:ImageBounds){
  box=clipFrameBox(box,frameBounds);
  if(!subject.headBox||!person(object,assets))return box?boxLoss(box,subject.box):4;
  const head=clipFrameBox(projectedBox(object,time,view,0,true,assets),frameBounds);
  return (box?boxLoss(box,subject.box):4)*.25+(head?boxLoss(head,subject.headBox):4)*4;
}
// Source boxes in medium/close shots describe the visible upper body, not off-screen legs.
function bodyBottom(analysis:ReferenceAnalysis,shotIndex:number,subject?:ReferenceAnalysis['frames'][number]['subjects'][number]){
  if(subject?.headBox&&subject.box[3]<.94&&(subject.box[3]-subject.box[1])/(subject.headBox[3]-subject.headBox[1])>4.7)return 0; // Full-height background person; a foreground person hidden behind a desk remains cropped.
  return {full_body:0,knees_up:.45,waist_up:.85,chest_up:1.1,head_shoulders:1.35}[analysis.shots[shotIndex].framing];
}
function solidBounds(scene:SceneDocument,time:number,assets:AssetDefinition[]=[]){return scene.objects.filter(o=>!person(o,assets)&&o.kind!=='plane'&&!o.hidden).flatMap(other=>{const p=evaluateTransform(other,time),matrix=new Matrix4().compose(new Vector3(...p.position),new Quaternion().setFromEuler(new Euler(...p.rotation.map(MathUtils.degToRad) as Vec3)),new Vector3(...p.scale)),asset=assets.find(asset=>asset.id===other.asset?.id);return (asset?partBounds(asset,evaluateJointAngles(other,time)):[new Box3(new Vector3(-.5,-.5,-.5),new Vector3(.5,.5,.5))]).map(box=>({id:other.id,name:other.name,box:box.clone().applyMatrix4(matrix)}));});}
function blockingAt(bounds:ReturnType<typeof solidBounds>,target:Vector3,view:PerspectiveCamera,excluded:string[]=[]){
  const distance=target.distanceTo(view.position),ray=new Ray(view.position,target.clone().sub(view.position).normalize());
  return bounds.filter(other=>{if(excluded.includes(other.id))return false;const hit=ray.intersectBox(other.box,new Vector3());return hit&&hit.distanceTo(view.position)<distance-.1;}).map(other=>other.name);
}
function blockingParts(bounds:ReturnType<typeof solidBounds>,pose:Transform,view:PerspectiveCamera){return blockingAt(bounds,new Vector3(...pose.position).add(new Vector3(0,1.66*pose.scale[1],0)),view);}
function visibleBodyHeights(analysis:ReferenceAnalysis,shotIndex:number,subject:ReferenceAnalysis['frames'][number]['subjects'][number]){return analysis.shots[shotIndex].framing==='full_body'&&subject.box[1]>.01&&subject.box[3]<.96?[.2,.85,1.35,1.66]:subject.headBox||subject.box[1]>.01?[1.35,1.66]:[];}
function blockingBody(bounds:ReturnType<typeof solidBounds>,pose:Transform,view:PerspectiveCamera,heights:number[]){return [...new Set(heights.flatMap(height=>blockingAt(bounds,new Vector3(...pose.position).add(new Vector3(0,height*pose.scale[1],0)),view)))];}
function visibleArea(object:SceneObject,time:number,view:PerspectiveCamera,bounds:ReturnType<typeof solidBounds>,assets:AssetDefinition[],frameBounds?:ImageBounds){const box=clipFrameBox(projectedBox(object,time,view,0,false,assets),frameBounds);if(!box)return 0;const pose=evaluateTransform(object,time),asset=assets.find(asset=>asset.id===object.asset?.id),center=person(object,assets)?new Vector3(0,1.2,0):asset?new Vector3(...asset.bounds.min).add(new Vector3(...asset.bounds.max)).multiplyScalar(.5):new Vector3();center.multiply(new Vector3(...pose.scale)).applyEuler(new Euler(...pose.rotation.map(MathUtils.degToRad) as Vec3)).add(new Vector3(...pose.position));return blockingAt(bounds,center,view,[object.id]).length?0:(box[2]-box[0])*(box[3]-box[1]);}
function facePosition(pose:Transform,box:Box,view:PerspectiveCamera):Vec3{
  const tangent=Math.tan(view.fov*Math.PI/360),depth=.217*pose.scale[1]/(2*tangent*(box[3]-box[1]));
  const point=new Vector3(((box[0]+box[2])/2-.5)*2*depth*tangent*16/9,(.5-(box[1]+box[3])/2)*2*depth*tangent,-depth).applyMatrix4(view.matrixWorld);
  return [point.x,pose.position[1],point.z];
}
function worldHeading(pose:Transform){const direction=new Vector3(0,0,1).applyEuler(new Euler(...pose.rotation.map(MathUtils.degToRad) as Vec3));return MathUtils.radToDeg(Math.atan2(direction.x,direction.z));}
function setHeading(pose:Transform,yaw:number){const rotation=new Quaternion().setFromEuler(new Euler(...pose.rotation.map(MathUtils.degToRad) as Vec3)).premultiply(new Quaternion().setFromAxisAngle(new Vector3(0,1,0),MathUtils.degToRad(yaw-worldHeading(pose))));const angles=new Euler().setFromQuaternion(rotation,'XYZ');pose.rotation=[angles.x,angles.y,angles.z].map(value=>Math.abs(value)<1e-10?0:MathUtils.radToDeg(value)) as Vec3;}
function boundObjects(scene:SceneDocument,name:string,bindings:ReferenceBindings){return bindings[name]?.length?scene.objects.filter(o=>bindings[name].includes(o.id)):scene.objects.filter(o=>o.name===name);}
function anchorBox(scene:SceneDocument,name:string,time:number,view:PerspectiveCamera,bottom:number,bindings:ReferenceBindings,assets:AssetDefinition[]=[]):Box|null{const boxes=boundObjects(scene,name,bindings).map(object=>projectedBox(object,time,view,bottom,false,assets)).filter((box):box is Box=>!!box);return boxes.length?[Math.min(...boxes.map(b=>b[0])),Math.min(...boxes.map(b=>b[1])),Math.max(...boxes.map(b=>b[2])),Math.max(...boxes.map(b=>b[3]))]:null;}
export function measureReferenceFraming(source:SceneDocument,analysis:ReferenceAnalysis,bindings:ReferenceBindings={},assets:AssetDefinition[]=[]){
  return analysis.frames.flatMap(frame=>{const scene=structuredClone(source);for(const item of [...scene.objects,...scene.cameras]){item.transform=worldTransform(source,item.id,frame.time);if('kind' in item){item.jointAngles=evaluateJointAngles(item,frame.time);item.hidden=effectivelyHidden(source,item.id);}else item.fov=evaluateFov(item,frame.time);item.track=null;delete item.animation;delete item.parentId;}const shot=scene.shots[frame.shotIndex],camera=scene.cameras.find(c=>c.id===shot?.cameraId);if(!camera)return [];
    const view=cameraFor(parameters(camera,frame.time)),bounds=solidBounds(scene,frame.time,assets);return frame.subjects.map(subject=>{const object=boundObjects(scene,subject.name,bindings)[0],box=clipFrameBox(anchorBox(scene,subject.name,frame.time,view,bodyBottom(analysis,frame.shotIndex,subject),bindings,assets),analysis.frameBounds);
      const occluders=object&&person(object,assets)?blockingParts(bounds,evaluateTransform(object,frame.time),view):[];
      const head=object&&person(object,assets)&&subject.headBox?clipFrameBox(projectedBox(object,frame.time,view,0,true,assets),analysis.frameBounds):null;
      let geometry:unknown;if(object&&person(object,assets)){const pose=evaluateTransform(object,frame.time),right=new Vector3(1,0,0).applyQuaternion(view.quaternion),toward=new Vector3(...view.position.toArray()).sub(new Vector3(...pose.position));right.y=0;right.normalize();toward.y=0;toward.normalize();const direction=subject.facing==='right'?right:subject.facing==='left'?right.clone().negate():subject.facing==='front'?toward:subject.facing==='back'?toward.clone().negate():null;const faceForward=faceDirection(object,frame.time,assets),faceYaw=MathUtils.radToDeg(Math.atan2(faceForward.x,faceForward.z));geometry={faceWorldYaw:faceYaw,faceCameraDot:faceForward.dot(toward),suggestedRootYaw:direction?worldHeading(pose)+MathUtils.radToDeg(Math.atan2(direction.x,direction.z))-faceYaw:null,cameraPosition:view.position.toArray(),cameraRight:right.toArray(),actorPosition:pose.position,actorWorldYaw:worldHeading(pose),screenFacingYaw:direction?MathUtils.radToDeg(Math.atan2(direction.x,direction.z)):null,approximateFaceAlignedPosition:subject.headBox?facePosition(pose,subject.headBox,view):null};}
      return {shotIndex:frame.shotIndex,time:frame.time,name:subject.name,objectIds:boundObjects(scene,subject.name,bindings).map(object=>object.id),principal:analysis.entities.find(e=>e.name===subject.name)?.principal??false,expected:subject.box,actual:box,occluders:[...new Set(occluders)],...(geometry?{geometry}:{}),centerError:box?Math.hypot((box[0]+box[2]-subject.box[0]-subject.box[2])/2,(box[1]+box[3]-subject.box[1]-subject.box[3])/2):1,heightError:box?Math.abs((box[3]-box[1])-(subject.box[3]-subject.box[1])):1,...(subject.headBox?{expectedHead:subject.headBox,actualHead:head,headCenterError:head?Math.hypot((head[0]+head[2]-subject.headBox[0]-subject.headBox[2])/2,(head[1]+head[3]-subject.headBox[1]-subject.headBox[3])/2):1,headHeightError:head?Math.abs(head[3]-head[1]-subject.headBox[3]+subject.headBox[1]):1}:{})};
    });});
}
/** Fit cameras to source-image observations. World layout and actor paths remain the expert's responsibility. */
export function fitReferenceCameras(source:SceneDocument,analysis:ReferenceAnalysis,bindings:ReferenceBindings={},globalSearch=true,assets:AssetDefinition[]=[],anchor=source,lockFov=false):SceneDocument{
  if([...source.objects,...source.cameras].some(item=>item.parentId))throw new Error('Numerical fitting currently requires a scene without parents. Use world-space placement and rendered measurements for this scene.');
  const scene=structuredClone(source);
  for(const [index,shot] of scene.shots.entries()){
    const camera=scene.cameras.find(c=>c.id===shot.cameraId);if(!camera)continue;
    const frames=analysis.frames.filter(frame=>frame.shotIndex===index&&frame.subjects.some(s=>boundObjects(scene,s.name,bindings).length));
    if(!frames.length)continue;
    const fit=(group:typeof frames,time:number,fov?:number,starting?:number[],searchSides=globalSearch)=>{
      const original=parameters(camera,time),moving=rootMoves(camera),offsets=new Map(group.map(frame=>[frame.time,parameters(camera,frame.time).map((value,index)=>value-original[index])]));
      let initial=[...(starting??original)];if(fov!==undefined)initial[5]=fov;
      const baseline=parameters(anchor.cameras.find(item=>item.id===camera.id)??camera,time);
      initial[5]=Math.max(15,Math.min(100,initial[5]));
      const facial=group.some(frame=>frame.subjects.some(subject=>subject.headBox)),bounds=new Map(group.map(frame=>[frame.time,solidBounds(scene,frame.time,assets)])),absent=new Map(group.map(frame=>[frame.time,analysis.entities.filter(entity=>!frame.subjects.some(subject=>subject.name===entity.name)).flatMap(entity=>boundObjects(scene,entity.name,bindings).filter(object=>!object.hidden&&person(object,assets)).map(object=>({object,weight:entity.principal?4:1})))]));
      const objective=(p:number[])=>{
        const minFov=15;
        if(p[1]<.6||p[1]>8||p[5]<minFov||p[5]>100||Math.abs(p[3])>1.3||p.slice(0,3).some(v=>Math.abs(v)>100)||Math.abs(p[4]-initial[4])>.35||p.slice(0,3).some((v,i)=>Math.abs(v-initial[i])>2.5)||(facial&&baseline[1]<3&&(Math.abs(p[1]-baseline[1])>.35||Math.abs(p[3]-baseline[3])>.25)))return 1000;
        let loss=0,n=0;
        for(const frame of group){const view=cameraFor(moving?p.map((value,index)=>index===5?value:value+offsets.get(frame.time)![index]):p);for(const subject of frame.subjects){let object=boundObjects(scene,subject.name,bindings)[0];if(!object)continue;const pose=evaluateTransform(object,frame.time);
          if(person(object,assets)&&new Vector3(...pose.position).add(new Vector3(0,1.66*pose.scale[1],0)).distanceTo(view.position)<.22)return 1000;const bottom=bodyBottom(analysis,frame.shotIndex,subject),box=person(object,assets)?projectedBox(object,frame.time,view,bottom,false,assets):anchorBox(scene,subject.name,frame.time,view,bottom,bindings,assets),weight=analysis.entities.find(entity=>entity.name===subject.name)?.principal?4:1;loss+=subjectLoss(object,frame.time,view,bottom,subject,box,assets,analysis.frameBounds)*weight;
          if(person(object,assets)&&blockingBody(bounds.get(frame.time)!,pose,view,visibleBodyHeights(analysis,frame.shotIndex,subject)).length)loss+=1.5;
          if(facial&&!person(object,assets)&&object.kind!=='plane'){const parts=boundObjects(scene,subject.name,bindings),target=new Vector3();for(const part of parts){const asset=assets.find(asset=>asset.id===part.asset?.id),pose=evaluateTransform(part,frame.time),center=asset?new Vector3(...asset.bounds.min).add(new Vector3(...asset.bounds.max)).multiplyScalar(.5):new Vector3();center.multiply(new Vector3(...pose.scale)).applyEuler(new Euler(...pose.rotation.map(MathUtils.degToRad) as Vec3)).add(new Vector3(...pose.position));target.add(center);}target.divideScalar(parts.length);if(blockingAt(bounds.get(frame.time)!,target,view,parts.map(part=>part.id)).length)loss+=2;}
          if(person(object,assets))loss+=facingLoss(object,frame.time,view,subject,assets)*weight*.35;
          n+=weight;
        }
        for(const item of absent.get(frame.time)!)loss+=visibleArea(item.object,frame.time,view,bounds.get(frame.time)!,assets,analysis.frameBounds)*item.weight*.7;}
        return loss/Math.max(1,n)+p.slice(0,3).reduce((v,x,i)=>v+(x-initial[i])**2,0)*.00005+(p[1]-initial[1])**2*.002+(p[5]-initial[5])**2*.00001;
      };
      const expert=[...initial],seeds=[expert];
      if(starting&&!searchSides){const back=new Vector3(0,0,1).applyQuaternion(cameraFor(expert).quaternion);for(const distance of [.5,1,2,-.5])seeds.push(expert.map((value,index)=>index<3?value+back.getComponent(index)*distance:value));}
      if(facial&&searchSides){
        const observed=group.flatMap(frame=>frame.subjects.flatMap(subject=>{const object=boundObjects(scene,subject.name,bindings)[0];return subject.headBox&&object&&person(object,assets)?[{pose:evaluateTransform(object,frame.time),offset:moving?offsets.get(frame.time)!.slice(0,3):[0,0,0],height:subject.headBox[3]-subject.headBox[1]}]:[];}));
        const center=new Vector3();let total=0;for(const item of observed){center.addScaledVector(new Vector3(...item.pose.position).sub(new Vector3(...item.offset as Vec3)),item.height);total+=item.height;}center.divideScalar(Math.max(total,.001));
        const radius=Math.max(1.2,Math.min(10,.217/(2*Math.tan(expert[5]*Math.PI/360)*(total/Math.max(1,observed.length)))));
        for(let angle=0;angle<8;angle++){const yaw=angle*Math.PI/4;seeds.push([center.x+Math.sin(yaw)*radius,expert[1],center.z+Math.cos(yaw)*radius,0,yaw,expert[5]]);}
      }
      const candidates=seeds.map(seed=>{initial=seed;return {seed,value:objective(seed)};}).sort((a,b)=>a.value-b.value).slice(0,searchSides?9:starting?3:1);
      let best=expert,bestValue=Infinity;
      for(const {seed} of candidates){initial=seed;let p=[...seed],value=objective(p),steps=[1,.5,1,.15,.15,fov===undefined&&!lockFov?8:0];
        for(let level=0;level<14;level++){let improved=true,passes=0;while(improved&&passes++<6){improved=false;for(let axis=0;axis<6;axis++){if(!steps[axis])continue;for(const sign of [-1,1]){const candidate=[...p];candidate[axis]+=steps[axis]*sign;const next=objective(candidate);if(next<value){p=candidate;value=next;improved=true;}}}}steps=steps.map(s=>s*.55);}
        if(value<bestValue){bestValue=value;best=p;}
      }
      return best;
    };
    if(!rootMoves(camera)){const p=fit(frames,shot.start);camera.transform=transform(p);camera.fov=p[5];}
    else{
      // Choose one side for the entire authored camera path, then make bounded local refinements.
      // Independent global searches per still can flip a tracking camera across the actors mid-shot.
      const origin=parameters(camera,shot.start),side=fit(frames,shot.start),delta=side.map((value,index)=>value-origin[index]);
      const fov=side[5],poses=frames.map(frame=>{const start=parameters(camera,frame.time).map((value,index)=>index===5?fov:value+delta[index]);return {time:frame.time,p:fit([frame],frame.time,fov,start,false)};});camera.fov=fov;
      const endpoint=(nearest:typeof poses[number],time:number)=>{const original=parameters(camera,nearest.time),edge=parameters(camera,time);return {time,transform:transform(edge.map((v,i)=>i===5?fov:v+nearest.p[i]-original[i]))};};
      const keys=poses.map(p=>({time:p.time,transform:transform(p.p)}));
      if(poses.length>1){if(keys[0].time>shot.start)keys.unshift(endpoint(poses[0],shot.start));if(keys.at(-1)!.time<shot.start+shot.duration)keys.push(endpoint(poses.at(-1)!,shot.start+shot.duration));}
      if(keys.length>1)setTransformMotion(camera,recordedTrack(keys),shot.start);
    }
  }
  return scene;
}


/** Recover ground-plane placement and visible heading from observed image boxes under the current cameras. */
export function fitReferenceActors(source:SceneDocument,analysis:ReferenceAnalysis,bindings:ReferenceBindings={},assets:AssetDefinition[]=[]):SceneDocument{
  if([...source.objects,...source.cameras].some(item=>item.parentId))throw new Error('Numerical fitting currently requires a scene without parents. Use world-space placement and rendered measurements for this scene.');
  const scene=structuredClone(source);
  for(const original of source.objects.filter(o=>person(o,assets)&&analysis.entities.some(e=>e.name===o.name||bindings[e.name]?.includes(o.id)))){
    const observations=analysis.frames.flatMap(frame=>{const subject=frame.subjects.find(s=>s.name===original.name||bindings[s.name]?.includes(original.id)),shot=scene.shots[frame.shotIndex],camera=scene.cameras.find(c=>c.id===shot?.cameraId);return subject&&camera?[{time:frame.time,subject,camera,shotIndex:frame.shotIndex,bottom:bodyBottom(analysis,frame.shotIndex,subject)}]:[];});
    if(!observations.length)continue;
    const firstPosition=evaluateTransform(original,observations[0].time).position,staticSupporting=!analysis.entities.some(entity=>entity.principal&&(entity.name===original.name||bindings[entity.name]?.includes(original.id)))&&observations.every(frame=>!/walk|run|cross|enter/i.test(frame.subject.action)&&new Vector3(...evaluateTransform(original,frame.time).position).distanceTo(new Vector3(...firstPosition))<.02);
    const adjusted=observations.map(({time,subject,camera,bottom,shotIndex})=>{
      const view=cameraFor(parameters(camera,time)),base=evaluateTransform(original,time),pose=structuredClone(base),right=new Vector3(1,0,0).applyQuaternion(view.quaternion);right.y=0;right.normalize();
      const toward=new Vector3().subVectors(view.position,new Vector3(...base.position));toward.y=0;toward.normalize();
      const direction=imageDirection(subject.facing,view,base),bodyDirection=imageDirection(subject.bodyFacing,view,base);
      const facing=direction?MathUtils.radToDeg(Math.atan2(direction.x,direction.z)):worldHeading(base),joint=neck(original,assets),bodyJoint=assets.find(asset=>asset.id===original.asset?.id)?.parts.find(part=>part.id==='body_yaw')?.joint;
      const bodyTarget=bodyDirection?MathUtils.radToDeg(Math.atan2(bodyDirection.x,bodyDirection.z)):worldHeading(base),yaw=staticSupporting?worldHeading(base):walkingHeading(original,time,subject.action,assets)??(joint?bodyTarget:facing);
      const bodyYaw=bodyJoint&&bodyDirection?MathUtils.clamp(((bodyTarget-yaw+540)%360)-180,bodyJoint.min,bodyJoint.max):evaluateJointAngles(original,time).body_yaw??0,headYaw=joint?MathUtils.clamp(((facing-yaw-bodyYaw+540)%360)-180,joint.min,joint.max):undefined;setHeading(pose,yaw);
      const bounds=solidBounds(scene,time,assets),proxy=atPose(original,pose,time);if(bodyJoint)putKey(ensureAnimation(proxy),jointProperty('body_yaw'),time,bodyYaw);if(headYaw!==undefined)putKey(ensureAnimation(proxy),jointProperty('head_yaw'),time,headYaw);
      const loss=(x:number,z:number)=>{pose.position[0]=x;pose.position[2]=z;if(Math.hypot(x-view.position.x,pose.position[1]+1.66*pose.scale[1]-view.position.y,z-view.position.z)<.22||Math.hypot(x-base.position[0],z-base.position[2])>(subject.headBox?5:2.5))return 1000;const box=projectedBox(proxy,time,view,bottom,false,assets);return subjectLoss(proxy,time,view,bottom,subject,box,assets,analysis.frameBounds)+(blockingBody(bounds,pose,view,visibleBodyHeights(analysis,shotIndex,subject)).length?.3:0)+.00005*((x-base.position[0])**2+(z-base.position[2])**2);};
      let x=base.position[0],z=base.position[2],value=loss(x,z),step=1;
      if(subject.headBox){const seed=facePosition(base,subject.headBox,view),next=loss(seed[0],seed[2]);if(next<value){x=seed[0];z=seed[2];value=next;}}
      for(let level=0;level<14;level++){let improved=true,passes=0;while(improved&&passes++<12){improved=false;for(const axis of [0,2])for(const sign of [-1,1]){const nx=axis===0?x+sign*step:x,nz=axis===2?z+sign*step:z,next=loss(nx,nz);if(next<value){x=nx;z=nz;value=next;improved=true;}}}step*=.55;}
      pose.position[0]=x;pose.position[2]=z;
      return {time,delta:[x-base.position[0],0,z-base.position[2]] as Vec3,yaw,headYaw,...(bodyJoint?{bodyYaw}:{})};
    });
    // Adjacent views of a match cut share one root point. Fit the cameras around that
    // common point instead of translating a camera/group after the fit has finished.
    const groups=staticSupporting?[adjusted.map((_,index)=>index)]:adjusted.flatMap((point,index)=>index&&observations[index].shotIndex!==observations[index-1].shotIndex&&point.time-adjusted[index-1].time<.15?[[index-1,index]]:[]);
    for(const indices of groups){
      const views=indices.map(index=>{const observation=observations[index],pose=evaluateTransform(original,observation.time);setHeading(pose,adjusted[index].yaw);const proxy=atPose(original,pose,observation.time);if(adjusted[index].bodyYaw!==undefined)putKey(ensureAnimation(proxy),jointProperty('body_yaw'),observation.time,adjusted[index].bodyYaw!);if(adjusted[index].headYaw!==undefined)putKey(ensureAnimation(proxy),jointProperty('head_yaw'),observation.time,adjusted[index].headYaw!);return {...observation,pose,proxy,view:cameraFor(parameters(observation.camera,observation.time)),bounds:solidBounds(scene,observation.time,assets)};});
      const targets=indices.map(index=>{const base=evaluateTransform(original,adjusted[index].time).position;return base.map((value,axis)=>value+adjusted[index].delta[axis]) as Vec3;}),center=targets.reduce((sum,target)=>sum.map((value,axis)=>value+target[axis]) as Vec3,[0,0,0] as Vec3).map(value=>value/targets.length) as Vec3;
      const loss=(x:number,z:number)=>{if(Math.hypot(x-center[0],z-center[2])>10)return 1000;let result=0;for(const frame of views){frame.pose.position[0]=x;frame.pose.position[2]=z;if(new Vector3(x,frame.pose.position[1]+1.66*frame.pose.scale[1],z).distanceTo(frame.view.position)<.22)return 1000;const proxy=frame.proxy;result+=subjectLoss(proxy,frame.time,frame.view,frame.bottom,frame.subject,projectedBox(proxy,frame.time,frame.view,frame.bottom,false,assets),assets,analysis.frameBounds)+(blockingBody(frame.bounds,frame.pose,frame.view,visibleBodyHeights(analysis,frame.shotIndex,frame.subject)).length?.3:0);}return result+.00005*((x-center[0])**2+(z-center[2])**2);};
      let point=[...center],value=loss(point[0],point[2]);for(const seed of [center,...targets]){let x=seed[0],z=seed[2],score=loss(x,z),step=1;for(let level=0;level<12;level++){let changed=true,passes=0;while(changed&&passes++<8){changed=false;for(const axis of [0,2])for(const sign of [-1,1]){const nx=axis===0?x+step*sign:x,nz=axis===2?z+step*sign:z,next=loss(nx,nz);if(next<score){x=nx;z=nz;score=next;changed=true;}}}step*=.5;}if(score<value){point=[x,center[1],z];value=score;}}
      for(const index of indices){const base=evaluateTransform(original,adjusted[index].time).position;adjusted[index].delta=point.map((value,axis)=>value-base[axis]) as Vec3;}
    }
    const item=scene.objects.find(o=>o.id===original.id)!;
    const originalTimes=original.track?[0,original.track.start,...(original.track.samples??[]).map(s=>original.track!.start+s.at*original.track!.duration),original.track.start+original.track.duration,scene.duration]:[0,scene.duration];
    originalTimes.push(...Object.entries(original.animation?.curves??{}).filter(([path])=>/^(position|rotation|scale)\./.test(path)).flatMap(([,keys])=>keys!.map(key=>key.time)));
    const times=[...originalTimes.filter(time=>!adjusted.some(a=>Math.abs(a.time-time)<1e-6)),...adjusted.map(a=>a.time)].sort((a,b)=>a-b).filter((time,i,all)=>!i||time-all[i-1]>1e-6);
    const keys=times.map(time=>{const before=[...adjusted].reverse().find(a=>a.time<=time)??adjusted[0],after=adjusted.find(a=>a.time>=time)??adjusted.at(-1)!,alpha=after.time===before.time?0:(time-before.time)/(after.time-before.time),pose=evaluateTransform(original,time);
      pose.position=pose.position.map((v,i)=>v+MathUtils.lerp(before.delta[i],after.delta[i],alpha)) as Vec3;
      let difference=((after.yaw-before.yaw+540)%360)-180;setHeading(pose,before.yaw+difference*alpha);
      if(time>adjusted.at(-1)!.time&&adjusted.length>1&&/walk|run|cross|enter/i.test(observations.at(-1)!.subject.action)){
        const a=adjusted.at(-2)!,b=adjusted.at(-1)!,pa=evaluateTransform(original,a.time).position,pb=evaluateTransform(original,b.time).position;
        pose.position=pb.map((v,i)=>v+b.delta[i]+((v+b.delta[i])-(pa[i]+a.delta[i]))*(time-b.time)/(b.time-a.time)) as Vec3;
      }
      return {time,transform:pose};});
    setTransformMotion(item,staticSupporting?null:recordedTrack(keys),0);if(staticSupporting)item.transform=keys[0].transform;
    for(const pose of adjusted){if(pose.headYaw!==undefined)putKey(ensureAnimation(item),jointProperty('head_yaw'),pose.time,pose.headYaw);if(pose.bodyYaw!==undefined)putKey(ensureAnimation(item),jointProperty('body_yaw'),pose.time,pose.bodyYaw);}
  }
  for(const object of scene.objects.filter(object=>person(object,assets)&&neck(object,assets)&&!analysis.entities.some(entity=>entity.principal&&(entity.name===object.name||bindings[entity.name]?.includes(object.id))))){const joint=neck(object,assets)!;for(const frame of analysis.frames){const subject=frame.subjects.find(subject=>subject.name===object.name||bindings[subject.name]?.includes(object.id)),camera=scene.cameras.find(camera=>camera.id===scene.shots[frame.shotIndex]?.cameraId);if(!subject||!camera)continue;const view=cameraFor(parameters(camera,frame.time)),pose=evaluateTransform(object,frame.time),right=new Vector3(1,0,0).applyQuaternion(view.quaternion),toward=view.position.clone().sub(new Vector3(...pose.position));right.y=0;right.normalize();toward.y=0;toward.normalize();const direction=subject.facing==='right'?right:subject.facing==='left'?right.negate():subject.facing==='front'?toward:subject.facing==='back'?toward.negate():null;if(direction){const angle=((MathUtils.radToDeg(Math.atan2(direction.x,direction.z))-worldHeading(pose)-(evaluateJointAngles(object,frame.time).body_yaw??0)+540)%360)-180;putKey(ensureAnimation(object),jointProperty('head_yaw'),frame.time,MathUtils.clamp(angle,joint.min,joint.max));}}}
  return scene;
}

/** Experimental numeric proposal. It still needs source/render review; no quality is inferred here. */
export function fitReferenceScene(scene:SceneDocument,analysis:ReferenceAnalysis,bindings:ReferenceBindings={},searchCameraSide=true,assets:AssetDefinition[]=[],progress?:(pass:number)=>void):SceneDocument{
  let fitted=structuredClone(scene);
  for(let pass=0;pass<3;pass++){progress?.(pass+1);fitted=fitReferenceCameras(fitted,analysis,bindings,searchCameraSide,assets,scene,true);fitted=fitReferenceActors(fitted,analysis,bindings,assets);}
  progress?.(4);
  return fitReferenceActors(fitReferenceCameras(fitted,analysis,bindings,false,assets,scene,true),analysis,bindings,assets);
}

/** World-space evidence at visible match cuts. Camera cuts cannot explain a person's root teleport. */
export function measureCutContinuity(scene:SceneDocument,analysis:ReferenceAnalysis,bindings:ReferenceBindings={}){
  return scene.shots.slice(1).flatMap((shot,index)=>analysis.entities.filter(entity=>entity.principal).flatMap(entity=>{
    const before=analysis.frames.filter(f=>f.shotIndex===index&&f.subjects.some(s=>s.name===entity.name)).at(-1),after=analysis.frames.find(f=>f.shotIndex===index+1&&f.subjects.some(s=>s.name===entity.name)),object=boundObjects(scene,entity.name,bindings)[0];
    if(!before||!after||!object||after.time-before.time>.15)return [];
    const from=worldTransform(scene,object.id,before.time).position,to=worldTransform(scene,object.id,after.time).position,distance=new Vector3(...from).distanceTo(new Vector3(...to));
    return [{name:entity.name,cut:shot.start,fromTime:before.time,toTime:after.time,from,to,distance,speed:distance/(after.time-before.time)}];
  }));
}
