import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { starterScript } from './model.ts';
import { checkScript, prepareScripts, ScriptInstance, idleScriptInput } from './runtime.ts';
import { checkProjectScript } from './check.ts';
import { createEmptyScene, createObject, evaluateTransform, History } from '../model.ts';
import { createProject, parseProject, serializeProject } from '../project/storage.ts';
import { projectContent } from '../project/model.ts';
import { projectArchive, readProjectArchive } from '../project/archive.ts';
import { applyProjectOperations } from '../scene-edit/operations.ts';
import { PerformanceSession } from '../performance/session.ts';
import { emptyAnimation, keepRecordedTake } from '../animation/model.ts';
import { builtinAssets, instantiateAsset, saveObjectAsset } from '../assets/library.ts';
import { evaluateAsset, validateAsset } from '../assets/model.ts';
import { ProjectRoomStore } from '../../server/projects/store.ts';
import type { Transform } from '../types.ts';

const pose=():Transform=>({position:[0,0,0],rotation:[0,0,0],scale:[1,1,1]});
test('project scripts survive independent instances, hot reload, pinned recordings, undo, archive and database reopen',async()=>{
  await prepareScripts();const scene=createEmptyScene(),script=starterScript('flight');scene.objects=[createObject('cube',1),createObject('cube',2)];
  const base=projectContent(createProject(scene)),history=new History(base);let project=applyProjectOperations(base,[{type:'upsert_script',sceneId:scene.id,script,expectedRevision:0},...scene.objects.map(object=>({type:'attach_script' as const,sceneId:scene.id,id:object.id,scriptId:script.id,parameters:{speed:object===scene.objects[0]?3:7},replaceController:true}))],0);history.commit(project);
  const doc=project.scenes[0],a=doc.objects[0],b=doc.objects[1],first=new PerformanceSession(a,0,doc,project.scripts),second=new PerformanceSession(b,0,doc,project.scripts);
  try {
    first.keys.add('w');for(let i=0;i<30;i++)first.update(1/60,5);assert.ok(first.pose.position[2]>a.transform.position[2]);assert.deepEqual(second.pose,b.transform);
    const before=structuredClone(first.pose),v2={...script,revision:2,source:script.source.replace('params.speed *','params.speed * 2 *')};
    project=applyProjectOperations(project,[{type:'upsert_script',sceneId:scene.id,script:v2,expectedRevision:1}],0);first.refreshScripts(project.scripts!,project.scenes[0].objects[0]);assert.deepEqual(first.pose,before);first.update(1/60,5);assert.equal(first.scriptRevision,2);assert.equal(second.scriptRevision,1);assert.equal(project.scenes[0].objects[0].components!.find(c=>c.type==='script')!.parameters.speed,3);
    first.start(5);first.keys.add('w');const v3={...v2,revision:3,stateVersion:2,source:v2.source.replace('velocity: 0','velocity: 1')};project=applyProjectOperations(project,[{type:'upsert_script',sceneId:scene.id,script:v3,expectedRevision:2}],0);first.refreshScripts(project.scripts!,project.scenes[0].objects[0]);for(let i=0;i<30;i++)first.update(1/30,5);assert.equal(first.scriptRevision,2,'recording pins its runtime');first.stop();
    const frames=first.recordedFrames,animation=keepRecordedTake(emptyAnimation(),'flight-take',frames,5);project.scenes[0].objects[0].animation=animation;
    const replay=evaluateTransform(project.scenes[0].objects[0],frames.at(-1)!.time);assert.deepEqual(replay.position,frames.at(-1)!.transform.position);
    first.discard();first.update(1/60,5);assert.equal(first.scriptRevision,3);assert.deepEqual(evaluateTransform(project.scenes[0].objects[0],frames.at(-1)!.time),replay,'new code does not alter baked playback');
    const saved={...createProject(project.scenes[0]),...project};assert.deepEqual(projectContent(parseProject(serializeProject(saved))),JSON.parse(JSON.stringify(project)));const archive=await readProjectArchive(projectArchive({project:saved,outputs:[]}));assert.deepEqual(archive.project.scripts,project.scripts);
    const directory=await mkdtemp(path.join(tmpdir(),'littletake-script-store-')),store=new ProjectRoomStore(directory),room=store.create(randomUUID(),randomUUID(),saved);store.db.close();const reopened=new ProjectRoomStore(directory);assert.deepEqual(reopened.get(room.code).project.scripts,project.scripts);reopened.db.close();
    assert.deepEqual(history.undo(),base);assert.equal(history.redo()!.scripts![0].source,script.source);
    assert.throws(()=>applyProjectOperations(project,[{type:'upsert_script',sceneId:scene.id,script:v2,expectedRevision:1}],0),/revision/);
    assert.throws(()=>applyProjectOperations(project,[{type:'remove_script',sceneId:scene.id,scriptId:script.id}],0),/Detach/);
    const malformed=structuredClone(saved);malformed.scripts=[];assert.throws(()=>parseProject(serializeProject(malformed)),/Missing script/);
    const asset=saveObjectAsset(project.scenes[0].objects[0],[], 'exported-cube');assert.ok(!asset.template?.components.some(c=>c.type==='script'),'scene controller references must not escape into a global prefab');
    assert.throws(()=>validateAsset({...asset,template:{...asset.template,components:[{type:'script',enabled:true,scriptId:script.id,parameters:{}}]}}),/Project scripts/);
  } finally {first.dispose();second.dispose();}
});

test('untrusted source is bounded and failed hot reload leaves a working controller; parented joint motion records as ordinary keys',async()=>{
  const script=starterScript('bounded');await checkScript(script);
  for(const source of ['while(true){}','function update(ctx){while(true){}}','function update(ctx){return fetch("https://example.com");}','function update(ctx){return process.env;}','function update(ctx){return document.body;}','function update(ctx){ctx.pose.position[0]=NaN;}','function update(ctx){ctx.state={bad:"x".repeat(9000000)};}','function update(ctx){ctx.input.keys.includes("w");}'])await assert.rejects(checkScript({...script,source}));
  const frame={dt:1/60,time:0,input:idleScriptInput(),pose:pose(),joints:{},params:{speed:4,turnSpeed:90,response:5}},instance=new ScriptInstance(script,frame);
  try {instance.queue({...script,revision:2,source:'function update(ctx){ while(true){} }'});const result=instance.step(frame);assert.equal(instance.definition.revision,1);assert.deepEqual(result.pose,pose());assert.ok(instance.error);instance.queue({...script,revision:3,stateVersion:2});instance.step(frame);assert.equal(instance.definition.revision,3);instance.queue({...script,revision:4,source:'function update(ctx){if(ctx.time>.2)throw new Error("late failure");}'});instance.step(frame);assert.throws(()=>instance.step({...frame,time:1},true),/late failure/);assert.equal(instance.definition.revision,4,'a recording must stop on failure instead of mixing controller revisions');}finally{instance.dispose();}
  const asset=builtinAssets.find(a=>a.id==='builtin-visitor')!,joint=evaluateAsset(asset).parts.find(p=>p.joint&&p.joint.min<=0&&p.joint.max>=10)!;
  const scene=createEmptyScene(),parent=createObject('cube',1),child=instantiateAsset(asset,'actor',[0,0,1],5);parent.transform.rotation[1]=90;child.parentId=parent.id;scene.objects=[parent,child];
  const controller={...script,source:`function update(ctx){ctx.pose.position[0]+=ctx.dt;ctx.pose.scale[0]=1+ctx.time*.1;ctx.joints[${JSON.stringify(joint.id)}]=Math.min(10,ctx.time*10);}`};
  const project=applyProjectOperations({...projectContent(createProject(scene)),assets:[asset]},[{type:'upsert_script',sceneId:scene.id,script:controller,expectedRevision:0},{type:'attach_script',sceneId:scene.id,id:child.id,scriptId:script.id,parameters:{},replaceController:true}],0);
  await checkProjectScript(controller,project,{sceneId:scene.id,id:child.id});
  await assert.rejects(checkProjectScript({...controller,source:`function update(ctx){ctx.joints[${JSON.stringify(joint.id)}]=360;}`},project),/joint limits/);
  const session=new PerformanceSession(project.scenes[0].objects[1],0,project.scenes[0],project.scripts,project.assets);
  try {session.start(5);for(let i=0;i<30;i++)session.update(1/30,5);session.stop();const recorded=keepRecordedTake(emptyAnimation(),'joints',session.recordedFrames,5);assert.ok(recorded.curves[`jointAngles.${joint.id}`]!.at(-1)!.value>9);assert.ok(Math.abs(session.pose.position[2]-2)<1e-6,'world displacement is converted back to parent local space');assert.ok(recorded.curves['position.z']!.length>20);assert.ok(recorded.curves['scale.x']!.at(-1)!.value>1.09,'script scale changes are retained in the take');}finally{session.dispose();}
  const jointOnly={...controller,source:`function update(ctx){ctx.joints[${JSON.stringify(joint.id)}]=10;}`},positioning=new PerformanceSession(project.scenes[0].objects[1],0,project.scenes[0],[jointOnly],project.assets);
  try{positioning.update(1/60,5);assert.equal(positioning.placement().jointAngles![joint.id],10,'joint-only positioning survives Stop Control');}finally{positioning.dispose();}
});
