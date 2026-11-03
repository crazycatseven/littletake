import {createServer} from 'node:http';
import {Readable} from 'node:stream';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createAIProvider,type AIEnvironment} from '../../ai/index.ts';
import {AIError,type AIProvider} from '../../ai/provider.ts';
import {createReferenceHandler,readReferenceJSON} from '../../reference-api.ts';
import {ReferenceJobStore} from './store.ts';
import {ReferenceWorker} from './worker.ts';
import {createReferenceJobsHandler} from './api.ts';

const mime:Record<string,string>={'.html':'text/html','.js':'text/javascript','.mjs':'text/javascript','.css':'text/css','.wasm':'application/wasm','.onnx':'application/octet-stream','.png':'image/png','.jpg':'image/jpeg','.svg':'image/svg+xml','.mp4':'video/mp4'};
export async function startReferenceService(options:{directory:string;port?:number;host?:string;key?:string;dist?:string;env?:AIEnvironment;providerFactory?:()=>AIProvider;callLimit?:number}){
  const host=options.host??'127.0.0.1',key=options.key??'',env={...process.env,...options.env,LITTLETAKE_ASSET_DIR:path.join(options.directory,'assets')},dist=path.resolve(options.dist??'dist');
  if(host!=='127.0.0.1'&&!key)throw new Error('Set REFERENCE_BACKEND_KEY before exposing the service.');
  const store=new ReferenceJobStore(options.directory,options.callLimit);let worker:ReferenceWorker;
  const jobs=createReferenceJobsHandler(store,env,()=>worker.kick(),id=>worker.cancel(id));
  const server=createServer(async(req,res)=>{
    try{
      const pathname=new URL(req.url??'/',`http://${req.headers.host}`).pathname;
      if(pathname==='/health'){res.setHeader('Content-Type','application/json');res.end('{"ok":true}');return;}
      if(key&&req.headers.authorization!=='Bearer '+key){res.statusCode=401;res.end('{"error":{"message":"Service authentication required."}}');return;}
      const headers=new Headers();for(const [name,value] of Object.entries(req.headers))if(value)headers.set(name,Array.isArray(value)?value.join(', '):value);
      const jobId=headers.get('x-littletake-job'),signal=jobId?worker.signal(jobId):undefined;
      const request=new Request(`http://${req.headers.host}${req.url}`,{method:req.method,headers,...(signal?{signal}:{}),...(req.method==='POST'?{body:Readable.toWeb(req) as ReadableStream<Uint8Array>,duplex:'half'}:{})});
      let response:Response;
      if(pathname==='/api/reference-jobs')response=await jobs(request);
      else if(pathname==='/api/reference'){
        if(!jobId||!signal)throw new AIError('invalid_job','Model steps must belong to the active background task.',403);
        const input=await readReferenceJSON(request);response=await store.request(jobId,input,requestId=>createReferenceHandler(env,()=>store.provider(jobId,requestId,options.providerFactory?.()??createAIProvider(env)))(new Request(request.url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input),signal})));
      }else{
        if(req.method!=='GET')throw new AIError('invalid_method','This resource is read-only.',405);
        const target=path.resolve(dist,'.'+decodeURIComponent(pathname==='/'?'/index.html':pathname));if(!target.startsWith(dist+path.sep))throw new AIError('missing_file','Not found.',404);
        const bytes=await readFile(target);response=new Response(bytes,{headers:{'Content-Type':mime[path.extname(target)]??'application/octet-stream'}});
      }
      res.statusCode=response.status;response.headers.forEach((value,name)=>res.setHeader(name,value));res.end(Buffer.from(await response.arrayBuffer()));
    }catch(error){res.statusCode=error instanceof AIError?error.status:(error as NodeJS.ErrnoException).code==='ENOENT'?404:500;res.setHeader('Content-Type','application/json');res.end(JSON.stringify({error:{message:error instanceof AIError?error.message:'The background service could not finish this operation.'}}));}
  });
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(options.port??4182,host,resolve);});
  const address=server.address();if(!address||typeof address==='string')throw new Error('The reference service has no network address.');
  const origin=`http://127.0.0.1:${address.port}`;worker=new ReferenceWorker(store,origin,key);store.recover();worker.kick();
  return {origin,store,worker,async close(){await worker.stop();await new Promise<void>(resolve=>server.close(()=>resolve()));store.close();}};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  try{process.loadEnvFile('.env.local');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  const service=await startReferenceService({directory:process.env.REFERENCE_DATA_DIR??path.resolve('.littletake/reference'),port:Number(process.env.PORT??4182),host:process.env.REFERENCE_HOST??'127.0.0.1',key:process.env.REFERENCE_BACKEND_KEY,callLimit:Number(process.env.REFERENCE_CALL_LIMIT??72)});
  console.log('LittleTake background service: '+service.origin);
  let closing=false;for(const signal of ['SIGINT','SIGTERM'] as const)process.on(signal,()=>{if(!closing){closing=true;void service.close().then(()=>process.exit(0));}});
}
