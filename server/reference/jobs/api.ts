import {z} from 'zod';
import {gzipSync} from 'node:zlib';
import {AIError} from '../../ai/provider.ts';
import {aiConnection,type AIEnvironment} from '../../ai/index.ts';
import {parseVideoReferenceInput} from '../analyze.ts';
import {readReferenceJSON} from '../../reference-api.ts';
import type {ReferenceJobStore} from './store.ts';

const submission=z.strictObject({id:z.uuid(),projectName:z.string().trim().min(1).max(120),sourceName:z.string().trim().min(1).max(120),input:z.unknown()});
const json=(value:unknown,status=200)=>Response.json(value,{status,headers:{'Cache-Control':'no-store'}});
export function createReferenceJobsHandler(store:ReferenceJobStore,env:AIEnvironment,wake:()=>void,cancel:(id:string)=>Promise<void>){
  return async(request:Request):Promise<Response>=>{try{
    const url=new URL(request.url),id=url.searchParams.get('id'),action=url.searchParams.get('action');
    if(id&&!z.uuid().safeParse(id).success)throw new AIError('invalid_job','Invalid reference task ID.',400);
    if(request.method==='GET'){
      if(!id)return json({...aiConnection(env),jobs:store.list()});
      const job=store.get(id);
      if(action==='result'){if(job.status!=='succeeded')throw new AIError('job_not_ready','The scene has not passed reconstruction review.',409);const result=store.payload(id).run.result;if(!result?.quality?.approved)throw new Error('The saved task has no approved result.');return json(result);}
      if(action==='input')return json(store.payload(id).input);
      if(action==='diagnostics')return new Response(gzipSync(JSON.stringify({format:'LittleTake.reference-job',version:1,...store.diagnostics(id)})),{headers:{'Content-Type':'application/gzip','Content-Disposition':`attachment; filename="LittleTake-${id}.json.gz"`,'Cache-Control':'no-store'}});
      return json(job);
    }
    if(request.method!=='POST')return new Response(null,{status:405,headers:{Allow:'GET, POST'}});
    const origin=request.headers.get('origin');if(origin&&origin!==url.origin)throw new AIError('wrong_origin','Open LittleTake directly to manage reference tasks.',403);
    if(id){if(action==='cancel'){await cancel(id);return json(store.get(id));}if(action==='resume'){const job=store.resume(id);wake();return json(job,202);}throw new AIError('invalid_action','Choose a task action.',400);}
    const value=submission.parse(await readReferenceJSON(request)),input=parseVideoReferenceInput(value.input);
    if(Object.entries(input).some(([key,value])=>value!==undefined&&!['video','direction'].includes(key)))throw new AIError('invalid_input','Submit the original clip and direction; source analysis is performed by the background task.',400);
    const job=store.create({...value,input});wake();return json(job,202);
  }catch(error){return json({error:{code:error instanceof AIError?error.code:'job_failed',message:error instanceof AIError?error.message:error instanceof z.ZodError?'The task input is invalid.':'The reference task could not be read or saved.'}},error instanceof AIError?error.status:error instanceof z.ZodError?400:500);}};
}
