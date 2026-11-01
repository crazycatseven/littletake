import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createReferenceHandler} from '../reference-api.ts';
import type {AIProvider,ToolResponse} from '../ai/provider.ts';
import {assetRecipeSchema} from '../../src/assets/model.ts';
import {builtinAssets} from '../../src/assets/builtin.ts';
import {createProject,parseProject,serializeProject} from '../../src/project/storage.ts';
import {aimedCameraTransform} from '../../src/scene-edit/operations.ts';
import {sceneFromProposal} from './draft.ts';
import {DEFAULT_SCENE_LOOK} from '../../src/scene-edit/look.ts';

const jpeg='data:image/jpeg;base64,'+Buffer.from([255,216,255,217]).toString('base64');
const names=['doorway','counter','arches','curved_desk'];
const pose={position:[0,0,0],rotation:[0,0,0],scale:[1,1,1]};
const body={video:{dataUrl:'data:video/mp4;base64,'+Buffer.from([0,0,0,16,...Buffer.from('ftyp'),0,0,0,0]).toString('base64'),duration:6,width:640,height:360},direction:'',
  source:{frameBounds:[.125,0,.875,1],cuts:[],contactSheet:jpeg,frames:[{time:0,shotIndex:0,frameIndex:0,dataUrl:jpeg,detections:[]}]},
  analysis:{summary:'Four recurring physical set pieces.',entities:names.map(name=>({name,description:name,color:'#d4a784',principal:false})),shots:[{start:0,duration:6,framing:'full_body',description:'One fixed camera'}],frames:[{time:0,shotIndex:0,subjects:names.map(name=>({name,box:[.1,.1,.9,.9],headBox:null,bodyRegionId:null,headRegionId:null,facing:'front',action:'static'})),setting:'Warm set'}],assumptions:[]}};
const post=(value:unknown)=>new Request('https://test.example/api/reference',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(value)});
const calls=(turn:number,items:{name:string;arguments:unknown}[]):ToolResponse=>{const output=items.map((item,index)=>({type:'function_call',call_id:`call_${turn}_${index}`,name:item.name,arguments:JSON.stringify(item.arguments)}));return {output,calls:output.map(item=>({id:item.call_id,name:item.name,arguments:item.arguments})),text:''};};
const outputs=(input:unknown[])=>input.filter((item:any)=>item.type==='function_call_output').map((item:any)=>JSON.parse(item.output));

test('an independent source audit retains supporting actors and a rejected semantic correction can add an entity before the director repairs it',async()=>{
  const initial={...body.analysis,frameBounds:[.125,0,.875,1],entities:[{name:'lead',description:'Walking person',color:'#582273',principal:true}],frames:[{time:0,shotIndex:0,subjects:[{name:'lead',box:[.1,.1,.3,.9],headBox:null,bodyRegionId:'p0',headRegionId:null,facing:'front',action:'walk'}],setting:'Doorway'}]};
  const corrected=structuredClone(initial);corrected.entities.push({name:'door_operator',description:'Supporting person holding a door open',color:'#222222',principal:false});corrected.frames[0].subjects.push({name:'door_operator',box:[0,0,.1,.1],headBox:null,bodyRegionId:'p1',headRegionId:null,facing:'front',action:'hold door'});
  corrected.frameBounds=[0,0,1,1];
  const detections=[{id:'p0',kind:'person',confidence:1,box:[.1,.1,.3,.9]},{id:'p1',kind:'person',confidence:1,box:[.6,.2,.8,.95]}];let paid=0;
  const handler=createReferenceHandler({},()=>({name:'test',model:'test',async segmentMedia(){throw new Error('The audit must reuse preserved measurements.');},async generateObject(request){paid++;
    assert.ok(request.content.some(part=>part.type==='video'));
    if(request.schemaName==='reference_observation_review'){assert.ok(request.content.filter(part=>part.type==='image').length>=2,'Full source frame plus unassigned-person detail.');return corrected;}
    assert.equal(request.schemaName,'reference_visual_review');return {approved:false,notes:'Supporting actor omitted.',scores:{composition:5,motion:5,layout:5,color:8},issues:[{shotIndex:0,time:0,problem:'Door operator missing',correction:'Add the observed supporting person.'}],revisedAnalysis:corrected};
  }}));
  const source={...body.source,frames:[{...body.source.frames[0],detections}]},response=await handler(post({...body,source,analysis:initial,sourceReview:true}));assert.equal(response.status,200);const audited=await response.json();
  assert.equal(audited.diagnostic.attempts.length,1);assert.equal(audited.diagnostic.attempts[0].request.schemaName,'reference_observation_review');assert.ok(!audited.scene);assert.equal(initial.entities.length,1);assert.deepEqual(audited.analysis.frames[0].subjects[1].box,detections[1].box);
  assert.deepEqual(audited.analysis.frameBounds,source.frameBounds,'An identity audit cannot invent a different measured image rectangle.');
  const lostBackground=await handler(post({...body,source,analysis:body.analysis,sourceReview:true}));assert.equal(lostBackground.status,502);assert.equal((await lostBackground.json()).error.code,'invalid_analysis','An identity audit cannot silently erase all fixed-landmark measurements.');
  const transform={position:[0,0,0],rotation:[0,0,0],scale:[1,1,1]},scene=sceneFromProposal({name:'Set',summary:'Old draft without supporting person',assumptions:[],bindings:[],look:DEFAULT_SCENE_LOOK,objects:[{name:'lead',kind:'human',color:'#582273',transform,motion:null}],shots:[{name:'Wide',start:0,duration:6,position:[0,2,5],target:[0,1,0],fov:45,motion:null}]},6).scene;
  const rejected=await handler(post({...body,source:undefined,analysis:initial,review:{scene,contactSheet:jpeg,frames:[{shotId:scene.shots[0].id,time:0}],sourceRegions:[{time:0,detections}]}}));assert.equal(rejected.status,200);const reviewed=await rejected.json();
  assert.equal(reviewed.quality.approved,false);assert.equal(reviewed.analysis.entities.length,2);assert.deepEqual(reviewed.scene,JSON.parse(JSON.stringify(scene)),'The critic changes observations, never secretly adds geometry.');assert.equal(paid,3);
  assert.deepEqual(reviewed.analysis.frameBounds,initial.frameBounds,'Semantic corrections must preserve measured source framing.');
  const lostDuringReview=await handler(post({...body,source:undefined,review:{scene,contactSheet:jpeg,frames:[{shotId:scene.shots[0].id,time:0}],sourceRegions:[{time:0,detections}]}}));assert.equal(lostDuringReview.status,502);assert.equal((await lostDuringReview.json()).error.code,'invalid_analysis','A rejected render cannot repair its score by erasing the observed background.');assert.equal(paid,4);
});

test('a bounded reference build preserves expert assets, resumes on a cold server without regeneration, and saves portable native scene references',async()=>{
  let paid=0,turns=0;
  const provider:AIProvider={name:'test',model:'test',async generateObject(request){paid++;assert.ok(request.content.some(part=>part.type==='image'&&part.dataUrl===jpeg),'Asset experts receive the original reference pixels.');
    const recipe=assetRecipeSchema.strip().parse(builtinAssets[0]);recipe.name=JSON.parse((request.content[0] as {text:string}).text).brief?.slice(0,50)??'Generated prop';
    const result=request.schemaName==='proxy_asset_recipe'?recipe:{approved:true,notes:'The rendered test asset meets its brief.',revisedRecipe:null};request.onOutput?.(JSON.stringify(result));return result;
  },async generateToolTurn(request){paid++;turns++;assert.ok(request.instructions.includes('REFERENCE RECONSTRUCTION CONTRACT'),'Reference rules must be trusted application instructions, not JSON metadata.');
    assert.ok((request.input as any[]).some(item=>item.content?.some((part:any)=>part.type==='input_video')));const result=outputs(request.input);
    if(turns===1)return calls(turns,[{name:'search_assets',arguments:{query:'Special architectural set pieces'}}]);
    if(turns===2)return calls(turns,[{name:'read_asset',arguments:{assetId:'builtin-chair'}}]);
    if(turns===3)return calls(turns,names.map(name=>({name:'generate_asset',arguments:{searchId:result[0].searchId,brief:'Model '+name+' as a hollow architectural proxy using the source reference.',reason:'The inspected chair is structurally unsuitable for this architectural piece.'}})));
    if(turns===4)return calls(turns,result.filter(item=>item.status==='ready').map((item,index)=>({name:'instantiate_asset',arguments:{assetId:item.asset.id,sceneId:'reference',name:names[index],transform:{...pose,position:[index*2,0,0]}}})));
    throw new Error('The request budget must stop before a fifth director call.');
  }};
  const first=createReferenceHandler({LITTLETAKE_ASSET_DIR:await mkdtemp(path.join(tmpdir(),'reference-assets-'))},()=>provider),response=await first(post(body));assert.equal(response.status,200);
  const prepared=await response.json();assert.equal(prepared.preparation,true);assert.ok(!prepared.scene);assert.equal(prepared.assets.filter((asset:any)=>asset.source==='generated').length,4);assert.equal(paid,12);assert.equal(turns,4);
  assert.ok(prepared.diagnostic.toolCalls.filter((call:any)=>call.name==='generate_asset').every((call:any)=>call.result.status==='ready'));
  const generated=prepared.assets.filter((asset:any)=>asset.source==='generated');let resumedTurns=0;let placements:unknown[]=[];
  const cold:AIProvider={name:'test',model:'test',async generateObject(){throw new Error('A cold restart must reuse approved embedded assets.');},async generateToolTurn(request){resumedTurns++;const result=outputs(request.input);
    if(resumedTurns===1)return calls(resumedTurns,[{name:'search_assets',arguments:{query:'architectural proxy'}}]);
    if(resumedTurns===2)return calls(resumedTurns,generated.map((asset:any)=>({name:'read_asset',arguments:{assetId:asset.id}})));
    if(resumedTurns===3)return calls(resumedTurns,generated.map((asset:any,index:number)=>({name:'instantiate_asset',arguments:{assetId:asset.id,sceneId:'reference',name:names[index],transform:{...pose,position:[index*2,0,0]}}})));
    if(result.some(item=>item.placementId))placements=result.filter(item=>item.placementId).map(item=>item.operation);
    if(resumedTurns===6)assert.ok(JSON.stringify(request.input).includes('Do not round measured times'),'Reference-specific validation must reach the existing bounded correction.');
    const plan={summary:'Reuse approved references to finish the native scene.',requestedViews:[],objectCounts:[],operations:[{type:'add_scene',sceneId:'reference',name:'Reference set',duration:resumedTurns<=5?6.02:6},...placements,{type:'add_camera',sceneId:'reference',camera:{id:'camera',name:'Camera',fov:45,transform:aimedCameraTransform([4,2,6],[0,1,0]),track:null}},{type:'add_shot',sceneId:'reference',shot:{id:'shot',name:'Shot',cameraId:'camera',start:0,duration:6}}]};
    if([4,6].includes(resumedTurns))return calls(resumedTurns,[{name:'render_scene',arguments:{sceneId:'reference',frames:[{shotId:'shot',time:0}],operations:plan.operations}}]);return {output:[],calls:[],text:JSON.stringify(resumedTurns===7?{...plan,operations:[],scenePreviewId:result.at(-1).scenePreviewId}:plan)};
  }};
  const fresh=createReferenceHandler({LITTLETAKE_ASSET_DIR:await mkdtemp(path.join(tmpdir(),'reference-cold-'))},()=>cold),resumed=await fresh(post({...body,assets:prepared.assets}));assert.equal(resumed.status,200);const draft=await resumed.json();
  assert.equal(draft.scene.objects.length,4);assert.ok(draft.scene.objects.every((object:any)=>object.kind==='asset'));assert.equal(resumedTurns,7);assert.equal(draft.diagnostic.attempts.length,2);assert.equal(draft.scene.duration,6);
  assert.ok(draft.scene.cameras.every((camera:any)=>JSON.stringify(camera.frameBounds)===JSON.stringify(body.source.frameBounds)),'The inspected source matte must also survive application to the real scene.');
  const project=createProject(draft.scene);project.assets=draft.assets;const reopened=parseProject(serializeProject(project));assert.deepEqual(reopened.scenes,draft.scene?[draft.scene]:[]);assert.deepEqual(reopened.assets,draft.assets);
  // A repair carries the source once, inside the comparison sheet, with its exact row clock.
  let repairTurns=0,expertCalls=0;const repairProvider:AIProvider={name:'test',model:'test',async generateObject(request){expertCalls++;
    const originals=request.content.filter(part=>part.type==='image'&&part.reference);assert.equal(originals.length,1);if(originals[0].type!=='image')throw new Error('Expected an original image.');
    assert.deepEqual(originals[0].provenance,{dataRef:'input.repair.contactSheet',transform:{type:'crop-png-v1',x:0,y:412,width:640,height:360}},'The expert receives only the original LEFT half, with the correct sheet-row offset.');
    const recipe=assetRecipeSchema.strip().parse(generated[0]);return request.schemaName==='proxy_asset_recipe'?recipe:{approved:true,notes:'Source-colored compatible asset.',revisedRecipe:null};
  },async generateToolTurn(request){repairTurns++;const serialized=JSON.stringify(request.input),result=outputs(request.input);
    assert.ok(serialized.includes('FAILED RENDER PAIR 1 at 3s'),'Image timestamps follow preserved sheet rows, not analysis array order.');
    assert.ok(serialized.includes('ORIGINAL ASSET REFERENCE at 0s'));
    if(repairTurns===1)return calls(repairTurns,[{name:'search_assets',arguments:{query:'reference architectural variant'}}]);
    if(repairTurns===2)return calls(repairTurns,[{name:'read_asset',arguments:{assetId:generated[0].id}}]);
    if(repairTurns===3)return calls(repairTurns,[{name:'generate_asset',arguments:{searchId:result[0].searchId,baseAssetId:generated[0].id,brief:'Correct this architecture to match the original reference colors and openings.',reason:'The original set requires a structurally compatible variant of this inspected prefab.'}}]);
    const operations:unknown[]=[{type:'set_asset',sceneId:draft.scene.id,id:draft.scene.objects[0].id,assetId:result.find(item=>item.status==='ready').asset.id}];if(repairTurns>=5)operations.push({type:'translate',sceneId:draft.scene.id,id:draft.scene.objects[0].id,offset:[.25,0,0]});
    if(repairTurns===6)assert.ok(JSON.stringify(request.input).includes('COMPLETE exact operations'),'A late uninspected edit must reach the bounded correction.');if([4,6].includes(repairTurns))return calls(repairTurns,[{name:'render_scene',arguments:{sceneId:draft.scene.id,frames:[{shotId:draft.scene.shots[0].id,time:0}],operations}}]);
    return {output:[],calls:[],text:JSON.stringify({summary:'Update the existing physical set without changing its identity or motion.',requestedViews:[],objectCounts:[],operations:repairTurns===7?[]:operations,...(repairTurns===7?{scenePreviewId:result.at(-1).scenePreviewId}:{})})};
  }};
  const repair={scene:draft.scene,assets:draft.assets,quality:{approved:false,notes:'Needs source-matching architecture.',scores:{composition:5,motion:5,layout:5,color:5},issues:[{shotIndex:0,time:3,problem:'Incorrect silhouette',correction:'Use the original source pixels.'}]},contactSheet:jpeg,frames:[3,0,5].map(time=>({shotId:draft.scene.shots[0].id,time}))};
  const repairHandler=createReferenceHandler({LITTLETAKE_ASSET_DIR:await mkdtemp(path.join(tmpdir(),'reference-repair-'))},()=>repairProvider);
  const repaired=await repairHandler(post({...body,source:undefined,repair})),fixed=await repaired.json();assert.equal(repaired.status,200,JSON.stringify({error:fixed.error,attempts:fixed.diagnostic?.attempts.map((attempt:any)=>({error:attempt.error,rawOutput:attempt.rawOutput})),toolCalls:fixed.diagnostic?.toolCalls.map((call:any)=>({name:call.name,error:call.error}))}));
  assert.equal(expertCalls,2);assert.equal(repairTurns,7);assert.equal(fixed.scene.id,draft.scene.id);assert.deepEqual(fixed.scene.shots,draft.scene.shots);assert.deepEqual(fixed.scene.objects.map((object:any)=>object.id),draft.scene.objects.map((object:any)=>object.id));assert.equal(fixed.scene.objects[0].transform.position[0],draft.scene.objects[0].transform.position[0]+.25);
  const invalid=await repairHandler(post({...body,source:undefined,repair:{...repair,frames:[{shotId:'absent',time:0}]}}));assert.equal(invalid.status,400);assert.equal(expertCalls,2,'Invalid row clocks stop before any paid provider work.');
});
