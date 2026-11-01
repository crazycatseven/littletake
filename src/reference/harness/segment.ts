import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadEnv } from 'vite';

// One explicit probe, sharing the reconstruction harness's persisted call ceiling.
const [file,concept]=process.argv.slice(2);
if(!file||!concept)throw new Error('Usage: tsx src/reference/harness/segment.ts <image> <concept>');
const directory=resolve('output/verification/reference-quality'),budgetPath=resolve(directory,'budget.json');
const budget=JSON.parse(readFileSync(budgetPath,'utf8'));
if(budget.used>=budget.limit)throw new Error('The verification call ceiling has been reached.');
const env={...loadEnv('development',process.cwd(),''),...process.env},key=env.MODEL_API_KEY;
if(!key)throw new Error('The Meta API is not configured.');
const video=/\.mp4$/i.test(file),dataUrl='data:'+(video?'video/mp4':'image/'+(/\.png$/i.test(file)?'png':'jpeg'))+';base64,'+readFileSync(file).toString('base64');
const media=video?{type:'input_video',video_url:dataUrl}:{type:'input_image',image_url:dataUrl};
const body={model:'sam-3.1',store:false,metadata:{mask_encoding:'one_bit',include_confidence:'true'},input:[{type:'message',role:'user',content:[{type:'input_text',text:concept},media]}]};
budget.used++;writeFileSync(budgetPath,JSON.stringify(budget));const prefix=resolve(directory,'call-'+budget.used);
writeFileSync(prefix+'-request.json',JSON.stringify({...body,input:[{type:'message',role:'user',content:[{type:'input_text',text:concept},video?{type:'input_video',video_url:resolve(file)}:{type:'input_image',image_url:resolve(file)}]}]},null,2));
console.log('SAM probe '+budget.used+' / '+budget.limit+' · '+concept);
const response=await fetch('https://api.meta.ai/v1/responses',{method:'POST',headers:{Authorization:'Bearer '+key,'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(150_000)});
const text=await response.text();writeFileSync(prefix+'-response.json',text);
console.log('HTTP '+response.status+' · response preserved');
if(!response.ok)process.exitCode=1;
