import test from 'node:test';
import assert from 'node:assert/strict';
import { createCamera, createEmptyScene, createObject, evaluateFov } from '../src/model.ts';
import { emptyAnimation, putKey } from '../src/animation/model.ts';
import { localTransform, worldTransform } from '../src/placement/hierarchy.ts';
import { movement } from '../src/components/model.ts';
import { PerformanceSession } from '../src/performance/session.ts';
import { XRRecording } from '../src/xr/recording.ts';
import { applyProjectOperations } from '../src/scene-edit/operations.ts';
import { sketchedCameraMove, withCameraMove } from '../src/spatial/sketch.ts';
import { renderScenePreview } from '../server/assets/preview.ts';
import { measureReferenceFraming } from '../src/reference/framing.ts';
import { analysisSchema } from '../src/reference/analysis.ts';
import type { Vec3 } from '../src/types.ts';

function fixture() {
  const scene = createEmptyScene('set'); scene.duration = 6;
  const parent = createObject('cube', 1); parent.id = 'parent'; parent.transform.position = [5, 0, 2]; parent.transform.rotation = [0, 90, 0];
  const actor = createObject('human', 2); actor.id = 'actor'; actor.name = 'Actor'; actor.parentId = parent.id; actor.transform.position = [0, 0, 0];
  const camera = createCamera('camera'); camera.parentId = parent.id; camera.transform.position = [0, 1.5, 7]; camera.transform.rotation = [0, 0, 0];
  camera.animation = emptyAnimation(); putKey(camera.animation, 'fov', 0, 40); putKey(camera.animation, 'fov', 6, 55);
  scene.objects = [parent, actor]; scene.cameras = [camera]; scene.shots = [{id:'shot',name:'Shot',cameraId:camera.id,start:0,duration:6}];
  return {name:'Integration', scenes:[scene]};
}
const near = (a:number[], b:number[]) => a.forEach((value,i)=>assert.ok(Math.abs(value-b[i])<1e-5, `${a} differs from ${b}`));

test('drawn and Agent camera paths use world positions under parents and retain FOV keys', () => {
  const project=fixture(),scene=project.scenes[0],camera=scene.cameras[0],points:Vec3[]=[[12,1.5,2],[12,1.5,-2]];
  const move=sketchedCameraMove(scene,camera,points,0,scene.shots[0]);
  const drawn=withCameraMove(project,scene.id,camera.id,move.track).scenes[0];
  near(worldTransform(drawn,camera.id,0).position,points[0]);near(worldTransform(drawn,camera.id,6).position,points[1]);
  assert.equal(evaluateFov(drawn.cameras[0],6),55);
  const path=applyProjectOperations(project,[{type:'follow_path',sceneId:scene.id,id:camera.id,time:0,start:0,duration:6,points,orientation:'look_at',forward:'-z',target:[5,1,2],replaceMotion:true}],0).scenes[0];
  near(worldTransform(path,camera.id,6).position,points[1]);assert.equal(evaluateFov(path.cameras[0],6),55);
  const aimed=applyProjectOperations(project,[{type:'set_camera_motion',sceneId:scene.id,id:camera.id,frames:points.map((position,i)=>({time:i*6,position,target:[5,1,2] as Vec3}))}],0).scenes[0];
  near(worldTransform(aimed,camera.id,6).position,points[1]);assert.equal(evaluateFov(aimed.cameras[0],6),55);
  assert.equal(project.scenes[0].cameras[0].track,null);
});

test('rendered inspection and reference measurements agree on parented poses and inherited visibility', () => {
  const scene=fixture().scenes[0],time=2,flat=structuredClone(scene);
  for(const item of [...flat.objects,...flat.cameras]){item.transform=worldTransform(scene,item.id,time);delete item.parentId;}
  const analysis=analysisSchema.parse({summary:'Actor',entities:[{name:'Actor',principal:true,description:'Actor',color:'#aaaaff'}],shots:[{start:0,duration:6,framing:'full_body',description:'Wide'}],frames:[{time,shotIndex:0,subjects:[{name:'Actor',box:[.3,.2,.6,.9],headBox:null,bodyRegionId:null,headRegionId:null,facing:'front',action:'standing'}],setting:'Set'}],assumptions:[]});
  const nested=measureReferenceFraming(scene,analysis)[0],flattened=measureReferenceFraming(flat,analysis)[0];
  near(nested.actual!,flattened.actual!);
  const nestedRender=renderScenePreview(scene,[],[{shotId:'shot',time}]).frames[0],flatRender=renderScenePreview(flat,[],[{shotId:'shot',time}]).frames[0];
  assert.deepEqual(nestedRender.visibleBoxes,flatRender.visibleBoxes);
  scene.objects[0].hidden=true;
  assert.deepEqual(renderScenePreview(scene,[],[{shotId:'shot',time}]).frames[0].visibleBoxes,{});
});

test('keyboard and XR takes retain local keys while respecting world motion under an animated parent', () => {
  const scene=fixture().scenes[0],parent=scene.objects[0],actor=scene.objects[1];
  const controller=movement('walk',2);assert.ok(controller.type==='movement');controller.space='world';actor.components=[controller];
  const control=new PerformanceSession(actor,0,scene),before=worldTransform(scene,actor.id,0);
  control.keys.add('w');control.update(1,scene.duration);
  scene.objects[1]=control.placement();
  near(worldTransform(scene,actor.id,0).position,[before.position[0],before.position[1],before.position[2]+2]);
  parent.animation=emptyAnimation();putKey(parent.animation,'position.x',0,5);putKey(parent.animation,'position.x',6,11);
  const record=new XRRecording(scene.objects[1],0,6);record.begin(1000);
  for(let step=1;step<=60;step++){
    const now=1000+step*50,at=record.sampleTime(now),pose={...before,position:[before.position[0],before.position[1],before.position[2]+2+at] as Vec3};
    record.sample(localTransform(scene,actor.id,pose,at),now);
  }
  record.stop();scene.objects[1]=record.apply();
  near(worldTransform(scene,actor.id,3).position,[before.position[0],before.position[1],before.position[2]+5]);
  assert.equal(scene.objects[1].parentId,parent.id);assert.equal(scene.objects[1].animation!.takes.length,1);
});
