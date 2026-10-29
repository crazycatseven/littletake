import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { Box3, Matrix4, Vector3 } from 'three';
import { trolleyDraft } from './fixtures/trolley.ts';
import { createAsset, createAssetGroup, disposeAssetGroup, evaluateAsset, measureAsset, poseAssetJoints, validateAsset, type AssetRecipe } from '../model.ts';
import { draftFromAsset, editAsset, reviseAsset, AssetDraftStore, updateAssetInstances } from '../edit.ts';
import { emptyConstruction } from './schema.ts';
import { AssetLibrary } from '../../../server/assets/library.ts';
import { renderAssetPreview } from '../../../server/assets/preview.ts';
import { createEmptyScene, createObject } from '../../model.ts';
import { createProject, serializeProject, parseProject } from '../../project/storage.ts';
import { expression } from './expression.ts';

const near=(a:number,b:number)=>assert.ok(Math.abs(a-b)<1e-6,`${a} != ${b}`);
const boundsFor=(recipe:AssetRecipe,sourceId:string)=>{
  const root=createAssetGroup(recipe), boxes:Box3[]=[];
  root.traverse(n=>{if(n.userData.sourceId===sourceId)boxes.push(new Box3().setFromObject(n,true));});disposeAssetGroup(root);return boxes;
};
test('real cart construction survives successive dimension edits, detached copies, immutable save, library reuse and project reload',async()=>{
  const draft=trolleyDraft(),initial=JSON.stringify(draft),base=createAsset(draft,'parametric-cart');
  near(base.bounds.size[0],1.12);near(base.bounds.size[1],2);near(base.bounds.size[2],.65);
  assert.equal(measureAsset(base).partCount,16);assert.equal(base.parts.length,7);
  let edited=draftFromAsset(base);const originalIds=evaluateAsset(edited).parts.map(p=>p.id);
  for(const [id,value] of [['width',1.5],['postHeight',2.1],['wheelRadius',.09],['depth',.9]] as const){
    edited=editAsset(edited,[{type:'set_parameter',id,value}]);
    assert.deepEqual(evaluateAsset(edited).parts.map(p=>p.id),originalIds);
    const wheels=boundsFor(edited,'wheel_FL'),posts=boundsFor(edited,'post_LF'),platform=boundsFor(edited,'base_platform')[0],casters=boundsFor(edited,'caster_FL');
    assert.equal(wheels.length,4);assert.equal(posts.length,4);
    wheels.forEach(b=>near(b.min.y,0));posts.forEach(b=>near(b.min.y,platform.max.y));casters.forEach(b=>near(b.max.y,platform.min.y));
    const joints=measureAsset(edited).joints;assert.equal(joints.length,4);
    for(const joint of joints){const axis=new Vector3(...joint.axisInAssetSpace),cylinder=new Vector3(...joint.cylinderAxisInAssetSpace!);near(Math.abs(axis.dot(cylinder)),1);}
    const angles=Object.fromEntries(joints.map((j,i)=>[j.partId,[90,30,-90,180][i]]));
    const posed=measureAsset(edited,angles);posed.bounds.min.forEach((v,i)=>near(v,measureAsset(edited).bounds.min[i]));
  }
  assert.equal(JSON.stringify(draft),initial);near(measureAsset(edited).bounds.size[0],1.5);
  const copy=evaluateAsset(edited).parts.find(p=>p.sourceId==='wheel_module'&&p.generatedBy.length)!,before=measureAsset(edited);
  const unique=editAsset(edited,[{type:'make_unique',partId:copy.id}]);assert.equal(measureAsset(unique).partCount,16);
  before.bounds.size.forEach((v,i)=>near(v,measureAsset(unique).bounds.size[i]));assert.ok(!evaluateAsset(unique).parts.some(p=>p.id===copy.id));
  const expanded=editAsset(unique,[{type:'bake_construction'}]);assert.equal(expanded.construction,undefined);assert.equal(measureAsset(expanded).partCount,16);
  before.bounds.size.forEach((v,i)=>near(v,measureAsset(expanded).bounds.size[i]));
  const library=new AssetLibrary(await mkdtemp(tmpdir()+'/littletake-toolkit-'));await library.register(base);const next=await library.revise(base,edited);assert.equal(next.version,2);assert.deepEqual(validateAsset(JSON.parse(JSON.stringify(next))),next);
  assert.ok((await library.search('hotel')).candidates.some(a=>a.id===base.id));
  const scene=createEmptyScene(),a={...createObject('cube',1),kind:'asset' as const,asset:{id:base.id,version:1}},b=structuredClone(a);b.id='other';b.transform.position=[4,0,0];scene.objects=[a,b];
  const project=createProject(scene);project.assets=[base];const updated=updateAssetInstances(project,base,next,'selected',{sceneId:scene.id,objectId:a.id});
  const reloaded=parseProject(serializeProject({...project,...updated.project}));assert.deepEqual(reloaded.scenes[0].objects[1],b);assert.deepEqual(reloaded.assets?.[1].construction,edited.construction);
  const memory=new Map<string,string>(),storage={getItem:(k:string)=>memory.get(k)??null,setItem:(k:string,v:string)=>{memory.set(k,v);},removeItem:(k:string)=>{memory.delete(k);}};
  const store=new AssetDraftStore(storage,base);store.save({base,draft:edited,messages:[{role:'user',text:'宽度和轮径调整后继续编辑'}]});assert.deepEqual(new AssetDraftStore(storage,base).read()!.draft,edited);
  assert.ok(renderAssetPreview(next).length>1000);
});

test('ordered array/mirror groups retain true reflected poses, independent joints and atomic dependency failures',()=>{
  let draft=trolleyDraft();const c=emptyConstruction();
  const wheel=draft.parts.find(p=>p.id==='wheel_FL')!;wheel.parentId='module';wheel.position=[.2,.3,.1];wheel.rotation=[0,0,90];
  draft.parts=[{...draft.parts[1],id:'module',position:[1,0,.2],rotation:[0,30,0]},wheel,{...draft.parts[4],id:'arm',parentId:wheel.id,kind:'cone',position:[.1,.3,.1],size:[.1,.4,.1]}];
  c.modifiers=[{id:'repeat',type:'array',targetId:'module',enabled:true,count:3,offset:[.7,0,0]},{id:'reflection',type:'mirror',targetId:'module',enabled:true,axes:['x'],referenceId:null}];draft.construction=c;
  const frame={...draft.parts[0],id:'frame',position:[-.3,.2,.4] as [number,number,number],rotation:[0,25,15] as [number,number,number]};draft.parts.push(frame);(c.modifiers[1] as Extract<typeof c.modifiers[number],{type:'mirror'}>).referenceId='frame';
  const result=evaluateAsset(draft);assert.equal(result.parts.length,19);assert.equal(measureAsset(draft).joints.length,6);
  const root=createAssetGroup(draft);const sourceId='wheel_FL',reflectedId='wheel_FL~reflection.x';
  poseAssetJoints(root,draft,{[sourceId]:43,[reflectedId]:43});root.updateMatrixWorld(true);
  const nodes=new Map<string,typeof root>();root.traverse(n=>{if(n.userData.partId)nodes.set(n.userData.partId,n as typeof root);});
  const point=new Vector3(.03,.05,.02),sourceMesh=nodes.get('arm')!.children[0].children[0].children[0],copyMesh=nodes.get('arm~reflection.x')!.children[0].children[0].children[0];
  const frameWorld=nodes.get('frame')!.matrixWorld,mirrorMatrix=frameWorld.clone().multiply(new Matrix4().makeScale(-1,1,1)).multiply(frameWorld.clone().invert());
  const expected=point.clone().applyMatrix4(sourceMesh.matrixWorld).applyMatrix4(mirrorMatrix);const actual=point.clone().applyMatrix4(copyMesh.matrixWorld);near(actual.distanceTo(expected),0);
  poseAssetJoints(root,draft,{[reflectedId]:-20});assert.ok(point.clone().applyMatrix4(copyMesh.matrixWorld).distanceTo(expected)>.01);disposeAssetGroup(root);
  const reordered=structuredClone(draft);reordered.construction!.modifiers.reverse();assert.notDeepEqual(evaluateAsset(reordered).parts.map(p=>p.id),result.parts.map(p=>p.id));
  const grouped=editAsset(draft,[{type:'group_parts',id:'whole',name:'全部组件',partIds:['module']}]);near(measureAsset(grouped).bounds.size[0],measureAsset(draft).bounds.size[0]);
  const serialized=JSON.stringify(draft),cyclic=structuredClone(c);cyclic.bindings=[{partId:'module',property:'position.x',expression:'parts.wheel_FL.position.x'},{partId:'wheel_FL',property:'position.x',expression:'parts.module.position.x'}];
  assert.throws(()=>editAsset(draft,[{type:'set_construction',construction:cyclic}]),/cycle/);
  cyclic.bindings=[];cyclic.anchors=[{id:'self',name:'cycle',partId:'module',position:[0,0,0]}];cyclic.constraints=[{id:'self_attach',type:'attach',targetId:'module',anchorId:'self',offset:[0,0,0]}];assert.throws(()=>editAsset(draft,[{type:'set_construction',construction:cyclic}]),/cycle/);
  const tooLarge=structuredClone(c);tooLarge.modifiers=[{...c.modifiers[0],type:'array',count:128,offset:[.1,0,0]},{...c.modifiers[0],id:'second',type:'array',count:128,offset:[0,0,.1]}];assert.throws(()=>editAsset(draft,[{type:'set_construction',construction:tooLarge}]),/budget/);
  for(const invalid of ['globalThis.x','1 / 0','1; process.exit()','constructor.constructor','(1 + 2'])assert.throws(()=>expression(invalid,()=>{throw new Error('Unknown reference');}));
  assert.equal(expression('2 + {parts.part-id.size.x} * 3',name=>{assert.equal(name,'parts.part-id.size.x');return 4;}),14);
  assert.equal(JSON.stringify(draft),serialized);
});
