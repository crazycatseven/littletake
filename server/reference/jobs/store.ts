import {DatabaseSync} from 'node:sqlite';
import {mkdirSync} from 'node:fs';
import path from 'node:path';
import {deflateSync,inflateSync} from 'node:zlib';
import {AIError,type AIProvider} from '../../ai/provider.ts';
import type {ReferenceJobSubmission,ReferenceJobSummary,ReferenceJobStatus} from '../../../src/reference/types.ts';
import type {ReferenceRun} from '../../../src/reference/workflow.ts';

const pack=(value:unknown)=>deflateSync(Buffer.from(JSON.stringify(value)));
const unpack=<T>(value:unknown):T=>JSON.parse(inflateSync(value as Uint8Array).toString('utf8'));
const now=()=>new Date().toISOString();
const columns='id,project_name,source_name,status,message,created_at,updated_at,calls_used,call_limit,error';
const summary=(row:any):ReferenceJobSummary=>({id:row.id,projectName:row.project_name,sourceName:row.source_name,status:row.status,message:row.message,createdAt:row.created_at,updatedAt:row.updated_at,callsUsed:row.calls_used,callLimit:row.call_limit,...(row.error?{error:row.error}:{})});

/** One durable database owns task checkpoints, request receipts and the paid-call ceiling. */
export class ReferenceJobStore{
  readonly db:DatabaseSync;
  constructor(directory:string,readonly callLimit=72){
    if(!Number.isSafeInteger(callLimit)||callLimit<0||callLimit>100)throw new Error('Reference task call limit must be 0–100.');
    mkdirSync(directory,{recursive:true});this.db=new DatabaseSync(path.join(directory,'reference-jobs.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL;PRAGMA synchronous=FULL;PRAGMA busy_timeout=10000;
      CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,project_name TEXT NOT NULL,source_name TEXT NOT NULL,status TEXT NOT NULL,message TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,calls_used INTEGER NOT NULL DEFAULT 0,call_limit INTEGER NOT NULL,input BLOB NOT NULL,run BLOB NOT NULL,error TEXT);
      CREATE TABLE IF NOT EXISTS requests(id INTEGER PRIMARY KEY,job_id TEXT NOT NULL,input BLOB NOT NULL,status TEXT NOT NULL,body BLOB,http_status INTEGER,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS calls(id INTEGER PRIMARY KEY,job_id TEXT NOT NULL,request_id INTEGER NOT NULL,kind TEXT NOT NULL,input BLOB NOT NULL,status TEXT NOT NULL,output BLOB,raw_output TEXT,error TEXT,created_at TEXT NOT NULL);`);
  }
  create(value:ReferenceJobSubmission):ReferenceJobSummary{
    const existing=this.db.prepare('SELECT * FROM jobs WHERE id=?').get(value.id) as any;
    if(existing){if(!Buffer.from(existing.input).equals(pack(value.input))||existing.project_name!==value.projectName||existing.source_name!==value.sourceName)throw new AIError('job_conflict','This task ID already belongs to another input.',409);return summary(existing);}
    const time=now();this.db.prepare('INSERT INTO jobs(id,project_name,source_name,status,message,created_at,updated_at,call_limit,input,run) VALUES(?,?,?,?,?,?,?,?,?,?)').run(value.id,value.projectName,value.sourceName,'queued','Waiting to start',time,time,this.callLimit,pack(value.input),pack({id:value.id,attempts:[]}));return this.get(value.id);
  }
  get(id:string):ReferenceJobSummary{const row=this.db.prepare('SELECT '+columns+' FROM jobs WHERE id=?').get(id);if(!row)throw new AIError('job_missing','This reference task could not be found.',404);return summary(row);}
  list(){return this.db.prepare('SELECT '+columns+' FROM jobs ORDER BY created_at DESC LIMIT 30').all().map(summary);}
  payload(id:string){this.get(id);const row=this.db.prepare('SELECT input,run FROM jobs WHERE id=?').get(id)!;return {input:unpack<ReferenceJobSubmission['input']>(row.input),run:unpack<ReferenceRun>(row.run)};}
  checkpoint(id:string,run:ReferenceRun){if(this.get(id).status!=='running')throw new AIError('job_stopped','The task has stopped.',409);this.db.prepare('UPDATE jobs SET run=?,updated_at=? WHERE id=?').run(pack(run),now(),id);}
  progress(id:string,message:string){this.db.prepare("UPDATE jobs SET message=?,updated_at=? WHERE id=? AND status='running'").run(message.slice(0,300),now(),id);}
  finish(id:string,status:ReferenceJobStatus,message:string,error?:string){this.db.prepare("UPDATE jobs SET status=?,message=?,error=?,updated_at=? WHERE id=? AND status NOT IN ('cancelled','succeeded')").run(status,message,error??null,now(),id);}
  claim():ReferenceJobSummary|undefined{
    const row=this.db.prepare("UPDATE jobs SET status='running',message='Starting background analysis',updated_at=? WHERE id=(SELECT id FROM jobs WHERE status='queued' ORDER BY created_at LIMIT 1) RETURNING "+columns).get(now());return row?summary(row):undefined;
  }
  recover(){
    this.db.exec("UPDATE calls SET status='unknown' WHERE status='running';UPDATE requests SET status='interrupted' WHERE status='running';");
    this.db.prepare("UPDATE jobs SET status=CASE WHEN EXISTS(SELECT 1 FROM requests WHERE job_id=jobs.id AND status='interrupted') THEN 'interrupted' ELSE 'queued' END,message=CASE WHEN EXISTS(SELECT 1 FROM requests WHERE job_id=jobs.id AND status='interrupted') THEN 'Service restarted during a model step. Resume retries that unfinished step; saved results are retained.' ELSE 'Service restarted; continuing from saved progress' END,updated_at=? WHERE status='running'").run(now());
  }
  resume(id:string){
    if(this.get(id).status!=='interrupted')throw new AIError('job_state','Only an interrupted task can be resumed.',409);
    this.db.prepare("UPDATE requests SET status='retry_allowed' WHERE job_id=? AND status='interrupted'").run(id);this.finish(id,'queued','Resuming from saved progress');return this.get(id);
  }
  async request(id:string,input:unknown,execute:(requestId:number)=>Promise<Response>):Promise<Response>{
    if(this.get(id).status!=='running')throw new AIError('job_stopped','The task has stopped.',409);
    const receipt=this.db.prepare('SELECT * FROM requests WHERE job_id=? AND input=? ORDER BY id DESC LIMIT 1').get(id,pack(input)) as any;
    if(receipt?.status==='ready')return new Response(inflateSync(receipt.body),{status:receipt.http_status,headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});
    if(receipt&&['running','interrupted'].includes(receipt.status))throw new AIError('job_interrupted','The previous model step has no confirmed result. Its evidence is retained; resume the task explicitly.',409);
    const requestId=Number(this.db.prepare("INSERT INTO requests(job_id,input,status,created_at) VALUES(?,?,'running',?)").run(id,pack(input),now()).lastInsertRowid);
    try{const response=await execute(requestId),body=Buffer.from(await response.arrayBuffer());this.db.prepare("UPDATE requests SET status='ready',body=?,http_status=? WHERE id=?").run(deflateSync(body),response.status,requestId);return new Response(body,{status:response.status,headers:response.headers});}
    catch(error){this.db.prepare("UPDATE requests SET status='interrupted' WHERE id=?").run(requestId);throw error;}
  }
  provider(id:string,requestId:number,provider:AIProvider):AIProvider{
    const call=async<T>(kind:string,input:unknown,execute:(raw:(text:string)=>void)=>Promise<T>)=>{
      const changed=this.db.prepare("UPDATE jobs SET calls_used=calls_used+1,updated_at=? WHERE id=? AND status='running' AND calls_used<call_limit RETURNING calls_used,call_limit").get(now(),id) as any;
      if(!changed)throw new AIError('call_limit','The background task reached its saved call limit or was stopped. Its inputs and results are retained.');
      const callId=Number(this.db.prepare("INSERT INTO calls(job_id,request_id,kind,input,status,created_at) VALUES(?,?,?,?,'running',?)").run(id,requestId,kind,pack(input),now()).lastInsertRowid);
      console.log(`Reference task ${id} · model call ${changed.calls_used}/${changed.call_limit} · ${kind}`);
      try{const result=await execute(raw=>this.db.prepare('UPDATE calls SET raw_output=? WHERE id=?').run(raw,callId));this.db.prepare("UPDATE calls SET status='ready',output=? WHERE id=?").run(pack(result),callId);return result;}
      catch(error){this.db.prepare("UPDATE calls SET status='failed',error=? WHERE id=?").run(error instanceof AIError?error.message:'The model step failed; request evidence is retained.',callId);throw error;}
    };
    return {name:provider.name,model:provider.model,
      generateObject:request=>{const {signal,onOutput,...input}=request;return call(request.schemaName,input,raw=>provider.generateObject({...request,onOutput:text=>{raw(text);onOutput?.(text);}}));},
      ...(provider.generateToolTurn?{generateToolTurn:(request:Parameters<NonNullable<AIProvider['generateToolTurn']>>[0])=>{const {signal,onResponse,...input}=request;return call('director',input,raw=>provider.generateToolTurn!({...request,onResponse:response=>{raw(JSON.stringify(response));onResponse?.(response);}}));}}:{}),
      ...(provider.segmentMedia?{segmentMedia:(media:Parameters<NonNullable<AIProvider['segmentMedia']>>[0],concept:string,signal?:AbortSignal)=>call('segmentation',{media,concept},()=>provider.segmentMedia!(media,concept,signal))}:{})};
  }
  diagnostics(id:string){return {job:this.get(id),...this.payload(id),requests:this.db.prepare('SELECT * FROM requests WHERE job_id=? ORDER BY id').all(id).map((row:any)=>({id:row.id,input:unpack(row.input),status:row.status,httpStatus:row.http_status,...(row.body?{response:JSON.parse(inflateSync(row.body).toString('utf8'))}:{})})),calls:this.db.prepare('SELECT * FROM calls WHERE job_id=? ORDER BY id').all(id).map((row:any)=>({id:row.id,requestId:row.request_id,kind:row.kind,status:row.status,input:unpack(row.input),...(row.output?{output:unpack(row.output)}:{}),rawOutput:row.raw_output,error:row.error,createdAt:row.created_at}))};}
  close(){this.db.close();}
}
