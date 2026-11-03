import {readFileSync,writeFileSync,mkdirSync,readdirSync,statSync,existsSync,renameSync} from 'node:fs';
import {resolve} from 'node:path';
import {createServer} from 'vite';
import {sceneFromProposal} from '../../../server/reference/draft.ts';
import {AIError} from '../../../server/ai/provider.ts';
const directory=resolve('output/verification/reference-quality');mkdirSync(directory,{recursive:true});
const atomicWrite=(path:string,data:string)=>{const temporary=path+'.'+crypto.randomUUID()+'.tmp';writeFileSync(temporary,data);renameSync(temporary,path);};
const budgetPath=resolve(directory,'budget.json');try{readFileSync(budgetPath);}catch{writeFileSync(budgetPath,JSON.stringify({used:0,limit:24}));}
const nativeFetch=globalThis.fetch;
globalThis.fetch=async(input,options)=>{
  const url=String(input instanceof Request?input.url:input);if(!url.startsWith('https://api.meta.ai/'))return nativeFetch(input,options);
  const budget=JSON.parse(readFileSync(budgetPath,'utf8'));const limit=Math.min(budget.limit,128);if(budget.used>=limit)throw new AIError('call_limit','Reference verification reached its '+limit+' call limit.');
  budget.used++;atomicWrite(budgetPath,JSON.stringify(budget));const n=budget.used,payload=JSON.parse(String(options?.body));
  let images=0,videos=0;for(const item of payload.input??[])for(const part of item.content??[]){
    if(part.type==='input_video'){videos++;if(videos===1)part.video_url='[source clip preserved in the run]';else{const file='call-'+n+'-video-'+videos+(part.video_url.startsWith('data:video/mp4')?'.mp4':'.webm');writeFileSync(resolve(directory,file),Buffer.from(part.video_url.split(',')[1],'base64'));part.video_url=file;}}
    if(part.type==='input_image'){const file='call-'+n+'-image-'+(++images)+(part.image_url.startsWith('data:image/png')?'.png':'.jpg');writeFileSync(resolve(directory,file),Buffer.from(part.image_url.split(',')[1],'base64'));part.image_url=file;}
  }
  writeFileSync(resolve(directory,'call-'+n+'-request.json'),JSON.stringify(payload,null,2));console.log('Meta request '+n+' / '+limit+' · '+(payload.text?.format?.name??payload.model));
  const response=await nativeFetch(input,options);const body=await response.clone().text();writeFileSync(resolve(directory,'call-'+n+'-response.json'),body);console.log('Muse response '+n+' · HTTP '+response.status);return response;
};
function saveImages(run:any,path:string){if(run.source){if(run.source.detailSheet)writeFileSync(resolve(path,'source-details.jpg'),Buffer.from(run.source.detailSheet.split(',')[1],'base64'));writeFileSync(resolve(path,'source.jpg'),Buffer.from(run.source.contactSheet.split(',')[1],'base64'));run.source.frames.forEach((frame:any,i:number)=>writeFileSync(resolve(path,'source-'+i+'.jpg'),Buffer.from(frame.dataUrl.split(',')[1],'base64')));}
  run.attempts.forEach((attempt:any,i:number)=>{if(attempt.layoutSheet)writeFileSync(resolve(path,'layout-'+i+'.jpg'),Buffer.from(attempt.layoutSheet.split(',')[1],'base64'));writeFileSync(resolve(path,'comparison-'+i+'.jpg'),Buffer.from(attempt.contactSheet.split(',')[1],'base64'));if(attempt.video)writeFileSync(resolve(path,'motion-'+i+(attempt.video.startsWith('data:video/mp4')?'.mp4':'.webm')),Buffer.from(attempt.video.split(',')[1],'base64'));});
  for(const [key,preview] of Object.entries(run.offline??{}) as [string,any][])if(['raw','fitted'].includes(key)){writeFileSync(resolve(path,'offline-'+key+'.jpg'),Buffer.from(preview.contactSheet.split(',')[1],'base64'));if(preview.video)writeFileSync(resolve(path,'offline-'+key+(preview.video.startsWith('data:video/mp4')?'.mp4':'.webm')),Buffer.from(preview.video.split(',')[1],'base64'));}
}
const server=await createServer({server:{host:'127.0.0.1',port:4181,strictPort:true,hmr:false},plugins:[{name:'reference-verification-artifacts',configureServer(server){server.middlewares.use('/verification',async(req,res)=>{
  if(req.method==='GET'){
    try{const folders=readdirSync(directory,{withFileTypes:true}).filter(entry=>entry.isDirectory()&&existsSync(resolve(directory,entry.name,'run.json'))).map(entry=>({path:resolve(directory,entry.name),date:statSync(resolve(directory,entry.name,'run.json')).mtimeMs})).sort((a,b)=>b.date-a.date);
      const run=JSON.parse(readFileSync(resolve(folders[0].path,'run.json'),'utf8'));
      for(const analysis of [run.analysis,...[run.initial,run.next,run.result].map(draft=>draft?.analysis)])for(const frame of analysis?.frames??[])for(const subject of frame.subjects){subject.headBox??=null;subject.bodyRegionId??=null;subject.headRegionId??=null;}
      const initial=run.requests?.find((record:any)=>record.server?.attempts?.some((attempt:any)=>attempt.request.schemaName==='reference_observations'));
      if(!run.initial&&!run.analysis&&initial){const analysis=initial.server.attempts.find((a:any)=>a.request.schemaName==='reference_observations').rawProposal,proposal=initial.server.attempts.find((a:any)=>a.request.schemaName==='littletake_reference_scene')?.rawProposal;
        // Recorded runs before the structured framing field retain the observed shot descriptions.
        for(const shot of analysis.shots)shot.framing??=/wide/i.test(shot.description)?'full_body':'waist_up';for(const frame of analysis.frames)for(const subject of frame.subjects){subject.headBox??=null;subject.bodyRegionId??=null;subject.headRegionId??=null;}
        run.analysis=analysis;if(proposal)run.initial={...sceneFromProposal({...proposal,bindings:proposal.bindings??[]},initial.input.video.duration),analysis,provider:initial.server.provider??'Meta',model:initial.server.model??'recorded Muse Contributor'};
      }
      const last=run.requests?.filter((record:any)=>record.status==='ready'&&record.server?.attempts?.some((attempt:any)=>attempt.request.schemaName==='reference_visual_review'&&attempt.rawProposal?.revisedProposal)).at(-1);
      if(!run.next&&last){const result=last.server.attempts.find((a:any)=>a.request.schemaName==='reference_visual_review').rawProposal,{revisedProposal,...quality}=result;run.next={...sceneFromProposal({...revisedProposal,bindings:revisedProposal.bindings??[]},last.input.video.duration),analysis:run.initial.analysis,quality,provider:last.server.provider??run.initial.provider,model:last.server.model??run.initial.model};}
      if(!run.initial&&!run.analysis)throw new Error('No preserved generation can be resumed.');res.setHeader('Content-Type','application/json');res.end(JSON.stringify({run,video:run.video??initial?.input.video}));return;
    }catch(error){res.statusCode=400;res.end(JSON.stringify({error:(error as Error).message}));return;}
  }
  if(req.method!=='POST'){res.statusCode=405;res.end();return;}
  try{let body='';for await(const part of req){body+=part;if(body.length>100_000_000)throw new Error('Verification artifact too large.');}
    const run=JSON.parse(body);if(!/^[a-zA-Z0-9_-]{1,80}$/.test(run.id))throw new Error('Invalid run ID.');
    const path=resolve(directory,run.id);mkdirSync(path,{recursive:true});atomicWrite(resolve(path,'run.json'),JSON.stringify(run,null,2));saveImages(run,path);
    if(run.result)writeFileSync(resolve(path,'scene.json'),JSON.stringify(run.result.scene,null,2));
    res.setHeader('Content-Type','application/json');res.end(JSON.stringify({saved:true,path}));
  }catch(error){res.statusCode=400;res.end(JSON.stringify({error:(error as Error).message}));}
});}}]});
await server.listen();console.log('Reference harness: http://127.0.0.1:4181/src/reference/harness/ · PID '+process.pid);
