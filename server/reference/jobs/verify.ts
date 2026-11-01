import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {build} from 'vite';
import {startReferenceService} from './service.ts';
import type {AIProvider} from '../../ai/provider.ts';
import type {ReferenceRun} from '../../../src/reference/workflow.ts';

const wait=async(check:()=>boolean,timeout=180_000)=>{const until=Date.now()+timeout;while(!check()){if(Date.now()>until)throw new Error('The background verification exceeded its time limit.');await new Promise(resolve=>setTimeout(resolve,100));}};
test('the detached background renderer preserves real clip frames, three shots and full motion; a saved pending review resumes without rendering or model calls',async()=>{
  const directory=await mkdtemp(path.join(tmpdir(),'littletake-background-')),dist=path.join(directory,'dist');
  await build({logLevel:'silent',build:{outDir:dist,emptyOutDir:true}});
  const fixture=JSON.parse(await readFile(new URL('../../assets/fixtures/scene-preview.json',import.meta.url),'utf8')),faces=JSON.parse(await readFile(new URL('../../../src/reference/fixtures/face-landmarks.json',import.meta.url),'utf8'));
  const video={dataUrl:'data:video/mp4;base64,'+(await readFile(new URL('../../../public/demo/grand-budapest-zero/input-web.mp4',import.meta.url))).toString('base64'),duration:12.011292,width:1280,height:720};
  let calls=0;const provider:AIProvider={name:'Offline verification',model:'recorded-scene-no-network',async generateObject(request){calls++;assert.equal(request.schemaName,'reference_visual_review');assert.ok(request.content.filter(part=>part.type==='video').length===2,'The critic receives both the original and actual full-timeline render.');return {approved:false,notes:'Recorded rejected fixture; this verifies background execution, not reconstruction quality.',scores:{composition:4,motion:5,layout:4,color:5},issues:[{shotIndex:0,time:0.041,problem:'The recorded layout remains unsuitable.',correction:'Keep the rejected result isolated.'}],revisedAnalysis:null};}};
  const key='offline-verification-service-key',headers={Authorization:'Bearer '+key},options={directory,dist,port:0,key,callLimit:1,providerFactory:()=>provider,env:{MODEL_API_KEY:'offline-fixture',MUSE_MODEL:'offline-fixture'}};
  let service=await startReferenceService(options);
  const id=crypto.randomUUID(),input={video,direction:'Offline background infrastructure verification'},submission={id,projectName:'Background verification',sourceName:'Recorded clip · no paid inference',input};
  service.store.create(submission);service.store.claim();
  const run:ReferenceRun={id,attempts:[],analysis:faces.analysis,sourceReviewed:true,initial:{scene:fixture.scene,assets:fixture.assets,analysis:faces.analysis,summary:'Recorded rejected proposal',assumptions:[],provider:'Recorded fixture',model:'no-network'}};
  service.store.checkpoint(id,run);service.store.finish(id,'queued','Recorded proposal queued');service.worker.kick();
  try{
    // Submission/status connections are already gone; only the service owns execution.
    await wait(()=>['failed','succeeded'].includes(service.store.get(id).status));const job=service.store.get(id),saved=service.store.payload(id).run;
    assert.equal(job.status,'failed');assert.equal(calls,1);assert.equal(job.callsUsed,1);assert.equal(saved.attempts.length,1);assert.equal(saved.attempts[0].quality?.approved,false);assert.equal(saved.attempts[0].scene.shots.length,3);assert.ok(saved.attempts[0].video?.startsWith('data:video/mp4;base64,'));assert.equal(saved.attempts[0].frames?.length,9);assert.deepEqual(saved.source?.frameBounds,[.125,0,.875,1]);assert.ok(saved.attempts[0].sourceRegions?.length===9);
    assert.equal((await fetch(service.origin+'/api/reference-jobs?id='+id+'&action=result')).status,401);assert.equal((await fetch(service.origin+'/api/reference-jobs?id='+id+'&action=result',{headers})).status,409);
    const restored=structuredClone(saved);delete restored.error;delete restored.next;delete restored.attempts[0].quality;delete restored.attempts[0].result;restored.phase='rendered';service.store.db.prepare("UPDATE jobs SET status='running' WHERE id=?").run(id);service.store.checkpoint(id,restored);
    const exactVideo=restored.attempts[0].video,exactFrames=restored.attempts[0].frames;await service.close();service=await startReferenceService(options);
    await wait(()=>service.store.get(id).status==='failed');const resumed=service.store.payload(id).run;
    assert.equal(calls,1,'The completed review and bounded failure must replay without another model call.');assert.equal(resumed.attempts.length,1,'A pending saved review must not be skipped or duplicated.');assert.equal(resumed.attempts[0].video,exactVideo);assert.deepEqual(resumed.attempts[0].frames,exactFrames);assert.equal(service.store.get(id).callsUsed,1);
    const response=await fetch(service.origin+'/api/reference-jobs?id='+id+'&action=diagnostics',{headers});assert.equal(response.status,200);assert.equal(response.headers.get('content-type'),'application/gzip');assert.ok((await response.arrayBuffer()).byteLength>1000);
    const evidence={job:service.store.get(id),sourceFrames:resumed.source?.frames.length,shots:resumed.attempts[0].scene.shots.length,pairedFrames:resumed.attempts[0].frames?.length,sourceBounds:resumed.source?.frameBounds,fullMotionPreserved:!!resumed.attempts[0].video,paidNetworkCalls:0,fixtureCalls:calls,restartPreservedExactVideo:true};console.log(JSON.stringify(evidence));await writeFile(path.join(directory,'verification.json'),JSON.stringify(evidence,null,2));
  }finally{await service.close();}
});
