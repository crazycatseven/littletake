import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startApplication } from '../../server/app/service.ts';
import { createSceneEditHandler } from '../../server/scene-edit-api.ts';
import { createProject, parseProject, serializeProject } from '../project/storage.ts';
import { projectContent } from '../project/model.ts';
import { ConversationSession } from './session.ts';
import { conversationHistory } from './conversations.ts';
import { newProgress, readSceneEditResponse, type AgentProgress, type ProgressListener } from './progress.ts';
import type { SceneEditResponse } from './types.ts';

const ready: SceneEditResponse = { status: 'ready', provider: 'Meta', model: 'test', plan: { summary: 'No scene changes.', operations: [], requestedViews: [] } };
const deferred = <T>() => { let resolve!: (value:T)=>void; const promise = new Promise<T>(done=>{resolve=done;}); return {promise,resolve}; };

test('production HTTP streams progress before inference finishes, preserves final errors, and aborts the model on disconnect', async t => {
  const original = globalThis.fetch, waiting = deferred<Response>(), started = deferred<void>();
  let modelSignal: AbortSignal | undefined, calls = 0;
  globalThis.fetch = (async (url, options) => {
    if (String(url) !== 'https://api.meta.ai/v1/responses') return original(url,options);
    calls++; modelSignal = options?.signal ?? undefined; started.resolve(); return waiting.promise;
  }) as typeof fetch;
  t.after(()=>{globalThis.fetch=original;});
  const directory = await mkdtemp(path.join(tmpdir(),'littletake-progress-'));
  const server = await startApplication({port:0,env:{LITTLETAKE_DATA_DIR:directory,LITTLETAKE_LOCAL_DEPTH:'0',LITTLETAKE_PUBLIC_URL:'',LITTLETAKE_WORKSPACE_PASSWORD:'',MODEL_API_KEY:'test-only-private',MUSE_MODEL:'test'}});
  t.after(()=>server.close());
  const project=createProject(),lease=crypto.randomUUID(),page=crypto.randomUUID(),headers={'Content-Type':'application/json','x-littletake-edit-lease':lease,'x-littletake-edit-page':page};
  const created=await original(server.origin+'/api/projects',{method:'POST',headers,body:JSON.stringify({action:'create',id:crypto.randomUUID(),project})}),room=await created.json();
  assert.equal(created.status,201);
  const input={project:projectContent(project),sceneId:project.activeSceneId,shotId:project.activeShotId,prompt:'What is in the current scene?',selectedId:null,time:0,snapshots:[]};
  const response=await original(server.origin+'/api/scene-edit',{method:'POST',headers:{...headers,'x-littletake-project':room.code,Accept:'application/x-ndjson'},body:JSON.stringify(input)});
  assert.equal(response.status,200); assert.match(response.headers.get('content-type')!,/x-ndjson/);
  const events:AgentProgress[]=[],first=deferred<void>();
  const result=readSceneEditResponse(response,event=>{events.push(event);first.resolve();});
  await Promise.race([first.promise,new Promise((_,reject)=>{const timer=setTimeout(()=>reject(new Error('The HTTP bridge buffered progress behind inference.')),2000);timer.unref();})]);
  await started.promise; assert.ok(events.length,'A real HTTP chunk arrives while the model is unresolved.');
  waiting.resolve(Response.json({status:'completed',output_text:JSON.stringify(ready.plan)}));
  const data=await result as any; assert.equal(data.status,'ready');assert.equal(calls,1);
  assert.deepEqual(data.diagnostic.progress,events);assert.ok(!JSON.stringify(data).includes('test-only-private'));
  const failedHandler=createSceneEditHandler({},()=>({name:'test',model:'test',async generateObject(){throw new Error('provider private internals');}}));
  const failed=await failedHandler(new Request('http://localhost/api/scene-edit',{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/x-ndjson'},body:JSON.stringify(input)}));
  const failedEvents:AgentProgress[]=[],failure=await readSceneEditResponse(failed,event=>failedEvents.push(event)) as any;
  assert.equal(failure.error.code,'edit_failed');assert.equal(failedEvents.at(-1)?.status,'error');assert.ok(!JSON.stringify(failure).includes('provider private internals'));
  const disconnect=new AbortController(),pending=deferred<Response>();
  globalThis.fetch=(async (url,options)=>{if(String(url)!=='https://api.meta.ai/v1/responses')return original(url,options);modelSignal=options?.signal??undefined;modelSignal?.addEventListener('abort',()=>pending.resolve(Response.json({status:'cancelled'})),{once:true});return pending.promise;}) as typeof fetch;
  const open=await original(server.origin+'/api/scene-edit',{method:'POST',headers:{...headers,'x-littletake-project':room.code,Accept:'application/x-ndjson'},signal:disconnect.signal,body:JSON.stringify(input)});
  await open.body!.getReader().read();disconnect.abort();
  for(let attempt=0;attempt<30&&!modelSignal?.aborted;attempt++)await new Promise(done=>setTimeout(done,10));
  assert.equal(modelSignal?.aborted,true,'Disconnect must cancel the actual provider signal.');
});

test('public progress survives saved conversations, failures, retry and interruption; stale events cannot cross threads', async () => {
  const project=createProject(),book=project.conversations,requests:{progress?:ProgressListener;deferred:ReturnType<typeof deferred<SceneEditResponse>>}[]=[];
  const session=new ConversationSession(book,{context:()=>({project:projectContent(project),sceneId:project.activeSceneId,shotId:project.activeShotId,revision:0,time:0,selectedId:null}),prepare(){},changed(){},preview(){},capture(){throw new Error('No capture expected');},apply(){return false;},
    request(_input,_signal,progress){const pending=deferred<SceneEditResponse>();requests.push({progress,deferred:pending});return pending.promise;}});
  session.setDraft('Check the scene.');const run=session.send();requests[0].progress!(newProgress('正在检查两个镜头…'));requests[0].deferred.resolve(ready);await run;
  const saved=parseProject(serializeProject(project)),user=saved.conversations.threads[0].messages[0];
  assert.equal(user.role,'user');if(user.role!=='user')throw new Error();assert.ok(user.progress?.some(event=>event.message==='正在检查两个镜头…'));assert.equal(user.progress?.at(-1)?.status,'done');
  assert.ok(!JSON.stringify(conversationHistory(book.threads[0].messages)).includes('正在检查两个镜头'),'Public work records are not replayed as model reasoning or extra user instructions.');
  session.setDraft('Continue.');const cancelled=session.send(),old=session.active;requests[1].progress!(newProgress('正在查看资产…'));session.create();const before=JSON.stringify(book);requests[1].progress!(newProgress('late event'));requests[1].deferred.resolve(ready);await cancelled;
  assert.equal(JSON.stringify(book),before);assert.equal(old.messages.at(-1)?.role,'user');assert.equal((old.messages.at(-1) as any).progress.at(-1).status,'error');
  const partial=createProject();partial.conversations.threads[0].messages.push({id:crypto.randomUUID(),role:'user',text:'An interrupted turn',status:'pending',progress:[newProgress('正在渲染…')]});
  assert.equal((parseProject(serializeProject(partial)).conversations.threads[0].messages[0] as any).status,'stopped');
  const bytes=new TextEncoder().encode(JSON.stringify({type:'progress',event:newProgress('正在读取中文帧…')})+'\n'+JSON.stringify({type:'result',data:ready})+'\n');let offset=0;const split=new Response(new ReadableStream({pull(controller){if(offset>=bytes.length){controller.close();return;}controller.enqueue(bytes.slice(offset,offset+2));offset+=2;}}),{headers:{'Content-Type':'application/x-ndjson'}}),received:AgentProgress[]=[];
  assert.equal((await readSceneEditResponse(split,event=>received.push(event)) as any).status,'ready');assert.equal(received[0].message,'正在读取中文帧…');
  const cut=new Response(JSON.stringify({type:'progress',event:newProgress('正在执行…')})+'\n',{headers:{'Content-Type':'application/x-ndjson'}});await assert.rejects(readSceneEditResponse(cut),/disconnected before finishing/);
});
