import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { XRControls } from './controls';
import { XR_RECORD, XR_RECORD_APPLY, XR_RECORD_DISCARD, XR_RECORD_PREVIEW } from './menu';
import { XRRecording, type XRRecordAction } from './recording';
import { createObject, History } from '../model';
import { XRKeyframeReader } from './timeline';

test('opt-in XR recording uses a single grip, reviews without mutation, applies once, and leaves ordinary grabs intact', () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { createElement: () => ({ getContext: () => ({}) }) } });
  const controllers = [new THREE.Group(), new THREE.Group()], grips = [new THREE.Group(), new THREE.Group()];
  const reference = new EventTarget(), session = Object.assign(new EventTarget(), { visibilityState: 'visible' });
  const renderer = { xr: { getController: (i:number)=>controllers[i], getControllerGrip:(i:number)=>grips[i], getReferenceSpace:()=>reference } } as unknown as THREE.WebGLRenderer;
  const item = createObject('cube', 1); item.transform.position=[0,0,-2];
  const before=structuredClone(item), history=new History(item), reader=new XRKeyframeReader();
  const object=new THREE.Mesh(new THREE.BoxGeometry(.1,.1,.1),new THREE.MeshBasicMaterial());object.position.fromArray(item.transform.position);object.userData.entityId=item.id;
  let take:XRRecording|null=null, now=1000, ordinary=0, time=0, tracked=true;
  const actions:XRRecordAction[]=[];
  const controls=new XRControls(renderer,{
    targets:()=>[object], selected:()=>[object], editable:()=>true, select:()=>{}, pose:()=>take?.pose??item.transform, action:()=>{},
    timelineState:()=>({time,duration:3,fps:30,selection:reader.read(take?.keyframeEntity()??item,3),recording:take?.state()??{mode:'idle',canRecord:true}}),
    timelineObject:()=>object,
    recordAction:action=>{
      actions.push(action);
      if(action==='record')take=new XRRecording(item,time,3);
      else if(action==='preview')take?.togglePreview();
      else if(action==='apply'){Object.assign(item,take!.apply());history.commit(item);take=null;}
      else {take=null;time=0;object.position.fromArray(item.transform.position);}
    },
    transform:(_,pose,phase)=>{
      if(!take){ordinary++;return true;}
      if(phase==='start')take.begin(now);
      else if(phase==='change'){take.sample(pose,now);object.position.fromArray(pose.position);}
      else if(phase==='end')take.stop();
      else take.cancelGrip();
      time=take.time;return true;
    },
  });
  const scene=new THREE.Scene();scene.add(controls.rig,controls.menuRoot,controls.timelineRoot,object);
  const frame={getPose:()=>tracked?{}:null,getViewerPose:()=>null} as unknown as XRFrame;
  const fire=(type:string,index=0)=>controllers[index].dispatchEvent({type} as never);
  const click=(action:number)=>{
    scene.updateMatrixWorld(true);
    const target=[...controls.menuRoot.children,...controls.timelineRoot.children].find(node=>node.userData.xrAction===action)!;
    assert.ok(target);
    controllers[0].quaternion.setFromUnitVectors(new THREE.Vector3(0,0,-1),controls.rig.worldToLocal(target.getWorldPosition(new THREE.Vector3())).sub(controllers[0].position).normalize());
    fire('selectstart');
  };
  const mode=()=>take?.mode;
  try{
    controls.start(session as unknown as XRSession,new THREE.Vector3(0,0,-3));
    controllers.forEach((controller)=>controller.dispatchEvent({type:'connected',data:{gripSpace:{}}} as never));
    click(5);click(XR_RECORD);assert.equal(mode(),'armed');
    grips[0].position.set(0,0,-2);controls.update(frame);fire('selectstart');assert.equal(mode(),'recording');
    fire('squeezestart',1); // A second hand cannot take over the object or start navigation.
    for(let i=1;i<=30;i++){now+=1000/30;grips[0].position.x=i/30;controls.update(frame);}
    fire('selectend');assert.equal(mode(),'review');assert.deepEqual(item,before);assert.equal(ordinary,0);
    grips[0].position.set(0,0,0);controls.update(frame);
    click(XR_RECORD_PREVIEW);assert.equal(take!.previewing,true);
    click(XR_RECORD_APPLY);assert.equal(take,null);assert.ok(item.animation);
    assert.deepEqual(history.undo(),before);assert.deepEqual(history.redo(),item);
    // Explicitly discard a cancelled/armed recording, then verify the ordinary path.
    time=0;click(XR_RECORD);assert.equal(mode(),'armed');
    grips[0].position.copy(object.position);controls.update(frame);fire('squeezestart');now+=200;controls.update(frame);
    tracked=false;controls.update(frame);assert.equal(mode(),'armed');
    tracked=true;grips[0].position.set(0,0,0);controls.update(frame);click(XR_RECORD_DISCARD);assert.equal(take,null);
    grips[0].position.copy(object.position);controls.update(frame);fire('squeezestart');controls.update(frame);fire('squeezeend');assert.equal(ordinary,3);
    assert.deepEqual(actions,['record','preview','apply','record','discard']);
  }finally{
    controls.dispose();object.geometry.dispose();(object.material as THREE.Material).dispose();
    if(previous)Object.defineProperty(globalThis,'document',previous);else Reflect.deleteProperty(globalThis,'document');
  }
});
