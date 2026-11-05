import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {MetaProvider} from '../ai/meta.ts';
import {AIError,type AIProvider} from '../ai/provider.ts';
import {AssetLibrary} from '../assets/library.ts';
import {generateAsset} from '../assets/expert.ts';
import {SceneDesigner,type SceneDesign} from './design.ts';
import {researchScene,referencePhotos,factualReferences} from './research.ts';
import {fixturePNG,fixtureImage,fixturePlan,fixtureResearch,fixtureReferenceSelection,fixtureReview,envelope,researchEnvelope,researchFetchFixture} from './fixtures.ts';
import {ProjectRoomStore} from '../projects/store.ts';
import {createProject} from '../../src/project/storage.ts';
import {projectArchive,readProjectArchive} from '../../src/project/archive.ts';
import type {AgentProgress} from '../../src/scene-edit/progress.ts';
import {createAsset} from '../../src/assets/model.ts';
import {startApplication} from '../app/service.ts';
import {readSceneEditResponse} from '../../src/scene-edit/progress.ts';
import {projectContent} from '../../src/project/model.ts';

test('grounded research, original pixels, concept correction and independent scope review persist across restart and project transfer',async()=>{
  const directory=await mkdtemp(path.join(tmpdir(),'littletake-design-'));let store=new ProjectRoomStore(directory);const lease=crypto.randomUUID(),room=store.create(crypto.randomUUID(),lease,createProject(null));
  const original='Build the complete river city with its defining island layout and skyline, not a generic district.',progress:AgentProgress[]=[],records:unknown[]=[];let calls=0,reviews=0,images=0;
  const provider=new MetaProvider({apiKey:'private-test-key',model:'test'},(async(_url,init)=>{
    if(++calls>9)throw new Error('Unexpected model loop in design verification.');
    const body=JSON.parse(String(init?.body));assert.equal(body.store,false);
    if(body.tools?.[0]?.type==='web_search'){assert.deepEqual(body.include,['web_search_call.results']);assert.ok(body.input[0].content[0].text.includes(original));return Response.json(researchEnvelope());}
    if(body.instructions?.startsWith('Select ORIGINAL visual references'))return Response.json(envelope(fixtureReferenceSelection));
    if(body.model==='muse-image-1.0'){images++;assert.ok(!body.reasoning);assert.equal(body.tools[0].enable_image_search,true);assert.ok(body.input[0].content.some((item:any)=>item.type==='input_image'));return Response.json({status:'completed',output:[{type:'image_generation_call',result:Buffer.from(fixturePNG).toString('base64')}]});}
    if(body.instructions.startsWith("You are LittleTake's scene designer."))return Response.json(envelope(fixturePlan));
    reviews++;return Response.json(envelope({...fixtureReview,scopePreserved:reviews>1,notes:reviews===1?'The first concept reduces the original coverage to a tiny district. Restore the full represented extent.':fixtureReview.notes}));
  }) as typeof fetch);
  const save=async(design:SceneDesign)=>{
    if(design.concept)store.saveOutput(room.code,lease,{id:design.concept.id,kind:'scene-design',sceneId:design.sceneId,shotId:'',name:'Concept',mime:'image/png'},Buffer.from(design.concept.image.split(',')[1],'base64'));
    store.saveOutput(room.code,lease,{id:design.id,kind:'scene-design',sceneId:design.sceneId,shotId:'',name:'Design evidence',mime:'application/json'},Buffer.from(JSON.stringify(design)),undefined,store.get(room.code).outputs.find(output=>output.id===design.id)?.updatedAt??0);
    return {imageOutputId:design.concept?.id};
  };
  const designer=new SceneDesigner(provider,original,event=>progress.push(event),save,records,researchFetchFixture),design=await designer.plan('river-city','Just use three generic blocks to make the task smaller.');
  assert.equal(design.status,'ready');assert.equal(design.originalRequest,original);assert.equal(design.research[0].findings,fixtureResearch.findings);assert.equal(design.research[0].images[0].credit,'Reference photographer · CC BY');assert.equal(images,2);assert.equal(reviews,2);assert.equal(calls,8);
  assert.ok(progress.some(event=>event.status==='error'));assert.ok(progress.some(event=>event.sources?.[0].url==='https://example.org/original-layout'));
  const attachments=progress.flatMap(event=>event.imageOutputId?[event.imageOutputId]:[]);assert.equal(new Set(attachments).size,2,'A corrected concept must not overwrite the earlier image referenced by history.');
  assert.equal(await designer.plan('river-city','Shrink it again.'),design);assert.equal(calls,8,'An accepted design is reused without new paid image requests.');assert.ok(!JSON.stringify(records).includes('private-test-key'));
  const project=store.get(room.code,lease).project;project.conversations.threads[0].messages.push({id:crypto.randomUUID(),role:'user',text:original,status:'answered',progress});store.save(room.code,lease,1,project);store.close();
  const reopened=store=new ProjectRoomStore(directory);assert.equal(reopened.get(room.code).outputs.length,3);for(const id of attachments)assert.deepEqual(Buffer.from(reopened.readOutput(room.code,id).data),Buffer.from(fixturePNG));
  const savedProgress=structuredClone(progress),resumed=new SceneDesigner({name:'test',model:'test',async generateObject(){throw new Error('A ready saved concept must not trigger another paid request.');}},original,event=>progress.push(event),save,[],researchFetchFixture,async()=>JSON.parse(Buffer.from(reopened.readOutput(room.code,design.id).data).toString('utf8')));
  assert.equal((await resumed.plan('river-city','Shrink the requested scene.')).concept?.id,design.concept!.id);assert.equal(calls,8);assert.ok(progress.at(-1)?.message.includes('Reusing'));
  const bundle=reopened.bundle(room.id),portable=await readProjectArchive(projectArchive(bundle));
  const other=new ProjectRoomStore(await mkdtemp(path.join(tmpdir(),'littletake-design-copy-'))),copy=other.create(crypto.randomUUID(),crypto.randomUUID(),portable.project,undefined,portable.outputs);
  assert.equal(copy.outputs.length,3);assert.deepEqual((copy.project.conversations.threads[0].messages[0] as any).progress,savedProgress);assert.equal(copy.project.scenes.length,0,'Planning and concepts cannot silently create or substitute a set.');other.close();reopened.close();
  // A failed build never applied its tentative scene ID. Retrying may choose a new ID;
  // the actual HTTP/application path must still reuse that accepted design, without a paid redo.
  const network=globalThis.fetch;let resumedCalls=0;
  globalThis.fetch=(async(url,options)=>{if(String(url)!=='https://api.meta.ai/v1/responses')return network(url,options);const body=JSON.parse(String(options?.body));assert.ok(body.tools.every((tool:any)=>tool.type==='function'),'Saved ready design must not trigger another paid search or image call.');resumedCalls++;return Response.json(resumedCalls===1?{status:'completed',output:[{type:'function_call',call_id:'resume-plan',name:'plan_scene',arguments:JSON.stringify({sceneId:'retried-scene-id',brief:'Continue the same original requested scene with its existing checked design.'})}]}:envelope({summary:'Prepared the saved design without applying a scene.',requestedViews:[],operations:[]}));}) as typeof fetch;
  const server=await startApplication({port:0,env:{LITTLETAKE_DATA_DIR:directory,LITTLETAKE_LOCAL_DEPTH:'0',MODEL_API_KEY:'test-only-private',MUSE_MODEL:'test'}});
  try{const response=await network(server.origin+'/api/scene-edit',{method:'POST',headers:{'Content-Type':'application/json','x-littletake-project':room.code,'x-littletake-edit-lease':lease,Accept:'application/x-ndjson'},body:JSON.stringify({project:projectContent(project),sceneId:null,shotId:null,prompt:original,selectedId:null,time:0,snapshots:[]})}),events:AgentProgress[]=[],result=await readSceneEditResponse(response,event=>events.push(event)) as any;assert.equal(result.status,'ready');assert.equal(resumedCalls,2);assert.ok(events.some(event=>event.imageOutputId===design.concept!.id&&event.message.includes('Reusing')));assert.equal(server.projects.get(room.code).outputs.length,3);assert.equal(JSON.parse(Buffer.from(server.projects.readOutput(room.code,design.id).data).toString('utf8')).sceneId,'retried-scene-id');assert.equal(server.projects.get(room.code).project.scenes.length,0);}finally{globalThis.fetch=network;await server.close();}
});

test('canonical scene roles reject unsuitable library geometry, cache the rejection and reuse expert-approved replacements',async()=>{
  let fits=0;const designer=new SceneDesigner({name:'test',model:'test',async generateObject(request){fits++;assert.equal(request.schemaName,'scene_asset_fit');const context=JSON.parse((request.content[0] as {text:string}).text);assert.equal(context.role.name,'Requested asset');assert.equal(request.content.filter(part=>part.type==='image').length,3);return {approved:false,notes:'The cluster contains unrelated equal-height structures and cannot serve this independent landmark.'};}},'Full original place');
  const asset=createAsset({name:'Misleading landmark name',description:'Unrelated geometry',tags:['test'],parts:[{id:'box',name:'Box',kind:'cube',position:[0,1,0],size:[1,2,1],rotation:[0,0,0],color:'#999999',parentId:null,joint:null}]} as any,'library-candidate');
  designer.designs.set('scene',{id:crypto.randomUUID(),sceneId:'scene',originalRequest:'Full original place',status:'ready',plan:fixturePlan,concept:{id:crypto.randomUUID(),image:'data:image/png;base64,'+Buffer.from(fixturePNG).toString('base64'),model:'fixture',prompt:'Original scope'},research:[{id:'reference-1',query:'place',findings:fixtureResearch.findings,sources:[],images:[{image:'data:image/png;base64,'+Buffer.from(fixturePNG).toString('base64'),title:'Original',url:'https://example.org/photo.png',page:'https://example.org/photo',credit:'Photographer'}],evidence:{request:{}}}],attempts:[]});
  await assert.rejects(designer.checkAsset('scene',undefined,asset,fixturePNG),/exact designAsset/);assert.equal(fits,0);
  await assert.rejects(designer.checkAsset('scene','Requested asset',asset,fixturePNG),/does not fit/);await assert.rejects(designer.checkAsset('scene','Requested asset',asset,fixturePNG),/does not fit/);assert.equal(fits,1,'Repeated unsuitable reuse cannot spend another model call.');
  assert.throws(()=>designer.assertAssetsReady('scene',new Set([asset.id]),[asset]),/unfulfilled asset roles/);
  const generated={...asset,id:'expert-replacement'};await designer.generatedFor('scene','Requested asset',generated);await designer.checkAsset('scene','Requested asset',generated,fixturePNG);await designer.checkAsset('ordinary-existing-edit',undefined,asset,fixturePNG);assert.equal(fits,1);
  designer.assertAssetsReady('scene',new Set([generated.id]),[generated]);assert.throws(()=>designer.assertAssetsReady('scene',new Set(),[generated]),/unfulfilled asset roles/);assert.throws(()=>designer.assertAssetsReady('scene',new Set([generated.id]),[{...generated,name:'Changed after approval'}]),/unfulfilled asset roles/);
  const retained=JSON.parse(JSON.stringify(designer.designs.get('scene'))),restored=new SceneDesigner({name:'test',model:'test',async generateObject(){throw new Error('An unchanged retained decision cannot be billed again.');}},'Full original place',undefined,undefined,undefined,researchFetchFixture,async()=>retained);await restored.plan('scene','Resume the retained scene.');await restored.checkAsset('scene','Requested asset',generated,fixturePNG);await assert.rejects(restored.checkAsset('scene','Requested asset',asset,fixturePNG),/does not fit/);await assert.rejects(restored.checkAsset('scene','Requested asset',{...generated,parts:generated.parts.map(part=>({...part,color:'#123456'}))},fixturePNG),/cannot be billed again/);
  const legacy=structuredClone(retained);delete legacy.plan.regions;let layoutCalls=0,referenceCalls=0,persisted:any;
  const upgraded=new SceneDesigner({name:'test',model:'test',async generateObject(request){if(request.schemaName==='scene_reference_selection')return fixtureReferenceSelection;if(request.schemaName==='scene_reference_research'){referenceCalls++;request.onResponse?.(researchEnvelope());return fixtureResearch;}layoutCalls++;assert.equal(request.schemaName,'scene_design_regions');assert.equal(request.format,'json_schema');assert.ok(JSON.stringify(request.content).includes(legacy.originalRequest));return {regions:[{name:'Requested region',designAsset:'Requested asset',min:[-6,-4],max:[6,4],usage:'repeat',description:'Preserve the required area while arranging enough compatible modules.'}]};}},legacy.originalRequest,undefined,async design=>{persisted=structuredClone(design);return {};},[],researchFetchFixture,async()=>legacy);
  const refined=await upgraded.plan('scene','Continue the complete requested environment.');assert.equal(layoutCalls,1);assert.equal(refined.concept!.id,retained.concept.id);assert.equal(persisted.plan.regions[0].max[0],6);await upgraded.checkAsset('scene','Requested asset',generated,fixturePNG);assert.equal(layoutCalls,1,'Adding explicit regional bounds must retain the concept, reference pixels and previous asset-fit decisions without another generation call.');await upgraded.plan('scene','Resume again');assert.equal(layoutCalls,1);
  await upgraded.search('Additional full-extent layout map');await upgraded.search('Additional full-extent layout map');assert.equal(referenceCalls,1);assert.equal(persisted.research.at(-1).query,'Additional full-extent layout map');assert.equal(persisted.research.at(-1).images[0].purpose,'layout');const resumedReferences=new SceneDesigner({name:'test',model:'test',async generateObject(){throw new Error('Saved targeted references must not be searched again.');}},legacy.originalRequest,undefined,undefined,[],researchFetchFixture,async()=>structuredClone(persisted));await resumedReferences.plan('scene','Continue with the saved layout reference');assert.equal((await resumedReferences.search('Additional full-extent layout map')).images[0].purpose,'layout');
  let refinementCalls=0,rejectRefinement=false;
  const refiner=new SceneDesigner({name:'test',model:'test',async generateObject(request){refinementCalls++;assert.equal(request.format,'json_schema');if(request.schemaName==='scene_design_refinement_review')return {approved:!rejectRefinement,notes:rejectRefinement?'The proposed module is unrelated to the original task.':'A clean repeatable module supplies the missing regional density without copying terrain.'};assert.equal(request.schemaName,'scene_design_refinement');const context=JSON.parse((request.content[0] as {text:string}).text);assert.ok(context.visibleDefects.includes('sparse'));const name=rejectRefinement?'Unrelated extra model':'Dense repeatable module';return {assetBriefs:[{name,brief:'A dense clean module matching the original silhouettes and authoring scale, without duplicating site terrain.'}],regions:[{name:name+' region',designAsset:name,min:[-6,-4],max:[6,4],usage:'repeat',description:'Fill the observed missing area with correctly sized independent modules.'}]};}},retained.originalRequest,undefined,async design=>{persisted=structuredClone(design);return {};},[],researchFetchFixture,async()=>structuredClone(retained));
  await refiner.plan('scene','Continue');const originalPlan=structuredClone(refiner.designs.get('scene')!.plan!);const completed=await refiner.refine('scene','scene-preview-1','The existing site layer has sparse props and leaves most of the region empty.',fixtureImage,'Add a reusable filling module without reducing the original task.');assert.equal(refinementCalls,2);assert.equal(completed.concept!.id,retained.concept.id);assert.deepEqual(completed.plan!.assetBriefs[0],originalPlan.assetBriefs[0]);assert.equal(completed.plan!.scope,originalPlan.scope);assert.equal(completed.plan!.displayScale,originalPlan.displayScale);assert.equal(completed.plan!.assetBriefs.length,originalPlan.assetBriefs.length+1);assert.ok(completed.assetFits!.some(fit=>fit.asset.id===generated.id&&fit.approved));assert.throws(()=>refiner.assertAssetsReady('scene',new Set([generated.id]),[generated]),/Dense repeatable module/);await assert.rejects(refiner.refine('scene','scene-preview-1','sparse',fixtureImage,'Try again'),/already requested/);assert.equal(refinementCalls,2);
  const acceptedPlan=JSON.stringify(completed.plan);rejectRefinement=true;await assert.rejects(refiner.refine('scene','scene-preview-2','Still sparse but retain the original requested scene.',fixtureImage,'Add only necessary missing geometry.'),/not accepted/);assert.equal(refinementCalls,4);assert.equal(JSON.stringify(completed.plan),acceptedPlan,'Rejected planning changes cannot overwrite accepted scope, layout or modeling requirements.');
});

test('invented sources cannot satisfy reference search and scope-rejected concepts cannot unlock modeling',async()=>{
  let imageCalls=0;
  // References only inform the design: photos that cannot establish the layout are dropped, never block it, and are not used as a standard.
  const unusable=await researchScene('Whole place layout','Full original place',{name:'test',model:'test',async generateObject(request){if(request.schemaName==='scene_reference_selection')return {...fixtureReferenceSelection,layoutUsable:false,notes:'The aerial is too hazy to establish the whole shape.'};request.onResponse?.(researchEnvelope());return fixtureResearch;}},undefined,researchFetchFixture);
  assert.equal(unusable.role,'inspiration');assert.equal(unusable.images.length,0);assert.match(unusable.findings,/too hazy/);
  const photo=(page:string,purpose?:'layout'|'identity'|'detail')=>({page,purpose,title:page,url:page,credit:'',image:fixtureImage});const old={images:[photo('old-1'),photo('old-2'),photo('old-3'),photo('old-4')]},targeted={images:[photo('new-layout','layout'),photo('new-identity','identity'),photo('new-detail','detail')]};assert.deepEqual(referencePhotos([old,targeted] as any).map(photo=>photo.page),['new-layout','new-identity','new-detail','old-1'],'Targeted layout evidence cannot be hidden by an older full image allowance.');
  // Invented sources are never trusted: unverified findings are dropped and the design follows the request instead.
  const unverified=await researchScene('named place','Original requested place',{name:'test',model:'test',async generateObject(request){request.onResponse?.(envelope(fixtureResearch));return fixtureResearch;}},undefined,researchFetchFixture);
  assert.equal(unverified.role,'inspiration');assert.deepEqual(unverified.sources,[]);assert.equal(unverified.images.length,0);assert.doesNotMatch(unverified.findings,new RegExp(fixtureResearch.findings.slice(0,20).replace(/[.*+?^${}()|[\]\\]/g,'\\$&')));
  const records:unknown[]=[],provider=new MetaProvider({apiKey:'private-test-key',model:'test'},(async(_url,init)=>{
    const body=JSON.parse(String(init?.body));if(body.tools?.[0]?.type==='web_search')return Response.json(researchEnvelope());
    if(body.instructions?.startsWith('Select ORIGINAL visual references'))return Response.json(envelope(fixtureReferenceSelection));
    if(body.model==='muse-image-1.0'){imageCalls++;return Response.json({status:'completed',output:[{type:'image_generation_call',result:Buffer.from(fixturePNG).toString('base64')}]});}
    return Response.json(envelope(body.instructions.startsWith("You are LittleTake's scene designer.")?fixturePlan:{...fixtureReview,scopePreserved:false,identityVisible:false}));
  }) as typeof fetch),designer=new SceneDesigner(provider,'Complete named place',undefined,undefined,records,researchFetchFixture);
  await assert.rejects(designer.plan('place','A generic tiny substitute.'),/does not yet match/);assert.equal(imageCalls,2);assert.equal(designer.designs.get('place')?.status,'failed');assert.equal(records.length,1);
  await assert.rejects(designer.plan('place','Try the same failed job again.'),/do not restart/);assert.equal(imageCalls,2);
});

test('an imagined scene takes the previs path: no photo search or concept review, and nothing a reviewer or content filter says stops the build',async()=>{
  const schemas:string[]=[];let photoFetches=0,images=0;
  const provider:AIProvider={name:'test',model:'test',async generateObject(request){
    schemas.push(request.schemaName!);
    if(request.schemaName==='scene_reference_research'){request.onResponse?.(researchEnvelope());return {...fixtureResearch,imagined:true};}
    if(request.schemaName==='proxy_asset_recipe')return {name:'Knight',description:'A rough knight proxy.',tags:['knight'],parts:[{id:'body',name:'Body',parentId:null,kind:'cube',position:[0,.5,0],rotation:[0,0,0],size:[1,1,1],color:'#888888',joint:null}]};
    if(request.schemaName==='proxy_asset_review')return {approved:false,notes:'The sword grip is slightly offset.',revisedRecipe:null};
    return fixturePlan;
  },async generateImage(){images++;throw new AIError('content_blocked','declined');}};
  const designer=new SceneDesigner(provider,'A knight faces a dragon',undefined,undefined,[],(async(...args:Parameters<typeof fetch>)=>{photoFetches++;return researchFetchFixture(...args);}) as typeof fetch);
  const design=await designer.plan('scene','A standoff.');
  assert.equal(design.status,'ready');assert.equal(design.concept,undefined,'A declined concept is skipped after one rephrased attempt.');assert.equal(images,2);
  assert.equal(photoFetches,0,'No image search for an imagined scene.');assert.deepEqual(schemas,['scene_reference_research','scene_design_plan'],'No selection or concept review was paid for.');assert.equal(factualReferences(design.research),false);
  const library=new AssetLibrary(await mkdtemp(path.join(tmpdir(),'littletake-previs-')));
  const {asset,job}=await generateAsset('A knight',provider,library,undefined,{previs:true});
  assert.equal(job.status,'ready','A failed self-check keeps the last version instead of blocking the scene.');assert.ok((await library.list()).some(item=>item.id===asset.id));
  assert.equal(job.attempts.length,2,'One build and one self-check.');
});
