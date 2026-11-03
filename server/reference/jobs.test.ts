import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {ReferenceJobStore} from './jobs/store.ts';
import {createReferenceJobsHandler} from './jobs/api.ts';
import {createReferenceJobsProxy} from './jobs/proxy.ts';

const input={video:{dataUrl:'data:video/mp4;base64,'+Buffer.from([0,0,0,16,...Buffer.from('ftyp'),0,0,0,0]).toString('base64'),duration:6,width:640,height:360},direction:''};
const request=(body:unknown)=>new Request('https://studio.example/api/reference-jobs',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
test('background tasks survive disconnects and restarts, replay completed requests, retain unknown paid steps and never reset the call ceiling',async()=>{
  const directory=await mkdtemp(path.join(tmpdir(),'littletake-jobs-')),id=crypto.randomUUID(),value={id,sourceName:'Reference.mp4',projectName:'Project A',input};let store=new ReferenceJobStore(directory,2),wakes=0;
  const api=createReferenceJobsHandler(store,{},()=>{wakes++;},async id=>store.finish(id,'cancelled','Cancelled'));
  const response=await api(request(value));assert.equal(response.status,202);assert.equal((await response.json()).status,'queued');assert.equal(wakes,1);
  assert.equal((await api(request(value))).status,202);assert.equal(store.list().length,1,'A repeated submission cannot create another paid task.');
  assert.equal((await api(request({...value,input:{...input,direction:'A different request'}}))).status,409);
  assert.equal((await api(new Request('https://studio.example/api/reference-jobs',{method:'POST',headers:{'Content-Type':'application/json',Origin:'https://other.example'},body:JSON.stringify({...value,id:crypto.randomUUID()})}))).status,403);
  assert.equal(store.claim()?.id,id);const checkpoint={id,phase:'source' as const,attempts:[]};store.checkpoint(id,checkpoint);
  let providerCalls=0;const paid=store.provider(id,1,{name:'Offline test',model:'no-network',async generateObject(request){providerCalls++;request.onOutput?.('{"observation":"saved"}');return {observation:'saved'};}});
  const body={step:'observe'},structured={instructions:'Inspect a reference',content:[],schema:{},schemaName:'reference_observations'};
  const first=await store.request(id,body,async()=>Response.json(await paid.generateObject(structured)));assert.deepEqual(await first.json(),{observation:'saved'});assert.equal(providerCalls,1);assert.equal(store.get(id).callsUsed,1);
  store.close();store=new ReferenceJobStore(directory,2);store.recover();assert.equal(store.get(id).status,'queued');assert.deepEqual(store.payload(id).run,checkpoint);store.claim();
  const cached=await store.request(id,body,async()=>{throw new Error('Completed work must never be reissued.');});assert.deepEqual(await cached.json(),{observation:'saved'});assert.equal(store.get(id).callsUsed,1);
  // A process can die after charging a call, before any provider receipt is available.
  store.db.exec(`INSERT INTO requests(job_id,input,status,created_at) SELECT id,input,'running',updated_at FROM jobs;INSERT INTO calls(job_id,request_id,kind,input,status,created_at) SELECT id,2,'director',input,'running',updated_at FROM jobs;UPDATE jobs SET calls_used=2;`);
  store.close();store=new ReferenceJobStore(directory,2);store.recover();assert.equal(store.get(id).status,'interrupted');assert.equal(store.get(id).callsUsed,2);assert.equal(store.claim(),undefined,'An uncertain paid step cannot resume automatically.');
  assert.ok(store.diagnostics(id).calls.some(call=>call.status==='unknown'));store.resume(id);store.claim();
  const bounded=store.provider(id,3,{name:'Offline test',model:'no-network',async generateObject(){throw new Error('The saved budget must stop before this call.');}});await assert.rejects(bounded.generateObject(structured),/call limit/);assert.equal(store.get(id).callsUsed,2);
  assert.equal((await createReferenceJobsHandler(store,{},()=>{},async()=>{})(new Request('https://studio.example/api/reference-jobs?id='+id+'&action=result'))).status,409,'Unverified work cannot be downloaded as an approved scene.');
  store.finish(id,'cancelled','Cancelled');assert.equal(store.get(id).status,'cancelled');assert.equal(store.diagnostics(id).calls[0].rawOutput,'{"observation":"saved"}');store.close();
  const unavailable=await createReferenceJobsProxy({})(new Request('https://studio.example/api/reference-jobs'));assert.equal((await unavailable.json()).available,false);
});
