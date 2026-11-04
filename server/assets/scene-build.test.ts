import test,{beforeEach,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { validateDocument } from '../../src/model.ts';
import type { SceneOperation } from '../../src/scene-edit/operations.ts';
import { applyProjectOperations } from '../../src/scene-edit/operations.ts';
import { proposeSceneEdit } from '../scene-edit.ts';
import { newDiagnostic } from '../../src/scene-edit/diagnostics.ts';
import { AssetLibrary } from './library.ts';
import type { AIProvider } from '../ai/provider.ts';
import type { AgentProgress } from '../../src/scene-edit/progress.ts';
import {builtinAssets} from '../../src/assets/builtin.ts';
import {assetRecipeSchema} from '../../src/assets/model.ts';
import {designProviderFixture as rawDesignProviderFixture,researchFetchFixture,fixturePlan,fixtureSceneReview,fixtureImage,fixtureResearch} from '../scene-design/fixtures.ts';
const designProviderFixture=(base:AIProvider)=>rawDesignProviderFixture(base,{...fixturePlan,assetBriefs:[]});
const originalFetch=globalThis.fetch;beforeEach(()=>{globalThis.fetch=researchFetchFixture;});afterEach(()=>{globalThis.fetch=originalFetch;});

// Captured from the actual cloud Manhattan scene, including the two blocked cameras and intersecting landmarks.
const scene=validateDocument(JSON.parse(readFileSync(new URL('./fixtures/manhattan-scene.json',import.meta.url),'utf8').replace(/^\uFEFF/,'')));
const source=()=>({project:{name:'Manhattan regression',scenes:[]},sceneId:null,shotId:null,prompt:'我需要一个比较完整的曼哈顿的场景',selectedId:null,time:0,snapshots:[]});
const operations=():SceneOperation[]=>[
  {type:'add_scene',sceneId:scene.id,name:scene.name,duration:scene.duration},
  ...scene.objects.map(object=>{if(object.kind==='asset')throw new Error('The captured regression must contain only raw primitives.');return {type:'add_object' as const,sceneId:scene.id,object:{...structuredClone(object),kind:object.kind}};}),
  ...scene.cameras.map(camera=>({type:'add_camera' as const,sceneId:scene.id,camera:structuredClone(camera)})),
  ...scene.shots.map(shot=>({type:'add_shot' as const,sceneId:scene.id,shot:structuredClone(shot)})),
];
const final=(ops:SceneOperation[],scenePreviewId?:string)=>({output:[],calls:[],text:JSON.stringify({summary:'测试方案',requestedViews:[],objectCounts:[],operations:ops,...(scenePreviewId?{scenePreviewId}:{})})});
const call=(name:string,args:unknown)=>({id:crypto.randomUUID(),name,arguments:JSON.stringify(args)});
const outputs=(input:unknown[])=>input.filter((item:any)=>item.type==='function_call_output').map((item:any)=>JSON.parse(item.output));

test('camera fitting targets actual geometry and increases visible subject pixels without changing objects or applying the preview',async()=>{
  const current=structuredClone(scene),input={...source(),project:{name:'Framing workflow',scenes:[current]},sceneId:current.id,shotId:current.shots[0].id,selectedId:'empire',prompt:'Frame the existing Empire subject with the aerial camera, preserving every object and its dimensions.'},frozen=JSON.stringify(input),frames=current.shots.map(shot=>({shotId:shot.id,time:shot.start}));let turns=0,before=0,after=0;
  const aerial=current.shots.find(shot=>shot.cameraId==='cam_aerial')!,provider:AIProvider={name:'offline camera workflow',model:'test',async generateObject(){throw new Error('A framing edit does not commission a new scene design or paid geometry.');},async generateToolTurn(request){
    turns++;const results=outputs(request.input);
    if(turns===1)return {output:[],text:'',calls:[call('render_scene',{sceneId:current.id,frames,operations:[]}),call('fit_camera',{sceneId:current.id,cameraId:'cam_aerial',objectIds:['empire'],direction:[1,1,1],fov:55,margin:1.15,precedingOperations:[]})]};
    if(turns===2){const baseline=results.find(item=>item.scenePreviewId),fit=results.find(item=>item.subjectBounds);before=baseline.frames.find((frame:any)=>frame.shotId===aerial.id).visibleBoxes.empire?.pixels??0;assert.equal(fit.operation.id,'cam_aerial');assert.equal(fit.applied,false);assert.ok(fit.subjectBounds.size[1]>0);return {output:[],text:'',calls:[call('render_scene',{sceneId:current.id,frames,operations:[fit.operation]})]};}
    const receipt=results.filter(item=>item.scenePreviewId).at(-1);after=receipt.frames.find((frame:any)=>frame.shotId===aerial.id).visibleBoxes.empire?.pixels??0;return final([],receipt.scenePreviewId);
  }};
  const response=await proposeSceneEdit(input,provider,undefined,newDiagnostic(),new AssetLibrary(await mkdtemp(path.join(tmpdir(),'littletake-camera-fit-'))));assert.equal(response.status,'ready');assert.ok(after>before&&after>500,'The independently rasterized fitted frame must actually reveal more of the requested subject.');assert.equal(JSON.stringify(input),frozen);
  if(response.status==='ready'){const applied=applyProjectOperations(input.project,response.plan.operations,0);assert.deepEqual(applied.scenes[0].objects,current.objects);assert.notDeepEqual(applied.scenes[0].cameras.find(camera=>camera.id==='cam_aerial')!.transform,current.cameras.find(camera=>camera.id==='cam_aerial')!.transform);}
});

test('a rendered rejection can correct a ready prefab without bypassing canonical scope or repeatedly billing the same stale evidence',async()=>{
  const library=new AssetLibrary(await mkdtemp(path.join(tmpdir(),'littletake-visual-correction-'))),input=source(),diagnostic=newDiagnostic();let turns=0,expertCalls=0,reviews=0,saved:any;
  const role=fixturePlan.assetBriefs[0].name,base=builtinAssets[0],recipe=assetRecipeSchema.strip().parse(base);recipe.name='Corrected visible silhouette';recipe.parts[0].color='#446688';
  const provider=rawDesignProviderFixture({name:'test',model:'test',async generateObject(request){
    if(request.schemaName==='scene_visual_review')return {...fixtureSceneReview,approved:++reviews>1,grades:{identity:reviews>1?9:3,layout:9,coverage:9,composition:9},blockingDefects:reviews>1?[]:['The required identifying backrest is missing.'],notes:'Use the visible required silhouette from the original reference.'};
    expertCalls++;const context=JSON.parse((request.content[0] as {text:string}).text);assert.match(context.brief,/CANONICAL SCENE-DESIGN ROLE/);assert.match(context.brief,/PUBLIC OBSERVED DEFECTS/);assert.match(context.brief,/backrest/);assert.ok(!context.brief.includes('A smaller substitute'));assert.ok(request.content.some(part=>part.type==='text'&&part.text.startsWith('ACTUAL REJECTED SCENE RENDER:')),'The modeling expert needs actual scene evidence as well as the public defect text.');assert.ok(request.content.filter(part=>part.type==='image').length>=3);
    return request.schemaName==='proxy_asset_recipe'?recipe:{approved:true,notes:'The actual corrected silhouette meets the original requirement.',revisedRecipe:null};
  },async generateToolTurn(request){
    turns++;const results=outputs(request.input),searchId=results.find(item=>item.searchId)?.searchId,placement=results.find(item=>item.placementId),rejected=results.find(item=>item.scenePreviewId&&!item.review.approved),generated=results.find(item=>item.asset?.name===recipe.name);
    const correction={searchId,sceneId:scene.id,designAsset:role,baseAssetId:base.id,brief:'A smaller substitute should never override the canonical requirement.',reason:'Restore the observed missing identifying backrest.',afterSceneReview:rejected?.scenePreviewId};
    if(turns===1)return {output:[],text:'',calls:[call('plan_scene',{sceneId:scene.id,brief:'Build the full requested reusable asset from the original reference and inspect the actual rendered result.'}),call('search_assets',{query:'chair'}),call('read_asset',{assetId:base.id}),call('instantiate_asset',{sceneId:scene.id,designAsset:role,assetId:base.id,name:'Requested item',transform:{position:[0,0,0],rotation:[0,0,0],scale:[1,1,1]}})]};
    if(turns===2)return {output:[],text:'',calls:[call('render_scene',{sceneId:scene.id,frames:[],operations:[{type:'add_scene',sceneId:scene.id,name:'Requested set',duration:5},placement.operation]})]};
    if(turns===3){const coverage=rejected.regionCoverage[0];assert.equal(coverage.matchingInstances,1);assert.ok(coverage.boundsCoverageUpperBound>0&&coverage.boundsCoverageUpperBound<1);assert.equal(rejected.review.approved,false,'Measured bounds coverage cannot override an independent visual rejection.');return {output:[],text:'',calls:[call('generate_asset',{...correction,afterSceneReview:'unknown-receipt'})]};}
    if(turns===4){assert.equal(expertCalls,0);assert.match(results.at(-1).error,/rejected scenePreviewId/);return {output:[],text:'',calls:[call('generate_asset',correction)]};}
    if(turns===5){assert.equal(expertCalls,2);return {output:[],text:'',calls:[call('generate_asset',{...correction,baseAssetId:generated.asset.id})]};}
    if(turns===6){assert.equal(expertCalls,2);assert.match(results.at(-1).error,/actually used in the rejected candidate/);return {output:[],text:'',calls:[call('render_scene',{sceneId:scene.id,frames:[],operations:[{type:'add_scene',sceneId:scene.id,name:'Requested set',duration:5},placement.operation,{type:'set_asset',sceneId:scene.id,id:placement.objectId,assetId:generated.asset.id}]})]};}
    return final([],results.filter(item=>item.scenePreviewId).at(-1).scenePreviewId);
  }},{...fixturePlan,regions:[{name:'Full requested region',designAsset:role,min:[-6,-4],max:[6,4],usage:'repeat',description:'The measured footprint is an upper bound; reference density and identity still require visual review.'}]});
  const response=await proposeSceneEdit(input,provider,undefined,diagnostic,library,undefined,undefined,undefined,undefined,{save:async design=>{saved=structuredClone(design);return {};}});
  assert.equal(response.status,'ready');assert.equal(reviews,2);assert.equal(expertCalls,2);assert.equal(turns,7);assert.equal(saved.assetFits.find((fit:any)=>fit.asset.id===base.id).approved,false);assert.ok(saved.assetFits.some((fit:any)=>fit.asset.name===recipe.name&&fit.approved));
  if(response.status==='ready'){const candidate=applyProjectOperations(input.project,response.plan.operations,0);assert.equal(candidate.scenes[0].objects.length,1);assert.equal(candidate.assets!.find(asset=>asset.id===candidate.scenes[0].objects[0].asset!.id)!.name,recipe.name);}assert.equal(input.project.scenes.length,0);
});

test('the actual uninspected Manhattan proposal is rejected and retained without changing the project', async()=>{
  const input=source(),before=JSON.stringify(input),diagnostic=newDiagnostic();let calls=0;
  await assert.rejects(proposeSceneEdit(input,{name:'recorded',model:'test',async generateObject(){throw new Error('Unexpected paid call.');},async generateToolTurn(){calls++;return final(operations());}},undefined,diagnostic,new AssetLibrary(await mkdtemp(path.join(tmpdir(),'littletake-build-')))),/plan_scene first/);
  assert.equal(calls,2);assert.equal(diagnostic.outcome,'failed');assert.equal(diagnostic.attempts[0].rawProposal&&JSON.stringify(diagnostic.attempts[0].rawProposal).includes('Empire State'),true);assert.equal(JSON.stringify(input),before);
});

test('new-set workflow sees real overview and shot pixels, fixes rejected framing and geometry, and finalizes only the exact inspected candidate',async()=>{
  const input=source(),frozen=JSON.stringify(input),diagnostic=newDiagnostic(),progress:AgentProgress[]=[],original=operations(),corrected=operations();let turns=0,reviews=0;
  const forwardDeclarations=(plan:SceneOperation[])=>[...plan.filter(operation=>operation.type==='add_camera'),...plan.filter(operation=>operation.type!=='add_camera')];
  const chrysler=corrected.find(op=>op.type==='add_object'&&op.object.id==='chrysler');if(chrysler?.type==='add_object')chrysler.object.transform.position[0]=-5;
  const aerial=corrected.find(op=>op.type==='add_camera'&&op.camera.id==='cam_aerial');if(aerial?.type==='add_camera')aerial.camera.transform.position=[45,55,60];
  const frames=scene.shots.map(shot=>({shotId:shot.id,time:shot.start}));
  const provider:AIProvider={name:'offline reviewer',model:'test',async generateObject(request){
    reviews++;assert.equal(request.schemaName,'scene_visual_review');assert.equal(request.format,'json_schema');const context=JSON.parse((request.content[0] as {text:string}).text),images=request.content.filter(part=>part.type==='image');assert.equal(images.length,6,'Each actual shot/overview frame must retain its own pixels, followed by the original photo and concept.');for(const image of images.slice(0,4)){const bytes=Buffer.from(image.dataUrl.split(',')[1],'base64');assert.equal(bytes.readUInt32BE(16),640);assert.equal(bytes.readUInt32BE(20),360);}assert.equal(context.originalUserRequest,input.prompt);assert.ok(context.design.research[0].sources.length);
    assert.equal(context.frames.length,4,'Both actual shots and automatic overview/top views must reach the reviewer.');assert.ok(context.measurements.objects.length===30);assert.equal(context.design.displayScale,fixturePlan.displayScale);assert.ok(context.measurements.objects.every((object:any)=>object.name===undefined&&object.realEquivalentSize[1]===object.bounds.size[1]/context.design.displayScale),'The independent reviewer needs the actual unit mapping without being biased by asset labels.');
    assert.equal(context.design.regions,undefined,'The builder layout hypothesis must not bias the reference reviewer.');assert.equal(context.measurements.overlaps,undefined,'Broad-phase terrain/containment pairs are not visual evidence.');
    const a=context.measurements.objects.find((object:any)=>object.id==='empire').bounds,b=context.measurements.objects.find((object:any)=>object.id==='chrysler').bounds;
    const overlap=a.min.every((value:number,index:number)=>value<b.max[index]&&a.max[index]>b.min[index]);
    assert.equal(overlap,reviews===1);assert.equal(context.frames[0].camera.position[1],reviews===1?9:55);
    return {...fixtureSceneReview,approved:reviews===2,referenceLayoutMatched:reviews===2,notes:reviews===1?'空中机位低于楼顶，地标互相穿插。抬高机位并分开两栋建筑。':'The deterministic repair reached the independent reviewer.'};
  },async generateToolTurn(request){turns++;const results=outputs(request.input);
    if(turns===1)return {output:[],calls:[call('plan_scene',{sceneId:scene.id,brief:'构建曼哈顿片场，统一米制比例，明确街区、公园、河道和可辨认地标；从空中与街道检查构图。'}),call('search_assets',{query:'Manhattan buildings city block taxi'})],text:''};
    if(turns===2)return {output:[],calls:[call('render_scene',{sceneId:scene.id,frames,operations:[{type:'set_asset',sceneId:scene.id,id:'object-1'}]}),call('render_scene',{sceneId:scene.id,frames,operations:forwardDeclarations(original)})],text:''};
    if(turns===3){assert.equal(results.find(item=>item.review)?.review.approved,false);return final([],results.find(item=>item.scenePreviewId).scenePreviewId);}
    if(turns===4){assert.ok(JSON.stringify(request.input.at(-1)).includes('completionRejected'));assert.ok(JSON.stringify(request.input.at(-1)).includes('空中机位'));return {output:[],calls:[call('render_scene',{sceneId:scene.id,frames,operations:forwardDeclarations(corrected)})],text:''};}
    const receipts=results.filter(item=>item.scenePreviewId);assert.deepEqual(receipts.map(item=>item.scenePreviewId),['scene-preview-1','scene-preview-2']);
    if(turns===5)return final([],'scene-preview-typo');
    return final([],receipts.at(-1).scenePreviewId);
  }};
  const response=await proposeSceneEdit(input,designProviderFixture(provider),undefined,diagnostic,new AssetLibrary(await mkdtemp(path.join(tmpdir(),'littletake-reviewed-'))),undefined,undefined,undefined,event=>progress.push(event));
  assert.equal(response.status,'ready');if(response.status!=='ready')throw new Error();assert.deepEqual(response.plan.operations,[corrected[0],...forwardDeclarations(corrected).filter(operation=>operation.type!=='add_scene')]);assert.equal(reviews,2);assert.equal(turns,6);assert.equal(JSON.stringify(input),frozen);
  const applied=applyProjectOperations(input.project,response.plan.operations,0);assert.equal(applied.scenes[0].cameras[0].transform.position[1],55);assert.ok(progress.some(event=>event.status==='error'&&event.message.includes('Scene needs revision:')));assert.ok(progress.some(event=>event.message==='Scene visual review passed.'));
  assert.equal(diagnostic.toolCalls?.filter(item=>item.name==='render_scene').length,3);const malformed=diagnostic.toolCalls!.find(item=>item.error)!;assert.match(malformed.error!,/assetId/);assert.ok(malformed.error!.length<1000,'A missing field should report the selected operation type, not thousands of errors from unrelated union branches.');
  assert.equal(diagnostic.sceneReviews?.length,2);assert.equal((diagnostic.sceneReviews![0].rawProposal as any).approved,false);assert.equal(diagnostic.sceneReviews![0].request.schemaName,'scene_visual_review');
});

test('a rejected visual receipt cannot be presented as a finished new scene',async()=>{
  const input=source(),diagnostic=newDiagnostic();let turns=0,reviews=0;
  await assert.rejects(proposeSceneEdit(input,designProviderFixture({name:'test',model:'test',async generateObject(){reviews++;return {...fixtureSceneReview,grades:{identity:9,layout:9,coverage:4,composition:9},blockingDefects:['The required reference density is missing.'],notes:'Names are present but the actual geometry is a generic city, not the requested place.'};},async generateToolTurn(request){turns++;const results=outputs(request.input);
    if(turns===1)return {output:[],calls:[call('plan_scene',{sceneId:scene.id,brief:'Manhattan at one consistent scale with recognizable blocks, park, rivers and unobstructed skyline framing.'}),call('search_assets',{query:'city'})],text:''};
    if(turns===2)return {output:[],calls:[call('render_scene',{sceneId:scene.id,frames:scene.shots.map(shot=>({shotId:shot.id,time:shot.start})),operations:operations()})],text:''};
    if(turns===3){const renamed=operations();for(const operation of renamed)if(operation.type==='add_object')operation.object.name='Different label '+operation.object.id;return {output:[],calls:[call('render_scene',{sceneId:scene.id,frames:scene.shots.map(shot=>({shotId:shot.id,time:shot.start})),operations:renamed})],text:''};}
    if(turns===4)assert.match(results.at(-1).error,/not new visual evidence/);
    return final([],results.find(item=>item.scenePreviewId).scenePreviewId);
  }}),undefined,diagnostic,new AssetLibrary(await mkdtemp(path.join(tmpdir(),'littletake-reject-review-')))),/has not passed its independent visual review/);
  assert.equal(reviews,1,'Validation feedback cannot cause an implicit paid re-review.');assert.equal(input.project.scenes.length,0);assert.equal(diagnostic.outcome,'failed');
  const existing={...source(),project:{name:'Existing placeholder set',scenes:[structuredClone(scene)]},sceneId:scene.id},before=JSON.stringify(existing);let existingTurns=0,existingReviews=0;
  const saved={id:crypto.randomUUID(),sceneId:scene.id,originalRequest:existing.prompt,status:'ready' as const,plan:{...fixturePlan,assetBriefs:[]},concept:{id:crypto.randomUUID(),image:fixtureImage,model:'fixture',prompt:existing.prompt},research:[{id:'reference-1',query:'city',findings:fixtureResearch.findings,sources:[],images:[{image:fixtureImage,title:'Original',url:'https://example.org/photo.png',page:'https://example.org/photo',credit:'Photographer'}],evidence:{request:{}}}],attempts:[]};
  await assert.rejects(proposeSceneEdit(existing,designProviderFixture({name:'test',model:'test',async generateObject(){existingReviews++;return {...fixtureSceneReview,approved:false,scopePreserved:false,identityVisible:false,referenceLayoutMatched:false,notes:'The existing placeholders still lack the originally requested identity.'};},async generateToolTurn(request){existingTurns++;const results=outputs(request.input);if(existingTurns===1){assert.ok(JSON.stringify(request.input).includes('savedSceneDesign'),'The application must restore the saved task before the first model turn even when the director skips plan_scene.');return {output:[],calls:[call('search_assets',{query:'city'})],text:''};}if(existingTurns===2)return {output:[],calls:[call('render_scene',{sceneId:scene.id,frames:scene.shots.map(shot=>({shotId:shot.id,time:shot.start})),operations:[]})],text:''};return final([],results.find(item=>item.scenePreviewId).scenePreviewId);}}),undefined,newDiagnostic(),new AssetLibrary(await mkdtemp(path.join(tmpdir(),'littletake-existing-review-'))),undefined,undefined,undefined,undefined,{load:async()=>structuredClone(saved),save:async()=>({})}),/has not passed its independent visual review/);assert.equal(existingReviews,1);assert.equal(JSON.stringify(existing),before,'A saved existing-scene task cannot bypass its rejected review by skipping plan_scene or returning a no-op.');
});
