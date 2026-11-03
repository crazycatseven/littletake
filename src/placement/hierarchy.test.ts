import assert from 'node:assert/strict';
import test from 'node:test';
import { Matrix4 } from 'three';
import { createDocument, createObject, evaluateTransform, History, validateDocument } from '../model.ts';
import { createProject, parseProject, serializeProject } from '../project/storage.ts';
import { projectContent } from '../project/model.ts';
import { applyProjectOperations } from '../scene-edit/operations.ts';
import { builtinAssets, instantiateAsset } from '../assets/library.ts';
import { inspectSpatial } from '../spatial/methods.ts';
import { sceneWorldMatrices, transformMatrix, hierarchyRoots, sceneEntities, effectivelyHidden } from './hierarchy.ts';
import { duplicateHierarchy, reparentScene } from './transforms.ts';
import { editAsset, assetDraft } from '../assets/edit.ts';
import { evaluateAsset, recipeBounds } from '../assets/model.ts';
import { worldMatrices } from '../assets/toolkit/transforms.ts';
import { trolleyDraft } from '../assets/toolkit/fixtures/trolley.ts';

function near(a: Matrix4, b: Matrix4) { a.elements.forEach((v,i)=>assert.ok(Math.abs(v-b.elements[i])<1e-5,`${i}: ${v} != ${b.elements[i]}`)); }

test('scene parenting retains world poses, independent animation, cameras and prefab links through nested transforms, detach, duplication, undo and saved projects', () => {
  const original=createDocument(),parent=createObject('cube',4);parent.name='Parent prop';parent.transform={position:[3,.5,-2],rotation:[0,25,0],scale:[1.2,1.2,1.2]};original.objects.push(parent);
  const asset=builtinAssets[0],instance=instantiateAsset(asset,'asset-instance',[0,0,3],original.duration);original.objects.push(instance);
  const project=createProject(original);project.assets=[asset];const history=new History(project);
  let scene=reparentScene(original,['object-1','asset-instance'],parent.id,1);
  for(let at=0;at<=5;at+=.125){const world=sceneWorldMatrices(scene,at);for(const id of ['object-1','asset-instance'])near(world.get(id)!,transformMatrix(evaluateTransform(original.objects.find(p=>p.id===id)!,at)));}
  assert.equal(scene.objects.find(p=>p.id===instance.id)!.asset!.id,asset.id);
  assert.equal(scene.objects[0].track!.start,original.objects[0].track!.start);
  assert.equal(scene.objects[0].track!.duration,original.objects[0].track!.duration);
  // Cameras keep their shot references while following the same parent transform.
  const cameraBefore=sceneWorldMatrices(scene,1).get('camera')!.clone();scene=reparentScene(scene,['camera'],parent.id,1);near(sceneWorldMatrices(scene,1).get('camera')!,cameraBefore);
  assert.equal(scene.shots[0].cameraId,'camera');
  const placed=sceneWorldMatrices(scene,2),oldParent=placed.get(parent.id)!.clone();
  scene.objects.find(p=>p.id===parent.id)!.transform.position[0]+=4;
  scene.objects.find(p=>p.id===parent.id)!.transform.rotation[1]+=30;
  scene.objects.find(p=>p.id===parent.id)!.transform.scale=[2,2,2];
  const moved=sceneWorldMatrices(scene,2),delta=moved.get(parent.id)!.clone().multiply(oldParent.invert());
  for(const id of ['object-1','asset-instance','camera'])near(moved.get(id)!,delta.clone().multiply(placed.get(id)!));
  assert.deepEqual(hierarchyRoots(sceneEntities(scene),[parent.id,'object-1','camera']),[parent.id]);
  scene.objects.find(p=>p.id===parent.id)!.hidden=true;assert.equal(effectivelyHidden(scene,'object-1'),true);delete scene.objects.find(p=>p.id===parent.id)!.hidden;
  const content={...project,scenes:[scene]},measured=inspectSpatial(content,{sceneId:scene.id,time:2,objectIds:[instance.id],frame:{kind:'world'}});
  assert.ok(measured.objects[0].bounds.size.every(v=>v>0));
  const encoded=serializeProject(content),restored=parseProject(encoded);assert.equal(restored.scenes[0].cameras[0].parentId,parent.id);near(sceneWorldMatrices(restored.scenes[0],2).get(instance.id)!,moved.get(instance.id)!);
  history.commit(restored);assert.equal(history.undo()!.scenes[0].objects[0].parentId,undefined);assert.equal(history.redo()!.scenes[0].objects[0].parentId,parent.id);
  const snapshot=JSON.stringify(scene);assert.throws(()=>reparentScene(scene,[parent.id],'object-1',2),/descendants/);assert.equal(JSON.stringify(scene),snapshot);
  const copies=duplicateHierarchy(scene,[parent.id,'object-1'],2);assert.equal(copies.ids.length,1);
  const copyParent=copies.ids[0],copyActor=copies.scene.objects.find(p=>p.parentId===copyParent&&p.kind==='human')!,copyInstance=copies.scene.objects.find(p=>p.parentId===copyParent&&p.kind==='asset')!;
  assert.ok(copyActor.track);assert.equal(copyInstance.asset!.id,asset.id);assert.equal(copies.scene.cameras.find(p=>p.id!=='camera')!.parentId,copyParent);validateDocument(copies.scene);
  const detached=reparentScene(scene,['object-1'],null,2);near(sceneWorldMatrices(detached,2).get('object-1')!,moved.get('object-1')!);assert.equal(detached.objects[0].parentId,undefined);
  const viaAgent=applyProjectOperations(projectContent(content),[{type:'set_parent',sceneId:scene.id,id:instance.id,parentId:'object-1'}],2);near(sceneWorldMatrices(viaAgent.scenes[0],2).get(instance.id)!,moved.get(instance.id)!);
  const removed=applyProjectOperations(projectContent(content),[{type:'remove_object',sceneId:scene.id,id:parent.id}],2);assert.equal(removed.scenes[0].cameras.length,0);assert.equal(removed.scenes[0].shots.length,0);assert.equal(removed.scenes[0].objects.some(p=>p.id===instance.id),false);
  // A non-uniform parent is safe for translation-only channels, never silently for rotating motion.
  const scaleParent=structuredClone(parent);scaleParent.transform={position:[3,0,0],rotation:[0,0,0],scale:[2,3,4]};const keyed=createObject('sphere',5);keyed.animation={takes:[],curves:{'position.x':[{time:0,value:0,interpolation:'smooth'},{time:5,value:2,interpolation:'smooth'}]}};
  const scaled={...original,objects:[scaleParent,keyed]},keyedChild=reparentScene(scaled,[keyed.id],scaleParent.id,0);
  for(let at=0;at<=5;at+=.25)near(sceneWorldMatrices(keyedChild,at).get(keyed.id)!,transformMatrix(evaluateTransform(keyed,at)));
  const unsafe={...original,objects:[scaleParent,original.objects[0]]};assert.throws(()=>reparentScene(unsafe,['object-1'],scaleParent.id,.5),/distort|skew|uniform/);
  assert.throws(()=>validateDocument({...scene,objects:scene.objects.map(p=>p.id===parent.id?{...p,parentId:'object-1'}:p)}),/descendants/);
});

test('prefab source-part reparenting retains geometry, local origin, child frames and saved construction; generated copies and cycles cannot damage the draft', () => {
  const draft=trolleyDraft();
  draft.parts.push({id:'sign-parent',name:'Sign holder',kind:'cube',parentId:null,position:[.3,1.5,.2],rotation:[0,30,0],size:[.2,.2,.2],color:'#999999',joint:null},
    {id:'sign',name:'Sign',kind:'cube',parentId:null,position:[0,1.3,0],rotation:[0,0,0],size:[.3,.1,.02],color:'#ffffff',joint:null},
    {id:'badge',name:'Badge',kind:'sphere',parentId:'sign',position:[0,.03,0],rotation:[0,0,0],size:[.01,.01,.01],color:'#ffeeaa',joint:null});
  const worlds=(value:typeof draft)=>worldMatrices(evaluateAsset(value).parts),before=worlds(draft),bounds=recipeBounds(draft);
  const parented=editAsset(draft,[{type:'reparent_part',id:'sign',parentId:'sign-parent'}]);
  for(const id of ['sign','badge'])near(worlds(parented).get(id)!,before.get(id)!);
  recipeBounds(parented).size.forEach((v,i)=>assert.ok(Math.abs(v-bounds.size[i])<1e-6));assert.equal(parented.parts.find(p=>p.id==='sign')!.parentId,'sign-parent');
  const moved=editAsset(parented,[{type:'set_part',id:'sign-parent',changes:{position:[.8,1.5,.2]}}]);
  near(worlds(moved).get('badge')!,new Matrix4().makeTranslation(.5,0,0).multiply(before.get('badge')!));
  const detached=editAsset(moved,[{type:'reparent_part',id:'sign',parentId:null}]);near(worlds(detached).get('sign')!,worlds(moved).get('sign')!);
  const reopened=assetDraft(JSON.parse(JSON.stringify(parented)));near(worlds(reopened).get('badge')!,before.get('badge')!);
  const raw=JSON.stringify(parented);assert.throws(()=>editAsset(parented,[{type:'reparent_part',id:'sign-parent',parentId:'badge'}]),/descendants/);assert.equal(JSON.stringify(parented),raw);
  const copy=evaluateAsset(parented).parts.find(p=>p.generatedBy.length)!;assert.throws(()=>editAsset(parented,[{type:'reparent_part',id:copy.id,parentId:null}]),/Generated copies/);
  assert.throws(()=>editAsset(parented,[{type:'reparent_part',id:'post_LF',parentId:'sign-parent'}]),/bindings/);
});
