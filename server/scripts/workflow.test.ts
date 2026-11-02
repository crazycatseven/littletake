import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { proposeSceneEdit } from '../scene-edit.ts';
import { AssetLibrary } from '../assets/library.ts';
import { createEmptyScene, createObject } from '../../src/model.ts';
import { starterScript } from '../../src/scripts/model.ts';
import { applyProjectOperations } from '../../src/scene-edit/operations.ts';
import { newDiagnostic } from '../../src/scene-edit/diagnostics.ts';
import type { AIProvider } from '../ai/provider.ts';

test('Muse native tools read, reject invalid code, check a revision and propose its exact source with mounting, without mutating the project',async()=>{
  const scene=createEmptyScene();scene.objects=[createObject('cube',1)];const source={name:'Controller harness',scenes:[scene]},script=starterScript('muse-flight'),before=JSON.stringify(source),diagnostic=newDiagnostic();let calls=0;
  const provider:AIProvider={name:'test',model:'deterministic-test',async generateObject(){throw new Error('Expected native tools.');},async generateToolTurn(request){
    calls++;assert.ok(request.instructions.includes('Script Component API v1'));assert.ok(request.tools.some(t=>t.name==='check_script'));
    const tool=(name:string,args:unknown)=>({output:[],calls:[{id:'tool-'+calls,name,arguments:JSON.stringify(args)}],text:''});
    if(calls===1)return tool('read_script',{scriptId:null});
    if(calls===2)return tool('check_script',{script:{...script,source:'function update(ctx){ while(true){} }'}});
    if(calls===3){assert.ok(JSON.stringify(request.input).includes('interrupted'));return tool('check_script',{script});}
    return {output:[],calls:[],text:JSON.stringify({summary:'Prepared a flight controller. Review it, then Start Control.',requestedViews:[],operations:[{type:'use_checked_script',sceneId:scene.id,checkId:'script-check-2'},{type:'attach_script',sceneId:scene.id,id:scene.objects[0].id,scriptId:script.id,parameters:{speed:6},replaceController:true}]})};
  }};
  const response=await proposeSceneEdit({project:source,sceneId:scene.id,shotId:null,selectedId:scene.objects[0].id,time:0,prompt:'Create a flight controller for this object.',snapshots:[]},provider,undefined,diagnostic,new AssetLibrary(await mkdtemp(path.join(tmpdir(),'littletake-script-harness-'))));
  assert.equal(response.status,'ready');assert.equal(calls,4);assert.equal(JSON.stringify(source),before);if(response.status!=='ready')return;
  const result=applyProjectOperations(source,response.plan.operations,0);assert.equal(result.scripts![0].source,script.source);const attached=result.scenes[0].objects[0].components!.find(c=>c.type==='script')!;assert.equal(attached.parameters.speed,6);assert.equal(diagnostic.toolCalls!.filter(call=>call.name==='check_script').length,2);
});
