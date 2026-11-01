import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MetaProvider } from '../ai/meta.ts';
import { AssetLibrary } from './library.ts';
import { generateAsset,type AssetJob } from './expert.ts';
import { budgetProvider } from './tools.ts';
import { builtinAssets } from '../../src/assets/builtin.ts';
import { builtinAssets as catalogAssets,instantiateAsset } from '../../src/assets/library.ts';
import { assetRecipeSchema } from '../../src/assets/model.ts';
import { createEmptyScene, History } from '../../src/model.ts';
import { createProject, parseProject, serializeProject } from '../../src/project/storage.ts';
import { validateProjectContent } from '../../src/project/model.ts';
import { applyProjectOperations } from '../../src/scene-edit/operations.ts';
import { newDiagnostic } from '../../src/scene-edit/diagnostics.ts';
import { proposeSceneEdit } from '../scene-edit.ts';
import type { SceneEditInput } from '../../src/scene-edit/types.ts';

const transform = { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] };
const json = (value: unknown) => ({ status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify(value) }] }] });
function transportFor(mode: 'generate' | 'reuse', assetId = 'builtin-chair') {
  let directorCalls = 0, expertCalls = 0;
  const requests: Record<string, any>[] = [];
  const transport = (async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(init.body as string); requests.push(body);
    if (!body.tools) {
      expertCalls++;
      if(expertCalls===1){const context=JSON.parse(body.input[0].content[0].text);assert.deepEqual(context.baseRecipe.parts,builtinAssets[0].parts,'The specialist receives the inspected base geometry, not only a short description.');}
      const recipe = assetRecipeSchema.strip().parse(builtinAssets[0]); recipe.name = 'Blue test chair'; recipe.tags = ['blue', 'test chair']; recipe.parts.forEach(p => p.color = '#4466aa');
      recipe.parts.push({...structuredClone(recipe.parts[0]),id:'side_handle',name:'Side handle',position:[.6,.6,0],size:[.12,.12,.12]});
      return Response.json(json(expertCalls === 1 ? recipe : { approved: true, notes: 'All rendered views meet the brief.', revisedRecipe: null }));
    }
    directorCalls++;
    assert.equal(body.parallel_tool_calls, true); assert.equal(body.store, false);
    const outputs = body.input.filter((x: any) => x.type === 'function_call_output').map((x: any) => JSON.parse(x.output));
    const call = (name: string, args: unknown) => Response.json({ status: 'completed', output: [{ type: 'function_call', call_id: 'call_' + directorCalls, name, arguments: JSON.stringify(args), status: 'completed' }] });
    if (directorCalls === 1) return call('search_assets', { query: mode === 'generate' ? 'blue test chair special' : 'chair' });
    if (directorCalls === 2) return call('read_asset', { assetId });
    if(mode==='generate'&&directorCalls===3)return call('generate_asset',{searchId:outputs[0].searchId,baseAssetId:'null',brief:'Blue chair with four legs and a backrest, matching the requested special asset.',reason:'The user explicitly requested a new independent test asset variant.'});
    if(mode==='generate'&&directorCalls===4){assert.equal(expertCalls,0,'An invalid base reference must not spend expert calls.');assert.match(outputs.at(-1).error,/JSON null/);return call('generate_asset',{searchId:outputs[0].searchId,baseAssetId:assetId,brief:'Blue chair with four legs and a backrest, matching the requested special asset.',reason:'The user explicitly requested a new independent test asset variant.'});}
    const selected = mode === 'generate' ? outputs.find((item:any)=>item.asset)?.asset.id : assetId,start=mode==='generate'?5:3;
    if (directorCalls === start) return call('instantiate_asset', { assetId: selected, sceneId: 'scene-1', name: 'Chair A', transform });
    if (directorCalls === start+1) return call('instantiate_asset', { assetId: selected, sceneId: 'scene-1', name: 'Chair B', transform: { ...transform, position: [2, 0, 0] } });
    return Response.json(json({ summary: 'Prepared two instances.', requestedViews: [], objectCounts: [], operations: outputs.filter((item:any)=>item.placementId).map((item:any)=>item.operation) }));
  }) as typeof fetch;
  return { provider: new MetaProvider({ apiKey: 'do-not-log-this-test-secret', model: 'test' }, transport), requests, counts: () => ({ directorCalls, expertCalls }) };
}
const input = (): SceneEditInput => ({ project: { name: 'Assets', scenes: [createEmptyScene()] }, sceneId: 'scene-1', shotId: null, prompt: 'Place chairs in this scene.', selectedId: null, time: 0, snapshots: [] });

test('library-first native tools reuse assets, preserve instance independence, export, undo and reload', async () => {
  const library = new AssetLibrary(await mkdtemp(path.join(tmpdir(), 'littletake-assets-'))), source = input(), frozen = JSON.stringify(source), diagnostic = newDiagnostic(), fake = transportFor('reuse');
  const response = await proposeSceneEdit(source, fake.provider, undefined, diagnostic, library);
  assert.equal(response.status, 'ready'); if (response.status !== 'ready') return;
  assert.deepEqual(fake.counts(), { directorCalls: 5, expertCalls: 0 }); assert.equal(JSON.stringify(source), frozen);
  assert.deepEqual(diagnostic.toolCalls!.map(c => c.name), ['search_assets', 'read_asset', 'instantiate_asset', 'instantiate_asset']);
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
  assert.match(diagnostic.toolCalls!.find(call=>call.error)!.error!,/JSON null/);
  const expertRequests = fake.requests.filter(r => !r.tools);
  assert.match(expertRequests[0].instructions, /dedicated Proxy Asset Modeling Expert/);
  assert.ok(!expertRequests[0].instructions.includes('film-set builder'));
  assert.ok(expertRequests[1].input[0].content.some((p: any) => p.type === 'input_image' && p.image_url.startsWith('data:image/png;base64,')));
  const result = applyProjectOperations(source.project, response.plan.operations, 0), asset = result.assets![0];
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
  let calls = 0;
  const provider = { name: 'test', model: 'test', async generateObject(request: any) { calls++; const value = calls === 1 ? recipe : { approved: false, notes: 'The requested feature is missing.', revisedRecipe: recipe }; request.onOutput?.(JSON.stringify(value)); return value; } };
  await assert.rejects(generateAsset('Test a chair which must not pass inspection.', provider, library), /review did not pass/);
  assert.equal(calls, 4); assert.equal((await library.list()).length, catalogAssets.length);
  const jobs = await readdir(path.join(library.directory, 'jobs')), job = await library.readJob(jobs[0].replace('.json', ''));
  assert.equal(job.status, 'failed'); assert.equal((job.attempts as any[]).filter(a => a.rawOutput).length, 4);
  const referenceImage='data:image/png;base64,'+Buffer.from(await library.preview(builtinAssets[0])).toString('base64');let resumedCalls=0;
  const revision=structuredClone(recipe);revision.parts[0].color='#224466';
  const resumed=await generateAsset('Continue the saved revised chair.',{name:'test',model:'test',async generateObject(request:any){resumedCalls++;assert.equal(request.schemaName,'proxy_asset_review');assert.ok(request.content.some((part:any)=>part.dataUrl===referenceImage));return {approved:true,notes:'The saved correction passes the rendered review.',revisedRecipe:resumedCalls===1?revision:null};}},library,undefined,{referenceImage,resumeJobId:String(job.id)});
  assert.equal(resumedCalls,2);assert.equal(resumed.asset.parts[0].color,'#224466');assert.equal(resumed.job.resumedFrom,job.id);assert.deepEqual(await library.read(resumed.asset.id),resumed.asset);assert.equal((await library.readJob(String(job.id))).status,'failed');
  const controller = new AbortController(); controller.abort(); await assert.rejects(generateAsset('A cancelled chair', provider, library, controller.signal)); assert.equal(calls, 4);
  const limited = budgetProvider(provider, 1), request = { instructions: '', content: [], schema: {}, schemaName: 'test' };
  await limited.generateObject(request); await assert.rejects(limited.generateObject(request), /call limit/); assert.equal(calls, 5);
});
