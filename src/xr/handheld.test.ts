import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { XRControls } from './controls';
import { XR_HANDHELD, XR_RECORD_DISCARD } from './menu';
import { XRRecording } from './recording';
import { createCamera } from '../model';
import { XRKeyframeReader } from './timeline';
import { XRViewfinder, viewfinderSvg } from './handheld';

function documentStub() {
  const previous=Object.getOwnPropertyDescriptor(globalThis,'document');
  Object.defineProperty(globalThis,'document',{configurable:true,value:{createElement:()=>({getContext:()=>({})})}});
  return ()=>{if(previous)Object.defineProperty(globalThis,'document',previous);else Reflect.deleteProperty(globalThis,'document');};
}

test('handheld framing is temporary; trigger toggles recording, grip release stops and tracking loss cancels',()=>{
  const restore=documentStub(), controllers=[new THREE.Group(),new THREE.Group()], grips=[new THREE.Group(),new THREE.Group()];
  const reference=new EventTarget(), session=Object.assign(new EventTarget(),{visibilityState:'visible'});
  const renderer={xr:{getController:(i:number)=>controllers[i],getControllerGrip:(i:number)=>grips[i],getReferenceSpace:()=>reference}} as unknown as THREE.WebGLRenderer;
  const camera=createCamera('camera','Camera'), before=structuredClone(camera), reader=new XRKeyframeReader();
  camera.transform.position=[0,0,-2];before.transform.position=[0,0,-2];
  let take:XRRecording<typeof camera>|null=null,now=0,tracked=true,ordinary=0;
  const controls=new XRControls(renderer,{
    targets:()=>[],selected:()=>[],editable:()=>true,select:()=>{},pose:()=>take?.pose??camera.transform,action:()=>{},
    transform:()=>{ordinary++;return true;},
    handheldState:()=>({available:!take,...(take?{id:camera.id,mode:take.mode as 'armed'|'recording'|'review'}:{})}),
    handheldAction:action=>{
      if(action==='enter')take=new XRRecording(camera,1,2);
      else if(action==='start')take!.begin(now);
      else if(action==='stop')take!.stop();
      else if(action==='cancel')take!.cancelGrip();
      else take=null;
      return true;
    },
    handheldPose:pose=>{if(take?.mode==='armed')take.prepare(pose);else take?.sample(pose,now);},
    recordAction:()=>{take=null;},
    timelineState:()=>({time:take?.time??1,duration:3,fps:30,selection:reader.read(take?.keyframeEntity()??camera,3),recording:take?.state()??{mode:'idle',canRecord:true}}),
  });
  const scene=new THREE.Scene();scene.add(controls.rig,controls.menuRoot,controls.timelineRoot);
  const frame={getPose:()=>tracked?{}:null,getViewerPose:()=>null} as unknown as XRFrame;
  const fire=(type:string,index=0)=>controllers[index].dispatchEvent({type} as never);
  const click=(action:number)=>{
    scene.updateMatrixWorld(true);
    const target=[...controls.menuRoot.children,...controls.timelineRoot.children].find(node=>node.userData.xrAction===action)!;
    controllers[0].quaternion.setFromUnitVectors(new THREE.Vector3(0,0,-1),controls.rig.worldToLocal(target.getWorldPosition(new THREE.Vector3())).sub(controllers[0].position).normalize());
    fire('selectstart');fire('selectend');
  };
  const mode=()=>take?.mode;
  try{
    controls.start(session as unknown as XRSession,new THREE.Vector3(0,0,-3));
    controllers.forEach(controller=>controller.dispatchEvent({type:'connected',data:{gripSpace:{}}} as never));
    click(XR_HANDHELD);assert.equal(mode(),'armed');assert.deepEqual(camera,before);
    // Aim away from panels; Grip acquires the camera without a ray hit.
    controllers[0].quaternion.identity();grips[0].position.set(0,0,-.5);
    fire('squeezestart');grips[0].position.x=.2;controls.update(frame);
    assert.equal(controls.menuRoot.visible,false);assert.equal(controls.timelineRoot.visible,false);
    assert.equal(mode(),'armed');const framed=structuredClone(take!.pose);assert.deepEqual(camera,before);
    fire('selectstart');fire('selectend');assert.equal(mode(),'recording');
    fire('squeezestart',1);assert.equal(mode(),'armed'); // Dual grip cancels the take and owns navigation.
    const rigBefore=controls.rig.position.clone();grips[1].position.x+=.2;controls.updateView(frame);
    assert.notDeepEqual(controls.rig.position,rigBefore);assert.deepEqual(camera,before);
    fire('squeezeend',1);fire('squeezeend');
    fire('squeezestart');controls.update(frame);const restarted=structuredClone(take!.pose);fire('selectstart');fire('selectend');
    now=500;grips[0].position.x=.5;grips[0].rotation.y=.3;controls.update(frame);
    fire('selectstart');fire('selectend');assert.equal(mode(),'review');assert.equal(take!.time,1);
    assert.equal(controls.menuRoot.visible,true);assert.equal(controls.timelineRoot.visible,true);
    assert.deepEqual(take!.preview(1),restarted);assert.deepEqual(camera,before);
    click(XR_RECORD_DISCARD);assert.equal(mode(),undefined);
    click(XR_HANDHELD);controllers[0].quaternion.identity();fire('squeezestart');fire('selectstart');fire('selectend');
    now+=250;controls.update(frame);fire('squeezeend');assert.equal(mode(),'review');
    click(XR_RECORD_DISCARD);click(XR_HANDHELD);controllers[0].quaternion.identity();fire('squeezestart');fire('selectstart');fire('selectend');
    tracked=false;controls.update(frame);assert.equal(mode(),'armed');assert.equal(controls.menuRoot.visible,true);assert.equal(controls.timelineRoot.visible,true);assert.deepEqual(camera,before);
    tracked=true;fire('squeezestart');fire('selectstart');fire('selectend');now+=1500;controls.update(frame);
    assert.equal(mode(),'review');assert.equal(take!.apply().animation!.takes[0].end,2);assert.equal(ordinary,0);
  }finally{controls.dispose();restore();}
});

test('viewfinder limits render rate, excludes helpers and restores renderer state on failure',()=>{
  const restore=documentStub(),viewfinder=new XRViewfinder(),helper=new THREE.Group(),scene=new THREE.Scene(),camera=new THREE.PerspectiveCamera();
  let target:THREE.WebGLRenderTarget|null=null,scissorTest=true,renders=0,fail=false;
  const renderer={xr:{enabled:true},getRenderTarget:()=>target,setRenderTarget:(value:THREE.WebGLRenderTarget|null)=>{target=value;},
    getViewport:(v:THREE.Vector4)=>v.set(1,2,3,4),getScissor:(v:THREE.Vector4)=>v.set(5,6,7,8),getScissorTest:()=>scissorTest,
    setViewport:()=>{},setScissor:()=>{},setScissorTest:(value:boolean)=>{scissorTest=value;},clear:()=>{},
    render:()=>{renders++;assert.equal(helper.visible,false);assert.equal(renderer.xr.enabled,false);if(fail)throw new Error('render failed');},
  };
  const state={available:false,id:'camera',mode:'recording' as const,time:2,start:1,end:3};
  try{
    viewfinder.render(renderer as unknown as THREE.WebGLRenderer,scene,camera,state,0,1,[helper]);
    viewfinder.render(renderer as unknown as THREE.WebGLRenderer,scene,camera,state,20,1,[helper]);assert.equal(renders,1);
    fail=true;assert.throws(()=>viewfinder.render(renderer as unknown as THREE.WebGLRenderer,scene,camera,state,100,1,[helper]),/render failed/);
    assert.equal(helper.visible,true);assert.equal(renderer.xr.enabled,true);assert.equal(target,null);assert.equal(scissorTest,true);
    assert.match(viewfinderSvg(state),/REC/);assert.match(viewfinderSvg(state),/1.0 \/ 2.0 s/);
  }finally{viewfinder.dispose();restore();}
});


test('Shot end limits recording without rejecting camera keys later in the scene',()=>{
  const camera=createCamera('camera','Camera');
  camera.animation={takes:[],curves:{'position.x':[{time:5,value:7,interpolation:'linear'}],fov:[{time:5,value:60,interpolation:'linear'}]}};
  const take=new XRRecording(camera,1,6,2),pose=structuredClone(camera.transform);pose.position=[1,2,3];
  take.prepare(pose);take.begin(0);pose.position[0]=2;take.sample(pose,2000);
  assert.equal(take.mode,'review');const result=take.apply();
  assert.equal(result.animation!.takes[0].end,2);
  assert.equal(result.animation!.curves['position.x']!.at(-1)!.time,5);
  assert.deepEqual(result.animation!.curves.fov,camera.animation.curves.fov);
});
