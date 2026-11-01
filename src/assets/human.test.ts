import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {Mesh,Vector3} from 'three';
import {createAssetGroup,disposeAssetGroup,evaluateAsset,poseAssetJoints,validateAsset,type AssetDefinition} from './model.ts';
import {instantiateAsset,saveObjectAsset} from './library.ts';
import {createEmptyScene,evaluateJointAngles} from '../model.ts';
import {applyProjectOperations} from '../scene-edit/operations.ts';
import {serializeContent,validateProjectContent} from '../project/model.ts';

test('recorded clothed rig gains reachable hands without changing old poses, props, curves or cross-project reuse',()=>{
  const legacy=JSON.parse(readFileSync(new URL('./fixtures/concierge-rig.json',import.meta.url),'utf8')) as AssetDefinition;
  const saved=JSON.stringify(legacy),asset=validateAsset(legacy);
  assert.equal(evaluateAsset(asset).parts.filter(part=>part.joint).length,18);
  assert.equal(JSON.stringify(legacy),saved);assert.deepEqual(validateAsset(asset),asset);
  assert.deepEqual(asset.bounds,legacy.bounds);assert.deepEqual(asset.template,legacy.template);
  const before=createAssetGroup(legacy),after=createAssetGroup(asset);
  const meshes=(root:typeof before)=>{const values=new Map<string,number[]>();root.traverse(node=>{if(node instanceof Mesh)values.set(node.parent!.parent!.parent!.userData.partId,node.matrixWorld.toArray());});return values;};
  const at=(root:typeof before,id:string)=>{let result:Vector3|undefined;root.traverse(node=>{if(node.userData.partId===id)result=node.children[0].getWorldPosition(new Vector3());});assert.ok(result,id);return result;};
  try{
    const oldPoses:Record<string,number>[]=[{},{body:15,head_yaw:-40,head:20,'left-upperarm':-35,'right-upperarm':-55,'left-forearm':-95,'right-forearm':-80,'left-thigh':30,'right-thigh':-30,'left-shin':40,'right-shin':5}];
    for(const angles of oldPoses){
      poseAssetJoints(before,legacy,angles);poseAssetJoints(after,asset,angles);
      const oldMatrices=meshes(before),newMatrices=meshes(after);assert.equal(oldMatrices.size,newMatrices.size);
      for(const [id,matrix] of oldMatrices)assert.ok(matrix.every((value,index)=>Math.abs(value-newMatrices.get(id)![index])<1e-9),id+' moved during upgrade');
    }
    poseAssetJoints(before,legacy,{'left-upperarm':-30,'right-upperarm':-30,'left-forearm':-70,'right-forearm':-70});
    const oldSeparation=Math.abs(at(before,'left-hand').x-at(before,'right-hand').x);
    poseAssetJoints(after,asset,{'left-upperarm':-30,'right-upperarm':-30,'left-forearm':-70,'right-forearm':-70,'left-shoulder_yaw':30,'right-shoulder_yaw':-30});
    const separation=Math.abs(at(after,'left-hand').x-at(after,'right-hand').x);
    assert.ok(separation<.2&&separation<oldSeparation/2,`Hands remain apart: ${separation}m`);
    const prop=asset.parts.find(part=>part.parentId==='left-hand');assert.ok(prop,'Recorded held prop is required');
    const propBefore=at(after,prop.id);poseAssetJoints(after,asset,{'left-hand':45});
    assert.ok(at(after,prop.id).distanceTo(propBefore)>.02,'A held prop follows the wrist');
  }finally{disposeAssetGroup(before);disposeAssetGroup(after);}
  const scene=createEmptyScene();scene.objects=[instantiateAsset(asset,'performer',[2,0,3],scene.duration)];
  const project=applyProjectOperations({name:'Rig edit',scenes:[scene],assets:[asset]},[
    {type:'set_property_keys',sceneId:scene.id,id:'performer',path:'jointAngles.left-shoulder_yaw',keys:[{time:0,value:0,interpolation:'linear'},{time:2,value:30,interpolation:'linear'}]},
    {type:'set_property_keys',sceneId:scene.id,id:'performer',path:'jointAngles.left-hand',keys:[{time:0,value:0,interpolation:'linear'},{time:2,value:40,interpolation:'linear'}]},
    {type:'set_property_keys',sceneId:scene.id,id:'performer',path:'jointAngles.body_yaw',keys:[{time:0,value:70,interpolation:'linear'},{time:2.40417,value:70,interpolation:'linear'},{time:4,value:-70,interpolation:'linear'}]},
  ],0);
  const reopened=validateProjectContent(JSON.parse(serializeContent(project)));assert.deepEqual(reopened,project);
  assert.equal(evaluateJointAngles(reopened.scenes[0].objects[0],1)['left-shoulder_yaw'],15);
  const playback=createAssetGroup(asset);try{for(let frame=0;frame<=120;frame++)poseAssetJoints(playback,asset,evaluateJointAngles(reopened.scenes[0].objects[0],frame/24));}finally{disposeAssetGroup(playback);}
  const prefab=saveObjectAsset(reopened.scenes[0].objects[0],reopened.assets!,'writing-performer'),instance=instantiateAsset(prefab,'other-performer',[-3,0,4],scene.duration);
  assert.deepEqual(instance.transform.position,[-3,0,4]);assert.equal(evaluateJointAngles(instance,1)['left-hand'],20);
  assert.deepEqual(validateProjectContent(JSON.parse(serializeContent({name:'Other project',scenes:[{...scene,objects:[instance]}],assets:[prefab]}))).scenes[0].objects[0],instance);
});
