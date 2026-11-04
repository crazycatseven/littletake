import assert from 'node:assert/strict';
import test,{beforeEach,afterEach} from 'node:test';
import { mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MetaProvider } from '../ai/meta.ts';
import { AssetLibrary } from './library.ts';
import { generateAsset,assetJobReferences,type AssetJob } from './expert.ts';
import type {AIContent} from '../ai/provider.ts';
import { budgetProvider } from './tools.ts';
import { builtinAssets } from '../../src/assets/builtin.ts';
import { builtinAssets as catalogAssets,instantiateAsset } from '../../src/assets/library.ts';
import { assetRecipeSchema,createAsset } from '../../src/assets/model.ts';
import { createEmptyScene, createDocument, History } from '../../src/model.ts';
import { createProject, parseProject, serializeProject } from '../../src/project/storage.ts';
import { validateProjectContent } from '../../src/project/model.ts';
import { applyProjectOperations } from '../../src/scene-edit/operations.ts';
import { newDiagnostic } from '../../src/scene-edit/diagnostics.ts';
import { proposeSceneEdit } from '../scene-edit.ts';
import type { SceneEditInput } from '../../src/scene-edit/types.ts';
import {designHTTPFixture,researchFetchFixture,fixturePlan,fixtureSceneReview} from '../scene-design/fixtures.ts';
const originalFetch=globalThis.fetch;beforeEach(()=>{globalThis.fetch=researchFetchFixture;});afterEach(()=>{globalThis.fetch=originalFetch;});

const transform = { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] };
const json = (value: unknown) => ({ status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify(value) }] }] });
function transportFor(mode: 'generate' | 'reuse', assetId = 'builtin-chair') {
  let directorCalls = 0, expertCalls = 0;
  const requests: Record<string, any>[] = [];
  const transport = (async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(init.body as string); requests.push(body);
    const design=designHTTPFixture(body);if(design)return Response.json(design);
    if (!body.tools) {
      if (body.instructions.includes('scene visual reviewer')) return Response.json(json({...fixtureSceneReview, notes: 'The measured chairs and overview renders meet the request.' }));
      expertCalls++;
      if(expertCalls===1){const context=JSON.parse(body.input[0].content[0].text);assert.deepEqual(context.baseRecipe.parts,builtinAssets[0].parts,'The specialist receives the inspected base geometry, not only a short description.');assert.ok(context.brief.includes(fixturePlan.assetBriefs[0].brief));assert.ok(!context.brief.includes('matching the requested special asset'),'The director cannot replace the canonical modeling requirement with an additional smaller brief.');}
      const recipe = assetRecipeSchema.strip().parse(builtinAssets[0]); recipe.name = 'Blue test chair'; recipe.tags = ['blue', 'test chair']; recipe.parts.forEach(p => p.color = '#4466aa');
      recipe.parts.push({...structuredClone(recipe.parts[0]),id:'side_handle',name:'Side handle',position:[.6,.6,0],size:[.12,.12,.12]});
      return Response.json(json(expertCalls === 1 ? recipe : { approved: true, notes: 'All rendered views meet the brief.' }));
    }
    directorCalls++;
    assert.equal(body.parallel_tool_calls, true); assert.equal(body.store, false);
    const outputs = body.input.filter((x: any) => x.type === 'function_call_output').map((x: any) => JSON.parse(x.output));
    const call = (name: string, args: unknown) => Response.json({ status: 'completed', output: [{ type: 'function_call', call_id: 'call_' + directorCalls, name, arguments: JSON.stringify(args), status: 'completed' }] });
    if (directorCalls === 1) return call('plan_scene', { sceneId: 'scene-1', brief: 'Place two reusable chairs two metres apart at normal scale; inspect their layout from above and at an angle.' });
    if (directorCalls === 2) return call('search_assets', { query: mode === 'generate' ? 'blue test chair special' : 'chair' });
    if (directorCalls === 3) return call('read_asset', { assetId });
    if(mode==='generate'&&directorCalls===4)return call('generate_asset',{searchId:outputs.find((item:any)=>item.searchId).searchId,baseAssetId:'unread-base',designAsset:'Requested asset',brief:'Blue chair with four legs and a backrest, matching the requested special asset.',reason:'The user explicitly requested a new independent test asset variant.'});
    if(mode==='generate'&&directorCalls===5){assert.equal(expertCalls,0,'An invalid base reference must not spend expert calls.');assert.match(outputs.at(-1).error,/Read the base asset/);return call('generate_asset',{searchId:outputs.find((item:any)=>item.searchId).searchId,baseAssetId:assetId,designAsset:'Requested asset',brief:'Blue chair with four legs and a backrest, matching the requested special asset.',reason:'The user explicitly requested a new independent test asset variant.'});}
    if(mode==='generate'&&directorCalls===6)return call('generate_asset',{searchId:outputs.find((item:any)=>item.searchId).searchId,baseAssetId:assetId,designAsset:'Requested asset',brief:'Another shortened attempt for exactly the same already-ready design role.',reason:'The director should receive the retained compatible asset instead of a new bill.'});
    const selected = mode === 'generate' ? outputs.find((item:any)=>item.asset)?.asset.id : assetId,start=mode==='generate'?7:4;
    if (directorCalls === start) return call('instantiate_asset', { assetId: selected, sceneId: 'scene-1', name: 'Chair A',designAsset:'Requested asset', transform });
    if (directorCalls === start+1) return call('instantiate_asset', { assetId: selected, sceneId: 'scene-1', name: 'Chair B',designAsset:'Requested asset', transform: { ...transform, position: [2, 0, 0] } });
    if (directorCalls === start+2) return call('render_scene', { sceneId: 'scene-1', frames: [], operations: outputs.filter((item:any)=>item.placementId).map((item:any)=>item.operation) });
    return Response.json(json({ summary: 'Prepared two instances.', requestedViews: [], objectCounts: [], operations: [], scenePreviewId: outputs.find((item:any)=>item.scenePreviewId).scenePreviewId }));
  }) as typeof fetch;
  return { provider: new MetaProvider({ apiKey: 'do-not-log-this-test-secret', model: 'test' }, transport), requests, counts: () => ({ directorCalls, expertCalls }) };
}
const input = (): SceneEditInput => ({ project: { name: 'Assets', scenes: [createEmptyScene()] }, sceneId: 'scene-1', shotId: null, prompt: 'Place chairs in this scene.', selectedId: null, time: 0, snapshots: [] });

test('library-first native tools reuse assets, preserve instance independence, export, undo and reload', async () => {
  const library = new AssetLibrary(await mkdtemp(path.join(tmpdir(), 'littletake-assets-'))), source = input(), frozen = JSON.stringify(source), diagnostic = newDiagnostic(), fake = transportFor('reuse');
  const response = await proposeSceneEdit(source, fake.provider, undefined, diagnostic, library);
  assert.equal(response.status, 'ready'); if (response.status !== 'ready') return;
  assert.deepEqual(fake.counts(), { directorCalls: 7, expertCalls: 0 }); assert.equal(JSON.stringify(source), frozen);
  assert.ok(fake.requests.filter(body=>body.text?.format?.name?.startsWith('scene_')).every(body=>body.text.format.type==='json_schema'&&body.text.format.strict),'Simple visual/design assessments must constrain the response shape instead of asking JSON mode to copy a schema.');
  assert.deepEqual(diagnostic.toolCalls!.map(c => c.name), ['plan_scene', 'search_assets', 'read_asset', 'instantiate_asset', 'instantiate_asset', 'render_scene']);
  assert.ok(!JSON.stringify(diagnostic).includes('do-not-log-this-test-secret'));
  const result = applyProjectOperations(source.project, response.plan.operations, 0);
  assert.equal(result.assets!.length, 1); assert.equal(result.scenes[0].objects.length, 2);
  assert.deepEqual(result.scenes[0].objects[0].asset, result.scenes[0].objects[1].asset);
  const moved = applyProjectOperations(result, [{ type: 'translate', sceneId: 'scene-1', id: result.scenes[0].objects[0].id, offset: [1, 0, 0] }], 0);
  assert.deepEqual(moved.scenes[0].objects[1], result.scenes[0].objects[1]); assert.deepEqual(moved.assets, result.assets);
  const history = new History(source.project); history.commit(result); assert.deepEqual(history.undo(), source.project); assert.deepEqual(history.redo(), result);
  const project = { ...createProject(result.scenes[0]), assets: result.assets };
  assert.deepEqual(parseProject(serializeProject(project)), project);
  assert.throws(() => validateProjectContent({ ...result, assets: [] }), /Missing asset/);
  const bad = structuredClone(response.plan.operations); bad[1] = { type: 'remove_object', sceneId: 'missing', id: 'missing' };
  assert.throws(() => applyProjectOperations(source.project, bad, 0)); assert.equal(JSON.stringify(source), frozen);
  const target=moved.scenes[0].objects[0];let swapCalls=0;
  let reuseTurns=0;const directDiagnostic=newDiagnostic(),direct=await proposeSceneEdit({...source,project:moved,prompt:'Inspect the current chair, then add one more instance.'},{name:'test',model:'test',async generateObject(){throw new Error('Use native tools.');},async generateToolTurn(request){reuseTurns++;const prepared=request.input.filter((item:any)=>item.type==='function_call_output').map((item:any)=>JSON.parse(item.output));if(reuseTurns<=2)return {output:[],calls:[{id:'inspect-'+reuseTurns,name:'render_asset',arguments:JSON.stringify({assetId:target.asset!.id,jointAngles:reuseTurns===1?{'missing-pose-part':30}:{}})}],text:''};return reuseTurns===3?{output:[],calls:[{id:'reuse-current',name:'instantiate_asset',arguments:JSON.stringify({assetId:target.asset!.id,sceneId:'scene-1',name:'Chair C',transform:{...transform,position:[4,0,0]}})}],text:''}:{output:[],calls:[],text:JSON.stringify({summary:'Reuse current chair',requestedViews:[],objectCounts:[],operations:prepared.filter(item=>item.placementId).map(item=>item.operation)})};}},undefined,directDiagnostic,library);
  assert.equal(direct.status,'ready');assert.equal(reuseTurns,4);assert.match(directDiagnostic.toolCalls![0].error!,/Invalid joint/);const measured=directDiagnostic.toolCalls![1].result as any;assert.ok(measured.measurements.parts.every((part:any)=>part.positionInAssetSpace.length===3));assert.deepEqual(directDiagnostic.toolCalls!.map(call=>call.name),['render_asset','render_asset','instantiate_asset']);if(direct.status==='ready'){const extended=applyProjectOperations(moved,direct.plan.operations,0);assert.equal(extended.scenes[0].objects.length,3);assert.deepEqual(extended.scenes[0].objects.slice(0,2),moved.scenes[0].objects);}
  const swap=await proposeSceneEdit({...source,project:moved,prompt:'Use the existing table prefab for this object, preserving its state.'},{name:'test',model:'test',async generateObject(){throw new Error('Use native tools.');},async generateToolTurn(){swapCalls++;return swapCalls===1?{output:[],calls:[],text:JSON.stringify({summary:'Change tint without inspection',requestedViews:[],objectCounts:[],operations:[{type:'set_color',sceneId:'scene-1',id:target.id,color:'#ffffff'}]})}:swapCalls===2?{output:[],calls:['builtin-table'].map(assetId=>({id:assetId,name:'read_asset',arguments:JSON.stringify({assetId})})),text:''}:{output:[],calls:[],text:JSON.stringify({summary:'Swap prefab',requestedViews:[],objectCounts:[],operations:[{type:'set_asset',sceneId:'scene-1',id:target.id,assetId:'builtin-table'},{type:'set_color',sceneId:'scene-1',id:target.id,color:'#ffffff'}]})};}},undefined,newDiagnostic(),library);
  assert.equal(swap.status,'ready');assert.equal(swapCalls,3);if(swap.status==='ready'){const changed=applyProjectOperations(moved,swap.plan.operations,0);assert.deepEqual(changed.scenes[0].objects[0],{...target,asset:{id:'builtin-table'}});assert.deepEqual(changed.scenes[0].objects[1],moved.scenes[0].objects[1]);}
  const human=catalogAssets.find(asset=>asset.id==='builtin-porter')!,actor=instantiateAsset(human,'performer',[2,0,3],6);actor.jointAngles={'body_yaw':55,'left-shoulder_side':22};
  const posed=applyProjectOperations({name:'Pose inspection',scenes:[{...createEmptyScene(),duration:6,objects:[actor]}],assets:[human]},[{type:'set_property_keys',sceneId:'scene-1',id:actor.id,path:'jointAngles.right-forearm',keys:[{time:0,value:0,interpolation:'linear'},{time:4,value:-60,interpolation:'linear'}]}],0),poseFrozen=JSON.stringify(posed),poseDiagnostic=newDiagnostic();let poseTurns=0;
  await proposeSceneEdit({...source,project:posed,prompt:'Inspect the existing writing pose at two seconds without changing it.'},{name:'test',model:'test',async generateObject(){throw new Error('Use native tools.');},async generateToolTurn(request){poseTurns++;if(poseTurns===1)return {output:[],calls:[{id:'actual-pose',name:'render_asset',arguments:JSON.stringify({assetId:human.id,instance:{sceneId:'scene-1',id:actor.id,time:2},jointAngles:{'left-upperarm':-30}})}],text:''};return {output:[],calls:[],text:JSON.stringify({summary:'Inspected the evaluated pose.',requestedViews:[],objectCounts:[],operations:[]})};}},undefined,poseDiagnostic,library);
  const inspected=poseDiagnostic.toolCalls![0].result as any;assert.equal(inspected.jointAngles.body_yaw,55);assert.equal(inspected.jointAngles['left-shoulder_side'],22);assert.equal(inspected.jointAngles['right-forearm'],-30);assert.equal(inspected.jointAngles['left-upperarm'],-30);assert.deepEqual(inspected.instance.transform.position,[2,0,3]);assert.equal(JSON.stringify(posed),poseFrozen,'Pose inspection cannot alter the prefab or its keyed instance.');
});

test('missing asset is delegated, rendered, inspected and persisted; a restarted library reuses it without expert calls', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'littletake-assets-')), library = new AssetLibrary(directory), source = input(), diagnostic = newDiagnostic(), fake = transportFor('generate');
  const response = await proposeSceneEdit(source, fake.provider, undefined, diagnostic, library);
  assert.equal(response.status, 'ready'); if (response.status !== 'ready') return;
  assert.equal(fake.counts().expertCalls, 2);
  assert.ok(diagnostic.toolCalls!.some(call=>call.name==='generate_asset'&&(call.result as any)?.reused===true),'A repeated canonical modeling request reuses its ready asset without another paid job.');
  assert.match(diagnostic.toolCalls!.find(call=>call.error)!.error!,/Read the base asset/);
  const expertRequests = fake.requests.filter(r => !r.tools && r.instructions.includes('dedicated Proxy Asset Modeling Expert'));
  assert.match(expertRequests[0].instructions, /dedicated Proxy Asset Modeling Expert/);
  assert.ok(!expertRequests[0].instructions.includes('film-set builder'));
  assert.ok(expertRequests[1].input[0].content.some((p: any) => p.type === 'input_image' && p.image_url.startsWith('data:image/png;base64,')));
  const result = applyProjectOperations(source.project, response.plan.operations, 0), asset = result.assets![0];
  const handle=(diagnostic.toolCalls!.find(call=>call.name==='generate_asset'&&!call.error)!.result as any).asset.id;assert.match(handle,/^prefab-\d+$/);assert.equal(diagnostic.assetHandles?.[handle],asset.id);assert.notEqual(handle,asset.id);assert.equal(result.scenes[0].objects[0].asset!.id,asset.id,'Turn-local compact references must resolve to the actual persistent asset ID in saved projects.');
  assert.deepEqual(asset.parts.find(part=>part.id==='seat')!.position,builtinAssets[0].parts.find(part=>part.id==='seat')!.position,'An asymmetric variant retains its base origin instead of shifting its skeleton and old placements.');
  const jobs = await readdir(path.join(directory, 'jobs')); const job = await library.readJob(jobs[0].replace('.json', '')) as AssetJob;
  assert.equal(job.status, 'ready'); assert.equal((job.attempts as unknown[]).length, 2); assert.ok(!JSON.stringify(job).includes('do-not-log-this-test-secret'));
  const fresh = new AssetLibrary(directory); assert.deepEqual(await fresh.read(asset.id), asset);
  assert.ok((await fresh.preview(asset)).length > 1000);
  const reuse = transportFor('reuse', asset.id), next = await proposeSceneEdit(input(), reuse.provider, undefined, newDiagnostic(), fresh);
  assert.equal(next.status, 'ready'); assert.equal(reuse.counts().expertCalls, 0); assert.equal((await fresh.list()).length, catalogAssets.length + 1);
  const duplicate = await Promise.all([fresh.register(asset), fresh.register(asset)]); assert.ok(duplicate.every(a => a.id === asset.id));
  assert.equal((await fresh.list()).filter(a => a.id === asset.id).length, 1);
  const variant = { ...asset, id: 'concurrent-publication' };
  const concurrent = await Promise.allSettled([fresh.register(variant), fresh.register({...variant,name:'Conflicting chair'})]);
  assert.equal(concurrent.filter(r => r.status === 'fulfilled').length, 1);
  assert.deepEqual(await fresh.read(variant.id), concurrent.find(r => r.status === 'fulfilled')!.value);
});

test('rejected and interrupted jobs retain evidence and budgets; a later explicit correction review can publish without regeneration', async () => {
  const library = new AssetLibrary(await mkdtemp(path.join(tmpdir(), 'littletake-assets-'))), recipe = assetRecipeSchema.strip().parse(builtinAssets[0]);
  const referenceImage='data:image/png;base64,'+Buffer.from(await library.preview(builtinAssets[0])).toString('base64'),references:AIContent[]=[{type:'text',text:'ORIGINAL REFERENCE: preserved source pixels, not an earlier generated candidate.'},{type:'image',dataUrl:referenceImage}];
  let calls = 0;
  const provider = { name: 'test', model: 'test', async generateObject(request: any) { calls++; const value = calls === 1 ? recipe : { approved: false, notes: 'The requested feature is missing.', revisedRecipe: recipe }; request.onOutput?.(JSON.stringify(value)); return value; } };
  await assert.rejects(generateAsset('Test a chair which must not pass inspection.', provider, library,undefined,{base:builtinAssets[0],references}), /review did not pass/);
  assert.equal(calls, 4); assert.equal((await library.list()).length, catalogAssets.length);
  const jobs = await readdir(path.join(library.directory, 'jobs')), job = await library.readJob(jobs[0].replace('.json', ''));
  assert.equal(job.status, 'failed'); assert.equal((job.attempts as any[]).filter(a => a.rawOutput).length, 4);
  assert.deepEqual(assetJobReferences(job as AssetJob),references);const legacy=structuredClone(job) as AssetJob;delete legacy.referenceContentStart;assert.deepEqual(assetJobReferences(legacy),references,'Legacy jobs must retain source captions without carrying the old base preview into the next review.');let resumedCalls=0;
  const revision=structuredClone(recipe);revision.parts[0].color='#224466';
  const resumed=await generateAsset('Continue the saved revised chair.',{name:'test',model:'test',async generateObject(request:any){resumedCalls++;assert.equal(request.schemaName,'proxy_asset_review');assert.ok(request.content.some((part:any)=>part.dataUrl===referenceImage));assert.ok(request.content.some((part:any)=>part.text?.startsWith('ORIGINAL REFERENCE:')));return {approved:true,notes:'The saved correction passes the rendered review.',revisedRecipe:resumedCalls===1?revision:null};}},library,undefined,{references:assetJobReferences(job as AssetJob),resumeJobId:String(job.id)});
  assert.equal(resumedCalls,2);assert.equal(resumed.asset.parts[0].color,'#224466');assert.equal(resumed.job.resumedFrom,job.id);assert.deepEqual(await library.read(resumed.asset.id),resumed.asset);assert.equal((await library.readJob(String(job.id))).status,'failed');
  assert.deepEqual(assetJobReferences(resumed.job),references);const legacyReview=structuredClone(resumed.job);delete legacyReview.referenceContentStart;assert.deepEqual(assetJobReferences(legacyReview),references,'A previous candidate render must not become an original reference after another continuation.');
  const controller = new AbortController(); controller.abort(); await assert.rejects(generateAsset('A cancelled chair', provider, library, controller.signal)); assert.equal(calls, 4);
  const limited = budgetProvider(provider, 1), request = { instructions: '', content: [], schema: {}, schemaName: 'test' };
  await limited.generateObject(request); await assert.rejects(limited.generateObject(request), /call limit/); assert.equal(calls, 5);
  const wideRecipe={...recipe,name:'Wide backing layer',parts:[{id:'tile',name:'Tile',parentId:null,kind:'cube',position:[-600,.05,0],rotation:[0,0,0],size:[100,.1,1],color:'#446677',joint:null}],construction:{parameters:[],bindings:[],anchors:[],constraints:[],excluded:[],offset:[0,0,0],modifiers:[{id:'tiles',type:'array',targetId:'tile',enabled:true,count:14,offset:[90,0,0]}]}};
  const wide=createAsset(wideRecipe,'wide-backing');assert.ok(wide.bounds.size[0]>1000&&wide.bounds.size[0]<2000);await library.register(wide);assert.deepEqual((await new AssetLibrary(library.directory).read(wide.id)).bounds,wide.bounds,'Valid +/-1000 coordinates can span more than 1000 metres and must survive saved asset validation.');
  const invalid=structuredClone(wideRecipe);invalid.construction.modifiers[0].count=40;
  const previousIds=new Set((await readdir(path.join(library.directory,'jobs'))).filter(name=>name.endsWith('.json')));await assert.rejects(generateAsset('Retain and correct this saved wide layer.',{name:'test',model:'test',async generateObject(){return invalid;}},library),/could not produce valid geometry/);
  const failedName=(await readdir(path.join(library.directory,'jobs'))).find(name=>name.endsWith('.json')&&!previousIds.has(name))!;let repairCalls=0;
  const repaired=await generateAsset('Retain and correct this saved wide layer.',{name:'test',model:'test',async generateObject(request){repairCalls++;if(request.schemaName==='proxy_asset_recipe'){const context=JSON.parse((request.content[0] as {text:string}).text);assert.ok(context.validationFeedback);assert.equal(context.previousRecipe.construction.modifiers[0].count,40);return wideRecipe;}return {approved:true,notes:'The preserved invalid revision was repaired and its current geometry inspected.',revisedRecipe:null};}},library,undefined,{resumeJobId:failedName.replace('.json','')});assert.equal(repairCalls,2);assert.ok(repaired.asset.bounds.size[0]>1000);
});

test('parallel specialist jobs retain ready assets and failed evidence without restarting a failed task or blocking its peers',async()=>{
  const library=new AssetLibrary(await mkdtemp(path.join(tmpdir(),'littletake-parallel-assets-'))),source={...input(),project:{name:'Existing set',scenes:[createDocument()]}},diagnostic=newDiagnostic();let turns=0,started=0,release!:()=>void;const together=new Promise<void>(done=>{release=done;}),calls:string[]=[];
  await library.register({...builtinAssets[0],id:'prefab-1',source:'edited',name:'A user-owned prefab-1'});
  const recipe=assetRecipeSchema.strip().parse(builtinAssets[0]);recipe.name='Parallel ready chair';
  const call=(name:string,args:unknown)=>({id:crypto.randomUUID(),name,arguments:JSON.stringify(args)});
  const response=await proposeSceneEdit(source,{name:'test',model:'test',async generateObject(request){const context=JSON.parse((request.content[0] as {text:string}).text);calls.push(context.brief);if(request.schemaName==='proxy_asset_review')return {approved:true,notes:'The rendered usable chair meets the brief.',revisedRecipe:null};if(++started===2)release();await Promise.race([together,new Promise((_,reject)=>{const timer=setTimeout(()=>reject(new Error('Independent specialist jobs were serialized.')),2000);timer.unref();})]);if(context.brief.includes('fail'))throw new Error('Modeling this requested shape failed.');return {...recipe,name:context.brief.includes('second')?'Parallel second chair':recipe.name};},async generateToolTurn(request){turns++;const results=request.input.filter((item:any)=>item.type==='function_call_output').map((item:any)=>JSON.parse(item.output));if(turns===1)return {output:[],calls:[call('search_assets',{query:'Two independent requested variants'})],text:''};const searchId=results.find((item:any)=>item.searchId).searchId,failed={searchId,brief:'One shape that should fail modeling.',reason:'The requested feature is absent in the library.'};if(turns===2)return {output:[],calls:[call('generate_asset',failed),call('generate_asset',{searchId,brief:'A usable independent chair variant.',reason:'The user requested another reusable asset.'}),call('generate_asset',{searchId,brief:'A second usable independent chair variant.',reason:'The user requested this additional reusable asset.'})],text:''};if(turns===3){assert.ok(results.some((item:any)=>item.asset?.name==='Parallel ready chair'));assert.ok(results.some((item:any)=>item.error?.includes('Modeling this requested shape failed')));return {output:[],calls:[call('generate_asset',failed)],text:''};}assert.match(results.at(-1).error,/already failed in this turn/);return {output:[],calls:[],text:JSON.stringify({summary:'One asset is ready; the other task is retained for explicit continuation. No scene edits.',requestedViews:[],operations:[]})};}},undefined,diagnostic,library);
  assert.equal(response.status,'ready');assert.equal(calls.length,5,'Three initial jobs and two rendered reviews; repeating the failed role cannot spend another call.');assert.deepEqual(Object.keys(diagnostic.assetHandles!).sort(),['prefab-2','prefab-3']);assert.equal(new Set(Object.values(diagnostic.assetHandles!)).size,2);const jobs=await readdir(path.join(library.directory,'jobs'));assert.equal(jobs.length,3);assert.deepEqual((await Promise.all(jobs.map(file=>library.readJob(file.replace('.json',''))))).map(job=>job.status).sort(),['failed','ready','ready']);assert.ok((await library.list()).some(asset=>asset.name==='Parallel ready chair'));assert.equal(source.project.scenes[0].objects.length,3);
});

test('recoverable tool errors expire, library reads refresh after generation, and new receipt IDs cannot disguise a stalled loop',async()=>{
  const library=new AssetLibrary(await mkdtemp(path.join(tmpdir(),'littletake-tool-state-'))),source={...input(),project:{name:'Repair prerequisite',scenes:[createDocument()]}},diagnostic=newDiagnostic();let turns=0,deferred:{id:string;name:string;arguments:string}[]=[];
  const call=(name:string,args:unknown)=>({id:crypto.randomUUID(),name,arguments:JSON.stringify(args)}),outputs=(request:any)=>request.input.filter((item:any)=>item.type==='function_call_output').map((item:any)=>JSON.parse(item.output));
  const placement={assetId:'builtin-car',sceneId:'scene-1',name:'Recovered car',transform:{position:[4,0,0],rotation:[0,0,0],scale:[1,1,1]}},original=JSON.stringify(source);
  const repaired=await proposeSceneEdit(source,{name:'test',model:'test',async generateObject(){throw new Error('No paid geometry generation expected.');},async generateToolTurn(request){turns++;
    if(turns===1)return {output:[],calls:[call('instantiate_asset',placement)],text:''};
    if(turns===3){const calls=[call('instantiate_asset',placement),...Array.from({length:11},(_,index)=>call('instantiate_asset',{...placement,name:'Other car '+index,transform:{...placement.transform,position:[6+index*2,0,0]}})),call('instantiate_asset',{...placement,name:'Measured repeated car',transform:{...placement.transform,position:[24,0,2]},repeat:{counts:[12,1,10],spacing:[3,0,5],variation:{seed:42,scaleMin:[1,.8,1],scaleMax:[1,1.2,1]}}})];deferred=calls.slice(8);return {output:[],calls,text:''};}
    if(turns===4){assert.equal(outputs(request).filter((item:any)=>item.error?.startsWith('Not run:')).length,5);return {output:[],calls:deferred.map(item=>({...item,id:crypto.randomUUID()})),text:''};}
    if(turns===2)return {output:[],calls:[call('read_asset',{assetId:'builtin-car'})],text:''};
    return {output:[],calls:[],text:JSON.stringify({summary:'Reuse the car after reading it.',requestedViews:[],operations:outputs(request).filter((item:any)=>item.placementId).map((item:any)=>item.operation)})};
  }},undefined,diagnostic,library);
  assert.equal(repaired.status,'ready');assert.equal(turns,5);assert.match(diagnostic.toolCalls![0].error!,/Read the asset/);assert.equal(diagnostic.toolCalls![2].error,undefined);assert.equal(diagnostic.toolCalls![0].arguments,diagnostic.toolCalls![2].arguments,'The identical call must succeed after its prerequisite changes.');
  if(repaired.status!=='ready')throw new Error();const populated=applyProjectOperations(source.project,repaired.plan.operations,0),repeated=populated.scenes[0].objects;assert.equal(repeated.length,135,'Independent calls and a repeated prefab batch must expand beyond the former 100-object cap.');assert.deepEqual(repeated.slice(-120,-118).map(object=>object.transform.position),[[24,0,2],[24,0,7]]);assert.deepEqual(repeated.at(-1)!.transform.position,[57,0,47]);assert.equal(new Set(repeated.map(object=>object.id)).size,135);const variants=repeated.slice(-120);assert.ok(variants.every(object=>object.transform.scale[0]===1&&object.transform.scale[2]===1&&object.transform.scale[1]>=.8&&object.transform.scale[1]<=1.2));assert.ok(new Set(variants.map(object=>object.transform.scale[1])).size>100);const reopened=parseProject(serializeProject({...createProject(null),...populated,activeSceneId:populated.scenes[0].id,activeShotId:populated.scenes[0].shots[0]?.id??null}));assert.deepEqual(reopened.scenes[0].objects,repeated,'Expanded variations remain independent and exactly reproducible after save/reload.');assert.equal(JSON.stringify(source),original);
  let measuredTurns=0;
  await proposeSceneEdit(source,{name:'test',model:'test',async generateObject(){throw new Error('No generation expected.');},async generateToolTurn(){measuredTurns++;
    if(measuredTurns<=3)return {output:[],calls:[call('inspect_spatial',{sceneId:measuredTurns===1?'missing-scene':'scene-1',time:0,objectIds:[measuredTurns===2?'missing-object':'object-1'],frame:{kind:'world'},precedingOperations:[]})],text:''};
    return {output:[],calls:[],text:JSON.stringify({summary:'The two distinct validation problems were repaired.',requestedViews:[],operations:[]})};
  }},undefined,newDiagnostic(),library);
  assert.equal(measuredTurns,4,'Correcting one validation problem and discovering another must not be mistaken for repeating the same error.');
  let assetTurns=0,expertCalls=0;
  const generated=await proposeSceneEdit(input(),{name:'test',model:'test',async generateObject(request){expertCalls++;if(request.schemaName==='proxy_asset_recipe'){const recipe=assetRecipeSchema.strip().parse(builtinAssets[0]);recipe.name='NavyMagicChair';recipe.tags=['NavyMagicChair'];return recipe;}return {approved:true,notes:'The requested chair is visible in the actual three-view preview.',revisedRecipe:null};},async generateToolTurn(request){assetTurns++;const result=outputs(request);
    if(assetTurns===1||assetTurns===3)return {output:[],calls:[call('search_assets',{query:'NavyMagicChair'})],text:''};
    if(assetTurns===2)return {output:[],calls:[call('generate_asset',{searchId:result[0].searchId,baseAssetId:'null',brief:'A reusable NavyMagicChair with four legs and a back.',reason:'The current library has no matching independently named chair.'})],text:''};
    assert.ok(result.filter((item:any)=>item.searchId).at(-1).candidates.some((item:any)=>item.name==='NavyMagicChair'),'The same query must see assets registered since its previous lookup.');
    return {output:[],calls:[],text:JSON.stringify({summary:'Asset saved; no scene edits requested.',requestedViews:[],operations:[]})};
  }},undefined,newDiagnostic(),library);
  assert.equal(generated.status,'ready');assert.equal(expertCalls,2,'Canonicalizing an explicitly nullable base does not require a paid retry.');
  let searches=0;
  await assert.rejects(proposeSceneEdit(source,{name:'test',model:'test',async generateObject(){throw new Error('No generation expected.');},async generateToolTurn(){if(++searches>5)throw new Error('A repeated lookup did not stop.');return {output:[],calls:[call('search_assets',{query:'NavyMagicChair'})],text:''};}},undefined,newDiagnostic(),library),/repeating the same observations or errors/);
  assert.equal(searches,3);
});

test('an instance that failed before read_asset succeeds when retried with the same arguments', async () => {
  const library = new AssetLibrary(await mkdtemp(path.join(tmpdir(), 'littletake-assets-'))), diagnostic = newDiagnostic();
  const place = { assetId: 'builtin-chair', sceneId: 'scene-1', name: 'Chair A', transform };
  let directorCalls = 0;
  const transport = (async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(init.body as string), outputs = body.input.filter((x: any) => x.type === 'function_call_output').map((x: any) => JSON.parse(x.output));
    directorCalls++;
    const call = (name: string, args: unknown) => Response.json({ status: 'completed', output: [{ type: 'function_call', call_id: 'call_' + directorCalls, name, arguments: JSON.stringify(args), status: 'completed' }] });
    if (directorCalls === 1) return call('instantiate_asset', place);
    if (directorCalls === 2) { assert.match(outputs.at(-1).error, /Read the asset/); return call('read_asset', { assetId: 'builtin-chair' }); }
    if (directorCalls === 3) return call('instantiate_asset', place);
    return Response.json(json({ summary: 'Placed one chair.', requestedViews: [], objectCounts: [], operations: outputs.filter((item: any) => item.placementId).map((item: any) => item.operation) }));
  }) as typeof fetch;
  const response = await proposeSceneEdit(input(), new MetaProvider({ apiKey: 'test', model: 'test' }, transport), undefined, diagnostic, library);
  assert.equal(response.status, 'ready');
  assert.deepEqual(diagnostic.toolCalls!.map(c => [c.name, Boolean(c.error)]), [['instantiate_asset', true], ['read_asset', false], ['instantiate_asset', false]]);
});

test('a round with a new tool error is progress; only repeated results stop the loop', async () => {
  const library = new AssetLibrary(await mkdtemp(path.join(tmpdir(), 'littletake-assets-'))), diagnostic = newDiagnostic();
  const place = { assetId: 'builtin-chair', sceneId: 'scene-1', name: 'Chair A', transform };
  let directorCalls = 0;
  const transport = (async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(init.body as string), outputs = body.input.filter((x: any) => x.type === 'function_call_output').map((x: any) => JSON.parse(x.output));
    directorCalls++;
    const call = (name: string, args: unknown) => Response.json({ status: 'completed', output: [{ type: 'function_call', call_id: 'call_' + directorCalls, name, arguments: JSON.stringify(args), status: 'completed' }] });
    if (directorCalls === 1) return call('instantiate_asset', place);
    if (directorCalls === 2) return call('read_asset', { assetId: 'missing-asset' });
    if (directorCalls === 3) return call('read_asset', { assetId: 'builtin-chair' });
    if (directorCalls === 4) return call('instantiate_asset', { ...place, name: 'Chair B' });
    return Response.json(json({ summary: 'Placed one chair.', requestedViews: [], objectCounts: [], operations: outputs.filter((item: any) => item.placementId).map((item: any) => item.operation) }));
  }) as typeof fetch;
  const response = await proposeSceneEdit(input(), new MetaProvider({ apiKey: 'test', model: 'test' }, transport), undefined, diagnostic, library);
  assert.equal(response.status, 'ready');
  assert.deepEqual(diagnostic.toolCalls!.map(c => Boolean(c.error)), [true, true, false, false]);

  let repeats = 0;
  const looping = (async () => { repeats++; return Response.json({ status: 'completed', output: [{ type: 'function_call', call_id: 'call_' + repeats, name: 'read_asset', arguments: JSON.stringify({ assetId: 'missing-asset' }), status: 'completed' }] }); }) as typeof fetch;
  await assert.rejects(proposeSceneEdit(input(), new MetaProvider({ apiKey: 'test', model: 'test' }, looping), undefined, newDiagnostic(), library), /two tool rounds repeating the same observations or errors/);
  assert.equal(repeats, 3);
});

test('a round asking for more than 8 tools runs 8 and answers the rest instead of failing', async () => {
  const library = new AssetLibrary(await mkdtemp(path.join(tmpdir(), 'littletake-assets-'))), diagnostic = newDiagnostic();
  let directorCalls = 0, skipped: any[] = [];
  const transport = (async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(init.body as string); directorCalls++;
    if (directorCalls === 1) return Response.json({ status: 'completed', output: Array.from({ length: 9 }, (_, i) => ({ type: 'function_call', call_id: 'call_' + i, name: 'search_assets', arguments: JSON.stringify({ query: 'chair ' + i }), status: 'completed' })) });
    skipped = body.input.filter((x: any) => x.type === 'function_call_output' && /Not run/.test(x.output));
    return Response.json(json({ summary: 'Nothing to place.', requestedViews: [], objectCounts: [], operations: [] }));
  }) as typeof fetch;
  const response = await proposeSceneEdit(input(), new MetaProvider({ apiKey: 'test', model: 'test' }, transport), undefined, diagnostic, library);
  assert.equal(response.status, 'ready');
  assert.equal(diagnostic.toolCalls!.length, 8);
  assert.deepEqual(skipped.map((x: any) => x.call_id), ['call_8']);
});

test('an empty or "null" baseAssetId starts a new asset instead of failing the call', async () => {
  for (const base of ['', 'null']) {
    const library = new AssetLibrary(await mkdtemp(path.join(tmpdir(), 'littletake-assets-'))), diagnostic = newDiagnostic();
    let directorCalls = 0, expertCalls = 0, expertBase: unknown = 'unset';
    const transport = (async (_url: unknown, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      if (!body.tools) {
        expertCalls++;
        if (expertCalls === 1) expertBase = JSON.parse(body.input[0].content[0].text).baseRecipe ?? null;
        const recipe = assetRecipeSchema.strip().parse(builtinAssets[0]); recipe.name = 'Lobby desk'; recipe.tags = ['desk', 'lobby'];
        return Response.json(json(expertCalls === 1 ? recipe : { approved: true, notes: 'All rendered views meet the brief.', revisedRecipe: null }));
      }
      directorCalls++;
      const outputs = body.input.filter((x: any) => x.type === 'function_call_output').map((x: any) => JSON.parse(x.output));
      const call = (name: string, args: unknown) => Response.json({ status: 'completed', output: [{ type: 'function_call', call_id: 'call_' + directorCalls, name, arguments: JSON.stringify(args), status: 'completed' }] });
      if (directorCalls === 1) return call('search_assets', { query: 'curved lobby desk' });
      if (directorCalls === 2) return call('generate_asset', { searchId: outputs[0].searchId, baseAssetId: base, brief: 'Curved wooden lobby desk 2.2m wide and 1m tall.', reason: 'No curved desk in the library.' });
      return Response.json(json({ summary: 'Prepared a desk.', requestedViews: [], objectCounts: [], operations: [] }));
    }) as typeof fetch;
    const response = await proposeSceneEdit(input(), new MetaProvider({ apiKey: 'test', model: 'test' }, transport), undefined, diagnostic, library);
    assert.equal(response.status, 'ready');
    assert.ok(!diagnostic.toolCalls!.some(call => call.error), JSON.stringify(base));
    assert.equal(expertBase, null);
  }
});

test("a reference run's approved assets can be placed without reading them again", async () => {
  const library = new AssetLibrary(await mkdtemp(path.join(tmpdir(), 'littletake-assets-'))), diagnostic = newDiagnostic();
  const approved = { ...structuredClone(builtinAssets[0]), id: 'asset-approved-desk', name: 'Approved desk' };
  const source = { ...input(), project: { name: 'Reference', scenes: [createEmptyScene()], assets: [approved] } };
  let directorCalls = 0;
  const transport = (async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(init.body as string), outputs = body.input.filter((x: any) => x.type === 'function_call_output').map((x: any) => JSON.parse(x.output));
    directorCalls++;
    if (directorCalls === 1) return Response.json({ status: 'completed', output: [{ type: 'function_call', call_id: 'call_1', name: 'instantiate_asset', arguments: JSON.stringify({ assetId: approved.id, sceneId: 'scene-1', name: 'Desk', transform }), status: 'completed' }] });
    return Response.json(json({ summary: 'Placed the desk.', requestedViews: [], objectCounts: [], operations: outputs.filter((item: any) => item.placementId).map((item: any) => item.operation) }));
  }) as typeof fetch;
  const response = await proposeSceneEdit(source as any, new MetaProvider({ apiKey: 'test', model: 'test' }, transport), undefined, diagnostic, library);
  assert.equal(response.status, 'ready');
  assert.deepEqual(diagnostic.toolCalls!.map(call => [call.name, Boolean(call.error)]), [['instantiate_asset', false]]);
});
