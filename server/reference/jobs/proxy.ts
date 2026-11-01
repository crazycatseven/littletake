import {readReferenceJSON} from '../../reference-api.ts';
import {AIError} from '../../ai/provider.ts';

/** The public app forwards short task operations; model work never runs in this request. */
export function createReferenceJobsProxy(env:Record<string,string|undefined>){
  return async(request:Request):Promise<Response>=>{
    const local=env.REFERENCE_BACKEND_URL&&!env.VERCEL&&new URL(env.REFERENCE_BACKEND_URL).hostname==='127.0.0.1';
    if(!env.REFERENCE_BACKEND_URL||(!env.REFERENCE_BACKEND_KEY&&!local))return Response.json({available:false,provider:'Meta',model:'',jobs:[],error:{message:'Background analysis is not configured on this deployment.'}},{status:request.method==='GET'?200:503});
    try{
      if(!['GET','POST'].includes(request.method))return new Response(null,{status:405});
      const url=new URL(request.url),origin=request.headers.get('origin');if(request.method==='POST'&&origin&&origin!==url.origin)throw new AIError('wrong_origin','Open LittleTake directly to manage reference tasks.',403);
      const body=request.method==='POST'&&!url.searchParams.has('id')?JSON.stringify(await readReferenceJSON(request)):undefined;
      const upstream=await fetch(new URL('/api/reference-jobs'+url.search,env.REFERENCE_BACKEND_URL),{method:request.method,headers:{...(env.REFERENCE_BACKEND_KEY?{Authorization:'Bearer '+env.REFERENCE_BACKEND_KEY}:{}),...(body?{'Content-Type':'application/json'}:{})},body,signal:request.signal,redirect:'error'});
      // Keep the readable body streaming: full diagnostic downloads can exceed Vercel's buffered-response limit.
      const headers=new Headers({'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});for(const name of ['Content-Type','Content-Disposition']){const value=upstream.headers.get(name);if(value)headers.set(name,value);}return new Response(upstream.body,{status:upstream.status,headers});
    }catch(error){return Response.json({error:{code:error instanceof AIError?error.code:'backend_unavailable',message:error instanceof AIError?error.message:'The background service is unavailable. Saved tasks will remain there; reconnect to check their status.'}},{status:error instanceof AIError?error.status:502});}
  };
}
